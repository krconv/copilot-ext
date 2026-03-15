import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gql, ok, registerTool } from '../client.js';

export const TRANSACTION_FIELDS = `
  fragment TagFields on Tag {
    colorName name id
  }
  fragment TransactionFields on Transaction {
    suggestedCategoryIds recurringId categoryId isReviewed
    accountId createdAt isPending userNotes itemId amount
    date name type id
    tags { ...TagFields }
  }
`;

export const TRANSACTION_PAGINATION = `
  ${TRANSACTION_FIELDS}
  fragment TransactionPaginationFields on TransactionPagination {
    edges { cursor node { ...TransactionFields } }
    pageInfo { endCursor hasNextPage hasPreviousPage startCursor }
  }
`;

export const EDIT_TRANSACTION_MUTATION = `
  ${TRANSACTION_FIELDS}
  mutation EditTransaction($itemId: ID!, $accountId: ID!, $id: ID!, $input: EditTransactionInput) {
    editTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
      transaction { ...TransactionFields }
    }
  }
`;

const filterSchema = {
  startDate: z.string().optional().describe('Start date YYYY-MM-DD'),
  endDate: z.string().optional().describe('End date YYYY-MM-DD'),
  categoryIds: z.array(z.string()).optional(),
  accountIds: z.array(z.string()).optional(),
  recurringId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  isReviewed: z.boolean().optional(),
  isPending: z.boolean().optional(),
  search: z.string().optional().describe('Full-text search on transaction name'),
  minAmount: z.number().optional().describe('Minimum absolute amount'),
  maxAmount: z.number().optional().describe('Maximum absolute amount'),
};

const sortSchema = {
  sortField: z.enum(['DATE', 'AMOUNT', 'NAME']).default('DATE'),
  sortDirection: z.enum(['ASC', 'DESC']).default('DESC'),
};

type FilterArgs = Partial<{
  startDate: string; endDate: string; categoryIds: string[]; accountIds: string[];
  recurringId: string; tagIds: string[]; isReviewed: boolean; isPending: boolean;
  search: string; minAmount: number; maxAmount: number;
}>;

function buildFilter(args: FilterArgs) {
  const f: Record<string, unknown> = {};
  const keys = Object.keys(filterSchema) as (keyof typeof filterSchema)[];
  for (const key of keys) {
    if ((args as Record<string, unknown>)[key] !== undefined) {
      f[key] = (args as Record<string, unknown>)[key];
    }
  }
  return Object.keys(f).length ? f : null;
}

