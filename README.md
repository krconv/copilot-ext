# copilot-ext

An extension layer for [Copilot Money](https://copilot.money) that adds two capabilities on top of the app's API:

1. **MCP server** — exposes Copilot's financial data as tools that any MCP-compatible AI client (Claude Desktop, Cursor, etc.) can call
2. **Transaction preprocessor** — runs an LLM in the background to automatically categorize, rename, and tag new transactions before you ever open the app

---

## Features

### MCP Server

A stateless HTTP server that exposes Copilot Money data as [Model Context Protocol](https://modelcontextprotocol.io) tools. Point any MCP client at `http://localhost:3000/mcp` and you can:

- **Transactions** — list, search, filter by date/category/tag, and edit transactions
- **Categories** — list, create, edit, delete, and set budgets
- **Tags** — list, create, and edit
- **Accounts** — list accounts and fetch live balances
- **Recurring transactions** — list and inspect recurring items
- **Investments** — access investment account data
- **Custom rules** — manage preprocessing rules (see below)

This lets you ask an AI assistant things like "summarize my dining spending last month" or "find all Amazon transactions over $50" directly from your editor or chat client.

### Transaction Preprocessor

A background daemon that watches for new transactions and runs them through a Claude-powered agent before they appear as "unreviewed" in your Copilot inbox.

**What it does per transaction:**

- Cleans up merchant names (e.g. `SQ *BLUE BOTTLE 4923 CA` → `Blue Bottle Coffee`)
- Assigns the most appropriate category from your existing category hierarchy
- Applies relevant tags
- Identifies transaction type (regular expense, income, or internal transfer)

**How the agent decides:**

The LLM receives the raw transaction alongside your full category/tag list, matched rule instructions, and has access to three tools:

- `search_merchant_names` — finds how you've named similar merchants in the past (uses trigram similarity on reviewed transactions)
- `search_transactions` — looks up similar transactions in your history
- `web_search` — identifies unfamiliar merchants (limited to 3 uses per transaction)

All decisions are stored in an audit log so you can see what the LLM changed and why.

### Custom Rules

Define glob patterns that match transaction names and inject additional instructions into the LLM prompt for those transactions. For example, a rule matching `"VENMO *"` could instruct the agent to always apply a specific tag or category.

### Dry-Run Mode

By default, the preprocessor runs in dry-run mode — it logs what it *would* change without touching your Copilot data. Set `DRY_RUN=false` to apply changes live.

---

## Setup

### Prerequisites

- Node.js 22+
- PostgreSQL 17+
- A Copilot Money account with a valid Firebase refresh token

### Environment Variables

Create a `.env` file:

```env
DATABASE_URL=postgres://copilot:copilot@localhost:5432/copilot_ext
FIREBASE_API_KEY=your_firebase_api_key
FIREBASE_REFRESH_TOKEN=your_firebase_refresh_token
LLM_MODEL=claude-sonnet-4-6
PORT=3000
DRY_RUN=true
```

### Running with Docker Compose

The easiest way to run both the server and the database:

```bash
docker compose up
```

This starts:
- The MCP + preprocessor server on port 3000
- PostgreSQL 17 with a persistent volume

### Running Locally

```bash
npm install
npm run db:migrate
npm run server
```

The MCP endpoint is available at `http://localhost:3000/mcp`.

---

## Connecting an MCP Client

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "copilot": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Cursor / other MCP clients

Point the client at `http://localhost:3000/mcp` using HTTP transport.

---

## Architecture

```
Copilot Money API (GraphQL)
         │
         ▼
┌─────────────────────────────────────┐
│          copilot-ext                │
│                                     │
│  MCP HTTP Server  (:3000/mcp)       │
│  └─ transactions, categories,       │
│     tags, accounts, investments...  │
│                                     │
│  Preprocessor Daemon                │
│  ├─ Firestore watcher (new txns)    │
│  ├─ Daily full resync (2 AM)        │
│  └─ Processing queue                │
│     └─ Claude agent per transaction │
│        ├─ merchant name search      │
│        ├─ transaction history       │
│        └─ web search                │
│                                     │
│  PostgreSQL                         │
│  ├─ synced transactions/categories  │
│  ├─ preprocessing audit log         │
│  └─ custom rules                    │
└─────────────────────────────────────┘
         │
         ▼ (live mode only)
  GraphQL mutations → Copilot backend
```

---

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript
- **MCP**: `@modelcontextprotocol/sdk`
- **LLM**: Claude via `@langchain/anthropic` + LangChain agent framework
- **Database**: PostgreSQL with `pg`
- **HTTP**: Express
- **Schema validation**: Zod

---

## Disclaimer

This project is not affiliated with or endorsed by Copilot Money. It interacts with Copilot's private GraphQL API, which may change without notice.
