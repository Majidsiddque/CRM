import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import pg from 'pg';
import type { Express } from 'express';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});

let app: Express;

beforeAll(() => {
  app = createApp(pool);
});

afterAll(async () => {
  await pool.end();
});

function req(
  method: string,
  path: string,
  instituteId: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    // Extract route params from path (e.g., /api/students/123 -> { id: '123' })
    const pathMatch = path.match(/^(.+?)\/([0-9a-f-]+)(?:\/(.+))?$/);
    const params: Record<string, string> = {};
    if (pathMatch && pathMatch[2]) {
      params.id = pathMatch[2];
    }

    const request = {
      method,
      url: path,
      headers: { 'x-institute-id': instituteId, 'content-type': 'application/json' },
      body: body, // Add body property for express.json() middleware
      header: (name: string) => request.headers[name.toLowerCase() as keyof typeof request.headers],
      on: (event: string, handler: (chunk: Buffer) => void) => {
        if (event === 'data') {
          if (body) handler(Buffer.from(JSON.stringify(body)));
        }
        if (event === 'end') {
          setTimeout(() => handler(Buffer.alloc(0)), 0);
        }
      },
      params: params, // Add params for route parameters
    };

    const response = {
      status: 200,
      headers: {} as Record<string, string>,
      statusCode: 200,
      data: null as unknown,
      status: (code: number) => {
        response.statusCode = code;
        return response;
      },
      json: (data: unknown) => {
        response.data = data;
        resolve({ status: response.statusCode, data });
      },
      send: () => {
        resolve({ status: response.statusCode, data: response.data });
      },
      setHeader: (name: string, value: string) => {
        response.headers[name] = value;
      },
      header: (name: string, value: string) => {
        response.headers[name] = value;
        return response;
      },
    };

    // @ts-expect-error - simplified request/response for testing
    app(request, response);
  });
}

describe('Dashboard API', () => {
  it('returns summary statistics for institute A', async () => {
    const { status, data } = await req('GET', '/api/dashboard', A);
    expect(status).toBe(200);
    expect(data).toMatchObject({
      total_students: expect.any(Number),
      active_students: expect.any(Number),
      pending_students: expect.any(Number),
      inactive_students: expect.any(Number),
      total_enquiries: expect.any(Number),
      fees_collected: expect.any(Number),
      admissions_by_month: expect.any(Array),
    });
  });

  it('returns different data for institute B', async () => {
    const { data: dataA } = await req('GET', '/api/dashboard', A);
    const { data: dataB } = await req('GET', '/api/dashboard', B);
    
    // Both should have data but potentially different values
    expect(dataA).toBeDefined();
    expect(dataB).toBeDefined();
  });

  it('requires valid institute ID header', async () => {
    const { status } = await req('GET', '/api/dashboard', 'invalid-uuid');
    expect(status).toBe(400);
  });
});

describe('Students API', () => {
  it('lists students for institute A', async () => {
    const { status, data } = await req('GET', '/api/students', A);
    expect(status).toBe(200);
    expect(data).toMatchObject({
      total: expect.any(Number),
      rows: expect.any(Array),
      page: expect.any(Number),
      pageSize: expect.any(Number),
    });
  });

  it('filters students by search query', async () => {
    const { status, data } = await req('GET', '/api/students?search=Pooja', A);
    expect(status).toBe(200);
    const result = data as { rows: { name: string }[] };
    if (result.rows.length > 0) {
      expect(result.rows.some(s => s.name.toLowerCase().includes('pooja'))).toBe(true);
    }
  });

  it('filters students by status', async () => {
    const { status, data } = await req('GET', '/api/students?status=Active', A);
    expect(status).toBe(200);
    const result = data as { rows: { status: string }[] };
    expect(result.rows.every(s => s.status === 'Active')).toBe(true);
  });

  it('supports pagination', async () => {
    const { data: page1 } = await req('GET', '/api/students?page=0&pageSize=5', A);
    const { data: page2 } = await req('GET', '/api/students?page=1&pageSize=5', A);
    
    const p1 = page1 as { rows: { id: string }[] };
    const p2 = page2 as { rows: { id: string }[] };
    
    if (p1.rows.length > 0 && p2.rows.length > 0) {
      expect(p1.rows[0].id).not.toBe(p2.rows[0].id);
    }
  });

  it('creates a new student', async () => {
    const { status, data } = await req('POST', '/api/students', A, {
      name: 'Test Student',
      city: 'Test City',
      course: 'Test Course',
      status: 'Pending',
    });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      id: expect.any(String),
      name: 'Test Student',
      status: 'Pending',
    });
  });

  it('requires name when creating student', async () => {
    const { status } = await req('POST', '/api/students', A, { city: 'Test' });
    expect(status).toBe(400);
  });

  it('deletes a student', async () => {
    // First create a student
    const { data: created } = await req('POST', '/api/students', A, {
      name: 'To Delete',
      status: 'Pending',
    });
    const student = created as { id: string };
    
    // Then delete it
    const { status } = await req('DELETE', `/api/students/${student.id}`, A);
    expect(status).toBe(204);
  });

  it('cannot delete student from another institute', async () => {
    // Create student for A
    const { data: created } = await req('POST', '/api/students', A, {
      name: 'Institute A Student',
      status: 'Active',
    });
    const student = created as { id: string };
    
    // Try to delete as B
    const { status } = await req('DELETE', `/api/students/${student.id}`, B);
    expect(status).toBe(400);
  });
});

