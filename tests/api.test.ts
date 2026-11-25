
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const instituteA = '11111111-1111-1111-1111-111111111111';
const instituteB = '22222222-2222-2222-2222-222222222222';

let server: ChildProcess;

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    if (server.exitCode !== null) {
      throw new Error('Backend process exited before becoming ready');
    }

    try {
      const response = await fetch(`${BASE_URL}/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Backend did not start within 30 seconds');
}

async function attack(action: string) {
  const response = await fetch(`${BASE_URL}/api/attack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      as: instituteA,
      target: instituteB,
      action,
    }),
  });

  if (!response.ok) {
    throw new Error(`Attack endpoint returned HTTP ${response.status}`);
  }

  return response.json() as Promise<{ result: string }>;
}

describe('API and institute data isolation', () => {
  beforeAll(async () => {
    server = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts'],
      {
        env: {
          ...process.env,
          PORT: String(PORT),
        },
        stdio: 'ignore',
      },
    );

    await waitForServer();
  }, 40000);

  afterAll(async () => {
    if (!server || server.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.kill('SIGKILL');
        reject(new Error('Backend process did not stop in time'));
      }, 5000);

      server.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      server.kill();
    });
  });

  it('should return a healthy status', async () => {
    const response = await fetch(`${BASE_URL}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'running',
    });
  });

  it('should return 1000 people for Institute A', async () => {
    const response = await fetch(
      `${BASE_URL}/api/people?institute=${instituteA}`,
    );

    expect(response.status).toBe(200);

    const data = await response.json();

    expect(data.total).toBe(1000);
    expect(data.rows).toHaveLength(10);

    expect(
      data.rows.every(
        (person: { institute_id: string }) =>
          person.institute_id === instituteA,
      ),
    ).toBe(true);
  });

  it('should return 1000 people for Institute B', async () => {
    const response = await fetch(
      `${BASE_URL}/api/people?institute=${instituteB}`,
    );

    expect(response.status).toBe(200);

    const data = await response.json();

    expect(data.total).toBe(1000);
    expect(data.rows).toHaveLength(10);

    expect(
      data.rows.every(
        (person: { institute_id: string }) =>
          person.institute_id === instituteB,
      ),
    ).toBe(true);
  });

  it('should return zero people for an unknown institute', async () => {
    const response = await fetch(
      `${BASE_URL}/api/people?institute=33333333-3333-3333-3333-333333333333`,
    );

    expect(response.status).toBe(200);

    const data = await response.json();

    expect(data.total).toBe(0);
  });

  it('should block cross-institute read', async () => {
    const result = await attack('read');

    expect(result.result).toContain('0 rows affected');
  });

  it('should block cross-institute update', async () => {
    const result = await attack('update');

    expect(result.result).toContain('0 rows affected');
  });

  it('should block cross-institute delete', async () => {
    const result = await attack('delete');

    expect(result.result).toContain('0 rows affected');
  });

  it('should block cross-institute insert', async () => {
    const result = await attack('insert');

    expect(result.result).toContain('blocked');
    expect(result.result).toContain('row-level security policy');
  });
});
