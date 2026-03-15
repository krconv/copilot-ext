import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gql, ok, registerTool } from '../client.js';

const ACCOUNT_FIELDS = `
  fragment AccountFields on Account {
    hasHistoricalUpdates latestBalanceUpdate hasLiveBalance
    institutionId isUserHidden isUserClosed liveBalance
    isManual balance subType itemId limit color name type mask id
  }
`;

export function registerAccountTools(server: McpServer): void {
  registerTool(
    server,
    'list_accounts',
    'List Accounts',
    `List all connected accounts with their current balances.
Account types: CREDIT, DEPOSITORY, INVESTMENT, LOAN, MORTGAGE, OTHER
By default returns visible, open accounts. Use includeHidden/includeClosed to see all.`,
    {
      type: z
        .enum(['CREDIT', 'DEPOSITORY', 'INVESTMENT', 'LOAN', 'MORTGAGE', 'OTHER'])
        .optional()
        .describe('Filter by account type'),
      includeHidden: z.boolean().default(false).describe('Include user-hidden accounts'),
      includeClosed: z.boolean().default(false).describe('Include closed accounts'),
    },
    async ({ type, includeHidden, includeClosed }) => {
      const query = `
        ${ACCOUNT_FIELDS}
        query Accounts($filter: AccountFilter) {
          accounts(filter: $filter) { ...AccountFields }
        }
      `;
      const filter: Record<string, unknown> = {};
      if (type) filter.type = type;
      if (includeHidden) filter.isHidden = null;
      if (includeClosed) filter.isClosed = null;
      const data = await gql<{ accounts: unknown }>(query, {
        filter: Object.keys(filter).length ? filter : null,
      });
      return ok(data.accounts);
    }
  );

  registerTool(
    server,
    'get_account',
    'Get Account',
    'Get details for a single account by its itemId and id. Both fields are available in list_accounts results.',
    {
      itemId: z.string().describe('Item/institution connection ID'),
      id: z.string().describe('Account ID'),
    },
    async ({ itemId, id }) => {
      const query = `
        ${ACCOUNT_FIELDS}
        query Account($itemId: ID!, $id: ID!) {
          account(itemId: $itemId, id: $id) { ...AccountFields }
        }
      `;
      const data = await gql<{ account: unknown }>(query, { itemId, id });
      return ok(data.account);
    }
  );

  registerTool(
    server,
    'get_account_live_balance',
    'Get Account Live Balance',
    'Fetch the real-time balance directly from the financial institution for an account. Only works for accounts where hasLiveBalance is true.',
    {
      itemId: z.string().describe('Item/institution connection ID'),
      accountId: z.string().describe('Account ID'),
    },
    async ({ itemId, accountId }) => {
      const query = `
        query AccountLiveBalance($itemId: ID!, $accountId: ID!) {
          accountLiveBalance(itemId: $itemId, accountId: $accountId) {
            balance date
          }
        }
      `;
      const data = await gql<{ accountLiveBalance: unknown }>(query, { itemId, accountId });
      return ok(data.accountLiveBalance);
    }
  );
}
