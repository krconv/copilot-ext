import { generateText, tool, isStepCount } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { pool } from '../shared/db.js';
import { type IdMaps } from './ids.js';

export const LLMResultSchema = z.object({
  name: z.string().optional().describe('Proper merchant name'),
  type: z.enum(['REGULAR', 'INCOME', 'INTERNAL_TRANSFER']).optional().describe('Transaction type'),
  categoryId: z.string().optional().describe('Category slug to apply'),
  tagIds: z.array(z.string()).optional().describe('Tag slugs to apply'),
  notes: z.string().optional().describe('Free-form note. Put the specific product/service/location here when the merchant name is the parent brand (e.g. note "Supercharger" when name is "Tesla"). Never restate the merchant name. Do not overwrite existing user notes.'),
  recurringId: z.string().nullable().optional().describe('Slug of the recurring item this transaction clearly belongs to (same merchant/subscription). Omit to leave unchanged; pass null to remove an existing recurring link that is clearly wrong.'),
  debug: z.string().optional().describe('Concise explanation of decisions made — what was changed and why, or why fields were left unchanged'),
});

export type LLMResult = z.infer<typeof LLMResultSchema>;

function searchMerchantNames() {
  return tool({
    description:
      'Find existing merchant name variants in this account. Call this before setting a name — ' +
      'the goal is to use whatever canonical form is already established, not invent a new one. ' +
      'Returns { name, transactions }[] sorted by similarity; prefer the variant with the highest transaction count. ' +
      'If no results exist, use the clean recognizable merchant name.',
    inputSchema: z.object({
      query: z.string().describe('Merchant name or keyword to search for'),
      limit: z.number().optional().describe('Max results to return (default 20)'),
      offset: z.number().optional().describe('Offset for pagination (default 0)'),
    }),
    execute: async ({ query, limit = 20, offset = 0 }) => {
      const result = await pool.query<{ name: string; transactions: number }>(
        `SELECT name, COUNT(*)::int AS transactions
         FROM transactions
         WHERE name ILIKE $1
           AND is_reviewed = true
           AND name IS NOT NULL
         GROUP BY name
         ORDER BY similarity(name, $2) DESC
         LIMIT $3 OFFSET $4`,
        [`%${query}%`, query, limit, offset]
      );
      return result.rows;
    },
  });
}

function transactionSearch(idMaps: IdMaps) {
  return tool({
    description:
      'Search past transactions by keyword across original_name, cleaned name, and notes. ' +
      'Returns recent matches with their category and type — use this to resolve cryptic bank codes ' +
      'or confirm how a merchant has been categorised before.',
    inputSchema: z.object({
      query: z.string().describe('Keyword or merchant name to search for'),
    }),
    execute: async ({ query }) => {
      const result = await pool.query<{
        name: string | null;
        original_name: string | null;
        user_notes: string | null;
        amount: string;
        date: string;
        category_id: string | null;
        type: string | null;
      }>(
        `SELECT name, original_name, user_notes, amount, date, category_id, type
         FROM transactions
         WHERE original_name ILIKE $1 OR name ILIKE $1 OR user_notes ILIKE $1
         ORDER BY date DESC
         LIMIT 15`,
        [`%${query}%`]
      );
      return result.rows.map(row => ({
        ...row,
        category_id: row.category_id
          ? (idMaps.categoryIdToSlug[row.category_id] ?? row.category_id)
          : null,
      }));
    },
  });
}

function searchMerchantCategoryStats(idMaps: IdMaps) {
  return tool({
    description:
      'Given a merchant name or keyword, returns how that merchant has been categorised historically ' +
      'as a distribution of { category, count } sorted by frequency. ' +
      'Use this to anchor categorization on the user\'s actual history rather than guessing — ' +
      'the most frequent category is usually the right one.',
    inputSchema: z.object({
      query: z.string().describe('Merchant name or keyword to search for'),
    }),
    execute: async ({ query }) => {
      const result = await pool.query<{ category_id: string; count: number }>(
        `SELECT category_id, COUNT(*)::int AS count
         FROM transactions
         WHERE (name ILIKE $1 OR original_name ILIKE $1)
           AND category_id IS NOT NULL
         GROUP BY category_id
         ORDER BY count DESC
         LIMIT 10`,
        [`%${query}%`]
      );
      return result.rows.map(row => ({
        category: idMaps.categoryIdToSlug[row.category_id] ?? row.category_id,
        count: row.count,
      }));
    },
  });
}

