import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});
const sharedTables = ['raw_punches', 'punches', 'processed_raw_punches', 'storage_usage', 'video_objects', 'jobs', 'failed_jobs'];
const oldOpsToken = process.env.OPS_TOKEN;
let api: Server;
let base = '';

beforeAll(async () => {
  process.env.OPS_TOKEN = 'experiment-isolation-test-token';
  api = createServer(createApp(pool));
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await pool.end();
  if (oldOpsToken === undefined) delete process.env.OPS_TOKEN;
  else process.env.OPS_TOKEN = oldOpsToken;
});

describe('attendance, storage, and job tables in institute isolation', () => {
  it('classifies raw punches, videos, and queue ledgers as shared operational tables', async () => {
    const result = await pool.query(
      `select table_name from information_schema.tables where table_schema='public' and table_name = any($1::text[])`,
      [sharedTables],
    );
    expect(result.rows.map((row: { table_name: string }) => row.table_name).sort()).toEqual([...sharedTables].sort());
    const scoped = await pool.query(
      `select table_name from information_schema.columns where table_schema='public' and column_name='institute_id' and table_name = any($1::text[])`,
      [sharedTables],
    );
    expect(scoped.rowCount).toBe(0);
  });

  it('keeps global job and video operations behind the ops token', async () => {
    const requests = [
      fetch(`${base}/api/jobs/failed`),
      fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'any', payload: {} }) }),
      fetch(`${base}/api/jobs/failed/00000000-0000-0000-0000-000000000001/replay`, { method: 'POST' }),
      fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: new Uint8Array([1]) }),
      fetch(`${base}/api/videos/00000000-0000-0000-0000-000000000001/play`),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
  });
});