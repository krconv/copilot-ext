import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { registerTransactionTools } from './tools/transactions.js';
import { registerCategoryTools } from './tools/categories.js';
import { registerTagTools } from './tools/tags.js';
import { registerRecurringTools } from './tools/recurrings.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerInvestmentTools } from './tools/investments.js';
import { registerUserTools } from './tools/user.js';
import { registerRulesTools } from './tools/rules.js';
import { migrate } from './shared/migrate.js';
import { startPreprocessor } from './preprocessor/index.js';
import { startProcessingLoop } from './preprocessor/queue.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const app = express();
app.use(cors());
app.use(express.json());

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'copilot-money', version: '1.0.0' });
  registerTransactionTools(server);
  registerCategoryTools(server);
  registerTagTools(server);
  registerRecurringTools(server);
  registerAccountTools(server);
  registerInvestmentTools(server);
  registerUserTools(server);
  registerRulesTools(server);
  return server;
}

async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => transport.close());
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Stateless: create a new transport + server instance per request.
// This avoids session management complexity and stale-session errors on restart.
// Serve at both / and /mcp so clients can use either URL.
app.post('/', handleMcp);
app.post('/mcp', handleMcp);

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

async function main(): Promise<void> {
  await migrate();

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(PORT, () => resolve());
    srv.on('error', reject);
  });
  console.log(`Copilot Money MCP server running on http://localhost:${PORT}`);

  // Preprocessor runs in the same process — errors are logged, not fatal
  startPreprocessor().catch(err => console.error('[preprocessor] fatal:', err));
  
  startProcessingLoop().catch(err => console.error('[processor] fatal:', err));
}

main().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
