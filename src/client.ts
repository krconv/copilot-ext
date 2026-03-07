import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToken } from './auth.js';

// ---------------------------------------------------------------------------
// Tool registration helper
//
// server.registerTool() has complex generics that cause TS2589
// ("Type instantiation is excessively deep and possibly infinite") when
// schemas contain enums or optional nested objects. This wrapper owns the
// type inference (inputSchema → handler args) and calls registerTool with
// `as any` to bypass the problematic SDK generics.
// ---------------------------------------------------------------------------

type ZodShape = Record<string, z.ZodTypeAny>;
type InferShape<T extends ZodShape> = { [K in keyof T]: z.infer<T[K]> };
type ToolContent = { content: Array<{ type: 'text'; text: string }> };

export function registerTool<T extends ZodShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: T,
  handler: (args: InferShape<T>) => Promise<ToolContent>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, { description, inputSchema }, handler);
}

const GRAPHQL_URL = 'https://app.copilot.money/api/graphql';

export async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const token = await getToken();
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json() as { data: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

/** Recursively remove __typename fields from API responses */
export function strip<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map(strip) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === '__typename') continue;
      result[k] = strip(v);
    }
    return result as T;
  }
  return obj;
}

export function ok(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(strip(data), null, 2) }] };
}
