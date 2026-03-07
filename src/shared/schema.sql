CREATE TABLE IF NOT EXISTS transactions (
  item_id        TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  id             TEXT NOT NULL,
  name           TEXT,
  amount         NUMERIC(12,2),
  date           DATE,
  type           TEXT,
  category_id    TEXT,
  recurring_id   TEXT,
  is_reviewed    BOOLEAN,
  is_pending     BOOLEAN,
  tag_ids        TEXT[],
  user_notes     TEXT,
  created_at     BIGINT,
  raw_json       JSONB NOT NULL,
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

CREATE TABLE IF NOT EXISTS sync_log (
  id                   SERIAL PRIMARY KEY,
  run_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger              TEXT NOT NULL,  -- 'firestore' | 'daily' | 'startup' | 'manual'
  scope                TEXT NOT NULL,  -- 'recent' (30d) | 'full' (all time)
  transactions_fetched INTEGER,
  new_count            INTEGER,
  modified_count       INTEGER,
  preprocessed_count   INTEGER,
  dry_run              BOOLEAN NOT NULL DEFAULT false,
  error                TEXT
);
