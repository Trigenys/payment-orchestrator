-- Extend the unused finance tables created in 001 without rewriting historical data.
ALTER TABLE payment_reconciliation_runs
  ADD COLUMN IF NOT EXISTS run_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_reconciliation_run_key_uq
  ON payment_reconciliation_runs (run_key) WHERE run_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_reconciliation_scope_idx
  ON payment_reconciliation_runs (project_id, merchant_id, subject_id, checked_at, id);
CREATE INDEX IF NOT EXISTS payment_ledger_entries_scope_idx
  ON payment_ledger_entries (project_id, merchant_id, payment_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_entry_once_per_kind
  ON payment_ledger_entries (batch_id, kind);
