import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { registerTransactionTools } from './tools/transactions.js';
import { registerCategoryTools } from './tools/categories.js';
import { registerTagTools } from './tools/tags.js';
import { registerRecurringTools } from './tools/recurrings.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerInvestmentTools } from './tools/investments.js';
import { registerUserTools } from './tools/user.js';
import { registerRulesTools } from './tools/rules.js';
import { startPreprocessor } from './preprocessor/index.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const app = express();
app.use(cors());
app.use(express.json());

const mcpServer = new McpServer({ name: 'copilot-money', version: '1.0.0' });
registerTransactionTools(mcpServer);
registerCategoryTools(mcpServer);
registerTagTools(mcpServer);
registerRecurringTools(mcpServer);
registerAccountTools(mcpServer);
registerInvestmentTools(mcpServer);
registerUserTools(mcpServer);
registerRulesTools(mcpServer);

// Track active SSE transports by session ID
const transports = new Map<string, SSEServerTransport>();

app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  res.on('close', () => transports.delete(transport.sessionId));
  await mcpServer.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query['sessionId'] as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Copilot Money MCP server running on http://localhost:${PORT}`);
  startPreprocessor().catch(err => console.error('[preprocessor] startup error:', err));
});
