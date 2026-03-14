import { createAgent, tool, providerStrategy } from 'langchain';
import { ChatAnthropic, tools as anthropicTools } from '@langchain/anthropic';
import { z } from 'zod';
import { pool } from '../shared/db.js';
import { type IdMaps } from './ids.js';

const LLMResultSchema = z.object({
  name: z.string().optional().describe('Proper merchant name'),
  type: z.enum(['REGULAR', 'INCOME', 'INTERNAL_TRANSFER']).optional().describe('Transaction type'),
  categoryId: z.string().optional().describe('Category slug to apply'),
  tagIds: z.array(z.string()).optional().describe('Tag slugs to apply'),
  debug: z.string().optional().describe('Concise explanation of decisions made — what was changed and why, or why fields were left unchanged'),
});

export type LLMResult = z.infer<typeof LLMResultSchema>;


function searchMerchantNames() {
  return tool(
    async ({ query, limit = 20, offset = 0 }: { query: string; limit?: number; offset?: number }) => {
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
      return JSON.stringify(result.rows);
    },
    {
      name: 'search_merchant_names',
      description:
        'Find existing merchant name variants in this account. Call this before setting a name — ' +
        'the goal is to use whatever canonical form is already established, not invent a new one. ' +
        'Returns { name, transactions }[] sorted by similarity; prefer the variant with the highest transaction count. ' +
        'If no results exist, use the clean recognizable merchant name.',
      schema: z.object({
        query: z.string().describe('Merchant name or keyword to search for'),
        limit: z.number().optional().describe('Max results to return (default 20)'),
        offset: z.number().optional().describe('Offset for pagination (default 0)'),
      }),
    }
  );
}

function transactionSearch(idMaps: IdMaps) {
  return tool(
    async ({ query }: { query: string }) => {
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
      const rows = result.rows.map(row => ({
        ...row,
        category_id: row.category_id
          ? (idMaps.categoryIdToSlug[row.category_id] ?? row.category_id)
          : null,
      }));
      return JSON.stringify(rows);
    },
    {
      name: 'search_transactions',
      description:
        'Search past transactions by keyword across original_name, cleaned name, and notes. ' +
        'Returns recent matches with their category and type — use this to resolve cryptic bank codes ' +
        'or confirm how a merchant has been categorised before.',
      schema: z.object({
        query: z.string().describe('Keyword or merchant name to search for'),
      }),
    }
  );
}

export async function runPreprocessPrompt(
  systemPrompt: string,
  txJson: string,
  idMaps: IdMaps
): Promise<{ result: LLMResult; provider: string; model: string }> {
  const modelName = process.env['LLM_MODEL'] ?? 'claude-sonnet-4-6';

  const agent = createAgent({
    model: new ChatAnthropic({ model: modelName }),
    tools: [searchMerchantNames(), transactionSearch(idMaps), anthropicTools.webSearch_20250305({ maxUses: 3 })],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseFormat: providerStrategy(LLMResultSchema as any),
  });

  const agentResult = await agent.invoke({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: txJson },
    ],
  });

  const result = agentResult.structuredResponse as LLMResult;

  return { result, provider: 'langchain-anthropic', model: modelName };
}
