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

const TAG_FIELDS = `
  fragment TagFields on Tag {
    colorName name id
  }
`;

export function registerTagTools(server: McpServer): void {
  registerTool(
    server,
    'list_tags',
    'List all tags available in the workspace.',
    {},
    async () => {
      const query = `
        ${TAG_FIELDS}
        query Tags {
          tags { ...TagFields }
        }
      `;
      const data = await gql<{ tags: unknown }>(query);
      return ok(data.tags);
    }
  );

  registerTool(
    server,
    'create_tag',
    `Create a new tag. ${COLOR_DESC}`,
    {
      name: z.string().describe('Tag name'),
      colorName: z.enum(COLOR_NAMES).describe('Tag color'),
    },
    async ({ name, colorName }) => {
      const query = `
        ${TAG_FIELDS}
        mutation CreateTag($input: CreateTagInput!) {
          createTag(input: $input) { ...TagFields }
        }
      `;
      const data = await gql<{ createTag: unknown }>(query, { input: { name, colorName } });
      return ok(data.createTag);
    }
  );

  registerTool(
    server,
    'edit_tag',
    `Update an existing tag. All fields are optional. ${COLOR_DESC}`,
    {
      id: z.string().describe('Tag ID'),
      name: z.string().optional(),
      colorName: z.enum(COLOR_NAMES).optional(),
    },
    async ({ id, name, colorName }) => {
      const input: Record<string, unknown> = {};
      if (name !== undefined) input.name = name;
      if (colorName !== undefined) input.colorName = colorName;

      const query = `
        ${TAG_FIELDS}
        mutation EditTag($id: ID!, $input: EditTagInput!) {
          editTag(id: $id, input: $input) { ...TagFields }
        }
      `;
      const data = await gql<{ editTag: unknown }>(query, { id, input });
      return ok(data.editTag);
    }
  );
}
