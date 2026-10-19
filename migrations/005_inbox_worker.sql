-- Fapshi sandbox inbox worker: durable retry schedule and fenced claims.
-- Additive: existing received messages remain eligible after migration.
ALTER TABLE payment_webhook_inbox
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS payment_inbox_claim_idx
  ON payment_webhook_inbox (provider, environment, status, next_attempt_at, leased_until);

-- Prevent status='processed' from accidentally re-entering the queue.
-- Worker claims only 'received' or expired 'processing' records.
