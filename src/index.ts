import pg from 'pg';
import { createApp } from './app.js';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});

const port = Number(process.env.PORT) || 3000;
const server = createApp(pool).listen(port, () => {
  console.log(`listening on ${port}`);
});

// Clean shutdown so ECS/Docker stops are quick and DB connections are released.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
