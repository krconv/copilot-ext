import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gql, ok, registerTool } from '../client.js';

const RECURRING_FIELDS = `
  fragment RecurringPaymentFields on RecurringPayment {
    amount isPaid date
  }
  fragment RecurringRuleFields on RecurringRule {
    nameContains minAmount maxAmount days
  }
  fragment RecurringFields on Recurring {
    nextPaymentAmount nextPaymentDate categoryId frequency state name id
  }
`;

const FREQUENCY_VALUES = [
  'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'BIMONTHLY',
  'QUARTERLY', 'SEMIANNUALLY', 'ANNUALLY', 'IRREGULAR',
] as const;

const FREQ_DESC = `Frequency options: ${FREQUENCY_VALUES.join(', ')}`;

export function registerRecurringTools(server: McpServer): void {
  registerTool(
    server,
    'list_recurrings',
    'List recurring payment rules. Can filter by state (ACTIVE/PAUSED/DELETED) and/or category. Returns rule details including next payment date, amount, and matched payment history.',
    {
      state: z.enum(['ACTIVE', 'PAUSED', 'DELETED']).optional().describe('Filter by recurring state'),
      categoryId: z.string().optional().describe('Filter by category ID'),
    },
    async ({ state, categoryId }) => {
      const query = `
        ${RECURRING_FIELDS}
        query Recurrings($filter: RecurringFilter) {
          recurrings(filter: $filter) {
            ...RecurringFields
            rule { ...RecurringRuleFields }
            payments { ...RecurringPaymentFields }
          }
        }
      `;
      const filter: Record<string, unknown> = {};
      if (state) filter.state = state;
      if (categoryId) filter.categoryId = categoryId;
      const data = await gql<{ recurrings: unknown }>(query, {
        filter: Object.keys(filter).length ? filter : null,
      });
      return ok(data.recurrings);
    }
  );

  registerTool(
    server,
    'get_recurring',
    'Get a single recurring rule by ID, including its detection rule and payment history.',
    {
      id: z.string().describe('Recurring rule ID'),
    },
    async ({ id }) => {
      const query = `
        ${RECURRING_FIELDS}
        query Recurring($id: ID!) {
          recurring(id: $id) {
            ...RecurringFields
            rule { ...RecurringRuleFields }
            payments { ...RecurringPaymentFields }
          }
        }
      `;
      const data = await gql<{ recurring: unknown }>(query, { id });
      return ok(data.recurring);
    }
  );

  registerTool(
    server,
    'list_upcoming_recurrings',
    'List all active recurring rules with their next payment date and amount.',
    {},
    async () => {
      const query = `
        ${RECURRING_FIELDS}
        query Recurrings($filter: RecurringFilter) {
          recurrings(filter: $filter) {
            ...RecurringFields
            rule { ...RecurringRuleFields }
            payments { ...RecurringPaymentFields }
          }
        }
      `;
      const data = await gql<{ recurrings: unknown }>(query, { filter: { state: 'ACTIVE' } });
      return ok(data.recurrings);
    }
  );

  registerTool(
    server,
    'list_unpaid_upcoming_recurrings',
    'List active recurring rules that have upcoming unpaid payments. Only includes recurrings where the next payment has not been matched/paid yet.',
    {},
    async () => {
      const query = `
        ${RECURRING_FIELDS}
        query UpcomingRecurrings {
          unpaidUpcomingRecurrings {
            ...RecurringFields
            rule { ...RecurringRuleFields }
            payments { ...RecurringPaymentFields }
          }
        }
      `;
      const data = await gql<{ unpaidUpcomingRecurrings: unknown }>(query);
      return ok(data.unpaidUpcomingRecurrings);
    }
  );

  registerTool(
    server,
    'create_recurring',
    `Create a new recurring payment rule. ${FREQ_DESC}
Optionally link a seed transaction to help the rule detect future payments.`,
    {
      name: z.string().describe('Recurring rule name (e.g. "Netflix", "Rent")'),
      frequency: z.enum(FREQUENCY_VALUES).describe('Payment frequency'),
      categoryId: z.string().optional().describe('Category to assign matched transactions'),
      // Flattened to avoid nested optional objects causing TS2589
      transactionId: z.string().optional().describe('Seed transaction ID (optional)'),
      transactionAccountId: z.string().optional().describe('Account ID of seed transaction'),
      transactionItemId: z.string().optional().describe('Item ID of seed transaction'),
    },
    async ({ name, frequency, categoryId, transactionId, transactionAccountId, transactionItemId }) => {
      const input: Record<string, unknown> = { name, frequency };
      if (categoryId) input.categoryId = categoryId;
      if (transactionId && transactionAccountId && transactionItemId) {
        input.transaction = {
          transactionId,
          accountId: transactionAccountId,
          itemId: transactionItemId,
        };
      }

      const query = `
        ${RECURRING_FIELDS}
        mutation CreateRecurring($input: CreateRecurringInput!) {
          createRecurring(input: $input) {
            ...RecurringFields
            rule { ...RecurringRuleFields }
            payments { ...RecurringPaymentFields }
          }
        }
      `;
      const data = await gql<{ createRecurring: unknown }>(query, { input });
      return ok(data.createRecurring);
    }
  );

  registerTool(
    server,
    'edit_recurring',
    `Update an existing recurring rule. All fields are optional. ${FREQ_DESC}`,
    {
      id: z.string().describe('Recurring rule ID'),
      name: z.string().optional(),
      frequency: z.enum(FREQUENCY_VALUES).optional(),
      categoryId: z.string().optional(),
    },
    async ({ id, name, frequency, categoryId }) => {
      const input: Record<string, unknown> = {};
      if (name !== undefined) input.name = name;
      if (frequency !== undefined) input.frequency = frequency;
      if (categoryId !== undefined) input.categoryId = categoryId;

      const query = `
        ${RECURRING_FIELDS}
        mutation EditRecurring($id: ID!, $input: EditRecurringInput!) {
          editRecurring(id: $id, input: $input) {
            recurring {
              ...RecurringFields
              rule { ...RecurringRuleFields }
              payments { ...RecurringPaymentFields }
            }
          }
        }
      `;
      const data = await gql<{ editRecurring: { recurring: unknown } }>(query, { id, input });
      return ok(data.editRecurring.recurring);
    }
  );

  registerTool(
    server,
    'delete_recurring',
    'Delete a recurring rule by ID. This removes the rule and stops future transaction matching.',
    {
      id: z.string().describe('Recurring rule ID'),
    },
    async ({ id }) => {
      const query = `
        mutation DeleteRecurring($deleteRecurringId: ID!) {
          deleteRecurring(id: $deleteRecurringId)
        }
      `;
      const data = await gql<{ deleteRecurring: boolean }>(query, { deleteRecurringId: id });
      return ok({ success: data.deleteRecurring, id });
    }
  );
}
