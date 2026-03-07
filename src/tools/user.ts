import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gql, ok, registerTool } from '../client.js';

export function registerUserTools(server: McpServer): void {
  registerTool(
    server,
    'get_user',
    'Get the current authenticated user profile including budgeting configuration, onboarding status, and subscription end date.',
    {},
    async () => {
      const query = `
        query User {
          user {
            budgetingConfig {
              isEnabled
              rolloversConfig {
                isEnabled startDate
                categories { isRolloverDisabled canBeDeleted isExcluded colorName name id }
              }
            }
            onboarding { lastCompletedStep isCompleted }
            serviceEndsOn termsStatus id
          }
        }
      `;
      const data = await gql<{ user: unknown }>(query);
      return ok(data.user);
    }
  );
}
