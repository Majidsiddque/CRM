import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});
let api: Server;
let s3: Server;
let base = '';
let s3Base = '';
const objects = new Map<string, Buffer>();
let rejectNextPut = false;
const oldEnv = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  access: process.env.S3_ACCESS_KEY_ID,
  secret: process.env.S3_SECRET_ACCESS_KEY,
  ops: process.env.OPS_TOKEN,
  limit: process.env.STORAGE_LIMIT_BYTES,
};
const token = 'storage-test-ops-token';

beforeAll(async () => {
  s3 = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        if (rejectNextPut) {
          rejectNextPut = false;
          res.writeHead(503).end('temporarily unavailable');
          return;
        }
        objects.set(path, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === 'GET') {
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const date = query.get('X-Amz-Date') ?? '';
      const expires = Number(query.get('X-Amz-Expires') ?? 0);
      const issued = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
      if (!issued || Date.now() > issued + expires * 1000) {
        res.writeHead(403).end('expired');
        return;
      }
      const value = objects.get(path);
      if (!value) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'video/mp4' }).end(value);
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => s3.listen(0, '127.0.0.1', resolve));
  s3Base = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
  process.env.S3_ENDPOINT = s3Base;
  process.env.S3_BUCKET = 'crm-videos';
  process.env.S3_REGION = 'ap-south-1';
  process.env.S3_ACCESS_KEY_ID = 'test-access';
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret';
  process.env.OPS_TOKEN = token;
  api = createServer(createApp(pool));
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => s3.close(() => resolve()));
  await pool.end();
  for (const [name, value] of Object.entries(oldEnv)) {
    const key = { endpoint: 'S3_ENDPOINT', bucket: 'S3_BUCKET', region: 'S3_REGION', access: 'S3_ACCESS_KEY_ID', secret: 'S3_SECRET_ACCESS_KEY', ops: 'OPS_TOKEN', limit: 'STORAGE_LIMIT_BYTES' }[name as keyof typeof oldEnv];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function usedBytes() {
  const result = await pool.query('select used_bytes from storage_usage where id=1');
  return Number(result.rows[0]?.used_bytes ?? 0);
}

describe('video storage experiment', () => {
  it('rejects upload and playback-link minting without the ops token', async () => {
    const upload = await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: new Uint8Array([1]) });
    expect(upload.status).toBe(401);
    const play = await fetch(`${base}/api/videos/not-a-real-id/play`);
    expect(play.status).toBe(401);
  });

  it('uploads within quota, rejects the next upload, and serves an expiring signed link', async () => {
    const startingUsage = await usedBytes();
    const body = new Uint8Array([0, 1, 2, 3, 4, 5]);
    process.env.STORAGE_LIMIT_BYTES = String(startingUsage + body.byteLength);
    try {
      const response = await fetch(`${base}/api/videos`, {
        method: 'POST', headers: { 'content-type': 'video/mp4', 'x-ops-token': token }, body,
      });
      expect(response.status).toBe(201);
      const saved = await response.json() as { id: string; key: string; playUrl: string; expiresInSeconds: number };
      expect(saved.expiresInSeconds).toBe(300);
      const direct = new URL(saved.playUrl);
      expect(direct.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(direct.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);

      const denied = await fetch(`${base}/api/videos`, {
        method: 'POST', headers: { 'content-type': 'video/mp4', 'x-ops-token': token }, body: new Uint8Array([7]),
      });
      expect(denied.status).toBe(413);
      expect(await usedBytes()).toBe(startingUsage + body.byteLength);

      const minted = await fetch(`${base}/api/videos/${saved.id}/play`, { headers: { 'x-ops-token': token } });
      expect(minted.status).toBe(200);
      const play = await minted.json() as { url: string; expiresInSeconds: number };
      expect(play.expiresInSeconds).toBe(300);
      const played = await fetch(play.url);
      expect(played.status).toBe(200);
      expect(Buffer.from(await played.arrayBuffer())).toEqual(Buffer.from(body));

      const expired = new URL(play.url);
      const old = new Date(Date.now() - 10 * 60_000).toISOString().replace(/[:-]|\.\d{3}/g, '');
      expired.searchParams.set('X-Amz-Date', old);
      expect((await fetch(expired)).status).toBe(403);
    } finally {
      await pool.query('update storage_usage set used_bytes=$1 where id=1', [startingUsage]);
      if (oldEnv.limit === undefined) delete process.env.STORAGE_LIMIT_BYTES; else process.env.STORAGE_LIMIT_BYTES = oldEnv.limit;
    }
  });

  it('does not count an object when storage rejects the upload', async () => {
    const startingUsage = await usedBytes();
    process.env.STORAGE_LIMIT_BYTES = String(startingUsage + 10);
    rejectNextPut = true;
    try {
      const response = await fetch(`${base}/api/videos`, {
        method: 'POST', headers: { 'content-type': 'video/mp4', 'x-ops-token': token }, body: new Uint8Array([1, 2, 3]),
      });
      expect(response.status).toBe(500);
      expect(await usedBytes()).toBe(startingUsage);
    } finally {
      if (oldEnv.limit === undefined) delete process.env.STORAGE_LIMIT_BYTES; else process.env.STORAGE_LIMIT_BYTES = oldEnv.limit;
    }
  });
});