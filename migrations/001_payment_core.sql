-- 001: Durable payment core and reserved financial processing tables.
-- Apply via npm run db:migrate; never connect test/live apps to the same schema.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_merchants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES payment_projects(id),
  display_name TEXT NOT NULL,
  country CHAR(2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','restricted','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, project_id)
);

CREATE TABLE IF NOT EXISTS payment_provider_accounts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES payment_merchants(id),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
  external_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','restricted','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, merchant_id),
  UNIQUE (provider, environment, external_account_id)
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES payment_projects(id),
  merchant_id TEXT NOT NULL,
  provider_account_id TEXT,
  external_reference TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','pending','authorized','succeeded','failed','cancelled','partially_refunded','refunded')),
  version INTEGER NOT NULL CHECK (version > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, external_reference),
  FOREIGN KEY (merchant_id, project_id) REFERENCES payment_merchants (id, project_id),
  FOREIGN KEY (provider_account_id, merchant_id) REFERENCES payment_provider_accounts (id, merchant_id)
);
CREATE INDEX IF NOT EXISTS payment_intents_merchant_idx ON payment_intents (project_id, merchant_id, status);

CREATE TABLE IF NOT EXISTS payment_creation_reservations (
  project_id TEXT NOT NULL REFERENCES payment_projects(id),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payment_id TEXT NOT NULL REFERENCES payment_intents(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, idempotency_key),
  UNIQUE (payment_id)
);

CREATE TABLE IF NOT EXISTS payment_provider_bindings (
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
  provider_payment_reference TEXT NOT NULL,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payment_intents(id),
  bound_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, environment, provider_payment_reference)
);

CREATE TABLE IF NOT EXISTS payment_provider_events (
  event_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
  event_id TEXT NOT NULL,
  payment_id TEXT REFERENCES payment_intents(id),
  received_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_events_payment_idx ON payment_provider_events (payment_id, received_at);

CREATE TABLE IF NOT EXISTS payment_transitions (
  id TEXT PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  payment_id TEXT NOT NULL REFERENCES payment_intents(id),
  source TEXT NOT NULL CHECK (source IN ('creation','provider_event')),
  source_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE(payment_id, source, source_id)
);
CREATE INDEX IF NOT EXISTS payment_transitions_payment_idx ON payment_transitions(payment_id, sequence);

-- The following tables are *reserved*: worker / webhook integrations in #27
-- are not implemented in this first payment-core persistence PR.
CREATE TABLE IF NOT EXISTS payment_webhook_inbox (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
  provider_reference TEXT NOT NULL,
  event_fingerprint TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','quarantined')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, environment, event_fingerprint)
);
CREATE TABLE IF NOT EXISTS payment_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES payment_projects(id),
  payment_id TEXT NOT NULL REFERENCES payment_intents(id),
  effect_key TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','delivered','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_until TIMESTAMPTZ,
  UNIQUE (project_id, destination, effect_key)
);
CREATE INDEX IF NOT EXISTS payment_outbox_pending_idx ON payment_outbox (status, next_attempt_at);
CREATE TABLE IF NOT EXISTS payment_ledger_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES payment_projects(id),
  source_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE(project_id, source_key)
);
CREATE TABLE IF NOT EXISTS payment_ledger_entries (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES payment_ledger_batches(id),
  project_id TEXT NOT NULL REFERENCES payment_projects(id),
  merchant_id TEXT NOT NULL REFERENCES payment_merchants(id),
  payment_id TEXT REFERENCES payment_intents(id),
  kind TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_reconciliation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES payment_projects(id),
  merchant_id TEXT NOT NULL REFERENCES payment_merchants(id),
  provider TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
