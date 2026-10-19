-- 004: Conservative shared verification budget for the Fapshi sandbox pilot.
-- Fapshi documents at most six status queries per minute/transId. Our cap is five.
CREATE TABLE IF NOT EXISTS fapshi_status_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment = 'sandbox'),
  provider_reference TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fapshi_status_attempts_recent_idx
  ON fapshi_status_attempts (environment, provider_reference, attempted_at DESC);
