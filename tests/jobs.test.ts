import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { enqueueJob, registerJob, runOneJob } from '../src/jobs.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});
let api: Server;
let base = '';
const opsToken = 'jobs-test-ops-token';
const oldToken = process.env.OPS_TOKEN;
const oldLimit = process.env.JOB_MAX_ATTEMPTS;

beforeAll(async () => {
  process.env.OPS_TOKEN = opsToken;
  process.env.JOB_MAX_ATTEMPTS = '3';
  api = createServer(createApp(pool));
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await pool.end();
  if (oldToken === undefined) delete process.env.OPS_TOKEN; else process.env.OPS_TOKEN = oldToken;
  if (oldLimit === undefined) delete process.env.JOB_MAX_ATTEMPTS; else process.env.JOB_MAX_ATTEMPTS = oldLimit;
});

describe('background job queue', () => {
  it('applies growing retry delays, records final failure, and protects replay controls', async () => {
    const kind = `retry-${randomUUID()}`;
    registerJob(kind, async () => { throw new Error('intentional test failure'); });
    const job = await enqueueJob(pool, kind, { test: true }) as { id: string };

    expect(await runOneJob(pool, kind)).toBe(true);
    let row = (await pool.query('select status, attempts, run_at from jobs where id=$1', [job.id])).rows[0] as { status: string; attempts: number; run_at: Date };
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(new Date(row.run_at).getTime() - Date.now()).toBeGreaterThan(3500);
    expect(new Date(row.run_at).getTime() - Date.now()).toBeLessThan(6500);

    await pool.query('update jobs set run_at=now() where id=$1', [job.id]);
    expect(await runOneJob(pool, kind)).toBe(true);
    row = (await pool.query('select status, attempts, run_at from jobs where id=$1', [job.id])).rows[0] as typeof row;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(2);
    expect(new Date(row.run_at).getTime() - Date.now()).toBeGreaterThan(8500);
    expect(new Date(row.run_at).getTime() - Date.now()).toBeLessThan(11500);

    await pool.query('update jobs set run_at=now() where id=$1', [job.id]);
    expect(await runOneJob(pool, kind)).toBe(true);
    row = (await pool.query('select status, attempts from jobs where id=$1', [job.id])).rows[0] as { status: string; attempts: number };
    expect(row).toEqual({ status: 'failed', attempts: 3 });
    const failed = await pool.query('select job_id, attempts, error from failed_jobs where job_id=$1', [job.id]);
    expect(failed.rows[0]).toMatchObject({ job_id: job.id, attempts: 3, error: 'intentional test failure' });

    expect((await fetch(`${base}/api/jobs/failed`)).status).toBe(401);
    const headers = { 'x-ops-token': opsToken };
    const listed = await fetch(`${base}/api/jobs/failed`, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { rows: Array<{ job_id: string }> }).rows.some((item) => item.job_id === job.id)).toBe(true);

    const replay = await fetch(`${base}/api/jobs/failed/${job.id}/replay`, { method: 'POST', headers });
    expect(replay.status).toBe(200);
    const replayed = await pool.query('select status, attempts from jobs where id=$1', [job.id]);
    expect(replayed.rows[0]).toEqual({ status: 'queued', attempts: 0 });
    const marker = await pool.query('select replayed_at from failed_jobs where job_id=$1', [job.id]);
    expect(marker.rows[0].replayed_at).toBeInstanceOf(Date);
  });

  it('runs a registered job successfully', async () => {
    const kind = `success-${randomUUID()}`;
    let received: unknown;
    registerJob(kind, async (payload) => { received = payload; });
    const job = await enqueueJob(pool, kind, { hello: 'world' }) as { id: string };
    expect(await runOneJob(pool, kind)).toBe(true);
    expect(received).toEqual({ hello: 'world' });
    const result = await pool.query('select status, attempts from jobs where id=$1', [job.id]);
    expect(result.rows[0]).toEqual({ status: 'succeeded', attempts: 1 });
  });
});