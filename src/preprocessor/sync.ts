import { gql } from '../client.js';
import { TRANSACTION_FIELDS } from '../tools/transactions.js';
import { pool } from '../shared/db.js';
import { enqueueTransactions } from './queue.js';
import { clearIdMapsCache } from './ids.js';

interface GqlCategory {
  id: string;
  name: string;
  colorName: string;
  isRolloverDisabled: boolean;
  isExcluded: boolean;
  childCategories: GqlCategory[];
}

interface GqlAccount {
  itemId: string;
  id: string;
  name: string;
  type: string | null;
  subType: string | null;
  mask: string | null;
  balance: number | null;
  isUserHidden: boolean | null;
  isUserClosed: boolean | null;
}

interface GqlRecurring {
  id: string;
  name: string;
  state: string;
  frequency: string;
  categoryId: string | null;
}

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
  query SyncTransactions($first: Int, $after: String, $filter: TransactionFilter, $sort: [TransactionSort!]) {
    transactions(first: $first, after: $after, filter: $filter, sort: $sort) {
      ...SyncPaginationFields
    }
  }
`;

export interface SyncOptions {
  scope: 'recent' | 'full';
  trigger: 'firestore' | 'daily' | 'startup' | 'manual';
  windowDays: number;
}

async function syncCategories(): Promise<void> {
  const data = await gql<{ categories: GqlCategory[] }>(`
    query SyncCategories {
      categories {
        id name colorName isRolloverDisabled isExcluded
        childCategories { id name colorName isRolloverDisabled isExcluded }
      }
    }
  `);

  for (const cat of data.categories) {
    await pool.query(
      `INSERT INTO categories (id, name, color_name, is_rollover_disabled, is_excluded, parent_id)
       VALUES ($1,$2,$3,$4,$5,NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         color_name = EXCLUDED.color_name,
         is_rollover_disabled = EXCLUDED.is_rollover_disabled,
         is_excluded = EXCLUDED.is_excluded,
         synced_at = now()`,
      [cat.id, cat.name, cat.colorName, cat.isRolloverDisabled, cat.isExcluded]
    );
    for (const child of cat.childCategories) {
      await pool.query(
        `INSERT INTO categories (id, name, color_name, is_rollover_disabled, is_excluded, parent_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           color_name = EXCLUDED.color_name,
           is_rollover_disabled = EXCLUDED.is_rollover_disabled,
           is_excluded = EXCLUDED.is_excluded,
           parent_id = EXCLUDED.parent_id,
           synced_at = now()`,
        [child.id, child.name, child.colorName, child.isRolloverDisabled, child.isExcluded, cat.id]
      );
    }
  }

  console.log(`[sync] categories: synced ${data.categories.length} parents`);
}

async function syncTags(): Promise<void> {
  const data = await gql<{ tags: GqlTag[] }>(`
    query SyncTags {
      tags { id name colorName }
    }
  `);

  const activeIds = data.tags.map(t => t.id);

  for (const tag of data.tags) {
    await pool.query(
      `INSERT INTO tags (id, name, color_name, is_excluded)
       VALUES ($1,$2,$3,false)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         color_name = EXCLUDED.color_name,
         is_excluded = false,
         synced_at = now()`,
      [tag.id, tag.name, tag.colorName]
    );
  }

  // Soft-delete tags no longer returned by the API
  if (activeIds.length > 0) {
    await pool.query(
      `UPDATE tags SET is_excluded = true WHERE id NOT IN (SELECT unnest($1::text[]))`,
      [activeIds]
    );
  } else {
    await pool.query(`UPDATE tags SET is_excluded = true`);
  }

  console.log(`[sync] tags: synced ${data.tags.length}`);
}

async function syncRecurrings(): Promise<void> {
  const data = await gql<{ recurrings: GqlRecurring[] }>(`
    query SyncRecurrings($filter: RecurringFilter) {
      recurrings(filter: $filter) {
        id name state frequency categoryId
      }
    }
  `, { filter: null });

  for (const r of data.recurrings) {
    await pool.query(
      `INSERT INTO recurrings (id, name, state, frequency, category_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         state = EXCLUDED.state,
         frequency = EXCLUDED.frequency,
         category_id = EXCLUDED.category_id,
         synced_at = now()`,
      [r.id, r.name, r.state, r.frequency, r.categoryId ?? null]
    );
  }

  // Soft-delete recurrings no longer returned by the API (mark as DELETED)
  const activeIds = data.recurrings.map(r => r.id);
  if (activeIds.length > 0) {
    await pool.query(
      `UPDATE recurrings SET state = 'DELETED' WHERE id NOT IN (SELECT unnest($1::text[]))`,
      [activeIds]
    );
  } else {
    await pool.query(`UPDATE recurrings SET state = 'DELETED'`);
  }

  console.log(`[sync] recurrings: synced ${data.recurrings.length}`);
}

async function syncAccounts(): Promise<void> {
  const data = await gql<{ accounts: GqlAccount[] }>(`
    query SyncAccounts {
      accounts(filter: null) {
        itemId id name type subType mask balance isUserHidden isUserClosed
      }
    }
  `);

  for (const acct of data.accounts) {
    await pool.query(
      `INSERT INTO accounts (item_id, id, name, type, sub_type, mask, balance, is_user_hidden, is_user_closed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (item_id, id) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         sub_type = EXCLUDED.sub_type,
         mask = EXCLUDED.mask,
         balance = EXCLUDED.balance,
         is_user_hidden = EXCLUDED.is_user_hidden,
         is_user_closed = EXCLUDED.is_user_closed,
         synced_at = now()`,
      [acct.itemId, acct.id, acct.name, acct.type, acct.subType, acct.mask,
       acct.balance, acct.isUserHidden, acct.isUserClosed]
    );
  }

  console.log(`[sync] accounts: synced ${data.accounts.length}`);
}

let isSyncing = false;

export async function runSync(options: SyncOptions): Promise<void> {
  if (isSyncing) {
    console.log(`[sync] ${options.trigger}/${options.scope}: skipped, sync already in progress`);
    return;
  }
  isSyncing = true;

  const { scope, trigger, windowDays } = options;
  const runAt = new Date();
  let transactionsFetched = 0;
  let newCount = 0;
  let modifiedCount = 0;
  let error: string | null = null;

  const allKeys: Array<{ itemId: string; accountId: string; id: string }> = [];

  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().split('T')[0]

  try {
    clearIdMapsCache();
    await syncCategories();
    await Promise.all([syncTags(), syncAccounts(), syncRecurrings()]);

    let after: string | null = null;
    let hasNext = true;
    let reachedCutoff = false;

    while (hasNext && !reachedCutoff) {
      const page = await gql<{ transactions: TransactionsPage }>(SYNC_QUERY, {
        first: 500,
        after,
        filter: null,
        sort: [{ field: 'DATE', direction: 'DESC' }],
      });

      const edges: TransactionsPage['edges'] = page.transactions.edges;
      const pageInfo: TransactionsPage['pageInfo'] = page.transactions.pageInfo;

      for (const { node: transaction } of edges) {
        // Stop early when we've passed the window (API returns DATE DESC order)
        if (cutoff && transaction.date < cutoff) {
          reachedCutoff = true;
          break;
        }
        transactionsFetched++;

        const tagIds = transaction.tags.map(tag => tag.id);
        const result = await pool.query<{ is_new: boolean }>(
          `INSERT INTO transactions
             (item_id, account_id, id, name, amount, date, type,
              category_id, recurring_id, is_reviewed, is_pending,
              tag_ids, user_notes, created_at, raw_json,
              original_name, original_category_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$4,$8)
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
             original_name = CASE
               WHEN transactions.is_pending = true AND EXCLUDED.is_pending = false
               THEN EXCLUDED.name
               ELSE transactions.original_name
             END,
             original_category_id = CASE
               WHEN transactions.is_pending = true AND EXCLUDED.is_pending = false
               THEN EXCLUDED.category_id
               ELSE transactions.original_category_id
             END,
             synced_at = now()
           RETURNING (xmax = 0) AS is_new`,
          [
            transaction.itemId, transaction.accountId, transaction.id, transaction.name, transaction.amount, transaction.date,
            transaction.type, transaction.categoryId || null, transaction.recurringId || null, transaction.isReviewed, transaction.isPending,
            tagIds, transaction.userNotes, transaction.createdAt, JSON.stringify(transaction),
          ]
        );

        if (result.rows[0]?.is_new) newCount++; else modifiedCount++;
        allKeys.push({ itemId: transaction.itemId, accountId: transaction.accountId, id: transaction.id });
      }

      hasNext = pageInfo.hasNextPage;
      after = pageInfo.endCursor;
    }

    enqueueTransactions(allKeys);
  } catch (err) {
    error = String(err);
    console.error('[sync] error:', err);
  } finally {
    isSyncing = false;
  }

  const dryRun = process.env['DRY_RUN'] !== 'false';

  await pool.query(
    `INSERT INTO sync_log
       (run_at, trigger, scope, transactions_fetched, new_count, modified_count, dry_run, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [runAt, trigger, scope, transactionsFetched, newCount, modifiedCount, dryRun, error]
  );

  // 30-day retention
  await pool.query(`DELETE FROM sync_log WHERE run_at < NOW() - INTERVAL '30 days'`);

  console.log(
    `[sync] ${trigger}/${scope}: fetched=${transactionsFetched} new=${newCount} modified=${modifiedCount}${error ? ` error=${error}` : ''}`
  );
}
