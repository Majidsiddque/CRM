import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import type { PoolClient } from 'pg';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});

async function asInstitute<T>(
  id: string | null,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (id !== null) {
      await c.query("select set_config('app.institute_id', $1, true)", [id]);
    }
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

afterAll(async () => {
  await pool.end();
});

describe.each([
  { me: A, other: B, label: 'A attacking B' },
  { me: B, other: A, label: 'B attacking A' },
])('$label', ({ me, other }) => {
  it('sees exactly its own 1000 rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query('select institute_id from people');
      expect(r.rowCount).toBe(1000);
      expect(r.rows.every((x) => x.institute_id === me)).toBe(true);
    }));

  it('plain select of the other institute returns 0 rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query('select * from people where institute_id = $1', [other]);
      expect(r.rowCount).toBe(0);
    }));

  it('update of the other institute changes 0 rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query("update people set name = 'hacked' where institute_id = $1", [other]);
      expect(r.rowCount).toBe(0);
    }));

  it('update cannot move a row into the other institute', () =>
    asInstitute(me, async (c) => {
      await expect(
        c.query('update people set institute_id = $1 where institute_id = $2', [other, me]),
      ).rejects.toThrow();
    }));

  it('delete of the other institute removes 0 rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query('delete from people where institute_id = $1', [other]);
      expect(r.rowCount).toBe(0);
    }));

  it('insert into the other institute is rejected', () =>
    asInstitute(me, async (c) => {
      await expect(
        c.query("insert into people (institute_id, name) values ($1, 'intruder')", [other]),
      ).rejects.toThrow(/row-level security/);
    }));

  it('join returns only its own rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        'select p.institute_id from people p join institutes i on i.id = p.institute_id',
      );
      expect(r.rowCount).toBe(1000);
      expect(r.rows.every((x) => x.institute_id === me)).toBe(true);
    }));

  it('join aimed at the other institute returns 0 rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        'select p.id from people p join institutes i on i.id = p.institute_id where i.id = $1',
        [other],
      );
      expect(r.rowCount).toBe(0);
    }));
});

describe('wrong or missing institute identifier', () => {
  it('unknown id returns 0 rows', () =>
    asInstitute('33333333-3333-3333-3333-333333333333', async (c) => {
      const r = await c.query('select * from people');
      expect(r.rowCount).toBe(0);
    }));

  it('missing id returns 0 rows', () =>
    asInstitute(null, async (c) => {
      const r = await c.query('select * from people');
      expect(r.rowCount).toBe(0);
    }));

  it('missing id cannot insert', () =>
    asInstitute(null, async (c) => {
      await expect(
        c.query("insert into people (institute_id, name) values ($1, 'x')", [A]),
      ).rejects.toThrow();
    }));

  it('malformed id errors', () =>
    asInstitute('not-a-uuid', async (c) => {
      await expect(c.query('select * from people')).rejects.toThrow();
    }));
});
// ---------------------------------------------------------------------------
// More routes: sub-queries, CTEs, write-via-join, copying, privileges, payments
// ---------------------------------------------------------------------------
describe.each([
  { me: A, other: B, label: 'A attacking B (advanced routes)' },
  { me: B, other: A, label: 'B attacking A (advanced routes)' },
])('$label', ({ me, other }) => {
  it('sub-query aimed at the other institute returns 0 rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        'select * from people where institute_id = (select id from institutes where id = $1)',
        [other],
      );
      expect(r.rowCount).toBe(0);
    }));

  it('CTE aimed at the other institute returns 0 rows', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        'with x as (select * from people) select * from x where institute_id = $1',
        [other],
      );
      expect(r.rowCount).toBe(0);
    }));

  it('UNION cannot smuggle in the other institute', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        'select id from people where institute_id = $1 union select id from people where institute_id = $2',
        [me, other],
      );
      expect(r.rowCount).toBe(1000);
    }));

  it('cross join cannot see the other institute', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        'select distinct a.institute_id from people a cross join people b',
      );
      expect(r.rows.map((x) => x.institute_id)).toEqual([me]);
    }));

  it('update via join changes 0 rows of the other institute', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        "update people p set name = 'hacked' from institutes i where i.id = p.institute_id and i.id = $1",
        [other],
      );
      expect(r.rowCount).toBe(0);
    }));

  it('delete via join removes 0 rows of the other institute', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        'delete from people p using institutes i where i.id = p.institute_id and i.id = $1',
        [other],
      );
      expect(r.rowCount).toBe(0);
    }));

  it('insert-select cannot copy rows into the other institute', () =>
    asInstitute(me, async (c) => {
      await expect(
        c.query(
          "insert into people (institute_id, name) select $1, 'copy_' || name from people",
          [other],
        ),
      ).rejects.toThrow(/row-level security/);
    }));

  it('insert with the right institute works (policy is not just blocking everything)', () =>
    asInstitute(me, async (c) => {
      const r = await c.query(
        "insert into people (institute_id, name) values ($1, 'legit_new_person')",
        [me],
      );
      expect(r.rowCount).toBe(1);
    }));

  it('cannot read the other institute payments', () =>
    asInstitute(me, async (c) => {
      const r = await c.query('select * from payments where institute_id = $1', [other]);
      expect(r.rowCount).toBe(0);
    }));

  it('cannot insert a payment for the other institute', () =>
    asInstitute(me, async (c) => {
      await expect(
        c.query(
          "insert into payments (institute_id, razorpay_payment_id, amount_paise, status) values ($1, 'pay_x', 100, 'captured')",
          [other],
        ),
      ).rejects.toThrow(/row-level security/);
    }));

  it('cannot change or delete payments at all', () =>
    asInstitute(me, async (c) => {
      await expect(c.query('update payments set amount_paise = 1')).rejects.toThrow(/permission denied/);
    }));
});

describe('the restricted database user', () => {
  it('is not a superuser and cannot bypass row-level security', () =>
    asInstitute(A, async (c) => {
      const r = await c.query(
        'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
      );
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    }));

  it('cannot TRUNCATE people (truncate would skip row-level security)', () =>
    asInstitute(A, async (c) => {
      await expect(c.query('truncate people')).rejects.toThrow(/permission denied/);
    }));

  // A failed statement aborts its transaction, so each one gets its own.
  it.each([
    ["insert into institutes (name) values ('evil')", /permission denied/],
    ["update institutes set name = 'x'", /permission denied/],
    ['delete from institutes', /permission denied/],
    ['alter table people disable row level security', /must be owner/],
    ['drop policy inst_isolation on people', /must be owner/],
  ])('cannot run: %s', (sql, pattern) =>
    asInstitute(A, async (c) => {
      await expect(c.query(sql)).rejects.toThrow(pattern);
    }));
});

describe('seed data', () => {
  it('has exactly 1000 people for each institute', async () => {
    for (const id of [A, B]) {
      await asInstitute(id, async (c) => {
        const r = await c.query('select count(*)::int as n from people');
        expect(r.rows[0].n).toBe(1000);
      });
    }
  });
});
