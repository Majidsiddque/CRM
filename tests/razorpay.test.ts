import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const SECRET = 'test_webhook_secret';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});

let api: Server;
let base = '';
let fake: Server;
let lastFakeRequest: { auth?: string | undefined; body?: Record<string, unknown> } = {};

const sign = (raw: string, secret = SECRET) =>
  createHmac('sha256', secret).update(raw).digest('hex');

function paidEvent(paymentId: string, institute = A, amount = 50000) {
  return JSON.stringify({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: 'plink_test123', notes: { institute_id: institute } } },
      payment: { entity: { id: paymentId, amount, currency: 'INR', status: 'captured' } },
    },
  });
}

function post(raw: string, headers: Record<string, string>) {
  return fetch(`${base}/api/razorpay/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw,
  });
}

async function countPayments(institute: string, paymentId: string) {
  const r = await fetch(`${base}/api/payments?institute=${institute}`);
  const d = (await r.json()) as { rows: { razorpay_payment_id: string }[] };
  return d.rows.filter((x) => x.razorpay_payment_id === paymentId).length;
}

beforeAll(async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
  process.env.RAZORPAY_KEY_SECRET = 'secret';

  // A stand-in for api.razorpay.com so tests need no internet or real keys.
  fake = createServer((req, res) => {
    let data = '';
    req.on('data', (d: Buffer) => (data += d.toString()));
    req.on('end', () => {
      lastFakeRequest = {
        auth: req.headers.authorization,
        body: JSON.parse(data || '{}') as Record<string, unknown>,
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'plink_test123',
          short_url: 'https://rzp.io/rzp/testlink',
          amount: 50000,
          currency: 'INR',
          status: 'created',
        }),
      );
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  api = createApp(pool).listen(0, '127.0.0.1');
  await new Promise<void>((r) => api.once('listening', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => api.close(r));
  await new Promise((r) => fake.close(r));
  await pool.end();
});

describe('creating a test-mode payment link', () => {
  it('calls Razorpay with test credentials and the institute in the notes', async () => {
    const res = await fetch(`${base}/api/payment-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ institute_id: A, amount_paise: 50000, description: 'Fee' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ short_url: 'https://rzp.io/rzp/testlink' });
    expect(lastFakeRequest.auth).toBe('Basic ' + Buffer.from('rzp_test_abc:secret').toString('base64'));
    expect(lastFakeRequest.body).toMatchObject({
      amount: 50000,
      currency: 'INR',
      notes: { institute_id: A },
    });
  });

  it('refuses live keys', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_abc';
    try {
      const res = await fetch(`${base}/api/payment-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ institute_id: A, amount_paise: 50000 }),
      });
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).toContain('test-mode');
    } finally {
      process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    }
  });

  it('rejects a bad institute id or amount', async () => {
    for (const body of [
      { institute_id: 'nope', amount_paise: 50000 },
      { institute_id: A, amount_paise: 5 },
    ]) {
      const res = await fetch(`${base}/api/payment-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('webhook signature check', () => {
  it('rejects a missing signature', async () => {
    const id = 'pay_' + randomUUID();
    expect((await post(paidEvent(id), {})).status).toBe(401);
    expect(await countPayments(A, id)).toBe(0);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const id = 'pay_' + randomUUID();
    const raw = paidEvent(id);
    expect((await post(raw, { 'X-Razorpay-Signature': sign(raw, 'wrong') })).status).toBe(401);
    expect(await countPayments(A, id)).toBe(0);
  });

  it('rejects a body changed after signing', async () => {
    const id = 'pay_' + randomUUID();
    const signed = sign(paidEvent(id, A, 50000));
    const tampered = paidEvent(id, A, 1);
    expect((await post(tampered, { 'X-Razorpay-Signature': signed })).status).toBe(401);
    expect(await countPayments(A, id)).toBe(0);
  });
});

describe('recording payments', () => {
  it('records a validly signed payment', async () => {
    const id = 'pay_' + randomUUID();
    const raw = paidEvent(id);
    const res = await post(raw, {
      'X-Razorpay-Signature': sign(raw),
      'X-Razorpay-Event-Id': 'evt_' + randomUUID(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'recorded' });
    expect(await countPayments(A, id)).toBe(1);
  });

  it('records only ONE payment when the same confirmation is sent twice', async () => {
    const id = 'pay_' + randomUUID();
    const eventId = 'evt_' + randomUUID();
    const raw = paidEvent(id);
    const headers = { 'X-Razorpay-Signature': sign(raw), 'X-Razorpay-Event-Id': eventId };

    const first = await post(raw, headers);
    const second = await post(raw, headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // acknowledged so Razorpay stops retrying
    expect(await first.json()).toMatchObject({ status: 'recorded' });
    expect(await second.json()).toMatchObject({ status: 'duplicate' });
    expect(await countPayments(A, id)).toBe(1);
  });

  it('still records ONE payment when a re-delivery carries a new event id', async () => {
    const id = 'pay_' + randomUUID();
    const raw = paidEvent(id);
    for (let i = 0; i < 2; i++) {
      await post(raw, {
        'X-Razorpay-Signature': sign(raw),
        'X-Razorpay-Event-Id': 'evt_' + randomUUID(),
      });
    }
    expect(await countPayments(A, id)).toBe(1);
  });

  it('records ONE payment when 8 identical confirmations arrive at the same moment', async () => {
    const id = 'pay_' + randomUUID();
    const raw = paidEvent(id);
    const headers = { 'X-Razorpay-Signature': sign(raw), 'X-Razorpay-Event-Id': 'evt_' + randomUUID() };
    const results = await Promise.all(Array.from({ length: 8 }, () => post(raw, headers)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await countPayments(A, id)).toBe(1);
  });

  it('acknowledges but ignores other event types', async () => {
    const raw = JSON.stringify({ event: 'payment.failed', payload: {} });
    const res = await post(raw, { 'X-Razorpay-Signature': sign(raw) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored' });
  });

  it('keeps payments separated by institute', async () => {
    const id = 'pay_' + randomUUID();
    const raw = paidEvent(id, B);
    await post(raw, { 'X-Razorpay-Signature': sign(raw) });
    expect(await countPayments(B, id)).toBe(1);
    expect(await countPayments(A, id)).toBe(0);
  });
});
