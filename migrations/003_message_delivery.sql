-- Schema-only worker safety for #24/#27. Delivery endpoints are NOT activated here.
ALTER TABLE payment_outbox
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS last_failure_code TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS payment_outbox_claim_idx
  ON payment_outbox (project_id, status, next_attempt_at, leased_until);
ALTER TABLE payment_webhook_inbox
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
