import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool } from '../client.js';
import { pool } from '../shared/db.js';

interface Rule {
  id: number;
  match: string;
  instruction: string;
  archived: boolean;
  created_at: Date;
}

export function registerRulesTools(server: McpServer): void {
  registerTool(
    server,
    'list_rules',
    'List transaction preprocessing rules. Rules are glob patterns (* = any chars, ? = one char, case-insensitive) matched against transaction names during preprocessing.',
    { includeArchived: z.boolean().default(false).describe('Include archived rules') },
    async ({ includeArchived }) => {
      const result = await pool.query<Rule>(
        includeArchived
          ? 'SELECT * FROM rules ORDER BY id'
          : 'SELECT * FROM rules WHERE archived = false ORDER BY id'
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.rows, null, 2) }] };
    }
  );

  registerTool(
    server,
    'create_rule',
    'Create a new preprocessing rule. The match pattern is a glob (case-insensitive) matched against transaction names. The instruction is added to the LLM prompt when the rule matches.',
    {
      match: z.string().describe('Glob pattern to match against transaction name (e.g. "AMZN *", "TST *")'),
      instruction: z.string().describe('Hint for the LLM when this rule matches (e.g. "This is an Amazon purchase")'),
    },
    async ({ match, instruction }) => {
      const result = await pool.query<Rule>(
        'INSERT INTO rules (match, instruction) VALUES ($1, $2) RETURNING *',
        [match, instruction]
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.rows[0], null, 2) }] };
    }
  );

  registerTool(
    server,
    'update_rule',
    'Update the match pattern and/or instruction of an existing rule.',
    {
      id: z.number().int().describe('Rule ID'),
      match: z.string().optional().describe('New glob pattern'),
      instruction: z.string().optional().describe('New instruction'),
    },
    async ({ id, match, instruction }) => {
      const updates: string[] = [];
      const values: unknown[] = [];
      if (match !== undefined) updates.push(`match = $${values.push(match)}`);
      if (instruction !== undefined) updates.push(`instruction = $${values.push(instruction)}`);
      if (updates.length === 0) throw new Error('No fields to update');
      values.push(id);
      const result = await pool.query<Rule>(
        `UPDATE rules SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (result.rows.length === 0) throw new Error(`Rule ${id} not found`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.rows[0], null, 2) }] };
    }
  );

  registerTool(
    server,
    'archive_rule',
    'Archive a rule (soft delete). Archived rules are excluded from preprocessing matches.',
    { id: z.number().int().describe('Rule ID') },
    async ({ id }) => {
      const result = await pool.query<Rule>(
        'UPDATE rules SET archived = true WHERE id = $1 RETURNING *',
        [id]
      );
      if (result.rows.length === 0) throw new Error(`Rule ${id} not found`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.rows[0], null, 2) }] };
    }
  );

  registerTool(
    server,
    'unarchive_rule',
    'Restore a previously archived rule.',
    { id: z.number().int().describe('Rule ID') },
    async ({ id }) => {
      const result = await pool.query<Rule>(
        'UPDATE rules SET archived = false WHERE id = $1 RETURNING *',
        [id]
      );
      if (result.rows.length === 0) throw new Error(`Rule ${id} not found`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.rows[0], null, 2) }] };
    }
  );
}
