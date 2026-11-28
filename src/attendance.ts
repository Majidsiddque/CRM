import type pg from 'pg';

// ---- Tunables --------------------------------------------------------------
// A punch dated more than this far in the future cannot be real.
export const FUTURE_TOLERANCE_SECONDS = 300;
// A punch that arrives later than this after it happened is "late": either a
// backlog re-send after an outage, or the machine clock is slow.
export const LATE_SECONDS = 600;
// Clock estimate: look at the last 3 live (single-punch) uploads. If their lags
// agree within CLOCK_SPREAD_SECONDS it is a steady clock error, not backlog.
export const CLOCK_WINDOW = 3;
export const CLOCK_SPREAD_SECONDS = 120;
// An error smaller than this is just network delay, so no correction.
export const CLOCK_OK_SECONDS = 120;

export const deviceTimezone = () => process.env.DEVICE_TIMEZONE ?? 'Asia/Kolkata';

// ---- Parsing ---------------------------------------------------------------
export interface ParsedLine {
  pin: string;
  time: string; // 'YYYY-MM-DD HH:MM:SS' exactly as the machine printed it
  status: number | null;
  verify: number | null;
}
export interface ParseResult {
  lines: ParsedLine[];
  bad: string[];
}

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function validTime(t: string): boolean {
  if (!TIME_RE.test(t)) return false;
  const d = new Date(`${t.replace(' ', 'T')}Z`);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCFullYear() >= 1970 &&
    d.toISOString().slice(0, 19).replace('T', ' ') === t
  );
}

function smallInt(v: string | undefined): number | null {
  if (v === undefined || !/^\d{1,5}$/.test(v.trim())) return null;
  const n = Number(v);
  return n <= 32767 ? n : null;
}

// ATTLOG lines look like: PIN <tab> time <tab> status <tab> verify <tab> workcode ...
export function parseAttlog(body: Buffer): ParseResult {
  const lines: ParsedLine[] = [];
  const bad: string[] = [];
  for (const raw of body.toString('utf8').split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const parts = raw.split('\t');
    const pin = parts[0]?.trim() ?? '';
    const time = parts[1]?.trim() ?? '';
    if (!pin || pin.length > 50 || !validTime(time)) {
      bad.push(raw.slice(0, 200));
      continue;
    }
    lines.push({ pin, time, status: smallInt(parts[2]), verify: smallInt(parts[3]) });
  }
  return { lines, bad };
}

// ---- Clock estimate --------------------------------------------------------
// lags = (server received time - machine time) in seconds for recent LIVE
// punches. A wrong clock gives the same lag every time; a backlog gives lags
// that all differ. Returns the correction in seconds (0 = trust the clock).
export function estimateClockOffset(lags: number[]): number {
  if (lags.length < CLOCK_WINDOW) return 0;
  const sorted = [...lags].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  if (max - min > CLOCK_SPREAD_SECONDS) return 0;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return Math.abs(median) <= CLOCK_OK_SECONDS ? 0 : median;
}

// ---- Processing ------------------------------------------------------------
export interface ProcessResult {
  kind: 'attlog' | 'skipped';
  lines: number;
  inserted: number;
  duplicates: number;
  bad: number;
  clockOffsetSeconds: number;
}

function isAttlog(method: string, url: string): boolean {
  if (method !== 'POST') return false;
  const table = new URL(url, 'http://localhost').searchParams.get('table');
  return table?.toUpperCase() === 'ATTLOG';
}

const RECORD_SQL = `
  insert into processed_raw_punches
    (raw_punch_id, kind, lines, inserted, duplicates, bad_lines, error)
  values ($1, $2, $3, $4, $5, $6, $7)
  on conflict (raw_punch_id) do update set
    processed_at = now(), kind = excluded.kind, lines = excluded.lines,
    inserted = excluded.inserted, duplicates = excluded.duplicates,
    bad_lines = excluded.bad_lines, error = excluded.error`;

const INSERT_PUNCHES_SQL = `
  insert into punches
    (raw_punch_id, device_serial, employee_pin, device_time, status, verify_mode,
     received_at, batch_size, device_time_utc, lag_seconds, clock_offset_seconds,
     corrected_time, clock_flag)
  select $1, $2, l.pin, l.t::timestamp, l.status, l.verify, $3::timestamptz, $4::int,
         u.utc, g.lag, $5::bigint,
         u.utc + make_interval(secs => $5::bigint),
         case when $5::bigint <> 0 then 'corrected'
              when g.lag < 0 - $6::bigint then 'future'
              when g.lag > $7::bigint then 'late'
              else 'ok' end
  from unnest($8::text[], $9::text[], $10::int[], $11::int[]) as l(pin, t, status, verify)
  cross join lateral (select l.t::timestamp at time zone $12::text as utc) u
  cross join lateral (
    select round(extract(epoch from ($3::timestamptz - u.utc)))::bigint as lag) g
  on conflict (device_serial, employee_pin, device_time) do nothing`;

