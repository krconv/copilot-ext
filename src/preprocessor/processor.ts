import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pool } from '../shared/db.js';
import { runPreprocessPrompt } from './llm.js';
import { gql } from '../client.js';
import { EDIT_TRANSACTION_MUTATION } from '../tools/transactions.js';

interface TransactionKey {
  itemId: string;
  accountId: string;
  id: string;
}

interface DbTransaction {
  item_id: string;
  account_id: string;
  id: string;
  name: string | null;
  amount: string;
  date: Date;
  type: string | null;
  category_id: string | null;
  recurring_id: string | null;
  is_reviewed: boolean | null;
  is_pending: boolean | null;
  tag_ids: string[] | null;
  user_notes: string | null;
  created_at: string | null;
  raw_json: Record<string, unknown>;
}

interface DbRule {
  id: number;
  match: string;
  instruction: string;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i');
}

export async function runProcessor(keys: TransactionKey[]): Promise<number> {
  if (keys.length === 0) return 0;

  const itemIds = keys.map(k => k.itemId);
  const accountIds = keys.map(k => k.accountId);
  const ids = keys.map(k => k.id);

  // Query eligible transactions from the candidate set
  const txResult = await pool.query<DbTransaction>(
    `SELECT t.* FROM transactions t
     JOIN unnest($1::text[], $2::text[], $3::text[]) AS k(item_id, account_id, txn_id)
       ON t.item_id = k.item_id AND t.account_id = k.account_id AND t.id = k.txn_id
     WHERE t.is_reviewed = false
       AND t.is_pending = false
       AND NOT EXISTS (
         SELECT 1 FROM transaction_preprocess_results r
         WHERE r.item_id = t.item_id
           AND r.account_id = t.account_id
           AND r.transaction_id = t.id
           AND r.applied = true
           AND r.dry_run = false
       )`,
    [itemIds, accountIds, ids]
  );

  const eligible = txResult.rows;
  if (eligible.length === 0) return 0;

  const rulesResult = await pool.query<DbRule>(
    'SELECT id, match, instruction FROM rules WHERE archived = false'
  );
  const rules = rulesResult.rows;

  let categorizer: string;
  try {
    categorizer = readFileSync(resolve(process.cwd(), 'TRANSACTION_CATEGORIZER.md'), 'utf8');
  } catch {
    console.error('[processor] TRANSACTION_CATEGORIZER.md not found — skipping preprocessing');
    return 0;
  }

  const dryRun = process.env['DRY_RUN'] !== 'false';
  let processedCount = 0;

  for (const tx of eligible) {
    try {
      const matchedRules = rules.filter(r => globToRegex(r.match).test(tx.name ?? ''));
      const matchedRuleIds = matchedRules.map(r => r.id);
      const rulesText = matchedRules.length
        ? matchedRules.map(r => `- ${r.instruction}`).join('\n')
        : '(none)';

      const systemPrompt = categorizer
        .replace('{{matched_rules}}', rulesText)
        .replace('{{transaction}}', JSON.stringify(tx.raw_json, null, 2));

      const txJson = JSON.stringify(tx.raw_json, null, 2);
      const { result, provider, model } = await runPreprocessPrompt(systemPrompt, txJson);

      if (dryRun) {
        console.log(JSON.stringify({
          id: tx.id,
          name: tx.name,
          amount: tx.amount,
          matchedRules: matchedRuleIds,
          wouldApply: result,
        }));
      } else {
        const input: Record<string, unknown> = {};
        if (result.name !== undefined) input['name'] = result.name;
        if (result.categoryId !== undefined) input['categoryId'] = result.categoryId;
        if (result.type !== undefined) input['type'] = result.type;
        if (result.userNotes !== undefined) input['userNotes'] = result.userNotes;
        if (result.tagIds !== undefined) input['tagIds'] = result.tagIds;

        if (Object.keys(input).length > 0) {
          await gql(EDIT_TRANSACTION_MUTATION, {
            itemId: tx.item_id,
            accountId: tx.account_id,
            id: tx.id,
            input,
          });
        }
      }

      await pool.query(
        `INSERT INTO transaction_preprocess_results (
           item_id, account_id, transaction_id,
           orig_name, orig_category_id, orig_type, orig_notes, orig_tag_ids,
           matched_rule_ids,
           llm_name, llm_category_id, llm_type, llm_notes, llm_tag_ids, llm_raw_output,
           llm_provider, llm_model,
           dry_run, applied, applied_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          tx.item_id, tx.account_id, tx.id,
          tx.name, tx.category_id, tx.type, tx.user_notes, tx.tag_ids,
          matchedRuleIds,
          result.name ?? null, result.categoryId ?? null, result.type ?? null,
          result.userNotes ?? null, result.tagIds ?? null, result,
          provider, model,
          dryRun, !dryRun, dryRun ? null : new Date(),
        ]
      );

      processedCount++;
    } catch (err) {
      console.error(`[processor] error processing tx ${tx.id}:`, err);
    }
  }

  return processedCount;
}
