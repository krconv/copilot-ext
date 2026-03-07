import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gql, ok, registerTool } from '../client.js';

const TIME_FRAMES = [
  'ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'ALL_TIME',
] as const;

const TF_DESC = `TimeFrame options: ${TIME_FRAMES.join(', ')}`;

export function registerInvestmentTools(server: McpServer): void {
  registerTool(
    server,
    'get_networth_history',
    `Get net worth history (assets and debt) over a time period. ${TF_DESC}`,
    {
      timeFrame: z.enum(TIME_FRAMES).default('ONE_MONTH').describe('Time range for history'),
    },
    async ({ timeFrame }) => {
      const query = `
        query Networth($timeFrame: TimeFrame) {
          networthHistory(timeFrame: $timeFrame) {
            assets date debt
          }
        }
      `;
      const data = await gql<{ networthHistory: unknown }>(query, { timeFrame });
      return ok(data.networthHistory);
    }
  );

  registerTool(
    server,
    'get_investment_summary',
    `Get investment portfolio summary: balance history and asset allocation breakdown.
${TF_DESC}
AllocationType options: TYPE (by security type), ACCOUNT (by account)`,
    {
      timeFrame: z.enum(TIME_FRAMES).default('ONE_MONTH').describe('Time range for balance history'),
      allocationType: z.enum(['TYPE', 'ACCOUNT']).optional().describe('How to group allocation breakdown'),
    },
    async ({ timeFrame, allocationType }) => {
      const balanceQuery = `
        query InvestmentBalance($timeFrame: TimeFrame) {
          investmentBalance(timeFrame: $timeFrame) {
            id date balance
          }
        }
      `;
      const allocationQuery = `
        query InvestmentAllocation($filter: AllocationFilter) {
          investmentAllocation(filter: $filter) {
            percentage amount type id
          }
        }
      `;
      const [balanceData, allocationData] = await Promise.all([
        gql<{ investmentBalance: unknown }>(balanceQuery, { timeFrame }),
        gql<{ investmentAllocation: unknown }>(allocationQuery, {
          filter: allocationType ?? null,
        }),
      ]);
      return ok({
        balanceHistory: balanceData.investmentBalance,
        allocation: allocationData.investmentAllocation,
      });
    }
  );

  registerTool(
    server,
    'get_holdings',
    'Get all investment holdings across all accounts, including security details, quantity, cost basis, and total return.',
    {},
    async () => {
      const query = `
        query Holdings {
          holdings {
            security {
              currentPrice lastUpdate symbol name type id
            }
            metrics { averageCost totalReturn costBasis }
            accountId quantity itemId id
          }
        }
      `;
      const data = await gql<{ holdings: unknown }>(query);
      return ok(data.holdings);
    }
  );
}
