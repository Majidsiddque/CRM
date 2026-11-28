import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { estimateClockOffset, parseAttlog, reprocessPending } from '../src/attendance.js';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});

let api: Server;
let base = '';

const TZ = process.env.DEVICE_TIMEZONE ?? 'Asia/Kolkata';
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});
const stamp = (ms: number) => fmt.format(new Date(ms));
const line = (pin: number | string, ms: number) => `${pin}\t${stamp(ms)}\t0\t1\t0\t0\t0`;
const newSerial = () => `ATT-${randomUUID()}`;
const MIN = 60_000;
const HOUR = 3_600_000;

async function upload(sn: string, body: string, table = 'ATTLOG') {
  const res = await fetch(`${base}/iclock/cdata?SN=${sn}&table=${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  expect(res.status).toBe(200);
}

async function punches(sn: string) {
  const r = await pool.query(
    `select employee_pin, device_time, batch_size, lag_seconds, clock_offset_seconds,
            clock_flag, corrected_time, received_at, device_time_utc
       from punches where device_serial = $1 order by id`,
    [sn],
  );
  return r.rows as {
    employee_pin: string;
    batch_size: number;
    lag_seconds: string;
    clock_offset_seconds: string;
    clock_flag: string;
    corrected_time: Date;
    received_at: Date;
    device_time_utc: Date;
  }[];
}

async function processed(sn: string) {
  const r = await pool.query(
    `select p.kind, p.lines, p.inserted, p.duplicates, p.bad_lines, p.error
       from processed_raw_punches p join raw_punches r on r.id = p.raw_punch_id
      where r.device_serial = $1 order by r.id`,
    [sn],
  );
  return r.rows as { kind: string; lines: number; inserted: number; duplicates: number; bad_lines: number; error: string | null }[];
}

// A device whose clock is `offsetMs` ahead (+) or behind (-), pushing `n` live punches.
async function liveBurst(sn: string, n: number, offsetMs: number, pin = 101) {
  const t0 = Date.now() + offsetMs;
  for (let i = 0; i < n; i++) await upload(sn, line(pin, t0 + i * 1000) + '\n');
}

beforeAll(async () => {
  api = createServer(createApp(pool));
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await pool.end();
});

describe('parseAttlog', () => {
  it('parses tab-separated lines, with LF or CRLF endings', () => {
    const r = parseAttlog(Buffer.from('101\t2026-11-28 09:01:12\t0\t1\t0\r\n102\t2026-11-28 09:02:00\t1\t15\t0\n'));
    expect(r.bad).toHaveLength(0);
    expect(r.lines).toEqual([
      { pin: '101', time: '2026-11-28 09:01:12', status: 0, verify: 1 },
      { pin: '102', time: '2026-11-28 09:02:00', status: 1, verify: 15 },
    ]);
  });

  it('collects bad lines instead of failing the whole batch', () => {
    const r = parseAttlog(Buffer.from('101\t2026-11-28 09:01:12\t0\t1\nnonsense\n102\t2026-13-45 99:99:99\t0\t1\n\t2026-11-28 09:01:12\n'));
    expect(r.lines).toHaveLength(1);
    expect(r.bad).toHaveLength(3);
  });

  it('keeps a missing or non-numeric status as null', () => {
    const r = parseAttlog(Buffer.from('101\t2026-11-28 09:01:12\tabc\n'));
    expect(r.lines[0]).toMatchObject({ status: null, verify: null });
  });
});

describe('estimateClockOffset', () => {
  it('trusts the clock with too little history', () => {
    expect(estimateClockOffset([])).toBe(0);
    expect(estimateClockOffset([5400, 5401])).toBe(0);
  });
  it('ignores small delays', () => {
    expect(estimateClockOffset([1, 2, 3])).toBe(0);
  });
  it('detects a steady slow clock', () => {
    expect(estimateClockOffset([5400, 5402, 5399])).toBe(5400);
  });
  it('detects a steady fast clock', () => {
    expect(estimateClockOffset([-7200, -7201, -7199])).toBe(-7200);
  });
  it('does not mistake backlog (lags that differ) for a clock error', () => {
    expect(estimateClockOffset([10800, 9000, 3600])).toBe(0);
  });
});

describe('same punch received twice is stored once', () => {
  it('ignores an exact re-send of the whole upload', async () => {
    const sn = newSerial();
    const t = Date.now() - 20 * MIN;
    const body = [101, 102, 103].map((p, i) => line(p, t + i * 1000)).join('\n') + '\n';
    await upload(sn, body);
    await upload(sn, body);
    expect(await punches(sn)).toHaveLength(3);
    const p = await processed(sn);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ lines: 3, inserted: 3, duplicates: 0 });
    expect(p[1]).toMatchObject({ lines: 3, inserted: 0, duplicates: 3 });
  });

  it('stores only the new punches when a re-send overlaps', async () => {
    const sn = newSerial();
    const t = Date.now() - 30 * MIN;
    const first = [0, 1, 2].map((i) => line(101, t + i * 60_000));
    const second = [0, 1, 2, 3, 4].map((i) => line(101, t + i * 60_000));
    await upload(sn, first.join('\n') + '\n');
    await upload(sn, second.join('\n') + '\n');
    expect(await punches(sn)).toHaveLength(5);
    expect((await processed(sn))[1]).toMatchObject({ inserted: 2, duplicates: 3 });
  });

  it('treats a repeated line inside one upload as one punch', async () => {
    const sn = newSerial();
    const l = line(101, Date.now() - 15 * MIN);
    await upload(sn, `${l}\n${l}\n`);
    expect(await punches(sn)).toHaveLength(1);
  });

  it('keeps different people at the same second, and the same person at different times', async () => {
    const sn = newSerial();
    const t = Date.now() - 40 * MIN;
    await upload(sn, [line(101, t), line(102, t), line(101, t + 1000)].join('\n') + '\n');
    expect(await punches(sn)).toHaveLength(3);
  });

  it('keeps the same pin and time on two different machines', async () => {
    const a = newSerial();
    const b = newSerial();
    const l = line(101, Date.now() - 25 * MIN) + '\n';
    await upload(a, l);
    await upload(b, l);
    expect(await punches(a)).toHaveLength(1);
    expect(await punches(b)).toHaveLength(1);
  });

  it('still saves every raw delivery untouched', async () => {
    const sn = newSerial();
    const body = line(101, Date.now() - 12 * MIN) + '\n';
    await upload(sn, body);
    await upload(sn, body);
    const r = await pool.query('select count(*)::int as n from raw_punches where device_serial = $1', [sn]);
    expect((r.rows[0] as { n: number }).n).toBe(2);
  });
});

describe('wrong machine clock', () => {
  it('flags a punch dated in the future', async () => {
    const sn = newSerial();
    await upload(sn, line(101, Date.now() + 2 * HOUR) + '\n');
    const [p] = await punches(sn);
    expect(p?.clock_flag).toBe('future');
    expect(Number(p?.lag_seconds)).toBeLessThan(-7000);
  });

  it('works out a slow clock from live punches and corrects later punches', async () => {
    const sn = newSerial();
    await liveBurst(sn, 4, -90 * MIN);
    const rows = await punches(sn);
    expect(rows).toHaveLength(4);
    // first two: not enough history yet, so just marked late
    expect(rows[0]?.clock_flag).toBe('late');
    expect(rows[1]?.clock_flag).toBe('late');
    // from the third live punch the steady 90-minute error is recognised
    for (const p of rows.slice(2)) {
      expect(p.clock_flag).toBe('corrected');
      expect(Number(p.clock_offset_seconds)).toBeGreaterThan(5300);
      const err = Math.abs(p.corrected_time.getTime() - p.received_at.getTime());
      expect(err).toBeLessThan(15_000);
    }
  });

  it('works out a fast clock the same way', async () => {
    const sn = newSerial();
    await liveBurst(sn, 4, 2 * HOUR);
    const rows = await punches(sn);
    for (const p of rows.slice(2)) {
      expect(p.clock_flag).toBe('corrected');
      expect(Number(p.clock_offset_seconds)).toBeLessThan(-7100);
    }
  });

  it('leaves a correct clock alone', async () => {
    const sn = newSerial();
    await liveBurst(sn, 4, 0);
    for (const p of await punches(sn)) {
      expect(p.clock_flag).toBe('ok');
      expect(Number(p.clock_offset_seconds)).toBe(0);
    }
  });

  it('does not mistake an outage backlog for a wrong clock', async () => {
    const sn = newSerial();
    await liveBurst(sn, 3, 0);
    const start = Date.now() - 5 * HOUR;
    const backlog = Array.from({ length: 30 }, (_, i) => line(200 + (i % 4), start + i * 5 * MIN));
    await upload(sn, backlog.join('\n') + '\n');
    const old = (await punches(sn)).filter((p) => p.batch_size === 30);
    expect(old).toHaveLength(30);
    for (const p of old) {
      expect(p.clock_flag).toBe('late');
      expect(Number(p.clock_offset_seconds)).toBe(0);
      expect(p.corrected_time.getTime()).toBe(p.device_time_utc.getTime());
    }
  });

  it('corrects a backlog from a machine whose clock is also wrong', async () => {
    const sn = newSerial();
    await liveBurst(sn, 3, -90 * MIN);
    const start = Date.now() - 90 * MIN - 5 * HOUR; // on the machine's (slow) clock
    const backlog = Array.from({ length: 10 }, (_, i) => line(300 + i, start + i * 5 * MIN));
    await upload(sn, backlog.join('\n') + '\n');
    const old = (await punches(sn)).filter((p) => p.batch_size === 10);
    expect(old).toHaveLength(10);
    for (const p of old) {
      expect(p.clock_flag).toBe('corrected');
      expect(Number(p.clock_offset_seconds)).toBeGreaterThan(5300);
    }
  });
});

describe('replay after an outage', () => {
  it('turns unprocessed raw uploads into punches, and only once', async () => {
    const sn = newSerial();
    const body = [101, 102].map((p, i) => line(p, Date.now() - 50 * MIN + i * 1000)).join('\n') + '\n';
    // Simulate "the raw copy was saved but processing never happened".
    await pool.query(
      `insert into raw_punches (device_serial, method, url, source_ip, headers, body)
       values ($1, 'POST', $2, '127.0.0.1', '{}'::jsonb, $3)`,
      [sn, `/iclock/cdata?SN=${sn}&table=ATTLOG`, Buffer.from(body)],
    );
    expect(await punches(sn)).toHaveLength(0);

    const first = await reprocessPending(pool, { deviceSerial: sn });
    expect(first).toMatchObject({ checked: 1, processed: 1, failed: 0, inserted: 2 });
    expect(await punches(sn)).toHaveLength(2);

    const second = await reprocessPending(pool, { deviceSerial: sn });
    expect(second.checked).toBe(0);
    expect(await punches(sn)).toHaveLength(2);
  });

  it('retries a raw upload whose earlier processing recorded an error', async () => {
    const sn = newSerial();
    const body = line(101, Date.now() - 45 * MIN) + '\n';
    const saved = await pool.query(
      `insert into raw_punches (device_serial, method, url, source_ip, headers, body)
       values ($1, 'POST', $2, '127.0.0.1', '{}'::jsonb, $3) returning id`,
      [sn, `/iclock/cdata?SN=${sn}&table=ATTLOG`, Buffer.from(body)],
    );
    const id = (saved.rows[0] as { id: string }).id;
    await pool.query(
      `insert into processed_raw_punches (raw_punch_id, kind, error) values ($1, 'attlog', 'simulated failure')`,
      [id],
    );
    const r = await reprocessPending(pool, { deviceSerial: sn });
    expect(r).toMatchObject({ checked: 1, processed: 1, inserted: 1 });
    expect((await processed(sn))[0]?.error).toBeNull();
  });

  it('a machine backlog sent twice after an outage still gives one copy of each punch', async () => {
    const sn = newSerial();
    const start = Date.now() - 4 * HOUR;
    const body = Array.from({ length: 20 }, (_, i) => line(101 + (i % 3), start + i * 4 * MIN)).join('\n') + '\n';
    await upload(sn, body);
    await upload(sn, body);
    expect(await punches(sn)).toHaveLength(20);
  });
});

describe('other uploads', () => {
  it('skips tables that are not punches (e.g. OPERLOG)', async () => {
    const sn = newSerial();
    await upload(sn, 'OPLOG 4\t0\t2026-11-28 09:00:00\t0\t0\t0\t0\n', 'OPERLOG');
    expect(await punches(sn)).toHaveLength(0);
    expect((await processed(sn))[0]?.kind).toBe('skipped');
  });

  it('still answers OK for garbage, and counts the bad lines', async () => {
    const sn = newSerial();
    await upload(sn, 'garbage\nmore garbage\n');
    expect(await punches(sn)).toHaveLength(0);
    expect((await processed(sn))[0]).toMatchObject({ kind: 'attlog', lines: 0, bad_lines: 2 });
  });
});