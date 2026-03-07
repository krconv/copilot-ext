import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gql, ok, registerTool } from '../client.js';

const COLOR_NAMES = [
  'RED1', 'RED2', 'ORANGE1', 'ORANGE2', 'YELLOW1', 'YELLOW2',
  'GREEN1', 'GREEN2', 'TEAL1', 'TEAL2', 'BLUE1', 'BLUE2',
  'PURPLE1', 'PURPLE2', 'PINK1', 'PINK2', 'BROWN1',
  'GRAY1', 'GRAY2', 'OLIVE1', 'OLIVE2',
] as const;

const COLOR_DESC = `Color options: ${COLOR_NAMES.join(', ')}`;

const CATEGORY_FIELDS = `
  fragment SpendMonthlyFields on CategoryMonthlySpent {
    unpaidRecurringAmount paidRecurringAmount comparisonAmount amount month id
  }
  fragment SpendFields on CategorySpend {
    current { ...SpendMonthlyFields }
    histories { ...SpendMonthlyFields }
  }
  fragment BudgetMonthlyFields on CategoryMonthlyBudget {
    unassignedRolloverAmount childRolloverAmount unassignedAmount
    resolvedAmount rolloverAmount childAmount goalAmount amount month id
  }
  fragment BudgetFields on CategoryBudget {
    current { ...BudgetMonthlyFields }
    histories { ...BudgetMonthlyFields }
  }
  fragment CategoryFields on Category {
    isRolloverDisabled canBeDeleted isExcluded templateId colorName name id
  }
`;

export function registerCategoryTools(server: McpServer): void {
  registerTool(
    server,
    'list_categories',
    'List all categories including their spend and budget data for the current and past months. Returns parent categories with their child categories nested.',
    {
      includeSpend: z.boolean().default(true).describe('Include spend history'),
      includeBudget: z.boolean().default(true).describe('Include budget data'),
    },
    async ({ includeSpend, includeBudget }) => {
      const query = `
        ${CATEGORY_FIELDS}
        query Categories($spend: Boolean = false, $budget: Boolean = false) {
          categories {
            ...CategoryFields
            spend @include(if: $spend) { ...SpendFields }
            budget @include(if: $budget) { ...BudgetFields }
            childCategories {
              ...CategoryFields
              spend @include(if: $spend) { ...SpendFields }
              budget @include(if: $budget) { ...BudgetFields }
            }
          }
        }
      `;
      const data = await gql<{ categories: unknown }>(query, {
        spend: includeSpend,
        budget: includeBudget,
      });
      return ok(data.categories);
    }
  );

  registerTool(
    server,
    'create_category',
    `Create a new category (or category group). ${COLOR_DESC}
To create a category group, pass childCategoryIds with the IDs of existing categories to include.`,
    {
      name: z.string().describe('Category name'),
      colorName: z.enum(COLOR_NAMES).describe('Color for the category'),
      isExcluded: z.boolean().optional().describe('Exclude from budget/spend tracking'),
      childCategoryIds: z.array(z.string()).optional().describe('IDs of categories to nest under this group'),
    },
    async ({ name, colorName, isExcluded, childCategoryIds }) => {
      const query = `
        ${CATEGORY_FIELDS}
        mutation CreateCategory($input: CreateCategoryInput!) {
          createCategory(input: $input) {
            ...CategoryFields
            childCategories { ...CategoryFields }
          }
        }
      `;
      const data = await gql<{ createCategory: unknown }>(query, {
        input: { name, colorName, isExcluded, childCategoryIds },
      });
      return ok(data.createCategory);
    }
  );

  registerTool(
    server,
    'edit_category',
    `Update an existing category. All input fields are optional. ${COLOR_DESC}`,
    {
      id: z.string().describe('Category ID'),
      name: z.string().optional(),
      colorName: z.enum(COLOR_NAMES).optional(),
      isExcluded: z.boolean().optional(),
      childCategoryIds: z.array(z.string()).optional(),
    },
    async ({ id, name, colorName, isExcluded, childCategoryIds }) => {
      const input: Record<string, unknown> = {};
      if (name !== undefined) input.name = name;
      if (colorName !== undefined) input.colorName = colorName;
      if (isExcluded !== undefined) input.isExcluded = isExcluded;
      if (childCategoryIds !== undefined) input.childCategoryIds = childCategoryIds;

      const query = `
        ${CATEGORY_FIELDS}
        mutation EditCategory($id: ID!, $input: EditCategoryInput!) {
          editCategory(id: $id, input: $input) {
            category {
              ...CategoryFields
              childCategories { ...CategoryFields }
            }
          }
        }
      `;
      const data = await gql<{ editCategory: { category: unknown } }>(query, { id, input });
      return ok(data.editCategory.category);
    }
  );

  registerTool(
    server,
    'delete_category',
    'Delete a category. Will fail if canBeDeleted is false (category has transactions or child categories). Check canBeDeleted field from list_categories first.',
    {
      id: z.string().describe('Category ID'),
    },
    async ({ id }) => {
      const query = `
        mutation DeleteCategory($id: ID!) {
          deleteCategory(id: $id)
        }
      `;
      const data = await gql<{ deleteCategory: boolean }>(query, { id });
      return ok({ success: data.deleteCategory, id });
    }
  );

  registerTool(
    server,
    'set_category_budget',
    'Set a uniform monthly budget amount for a category (applies to all future months).',
    {
      categoryId: z.string().describe('Category ID'),
      amount: z.number().describe('Budget amount in dollars'),
    },
    async ({ categoryId, amount }) => {
      const query = `
        mutation EditBudget($categoryId: ID!, $input: EditCategoryBudgetInput!) {
          editCategoryBudget(categoryId: $categoryId, input: $input)
        }
      `;
      const data = await gql<{ editCategoryBudget: boolean }>(query, {
        categoryId,
        input: { amount },
      });
      return ok({ success: data.editCategoryBudget, categoryId, amount });
    }
  );

  registerTool(
    server,
    'set_category_budget_monthly',
    'Set the budget for a specific month for a category. Use this to override the default budget for a particular month.',
    {
      categoryId: z.string().describe('Category ID'),
      amount: z.number().describe('Budget amount in dollars for this month'),
      month: z.string().describe('Month in YYYY-MM format (e.g. "2024-03")'),
    },
    async ({ categoryId, amount, month }) => {
      const query = `
        mutation EditBudgetMonthly($categoryId: ID!, $input: [EditCategoryBudgetMonthlyInput!]!) {
          editCategoryBudgetMonthly(categoryId: $categoryId, input: $input)
        }
      `;
      const data = await gql<{ editCategoryBudgetMonthly: boolean }>(query, {
        categoryId,
        input: [{ amount, month }],
      });
      return ok({ success: data.editCategoryBudgetMonthly, categoryId, amount, month });
    }
  );
}
