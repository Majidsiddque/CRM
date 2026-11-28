import type pg from 'pg';

export type JobHandler = (payload: unknown) => Promise<void>;
const handlers = new Map<string, JobHandler>();
export const registerJob = (kind: string, handler: JobHandler) => handlers.set(kind, handler);

export async function enqueueJob(pool: pg.Pool, kind: string, payload: unknown) {
  const r = await pool.query(
    `insert into jobs (kind, payload) values ($1, $2::jsonb) returning id, kind, payload, status, attempts, run_at`,
    [kind, JSON.stringify(payload)],
  );
  return r.rows[0];
}

export async function runOneJob(pool: pg.Pool, kind?: string): Promise<boolean> {
  const c = await pool.connect();
  let job: { id: string; kind: string; payload: unknown; attempts: number } | undefined;
  try {
    await c.query('begin');
    const r = await c.query(
      `select id, kind, payload, attempts from jobs where status = 'queued' and run_at <= now() and ($1::text is null or kind = $1) order by run_at, created_at for update skip locked limit 1`,
      [kind ?? null],
    );
    job = r.rows[0] as typeof job;
    if (!job) { await c.query('commit'); return false; }
    await c.query("update jobs set status='running', attempts=attempts+1, updated_at=now() where id=$1", [job.id]);
    await c.query('commit');
  } finally { c.release(); }
  try {
    const handler = handlers.get(job.kind);
    if (!handler) throw new Error(`No handler registered for job kind: ${job.kind}`);
    await handler(job.payload);
    await pool.query("update jobs set status='succeeded', updated_at=now(), last_error=null where id=$1", [job.id]);
  } catch (e) {
    const message = (e as Error).message.slice(0, 2000);
    const attempts = job.attempts + 1;
    const limit = Number(process.env.JOB_MAX_ATTEMPTS ?? 5);
    if (attempts >= limit) {
      await pool.query("update jobs set status='failed', updated_at=now(), last_error=$2 where id=$1", [job.id, message]);
      await pool.query('insert into failed_jobs (job_id, kind, payload, attempts, error) values ($1,$2,$3::jsonb,$4,$5) on conflict (job_id) do update set attempts=excluded.attempts,error=excluded.error,failed_at=now()', [job.id, job.kind, JSON.stringify(job.payload), attempts, message]);
    } else {
      const delay = Math.min(3600, 5 * 2 ** (attempts - 1));
      await pool.query("update jobs set status='queued', run_at=now()+($2::text || ' seconds')::interval, updated_at=now(), last_error=$3 where id=$1", [job.id, delay, message]);
    }
  }
  return true;
}

export function startJobWorker(pool: pg.Pool) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try { if (!(await runOneJob(pool))) await new Promise((resolve) => setTimeout(resolve, 1000)); }
      catch (e) { console.error('job worker error:', (e as Error).message); await new Promise((resolve) => setTimeout(resolve, 1000)); }
    }
  };
  void loop();
  return () => { stopped = true; };
}