// Turns one saved raw upload into clean punches. Safe to run again on the same
// raw row: duplicates are ignored by the UNIQUE constraint.
export async function processRawPunch(
  pool: pg.Pool,
  rawId: string | number,
): Promise<ProcessResult | null> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const found = await c.query(
      'select id, received_at, device_serial, method, url, body from raw_punches where id = $1',
      [rawId],
    );
    const raw = found.rows[0] as
      | { id: string; received_at: Date; device_serial: string | null; method: string; url: string; body: Buffer }
      | undefined;
    if (!raw) return null;

    if (!raw.device_serial || !isAttlog(raw.method, raw.url)) {
      await c.query(RECORD_SQL, [raw.id, 'skipped', 0, 0, 0, 0, null]);
      await c.query('commit');
      return { kind: 'skipped', lines: 0, inserted: 0, duplicates: 0, bad: 0, clockOffsetSeconds: 0 };
    }

    // One batch at a time per machine, so the clock estimate sees a stable history.
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [raw.device_serial]);

    const { lines, bad } = parseAttlog(raw.body);
    const tz = deviceTimezone();
    let offset = 0;

    if (lines.length > 0) {
      const live = lines.length === 1;
      const prev = await c.query(
        `select lag_seconds from punches
          where device_serial = $1 and batch_size = 1 and received_at < $2
          order by received_at desc, id desc limit $3`,
        [raw.device_serial, raw.received_at, live ? CLOCK_WINDOW - 1 : CLOCK_WINDOW],
      );
      const lags = prev.rows.map((r: { lag_seconds: string }) => Number(r.lag_seconds));
      if (live) {
        const cur = await c.query(
          `select round(extract(epoch from ($1::timestamptz - ($2::timestamp at time zone $3::text))))::bigint as lag`,
          [raw.received_at, lines[0]?.time, tz],
        );
        lags.unshift(Number((cur.rows[0] as { lag: string }).lag));
      }
      offset = estimateClockOffset(lags);
    }

    let inserted = 0;
    if (lines.length > 0) {
      const r = await c.query(INSERT_PUNCHES_SQL, [
        raw.id,
        raw.device_serial,
        raw.received_at,
        lines.length,
        offset,
        FUTURE_TOLERANCE_SECONDS,
        LATE_SECONDS,
        lines.map((l) => l.pin),
        lines.map((l) => l.time),
        lines.map((l) => l.status),
        lines.map((l) => l.verify),
        tz,
      ]);
      inserted = r.rowCount ?? 0;
    }

    const result: ProcessResult = {
      kind: 'attlog',
      lines: lines.length,
      inserted,
      duplicates: lines.length - inserted,
      bad: bad.length,
      clockOffsetSeconds: offset,
    };
    await c.query(RECORD_SQL, [raw.id, 'attlog', result.lines, result.inserted, result.duplicates, result.bad, null]);
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    // Remember the failure so the reprocess command retries this raw row.
    await pool
      .query(RECORD_SQL, [rawId, 'attlog', 0, 0, 0, 0, (e as Error).message.slice(0, 500)])
      .catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

// Replay: turns every raw upload that was never processed (or failed) into
// punches, oldest first. This is the "server was down / parser broke" recovery.
export async function reprocessPending(
  pool: pg.Pool,
  opts: { deviceSerial?: string } = {},
): Promise<{ checked: number; processed: number; failed: number; inserted: number }> {
  const pending = await pool.query(
    `select r.id from raw_punches r
       left join processed_raw_punches p on p.raw_punch_id = r.id
      where (p.raw_punch_id is null or p.error is not null)
        and ($1::text is null or r.device_serial = $1)
      order by r.id`,
    [opts.deviceSerial ?? null],
  );
  const summary = { checked: pending.rows.length, processed: 0, failed: 0, inserted: 0 };
  for (const row of pending.rows as { id: string }[]) {
    try {
      const r = await processRawPunch(pool, row.id);
      summary.processed += 1;
      summary.inserted += r?.inserted ?? 0;
    } catch (e) {
      summary.failed += 1;
      console.error(`raw punch ${row.id} failed:`, (e as Error).message);
    }
  }
  return summary;
}