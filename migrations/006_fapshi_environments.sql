-- The shared status budget applies independently to sandbox and live.
-- Existing sandbox rows and their rolling-window reservations are preserved.
ALTER TABLE fapshi_status_attempts
  DROP CONSTRAINT fapshi_status_attempts_environment_check;
ALTER TABLE fapshi_status_attempts
  ADD CONSTRAINT fapshi_status_attempts_environment_check
  CHECK (environment IN ('sandbox', 'live'));