function searchRecurrings(idMaps: IdMaps) {
  return tool({
    description:
      'Look up recurring items (subscriptions, memberships, regular bills) by name. ' +
      'Use when a charge looks like it could be a recurring subscription or bill and is not already ' +
      'linked to a recurring. Returns { recurringId, name, frequency }[]; set the transaction\'s ' +
      'recurringId to the matching recurringId (a slug). Only link on an obvious match.',
    inputSchema: z.object({
      query: z.string().describe('Merchant or subscription name to search for'),
    }),
    execute: async ({ query }) => {
      const result = await pool.query<{ id: string; name: string; frequency: string }>(
        `SELECT id, name, frequency
         FROM recurrings
         WHERE state != 'DELETED' AND name ILIKE $1
         ORDER BY name
         LIMIT 20`,
        [`%${query}%`]
      );
      return result.rows.map(r => ({
        recurringId: idMaps.recurringIdToSlug[r.id] ?? r.id,
        name: r.name,
        frequency: r.frequency,
      }));
    },
  });
}

const SkipSchema = z.object({
  reason: z.string().describe('Why you could not confidently determine the merchant and/or categorization'),
});

export interface PreprocessOutcome {
  result: LLMResult;
  unresolved: boolean;
  unresolvedReason?: string;
  provider: string;
  model: string;
}

/** Validate that every id the model submitted is a real slug we can resolve. */
function validateResultIds(input: LLMResult, idMaps: IdMaps): string[] {
  const errs: string[] = [];
  if (input.categoryId !== undefined && !(input.categoryId in idMaps.categories)) {
    errs.push(`Unknown category "${input.categoryId}" — use one of the category slugs listed in the prompt (not a tag).`);
  }
  for (const t of input.tagIds ?? []) {
    if (!(t in idMaps.tags)) errs.push(`Unknown tag "${t}" — use one of the tag slugs listed in the prompt.`);
  }
  if (input.recurringId != null && !(input.recurringId in idMaps.recurrings)) {
    errs.push(`Unknown recurring "${input.recurringId}" — use a recurringId returned by search_recurrings.`);
  }
  return errs;
}

export async function runPreprocessPrompt(
  systemPrompt: string,
  txJson: string,
  idMaps: IdMaps
): Promise<PreprocessOutcome> {
  const modelName = process.env['LLM_MODEL'] ?? 'claude-sonnet-4-6';
  const provider = 'ai-sdk-anthropic';

  // The agent finishes by calling submit_result or skip. submit_result validates
  // its ids: on a bad category/tag/recurring it returns an error the model sees
  // and retries — the loop stops only on a *valid* submit (or skip), tracked via
  // `done`. So an unresolved slug can never be written to Copilot, and there is
  // no "model stopped without emitting an object" failure mode.
  let captured: LLMResult | null = null;
  let skippedReason: string | null = null;
  let done = false;

  await generateText({
    model: anthropic(modelName),
    tools: {
      search_merchant_names: searchMerchantNames(),
      search_transactions: transactionSearch(idMaps),
      search_merchant_category_stats: searchMerchantCategoryStats(idMaps),
      search_recurrings: searchRecurrings(idMaps),
      web_search: anthropic.tools.webSearch_20250305({ maxUses: 3 }),
      submit_result: tool({
        description:
          'Submit your final decision for this transaction. Include every field you want to set; ' +
          'omit fields you are leaving unchanged. If this returns an error, fix the invalid value and call it again.',
        inputSchema: LLMResultSchema,
        execute: async (input) => {
          const errs = validateResultIds(input, idMaps);
          if (errs.length > 0) return { ok: false, error: errs.join(' ') };
          captured = input;
          done = true;
          return { ok: true };
        },
      }),
      skip: tool({
        description:
          'Leave this transaction unchanged. Call this instead of submit_result when you cannot ' +
          'confidently determine the merchant name and/or categorization — do not force a guess.',
        inputSchema: SkipSchema,
        execute: async ({ reason }) => {
          skippedReason = reason;
          done = true;
          return { ok: true };
        },
      }),
    },
    stopWhen: [isStepCount(15), () => done],
    // The catalog goes in `instructions` (a system message), not `messages` —
    // the AI SDK rejects role:'system' entries in `messages`. The ephemeral
    // cacheControl breakpoint stays on it so the catalog prefix is cached across
    // tool-call round-trips; the per-transaction user message stays uncached.
    instructions: {
      role: 'system',
      content: systemPrompt,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    messages: [{ role: 'user', content: txJson }],
  });

  if (captured) {
    return { result: captured, unresolved: false, provider, model: modelName };
  }
  return {
    result: {},
    unresolved: true,
    unresolvedReason: skippedReason ?? 'agent ended without submitting a valid result',
    provider,
    model: modelName,
  };
}
