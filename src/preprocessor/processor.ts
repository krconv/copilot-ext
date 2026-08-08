import { pool } from '../shared/db.js';
import { runPreprocessPrompt, type LLMResult } from './llm.js';
import { getIdMaps, getAccountMap, replaceIdsWithNames, resolveResultIds } from './ids.js';
import { buildPrompt } from './prompt.js';
import { gql } from '../client.js';
import { EDIT_TRANSACTION_MUTATION, ADD_TRANSACTION_TO_RECURRING_MUTATION } from '../tools/transactions.js';

export interface TransactionKey {
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
  original_name: string | null;
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

export async function processSingleTransaction(key: TransactionKey): Promise<boolean> {
  const { itemId, accountId, id } = key;

  const transactionResult = await pool.query<DbTransaction>(
    `SELECT t.* FROM transactions t
     WHERE t.item_id = $1 AND t.account_id = $2 AND t.id = $3
       AND t.is_reviewed = false
       AND NOT EXISTS (
         SELECT 1 FROM transaction_preprocess_results r
         WHERE r.item_id = t.item_id
           AND r.account_id = t.account_id
           AND r.transaction_id = t.id
           AND r.applied = true
           AND r.dry_run = false
       )`,
    [itemId, accountId, id]
  );

  if (transactionResult.rows.length === 0) return false;
  const transaction = transactionResult.rows[0]!;

  const rulesResult = await pool.query<DbRule>(
    'SELECT id, match, instruction FROM rules WHERE archived = false'
  );
  const rules = rulesResult.rows;

  const [idMaps, accountMap] = await Promise.all([getIdMaps(), getAccountMap()]);
  const dryRun = process.env['DRY_RUN'] !== 'false';

  try {
    const recurringName = transaction.recurring_id
      ? idMaps.recurringIdToName[transaction.recurring_id]
      : undefined;

    const matchedRules = rules.filter(rule => globToRegex(rule.match).test(transaction.name ?? ''));
    const matchedRuleIds = matchedRules.map(rule => rule.id);

    const account = accountMap[`${transaction.item_id}:${transaction.account_id}`];

    const raw = transaction.raw_json as {
        name: string | null;
        amount: number;
        date: string;
        type: string | null;
        categoryId: string | null;
        recurringId: string | null;
        isPending: boolean | null;
        userNotes: string | null;
        tags?: Array<{ id: string; name: string }>;
        suggestedCategoryIds?: string[] | null;
      };

      const tagSlugs = (raw.tags ?? []).map(t => idMaps.tagIdToSlug[t.id] ?? t.name);

      // History-first name hint: the most common name this account has already used
      // for reviewed transactions sharing this exact raw (original) name.
      let establishedName: string | undefined;
      if (transaction.original_name) {
        const est = await pool.query<{ name: string }>(
          `SELECT name FROM transactions
           WHERE original_name = $1 AND is_reviewed = true AND name IS NOT NULL
           GROUP BY name ORDER BY COUNT(*) DESC LIMIT 1`,
          [transaction.original_name]
        );
        establishedName = est.rows[0]?.name;
      }

      const curated: Record<string, unknown> = {
        name: raw.name,
        establishedName,
        amount: raw.amount,
        date: raw.date,
        type: raw.type,
        categoryId: raw.categoryId,
        isRecurring: raw.recurringId != null,
        recurringName,
        isPending: raw.isPending ?? undefined,
        tags: tagSlugs.length > 0 ? tagSlugs : undefined,
        suggestedCategoryIds: (raw.suggestedCategoryIds?.length ?? 0) > 0
          ? raw.suggestedCategoryIds : undefined,
        userNotes: raw.userNotes ?? undefined,
        account: account ? {
          name: account.name,
          ...(account.type && { type: account.type }),
          ...(account.subType && { subType: account.subType }),
        } : undefined,
      };

      for (const k of Object.keys(curated)) {
        if (curated[k] === undefined || curated[k] === null) delete curated[k];
      }

      const systemPrompt = buildPrompt(idMaps, matchedRules);
      const transactionJson = replaceIdsWithNames(JSON.stringify(curated, null, 2), idMaps);
      const llmOut = await runPreprocessPrompt(systemPrompt, transactionJson, idMaps);
      const result = llmOut.result;
      const provider = llmOut.provider;
      const model = llmOut.model;
      if (llmOut.unresolved) {
        result.debug = `UNRESOLVED: ${llmOut.unresolvedReason ?? 'not confident'}`;
      }
      // Unresolved transactions are never marked applied — nothing is written to
      // Copilot and they remain eligible for a later pass / manual review.
      const appliedLive = !dryRun && !llmOut.unresolved;
      const resolved = resolveResultIds(result, idMaps);
      if (resolved.categoryId !== undefined) result.categoryId = resolved.categoryId;
      if (resolved.tagIds !== undefined) result.tagIds = resolved.tagIds;
      if (resolved.recurringId !== undefined) result.recurringId = resolved.recurringId;

      // Programmatic normalization (kept out of the prompt):
      //  - internal transfers / income never carry a category
      //  - a transaction linked to a recurring doesn't need a note (the recurring captures it)
      const finalType = result.type ?? transaction.type;
      if (finalType === 'INTERNAL_TRANSFER' || finalType === 'INCOME') {
        result.categoryId = undefined;
      }
      const willBeRecurring =
        result.recurringId === null ? false
        : result.recurringId !== undefined ? true
        : transaction.recurring_id != null;
      if (willBeRecurring) result.notes = undefined;

      // Render the before → after diff for every transaction (dry-run and live).
      const origCategory = transaction.category_id
        ? (idMaps.categoryIdToSlug[transaction.category_id] ?? transaction.category_id)
        : null;
      const origTags = (transaction.tag_ids ?? []).map(id => idMaps.tagIdToSlug[id] ?? id);

      const fields = ['name', 'type', 'categoryId', 'tagIds', 'notes', 'recurring'] as const;
      const before: Record<string, unknown> = {
        name: transaction.name,
        type: transaction.type,
        categoryId: origCategory,
        tagIds: origTags.length > 0 ? origTags : undefined,
        notes: transaction.user_notes ?? undefined,
        recurring: transaction.recurring_id
          ? (idMaps.recurringIdToName[transaction.recurring_id] ?? transaction.recurring_id)
          : undefined,
      };
      const after: Record<string, unknown> = {
        name: result.name,
        type: result.type,
        categoryId: result.categoryId ? (idMaps.categoryIdToSlug[result.categoryId] ?? result.categoryId) : undefined,
        tagIds: result.tagIds?.map(id => idMaps.tagIdToSlug[id] ?? id),
        notes: result.notes,
        recurring: result.recurringId === null
          ? null
          : result.recurringId
            ? (idMaps.recurringIdToName[result.recurringId] ?? result.recurringId)
            : undefined,
      };

      const BOLD = '\x1b[1m'; const GREEN = '\x1b[32m'; const RESET = '\x1b[0m';
      const fmt = (val: unknown) => val == null || (Array.isArray(val) && val.length === 0) ? '(none)' : JSON.stringify(val);
      const tag = dryRun ? 'dry-run' : llmOut.unresolved ? 'unresolved' : 'applied';
      const lines: string[] = [`[${tag}] ${transaction.id}  $${transaction.amount}`];
      for (const f of fields) {
        const b = before[f]; const a = after[f];
        const changed = a !== undefined && JSON.stringify(a) !== JSON.stringify(b);
        const label = `  ${f.padEnd(12)}`;
        if (changed) {
          lines.push(`${label}${fmt(b)} → ${BOLD}${GREEN}${fmt(a)}${RESET}`);
        } else {
          lines.push(`${label}${fmt(b)}`);
        }
      }
      if (matchedRuleIds.length > 0) lines.push(`  rules:      ${matchedRuleIds.join(', ')}`);
      if (result.debug) lines.push(`  ${result.debug}`);
      console.log(lines.join('\n'));

      if (appliedLive) {
        const input: Record<string, unknown> = {};
        if (result.name !== undefined) input['name'] = result.name;
        if (result.categoryId !== undefined) input['categoryId'] = result.categoryId;
        if (result.type !== undefined) input['type'] = result.type;
        if (result.tagIds !== undefined) input['tagIds'] = result.tagIds;
        if (result.notes !== undefined) input['userNotes'] = result.notes;

        try {
          if (Object.keys(input).length > 0) {
            await gql(EDIT_TRANSACTION_MUTATION, {
              itemId: transaction.item_id,
              accountId: transaction.account_id,
              id: transaction.id,
              input,
            });
          }

          // Recurring linking/clearing is a separate mutation — editTransaction does not accept recurringId.
          // null clears the existing link (isExcluded on the recurring it's currently on); a slug links it.
          if (result.recurringId === null) {
            if (transaction.recurring_id) {
              await gql(ADD_TRANSACTION_TO_RECURRING_MUTATION, {
                itemId: transaction.item_id,
                accountId: transaction.account_id,
                id: transaction.id,
                input: { recurringId: transaction.recurring_id, isExcluded: true },
              });
            }
          } else if (result.recurringId !== undefined) {
            await gql(ADD_TRANSACTION_TO_RECURRING_MUTATION, {
              itemId: transaction.item_id,
              accountId: transaction.account_id,
              id: transaction.id,
              input: { recurringId: result.recurringId, isExcluded: false },
            });
          }
        } catch (err) {
          // A pending charge (e.g. a gas-pump pre-auth) can vanish from Copilot
          // before we apply — it's deleted and reposted under a new id. Rather than
          // error out and recycle it forever, record an applied result so FRESH_SQL
          // excludes it from future batches. Any other error still propagates.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/not found/i.test(msg)) throw err;
          result.debug = `ARCHIVED: ${msg} — no longer in Copilot (pending charge reposted under a new id)`;
          console.log(`  \x1b[33m[archived]\x1b[0m ${transaction.id} — ${msg}`);
        }
      }

    await pool.query(
      `INSERT INTO transaction_preprocess_results (
         item_id, account_id, transaction_id,
         orig_name, orig_category_id, orig_type, orig_notes, orig_tag_ids,
         matched_rule_ids,
         llm_name, llm_category_id, llm_type, llm_notes, llm_tag_ids, llm_debug, llm_raw_output,
         llm_provider, llm_model,
         dry_run, applied, applied_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        transaction.item_id, transaction.account_id, transaction.id,
        transaction.name, transaction.category_id, transaction.type, transaction.user_notes, transaction.tag_ids,
        matchedRuleIds,
        result.name ?? null, result.categoryId ?? null, result.type ?? null,
        result.notes ?? null, result.tagIds ?? null, result.debug ?? null, result,
        provider, model,
        dryRun, appliedLive, appliedLive ? new Date() : null,
      ]
    );

    return true;
  } catch (err) {
    console.error(`[processor] error processing transaction ${transaction.id}:`, err);
    return false;
  }
}
