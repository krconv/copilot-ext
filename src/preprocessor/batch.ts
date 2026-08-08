import '../shared/tracing.js';
import 'dotenv/config';
import { pool } from '../shared/db.js';
import { processSingleTransaction } from './processor.js';

/**
 * One-shot batch runner for iterating on the preprocessor locally.
 *
 *   tsx src/preprocessor/batch.ts [N] [fresh|redo] [--apply]
 *
 * - N       how many transactions to process (default 5)
 * - fresh   (default) next N unreviewed txns with no dry-run result yet — advances
 * - redo    re-run the N most-recently dry-run-processed txns — validate a tweak
 * - --apply run live (writes to Copilot). Omitted → forced dry-run for review.
 *
 * Prints a before→after diff per transaction (via processSingleTransaction's
 * dry-run output) and exits.
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const mode = args.includes('redo') ? 'redo' : 'fresh';
const n = parseInt(args.find((a) => /^\d+$/.test(a)) ?? '5', 10);

// Force the mode explicitly so a DRY_RUN value in .env can't turn an --apply
// run back into a dry-run (or vice-versa).
process.env['DRY_RUN'] = apply ? 'false' : 'true';

// Newest unreviewed transactions not yet live-applied. Deterministic: re-running
// yields the same set (so we can tweak + re-run), and --apply advances past them.
const FRESH_SQL = `
  SELECT t.item_id, t.account_id, t.id
  FROM transactions t
  WHERE t.is_reviewed = false
    AND NOT EXISTS (
      SELECT 1 FROM transaction_preprocess_results r
      WHERE r.item_id = t.item_id AND r.account_id = t.account_id AND r.transaction_id = t.id
        AND r.applied = true AND r.dry_run = false
    )
  ORDER BY t.date DESC
  LIMIT $1`;

const REDO_SQL = `
  SELECT t.item_id, t.account_id, t.id
  FROM transactions t
  JOIN LATERAL (
    SELECT MAX(processed_at) AS last_dry FROM transaction_preprocess_results r
    WHERE r.item_id = t.item_id AND r.account_id = t.account_id AND r.transaction_id = t.id
      AND r.dry_run = true
  ) d ON d.last_dry IS NOT NULL
  WHERE t.is_reviewed = false
  ORDER BY d.last_dry DESC
  LIMIT $1`;

async function main(): Promise<void> {
  const { rows } = await pool.query<{ item_id: string; account_id: string; id: string }>(
    mode === 'redo' ? REDO_SQL : FRESH_SQL,
    [n]
  );

  console.log(
    `[batch] mode=${mode} apply=${apply} — processing ${rows.length} transaction(s)` +
      (apply ? ' \x1b[1m\x1b[31mLIVE (writes to Copilot)\x1b[0m' : ' (dry-run)')
  );

  for (const r of rows) {
    await processSingleTransaction({ itemId: r.item_id, accountId: r.account_id, id: r.id });
  }

  await pool.end();
  console.log('[batch] done');
}

main().catch((err) => {
  console.error('[batch] error:', err);
  process.exit(1);
});
