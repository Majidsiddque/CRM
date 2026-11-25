import express from 'express';
import type { Express } from 'express';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { createTestPaymentLink, verifyWebhookSignature } from './razorpay.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WebhookPayload {
  event?: string;
  payload?: {
    payment_link?: { entity?: { id?: string; notes?: Record<string, string> } };
    payment?: {
      entity?: { id?: string; amount?: number; currency?: string; status?: string };
    };
  };
}

export function createApp(pool: pg.Pool): Express {
  async function asInstitute<T>(id: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.institute_id', $1, true)", [id]);
      return await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }

  const app = express();

  // Razorpay webhook. Must be registered BEFORE any JSON parser: the signature
  // is computed over the exact bytes Razorpay sent, so we need the raw body.
  app.post(
    '/api/razorpay/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
      if (!secret) {
        res.status(500).json({ error: 'webhook secret not configured' });
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.header('x-razorpay-signature');
      if (!verifyWebhookSignature(raw, sig, secret)) {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }

      let body: WebhookPayload;
      try {
        body = JSON.parse(raw.toString('utf8')) as WebhookPayload;
      } catch {
        res.status(400).json({ error: 'invalid JSON' });
        return;
      }

      // Only successful payment-link payments are recorded. Anything else is
      // acknowledged (2xx) so Razorpay does not keep retrying it.
      if (body.event !== 'payment_link.paid') {
        res.json({ status: 'ignored', event: body.event ?? null });
        return;
      }

      const link = body.payload?.payment_link?.entity;
      const pay = body.payload?.payment?.entity;
      const instituteId = link?.notes?.institute_id ?? '';
      if (!pay?.id || !pay.amount || !UUID.test(instituteId)) {
        res.status(400).json({ error: 'payload missing payment id, amount or institute' });
        return;
      }

      // Razorpay's per-delivery id; fall back to the payment id so a missing
      // header still dedupes correctly.
      const eventId = req.header('x-razorpay-event-id') ?? `payment:${pay.id}`;

      try {
        const result = await asInstitute(instituteId, async (c) => {
          const seen = await c.query(
            'insert into webhook_events (event_id) values ($1) on conflict do nothing',
            [eventId],
          );
          const inserted = await c.query(
            `insert into payments
               (institute_id, razorpay_payment_id, razorpay_payment_link_id,
                amount_paise, currency, status)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (razorpay_payment_id) do nothing`,
            [instituteId, pay.id, link?.id ?? null, pay.amount, pay.currency ?? 'INR', pay.status ?? 'captured'],
          );
          await c.query('commit');
          return { newEvent: seen.rowCount === 1, newPayment: inserted.rowCount === 1 };
        });
        res.json({
          status: result.newPayment ? 'recorded' : 'duplicate',
          newEvent: result.newEvent,
        });
      } catch (e) {
        // 500 makes Razorpay retry later, which is what we want for a DB hiccup.
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  app.use(express.static('public'));

  app.get('/health', (_req, res) => res.json({ status: 'running' }));

  app.get('/api/people', async (req, res) => {
    const inst = String(req.query.institute ?? '');
    try {
      const out = await asInstitute(inst, async (c) => {
        const total = await c.query('select count(*)::int as n from people');
        const rows = await c.query(
          'select name, email, institute_id from people order by id limit 10',
        );
        return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Create a TEST-mode Razorpay payment link for an institute.
  app.post('/api/payment-links', express.json(), async (req, res) => {
    const { institute_id: inst, amount_paise: amount, description } = (req.body ?? {}) as {
      institute_id?: string;
      amount_paise?: number;
      description?: string;
    };
    if (!inst || !UUID.test(inst)) {
      res.status(400).json({ error: 'institute_id must be a UUID' });
      return;
    }
    if (!Number.isInteger(amount) || (amount as number) < 100) {
      res.status(400).json({ error: 'amount_paise must be an integer >= 100' });
      return;
    }
    try {
      const link = await createTestPaymentLink({
        instituteId: inst,
        amountPaise: amount as number,
        description: description ?? 'Test payment',
      });
      res.status(201).json({ id: link.id, short_url: link.short_url, status: link.status });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.get('/api/payments', async (req, res) => {
    const inst = String(req.query.institute ?? '');
    try {
      const rows = await asInstitute(inst, async (c) => {
        const r = await c.query(
          'select razorpay_payment_id, amount_paise, currency, status, created_at from payments order by created_at',
        );
        return r.rows;
      });
      res.json({ total: rows.length, rows });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  const attacks: Record<string, string> = {
    read: 'select id from people where institute_id = $1',
    update: "update people set name = 'hacked' where institute_id = $1",
    delete: 'delete from people where institute_id = $1',
    insert: "insert into people (institute_id, name) values ($1, 'intruder')",
  };

  app.post('/api/attack', express.json(), async (req, res) => {
    const { as, target, action } = (req.body ?? {}) as Record<string, string>;
    const sql = attacks[action ?? ''];
    if (!sql) {
      res.status(400).json({ error: 'unknown action' });
      return;
    }
    try {
      const rowCount = await asInstitute(as ?? '', async (c) => {
        const r = await c.query(sql, [target]);
        return r.rowCount;
      });
      res.json({ result: `allowed, ${rowCount} rows affected` });
    } catch (e) {
      res.json({ result: `blocked: ${(e as Error).message}` });
    }
  });

  return app;
}
