import 'dotenv/config';
import { migrate } from '../shared/migrate.js';
import { runSync } from './sync.js';
import { pool } from '../shared/db.js';

/**
 * One-shot: migrate the schema, then pull Copilot data into the local DB.
 *
 *   tsx src/preprocessor/sync-once.ts [windowDays]
 *
 * windowDays defaults to 30 (recent). Pass a large number (e.g. 3650) for a
 * full historical sync. Read-only against Copilot — no writes, no LLM.
 */

const days = parseInt(process.argv[2] ?? '30', 10);

async function main(): Promise<void> {
  await migrate();
  await runSync({
    scope: days >= 3650 ? 'full' : 'recent',
    trigger: 'manual',
    windowDays: days,
  });
  await pool.end();
  console.log('[sync-once] done');
}

main().catch((err) => {
  console.error('[sync-once] error:', err);
  process.exit(1);
});
