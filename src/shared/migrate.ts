import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('Migration complete — all tables created or already exist');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
