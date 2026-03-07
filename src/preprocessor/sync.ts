import { gql } from '../client.js';
import { TRANSACTION_FIELDS } from '../tools/transactions.js';
import { pool } from '../shared/db.js';
import { runProcessor } from './processor.js';

interface GqlTag {
  id: string;
  name: string;
  colorName: string;
}

interface GqlTransaction {
  itemId: string;
  accountId: string;
  id: string;
  name: string | null;
  amount: number;
  date: string;
  type: string | null;
  categoryId: string | null;
  recurringId: string | null;
  isReviewed: boolean | null;
  isPending: boolean | null;
  userNotes: string | null;
  createdAt: number | null;
  tags: GqlTag[];
  suggestedCategoryIds: string[] | null;
}

interface TransactionsPage {
  edges: Array<{ cursor: string; node: GqlTransaction }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const SYNC_QUERY = `
  ${TRANSACTION_FIELDS}
  fragment SyncPaginationFields on TransactionPagination {
    edges { cursor node { ...TransactionFields } }
    pageInfo { endCursor hasNextPage }
  }
  query SyncTransactions($first: Int, $after: String, $filter: TransactionFilter) {
    transactions(first: $first, after: $after, filter: $filter) {
      ...SyncPaginationFields
    }
  }
`;

export interface SyncOptions {
  scope: 'recent' | 'full';
  trigger: 'firestore' | 'daily' | 'startup' | 'manual';
  windowDays?: number;
}

export async function runSync(options: SyncOptions): Promise<void> {
  const { scope, trigger, windowDays = 30 } = options;
  const runAt = new Date();
  let transactionsFetched = 0;
  let newCount = 0;
  let modifiedCount = 0;
  let preprocessedCount = 0;
  let error: string | null = null;

  const allKeys: Array<{ itemId: string; accountId: string; id: string }> = [];

  try {
    const filter: Record<string, unknown> = {};
    if (scope === 'recent') {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - windowDays);
      filter['startDate'] = startDate.toISOString().split('T')[0];
    }

    let after: string | null = null;
    let hasNext = true;

    while (hasNext) {
      const page = await gql<{ transactions: TransactionsPage }>(SYNC_QUERY, {
        first: 500,
        after,
        filter: Object.keys(filter).length ? filter : null,
      });

      const edges: TransactionsPage['edges'] = page.transactions.edges;
      const pageInfo: TransactionsPage['pageInfo'] = page.transactions.pageInfo;
      transactionsFetched += edges.length;


      for (const { node: tx } of edges) {
        const tagIds = tx.tags.map(t => t.id);
        const result = await pool.query<{ is_new: boolean }>(
          `INSERT INTO transactions
             (item_id, account_id, id, name, amount, date, type,
              category_id, recurring_id, is_reviewed, is_pending,
              tag_ids, user_notes, created_at, raw_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (item_id, account_id, id) DO UPDATE SET
             name = EXCLUDED.name,
             amount = EXCLUDED.amount,
             date = EXCLUDED.date,
             type = EXCLUDED.type,
             category_id = EXCLUDED.category_id,
             recurring_id = EXCLUDED.recurring_id,
             is_reviewed = EXCLUDED.is_reviewed,
             is_pending = EXCLUDED.is_pending,
             tag_ids = EXCLUDED.tag_ids,
             user_notes = EXCLUDED.user_notes,
             created_at = EXCLUDED.created_at,
             raw_json = EXCLUDED.raw_json,
             synced_at = now()
           RETURNING (xmax = 0) AS is_new`,
          [
            tx.itemId, tx.accountId, tx.id, tx.name, tx.amount, tx.date,
            tx.type, tx.categoryId, tx.recurringId, tx.isReviewed, tx.isPending,
            tagIds, tx.userNotes, tx.createdAt, JSON.stringify(tx),
          ]
        );

        if (result.rows[0]?.is_new) newCount++; else modifiedCount++;
        allKeys.push({ itemId: tx.itemId, accountId: tx.accountId, id: tx.id });
      }

      hasNext = pageInfo.hasNextPage;
      after = pageInfo.endCursor;
    }

    preprocessedCount = await runProcessor(allKeys);
  } catch (err) {
    error = String(err);
    console.error('[sync] error:', err);
  }

  await pool.query(
    `INSERT INTO sync_log
       (run_at, trigger, scope, transactions_fetched, new_count, modified_count, preprocessed_count, dry_run, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [runAt, trigger, scope, transactionsFetched, newCount, modifiedCount, preprocessedCount, false, error]
  );

  // 30-day retention
  await pool.query(`DELETE FROM sync_log WHERE run_at < NOW() - INTERVAL '30 days'`);

  console.log(
    `[sync] ${trigger}/${scope}: fetched=${transactionsFetched} new=${newCount} modified=${modifiedCount} preprocessed=${preprocessedCount}${error ? ` error=${error}` : ''}`
  );
}
