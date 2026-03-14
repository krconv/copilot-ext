CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS categories (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  color_name           TEXT,
  is_rollover_disabled BOOLEAN NOT NULL DEFAULT false,
  is_excluded          BOOLEAN NOT NULL DEFAULT false,
  parent_id            TEXT REFERENCES categories(id),
  description          TEXT,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color_name  TEXT,
  is_excluded BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recurrings (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  state       TEXT NOT NULL,
  frequency   TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id),
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  item_id        TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  id             TEXT NOT NULL,
  name           TEXT,
  amount         NUMERIC(12,2),
  date           DATE,
  type           TEXT,
  category_id    TEXT REFERENCES categories(id),
  recurring_id   TEXT,
  is_reviewed    BOOLEAN,
  is_pending     BOOLEAN,
  tag_ids        TEXT[],
  user_notes     TEXT,
  created_at     BIGINT,
  raw_json       JSONB NOT NULL,
  original_name        TEXT,
  original_category_id TEXT REFERENCES categories(id),
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, account_id, id)
);

CREATE TABLE IF NOT EXISTS transaction_preprocess_results (
  id               SERIAL PRIMARY KEY,
  item_id          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  transaction_id   TEXT NOT NULL,

  -- Snapshot at time of preprocessing
  orig_name        TEXT,
  orig_category_id TEXT,
  orig_type        TEXT,
  orig_notes       TEXT,
  orig_tag_ids     TEXT[],

  -- Debug: which rule IDs matched
  matched_rule_ids INTEGER[],

  -- LLM output
  llm_name         TEXT,
  llm_category_id  TEXT,
  llm_type         TEXT,
  llm_notes        TEXT,
  llm_tag_ids      TEXT[],
  llm_debug        TEXT,
  llm_raw_output   JSONB,
  llm_provider     TEXT,
  llm_model        TEXT,

  dry_run          BOOLEAN NOT NULL DEFAULT false,
  applied          BOOLEAN NOT NULL DEFAULT false,
  applied_at       TIMESTAMPTZ,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (item_id, account_id, transaction_id)
    REFERENCES transactions (item_id, account_id, id)
);

CREATE TABLE IF NOT EXISTS rules (
  id          SERIAL PRIMARY KEY,
  match       TEXT NOT NULL UNIQUE,  -- glob: * = any chars, ? = one char (case-insensitive)
  instruction TEXT NOT NULL,
  archived    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  item_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT,
  sub_type       TEXT,
  mask           TEXT,
  balance        NUMERIC(12,2),
  is_user_hidden BOOLEAN,
  is_user_closed BOOLEAN,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, id)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single row
  refresh_token TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_log (
  id                   SERIAL PRIMARY KEY,
  run_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger              TEXT NOT NULL,  -- 'firestore' | 'daily' | 'startup' | 'manual'
  scope                TEXT NOT NULL,  -- 'recent' (30d) | 'full' (all time)
  transactions_fetched INTEGER,
  new_count            INTEGER,
  modified_count       INTEGER,
  dry_run              BOOLEAN NOT NULL DEFAULT false,
  error                TEXT
);

-- Migrations for existing tables
ALTER TABLE transaction_preprocess_results ADD COLUMN IF NOT EXISTS llm_debug TEXT;
