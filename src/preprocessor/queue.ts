import { pool } from '../shared/db.js';
import { processSingleTransaction, type TransactionKey } from './processor.js';

export type { TransactionKey };

const queue: TransactionKey[] = [];

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_SLEEP_MS = 5_000;

export function enqueueTransactions(keys: TransactionKey[]): void {
  if (keys.length === 0) return;
  const existing = new Set(queue.map(k => `${k.itemId}:${k.accountId}:${k.id}`));
  const novel = keys.filter(k => !existing.has(`${k.itemId}:${k.accountId}:${k.id}`));
  if (novel.length === 0) return;
  queue.push(...novel);
  console.log(`[queue] enqueued ${novel.length} (pending: ${queue.length})`);
}

async function pollDbForUnprocessed(): Promise<TransactionKey[]> {
  const dryRun = process.env['DRY_RUN'] !== 'false';

  const result = await pool.query<{ item_id: string; account_id: string; id: string }>(
    dryRun
      ? `SELECT t.item_id, t.account_id, t.id
         FROM transactions t
         LEFT JOIN LATERAL (
           SELECT processed_at FROM transaction_preprocess_results r
           WHERE r.item_id = t.item_id
             AND r.account_id = t.account_id
             AND r.transaction_id = t.id
             AND r.dry_run = true
           ORDER BY processed_at DESC
           LIMIT 1
         ) last_dry ON true
         WHERE t.is_reviewed = false
           AND NOT EXISTS (
             SELECT 1 FROM transaction_preprocess_results r
             WHERE r.item_id = t.item_id
               AND r.account_id = t.account_id
               AND r.transaction_id = t.id
               AND r.applied = true
               AND r.dry_run = false
           )
         ORDER BY last_dry.processed_at ASC NULLS FIRST
         LIMIT 1000`
      : `SELECT t.item_id, t.account_id, t.id
         FROM transactions t
         WHERE t.is_reviewed = false
           AND NOT EXISTS (
             SELECT 1 FROM transaction_preprocess_results r
             WHERE r.item_id = t.item_id
               AND r.account_id = t.account_id
               AND r.transaction_id = t.id
               AND r.applied = true
               AND r.dry_run = false
           )
         ORDER BY t.date DESC
         LIMIT 1000`
  );
  return result.rows.map(r => ({ itemId: r.item_id, accountId: r.account_id, id: r.id }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startProcessingLoop(): Promise<void> {
  const sleepBetweenRuns = process.env['SLEEP_BETWEEN_AGENT_RUNS']
    ? parseInt(process.env['SLEEP_BETWEEN_AGENT_RUNS'], 10)
    : 0;

  console.log(
    sleepBetweenRuns
      ? `[queue] starting loop (sleep between runs: ${sleepBetweenRuns}ms)`
      : '[queue] starting loop (no sleep between runs)'
  );

  let lastPollAt = 0;

  while (true) {
    if (queue.length === 0) {
      const now = Date.now();
      if (now - lastPollAt >= POLL_INTERVAL_MS) {
        console.log('[queue] empty — polling DB for unprocessed transactions');
        try {
          const keys = await pollDbForUnprocessed();
          lastPollAt = Date.now();
          if (keys.length > 0) {
            enqueueTransactions(keys);
          } else {
            console.log('[queue] nothing to process');
          }
        } catch (err) {
          console.error('[queue] DB poll error:', err);
          lastPollAt = Date.now(); // avoid tight retry loop on error
        }
      } else {
        await sleep(IDLE_SLEEP_MS);
      }
      continue;
    }

    const key = queue.shift()!;
    try {
      await processSingleTransaction(key);
    } catch (err) {
      console.error(`[queue] error processing ${key.id}:`, err);
    }

    if (sleepBetweenRuns > 0) {
      await sleep(sleepBetweenRuns);
    }
  }
}
