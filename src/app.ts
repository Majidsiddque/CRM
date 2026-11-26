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
  app.use(express.json());

  // Root route serves the CRM app
  app.get('/', (_req, res) => res.sendFile('crm.html', { root: 'public' }));

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
  app.post('/api/payment-links', async (req, res) => {
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

  // Helper to get institute ID from header
  function getInstituteId(req: express.Request): string {
    const id = req.header('x-institute-id') ?? '';
    if (!UUID.test(id)) {
      throw new Error('x-institute-id header must be a valid UUID');
    }
    return id;
  }

  // Dashboard summary
  app.get('/api/dashboard', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const summary = await asInstitute(inst, async (c) => {
        const stats = await c.query(`
          select
            (select count(*)::int from students) as total_students,
            (select count(*)::int from students where status = 'Active') as active_students,
            (select count(*)::int from students where status = 'Pending') as pending_students,
            (select count(*)::int from students where status = 'Inactive') as inactive_students,
            (select count(*)::int from enquiries) as total_enquiries
        `);
        
        const monthlyAdmissions = await c.query(`
          select 
            extract(month from joined)::int as month,
            count(*)::int as count
          from students
          where extract(year from joined) = extract(year from current_date)
          group by month
          order by month
        `);

        const feesCollected = await c.query(`
          select count(*)::int * 21000 as fees
          from students
          where status = 'Active'
        `);

        return {
          ...stats.rows[0],
          fees_collected: feesCollected.rows[0]?.fees ?? 0,
          admissions_by_month: monthlyAdmissions.rows,
        };
      });
      res.json(summary);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // List students with filters, search, sort, and pagination
  app.get('/api/students', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const search = String(req.query.search ?? '').toLowerCase();
      const status = String(req.query.status ?? '');
      const sortBy = String(req.query.sortBy ?? 'joined');
      const sortOrder = String(req.query.sortOrder ?? 'desc');
      const page = Math.max(0, parseInt(String(req.query.page ?? '0'), 10));
      const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '8'), 10)));

      const allowedSortFields = ['name', 'city', 'course', 'status', 'joined'];
      const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'joined';
      const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

      const result = await asInstitute(inst, async (c) => {
        let whereClause = 'WHERE true';
        const params: (string | number)[] = [];
        let paramCount = 0;

        if (search) {
          paramCount++;
          whereClause += ` AND (LOWER(name) LIKE $${paramCount} OR LOWER(city) LIKE $${paramCount} OR LOWER(course) LIKE $${paramCount})`;
          params.push(`%${search}%`);
        }

        if (status) {
          paramCount++;
          whereClause += ` AND status = $${paramCount}`;
          params.push(status);
        }

        const countResult = await c.query(`SELECT count(*)::int as total FROM students ${whereClause}`, params);
        const total = countResult.rows[0]?.total ?? 0;

        const offset = page * pageSize;
        params.push(pageSize, offset);
        const dataResult = await c.query(
          `SELECT id, name, city, course, status, joined 
           FROM students ${whereClause} 
           ORDER BY ${sortField} ${sortDir}, id 
           LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
          params
        );

        return { total, rows: dataResult.rows, page, pageSize };
      });

      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Create student
  app.post('/api/students', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const { name, city, course, status } = (req.body ?? {}) as {
        name?: string;
        city?: string;
        course?: string;
        status?: string;
      };

      if (!name?.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      const validStatuses = ['Active', 'Pending', 'Inactive'];
      const studentStatus = validStatuses.includes(status ?? '') ? status : 'Pending';

      const result = await asInstitute(inst, async (c) => {
        const r = await c.query(
          `INSERT INTO students (institute_id, name, city, course, status, joined)
           VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
           RETURNING id, name, city, course, status, joined`,
          [inst, name.trim(), city?.trim() || null, course?.trim() || null, studentStatus]
        );
        await c.query('commit');
        return r.rows[0];
      });

      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Delete student
  app.delete('/api/students/:id', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const studentId = req.params.id;

      if (!UUID.test(studentId)) {
        res.status(400).json({ error: 'invalid student id' });
        return;
      }

      await asInstitute(inst, async (c) => {
        const result = await c.query('DELETE FROM students WHERE id = $1', [studentId]);
        await c.query('commit');
        
        if (result.rowCount === 0) {
          throw new Error('student not found or access denied');
        }
      });

      res.status(204).send();
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // List courses
  app.get('/api/courses', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const courses = await asInstitute(inst, async (c) => {
        const r = await c.query(
          'SELECT id, name, icon, description, fees, seats_filled FROM courses ORDER BY name'
        );
        return r.rows;
      });
      res.json({ total: courses.length, rows: courses });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // List enquiries
  app.get('/api/enquiries', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const enquiries = await asInstitute(inst, async (c) => {
        const r = await c.query(
          'SELECT id, name, course, stage, created_at FROM enquiries ORDER BY created_at DESC'
        );
        return r.rows;
      });
      res.json({ total: enquiries.length, rows: enquiries });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Create enquiry
  app.post('/api/enquiries', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const { name, course } = (req.body ?? {}) as { name?: string; course?: string };

      if (!name?.trim() || !course?.trim()) {
        res.status(400).json({ error: 'name and course are required' });
        return;
      }

      const result = await asInstitute(inst, async (c) => {
        const r = await c.query(
          `INSERT INTO enquiries (institute_id, name, course, stage)
           VALUES ($1, $2, $3, 0)
           RETURNING id, name, course, stage, created_at`,
          [inst, name.trim(), course.trim()]
        );
        await c.query('commit');
        return r.rows[0];
      });

      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Move enquiry to next stage
  app.patch('/api/enquiries/:id/advance', async (req, res) => {
    try {
      const inst = getInstituteId(req);
      const enquiryId = req.params.id;

      if (!UUID.test(enquiryId)) {
        res.status(400).json({ error: 'invalid enquiry id' });
        return;
      }

      const result = await asInstitute(inst, async (c) => {
        const current = await c.query('SELECT stage FROM enquiries WHERE id = $1', [enquiryId]);
        
        if (current.rows.length === 0) {
          throw new Error('enquiry not found or access denied');
        }

        const currentStage = current.rows[0].stage;
        if (currentStage >= 2) {
          throw new Error('enquiry is already at final stage');
        }

        const r = await c.query(
          `UPDATE enquiries SET stage = stage + 1 
           WHERE id = $1 
           RETURNING id, name, course, stage, created_at`,
          [enquiryId]
        );
        await c.query('commit');
        return r.rows[0];
      });

      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Attack endpoint for testing data isolation - only enabled in development
  if (process.env.NODE_ENV !== 'production') {
    const attacks: Record<string, string> = {
      read: 'select id from people where institute_id = $1',
      update: "update people set name = 'hacked' where institute_id = $1",
      delete: 'delete from people where institute_id = $1',
      insert: "insert into people (institute_id, name) values ($1, 'intruder')",
    };

    app.post('/api/attack', async (req, res) => {
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
  }

  return app;
}