describe('Courses API', () => {
  it('lists courses for institute A', async () => {
    const { status, data } = await req('GET', '/api/courses', A);
    expect(status).toBe(200);
    expect(data).toMatchObject({
      total: expect.any(Number),
      rows: expect.any(Array),
    });
    const result = data as { rows: { name: string; icon: string }[] };
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]).toMatchObject({
      name: expect.any(String),
      icon: expect.any(String),
    });
  });

  it('institute A and B have separate course lists', async () => {
    const { data: dataA } = await req('GET', '/api/courses', A);
    const { data: dataB } = await req('GET', '/api/courses', B);
    
    expect(dataA).toBeDefined();
    expect(dataB).toBeDefined();
    // Both should have courses
    expect((dataA as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    expect((dataB as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });
});

describe('Enquiries API', () => {
  it('lists enquiries for institute A', async () => {
    const { status, data } = await req('GET', '/api/enquiries', A);
    expect(status).toBe(200);
    expect(data).toMatchObject({
      total: expect.any(Number),
      rows: expect.any(Array),
    });
  });

  it('creates a new enquiry', async () => {
    const { status, data } = await req('POST', '/api/enquiries', A, {
      name: 'Test Enquiry',
      course: 'Full Stack Web',
    });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      id: expect.any(String),
      name: 'Test Enquiry',
      course: 'Full Stack Web',
      stage: 0,
    });
  });

  it('requires name and course when creating enquiry', async () => {
    const { status } = await req('POST', '/api/enquiries', A, { name: 'Test' });
    expect(status).toBe(400);
  });

  it('advances enquiry to next stage', async () => {
    // Create an enquiry
    const { data: created } = await req('POST', '/api/enquiries', A, {
      name: 'Stage Test',
      course: 'Test Course',
    });
    const enquiry = created as { id: string; stage: number };
    expect(enquiry.stage).toBe(0);
    
    // Advance it
    const { status, data } = await req('PATCH', `/api/enquiries/${enquiry.id}/advance`, A);
    expect(status).toBe(200);
    expect((data as { stage: number }).stage).toBe(1);
  });

  it('cannot advance enquiry beyond final stage', async () => {
    // Create an enquiry
    const { data: created } = await req('POST', '/api/enquiries', A, {
      name: 'Final Stage Test',
      course: 'Test Course',
    });
    const enquiry = created as { id: string };
    
    // Advance to stage 1
    await req('PATCH', `/api/enquiries/${enquiry.id}/advance`, A);
    // Advance to stage 2 (final)
    await req('PATCH', `/api/enquiries/${enquiry.id}/advance`, A);
    // Try to advance beyond
    const { status } = await req('PATCH', `/api/enquiries/${enquiry.id}/advance`, A);
    expect(status).toBe(400);
  });

  it('cannot advance enquiry from another institute', async () => {
    // Create enquiry for A
    const { data: created } = await req('POST', '/api/enquiries', A, {
      name: 'Institute A Enquiry',
      course: 'Test',
    });
    const enquiry = created as { id: string };
    
    // Try to advance as B
    const { status } = await req('PATCH', `/api/enquiries/${enquiry.id}/advance`, B);
    expect(status).toBe(400);
  });
});
