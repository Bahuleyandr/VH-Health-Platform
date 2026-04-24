-- 080_failed_notifications.sql
-- Ports the `failed_notifications` table from the legacy
-- apps/backend/migrations/022_missing_emr_tables.sql into the canonical
-- src/migrations/ tree.
--
-- Before: notificationRetryService + healthController queried this table
-- but runMigrations() at server startup never applied 022 (legacy tree).
-- Result: cron jobs logged errors every cycle:
--   relation "failed_notifications" does not exist
-- and health-check endpoints returned 500 for the notification-backlog check.
--
-- Idempotent CREATE / CREATE INDEX — safe against envs that already ran 022.

CREATE TABLE IF NOT EXISTS failed_notifications (
  id            SERIAL PRIMARY KEY,
  user_id       UUID,
  type          VARCHAR(20) NOT NULL DEFAULT 'push',
  phone         VARCHAR(20),
  device_token  TEXT,
  title         VARCHAR(255),
  body          TEXT,
  data          JSONB,
  error_message TEXT,
  retry_count   INTEGER DEFAULT 0,
  max_retries   INTEGER DEFAULT 4,
  last_retry_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  status        VARCHAR(20) DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_notifications_status
  ON failed_notifications(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_failed_notifications_user
  ON failed_notifications(user_id);
