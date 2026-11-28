import pg from 'pg';
import { reprocessPending } from './attendance.js';

// npm run machine:reprocess  -> turns any unprocessed raw uploads into punches.
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app_user:change_me@127.0.0.1:55432/postgres',
});

try {
  console.log(await reprocessPending(pool));
} finally {
  await pool.end();
}