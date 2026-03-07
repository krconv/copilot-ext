import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'] ?? 'postgres://copilot:copilot@localhost:5432/copilot_preprocessor',
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err);
});