export function registerTransactionTools(server: McpServer): void {
  registerTool(
    server,
    'list_transactions',
    'List Transactions',
    'List and filter transactions with pagination. Returns transactions with their ids, amounts, dates, categories, tags, and notes. Use pageInfo.endCursor + after param to paginate.',
    {
      ...filterSchema,
      ...sortSchema,
      first: z.number().int().min(1).max(500).default(50).describe('Number of transactions to return'),
      after: z.string().optional().describe('Cursor for pagination (from previous pageInfo.endCursor)'),
    },
    async (args) => {
      const query = `
        ${TRANSACTION_PAGINATION}
        query Transactions($first: Int, $after: String, $filter: TransactionFilter, $sort: [TransactionSort!]) {
          transactions(first: $first, after: $after, filter: $filter, sort: $sort) {
            ...TransactionPaginationFields
          }
        }
      `;
      const data = await gql<{ transactions: unknown }>(query, {
        first: args.first,
        after: args.after,
        filter: buildFilter(args),
        sort: [{ field: args.sortField, direction: args.sortDirection }],
      });
      return ok(data.transactions);
    }
  );

  registerTool(
    server,
    'get_transaction',
    'Get Transaction',
    'Get a single transaction by its composite key (itemId + accountId + id). All three fields are required and can be found in list_transactions results.',
    {
      itemId: z.string().describe('Item/institution connection ID'),
      accountId: z.string().describe('Account ID'),
      id: z.string().describe('Transaction ID'),
    },
    async ({ itemId, accountId, id }) => {
      const query = `
        ${TRANSACTION_FIELDS}
        query Transaction($itemId: ID!, $accountId: ID!, $id: ID!) {
          transaction(itemId: $itemId, accountId: $accountId, id: $id) {
            ...TransactionFields
          }
        }
      `;
      const data = await gql<{ transaction: unknown }>(query, { itemId, accountId, id });
      return ok(data.transaction);
    }
  );

  registerTool(
    server,
    'edit_transaction',
    'Edit Transaction',
    `Update editable fields on a transaction. Requires the composite key (itemId + accountId + id).

All input fields are optional — only provide what you want to change:
- name: Override merchant/transaction name
- categoryId: Set category
- tagIds: Replace all tags (pass empty array to remove all)
- userNotes: Free-form notes. The first line appears as a title suffix in the app (e.g. note "Bike" on "Wal-Mart" shows as "Wal-Mart: Bike")
- recurringId: Link to a recurring rule
- isReviewed: Mark as reviewed
- amount: Override amount
- date: Override date (YYYY-MM-DD)`,
    {
      itemId: z.string(),
      accountId: z.string(),
      id: z.string(),
      name: z.string().optional(),
      amount: z.number().optional(),
      date: z.string().optional().describe('YYYY-MM-DD'),
      categoryId: z.string().optional(),
      recurringId: z.string().optional(),
      isReviewed: z.boolean().optional(),
      userNotes: z.string().optional(),
      tagIds: z.array(z.string()).optional().describe('Replaces all existing tags'),
    },
    async ({ itemId, accountId, id, name, amount, date, categoryId, recurringId, isReviewed, userNotes, tagIds }) => {
      const input: Record<string, unknown> = {};
      if (name !== undefined) input.name = name;
      if (amount !== undefined) input.amount = amount;
      if (date !== undefined) input.date = date;
      if (categoryId !== undefined) input.categoryId = categoryId;
      if (recurringId !== undefined) input.recurringId = recurringId;
      if (isReviewed !== undefined) input.isReviewed = isReviewed;
      if (userNotes !== undefined) input.userNotes = userNotes;
      if (tagIds !== undefined) input.tagIds = tagIds;

      const query = `
        ${TRANSACTION_FIELDS}
        mutation EditTransaction($itemId: ID!, $accountId: ID!, $id: ID!, $input: EditTransactionInput) {
          editTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
            transaction { ...TransactionFields }
          }
        }
      `;
      const data = await gql<{ editTransaction: { transaction: unknown } }>(query, {
        itemId, accountId, id, input,
      });
      return ok(data.editTransaction.transaction);
    }
  );

  registerTool(
    server,
    'get_transactions_summary',
    'Get Transactions Summary',
    'Get aggregate stats (total count, net income, total income, total spent) for a set of transactions matching the given filter.',
    { ...filterSchema },
    async (args) => {
      const query = `
        query TransactionSummary($filter: TransactionFilter) {
          transactionsSummary(filter: $filter) {
            transactionsCount totalNetIncome totalIncome totalSpent
          }
        }
      `;
      const data = await gql<{ transactionsSummary: unknown }>(query, { filter: buildFilter(args) });
      return ok(data.transactionsSummary);
    }
  );

  registerTool(
    server,
    'export_transactions',
    'Export Transactions',
    'Get a CSV download URL for transactions matching the given filter. The URL expires after a short period.',
    { ...filterSchema, ...sortSchema },
    async (args) => {
      const query = `
        query ExportTransactions($filter: TransactionFilter, $sort: [TransactionSort!]) {
          exportTransactions(filter: $filter, sort: $sort) {
            expiresAt url
          }
        }
      `;
      const data = await gql<{ exportTransactions: unknown }>(query, {
        filter: buildFilter(args),
        sort: [{ field: args.sortField, direction: args.sortDirection }],
      });
      return ok(data.exportTransactions);
    }
  );
}
