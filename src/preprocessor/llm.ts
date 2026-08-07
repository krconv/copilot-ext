import { generateText, tool, Output, isStepCount } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { pool } from '../shared/db.js';
import { type IdMaps } from './ids.js';

export const LLMResultSchema = z.object({
  name: z.string().optional().describe('Proper merchant name'),
  type: z.enum(['REGULAR', 'INCOME', 'INTERNAL_TRANSFER']).optional().describe('Transaction type'),
  categoryId: z.string().optional().describe('Category slug to apply'),
  tagIds: z.array(z.string()).optional().describe('Tag slugs to apply'),
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

export async function runPreprocessPrompt(
  systemPrompt: string,
  txJson: string,
  idMaps: IdMaps
): Promise<{ result: LLMResult; provider: string; model: string }> {
  const modelName = process.env['LLM_MODEL'] ?? 'claude-sonnet-4-6';

  const { output } = await generateText({
    model: anthropic(modelName),
    tools: {
      search_merchant_names: searchMerchantNames(),
      search_transactions: transactionSearch(idMaps),
      search_merchant_category_stats: searchMerchantCategoryStats(idMaps),
      web_search: anthropic.tools.webSearch_20250305({ maxUses: 3 }),
    },
    stopWhen: isStepCount(10),
    output: Output.object({ schema: LLMResultSchema }),
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

  return { result: output, provider: 'ai-sdk-anthropic', model: modelName };
}
