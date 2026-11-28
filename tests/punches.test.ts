import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});

let api: Server;
let base = '';

// raw_punches is append-only for app_user, so each test uses its own serial.
const newSerial = () => `TEST-${randomUUID()}`;

async function rowsFor(serial: string) {
  const r = await pool.query(
    'select * from raw_punches where device_serial = $1 order by id',
    [serial],
  );
  return r.rows as {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Buffer;
    received_at: Date;
  }[];
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

describe('attendance machine: raw punch intake', () => {
  it('stores the exact bytes sent and answers OK', async () => {
    const sn = newSerial();
    const body = '101\t2026-11-28 09:01:12\t0\t1\t0\t0\t0\n102\t2026-11-28 09:01:40\t0\t1\t0\t0\t0\n';
    const res = await fetch(`${base}/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');

    const rows = await rowsFor(sn);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body.toString('utf8')).toBe(body);
    expect(rows[0]?.method).toBe('POST');
    expect(rows[0]?.url).toContain('table=ATTLOG');
    expect(rows[0]?.headers['content-type']).toBe('text/plain');
    expect(rows[0]?.received_at).toBeInstanceOf(Date);
  });

  it('keeps odd bytes untouched (not valid UTF-8, CRLF, no trailing newline)', async () => {
    const sn = newSerial();
    const body = Buffer.from([0xff, 0xfe, 0x00, 0x09, 0x41, 0x0d, 0x0a, 0x80]);
    const res = await fetch(`${base}/iclock/cdata?SN=${sn}&table=ATTLOG`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    expect(res.status).toBe(200);
    const rows = await rowsFor(sn);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body.equals(body)).toBe(true);
  });

  it('accepts the generic /machine/punches route with a JSON body and header serial', async () => {
    const sn = newSerial();
    const body = '{"employee":"101","time":"2026-11-28T09:01:12+05:30"}';
    const res = await fetch(`${base}/machine/punches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Serial': sn },
      body,
    });
    expect(res.status).toBe(200);
    const rows = await rowsFor(sn);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body.toString('utf8')).toBe(body);
  });

  it('stores an empty body too', async () => {
    const sn = newSerial();
    const res = await fetch(`${base}/iclock/cdata?SN=${sn}&table=ATTLOG`, { method: 'POST' });
    expect(res.status).toBe(200);
    const rows = await rowsFor(sn);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body.length).toBe(0);
  });

  it('stores every delivery as its own row (dedupe comes in step 2)', async () => {
    const sn = newSerial();
    for (let i = 0; i < 2; i++) {
      await fetch(`${base}/iclock/cdata?SN=${sn}&table=ATTLOG`, {
        method: 'POST',
        body: '101\t2026-11-28 09:01:12\t0\t1\t0\t0\t0\n',
      });
    }
    expect(await rowsFor(sn)).toHaveLength(2);
  });

  it('answers the handshake with settings and the serial', async () => {
    const res = await fetch(`${base}/iclock/cdata?SN=HS-123&options=all`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('GET OPTION FROM: HS-123');
    expect(text).toContain('Realtime=1');
  });

  it('answers the command poll with OK', async () => {
    const res = await fetch(`${base}/iclock/getrequest?SN=HS-123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });
});