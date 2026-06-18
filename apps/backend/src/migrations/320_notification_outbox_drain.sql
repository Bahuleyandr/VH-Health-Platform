-- 320_notification_outbox_drain.sql
--
-- Audit C-6 — drain the notification_outbox.
--
-- The outbox (notification_outbox) persists notification intent before the
-- inline send, but getPendingForRetry() had zero callers, so the durable-retry
-- guarantee was inert. A new drain cron (utils/scheduler.js
-- `notification-outbox-drain`) now claims due rows with FOR UPDATE SKIP LOCKED
-- and delivers them via the real send path.
--
-- The drain's claim query filters on:
--     status IN ('PENDING','FAILED')
--     AND retry_count < 3
--     AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '5 min')
--   ORDER BY created_at ASC
--   FOR UPDATE SKIP LOCKED
--
-- The baseline ships notification_outbox_status_retry_count_idx (status,
-- retry_count) and notification_outbox_created_at_idx (created_at). Those work,
-- but the hot drain path also discriminates on last_attempt_at within the
-- eligible statuses. This adds a PARTIAL composite index aligned to the exact
-- predicate so the claim stays index-driven as the table grows: only the two
-- drainable statuses are indexed (SENT rows — the vast majority over time — are
-- excluded), keyed by (status, last_attempt_at).
--
-- Design notes:
--   * CREATE INDEX IF NOT EXISTS — idempotent; re-running is a fast no-op.
--   * NOT run CONCURRENTLY: the migration runner wraps each file in a single
--     transaction (runMigrations.js), and CREATE INDEX CONCURRENTLY cannot run
--     inside a transaction. A plain CREATE INDEX takes a brief lock; the outbox
--     is a low-cardinality queue table so this is acceptable at deploy time.
--   * No schema/column change, no new table → no RLS/tenant_id work. The
--     notification_outbox table is an internal delivery queue (no tenant_id
--     column in the baseline); this migration does not change that.

BEGIN;

-- Partial composite index for the drain claim path.
CREATE INDEX IF NOT EXISTS notification_outbox_drain_idx
  ON public.notification_outbox (status, last_attempt_at)
  WHERE status IN ('PENDING', 'FAILED');

-- Audit stamp (idempotent, repo convention).
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NOTIFICATION_OUTBOX_DRAIN_INDEX_APPLIED',
  'notification_outbox',
  'notification_outbox',
  jsonb_build_object(
    'migration', '320_notification_outbox_drain.sql',
    'audit', 'C-6 (docs/PLATFORM_AUDIT_2026-06-18.md)',
    'reason', 'Partial composite index (status, last_attempt_at) WHERE status IN (PENDING,FAILED) for the new outbox drain claim path.',
    'new_index', 'notification_outbox_drain_idx'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NOTIFICATION_OUTBOX_DRAIN_INDEX_APPLIED'
    AND resource = 'notification_outbox'
);

COMMIT;
