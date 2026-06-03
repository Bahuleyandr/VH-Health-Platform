-- Migration 264: Notification read/acknowledgement/escalation history.
--
-- Notification state must be traceable independently of the current
-- notifications.is_read flag. This append-only table records who read or
-- acknowledged an alert, and when an unread critical alert was escalated.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL
    DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  event_type      VARCHAR(40) NOT NULL,
  actor_uid       UUID,
  actor_role      VARCHAR(80),
  recipient_user_id INTEGER,
  recipient_uid   UUID,
  notification_type VARCHAR(80),
  notification_priority VARCHAR(40),
  related_id      INTEGER,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT notification_events_event_type_chk
    CHECK (event_type IN ('delivered', 'read', 'acknowledged', 'escalated', 'auto_escalated'))
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'tenants'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_notification_events_tenant'
  ) THEN
    ALTER TABLE notification_events
      ADD CONSTRAINT fk_notification_events_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_notification_events_notification_created
  ON notification_events (notification_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_tenant_created
  ON notification_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_tenant_type_created
  ON notification_events (tenant_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_critical_lookup
  ON notification_events (tenant_id, notification_id, event_type)
  WHERE event_type IN ('escalated', 'auto_escalated', 'acknowledged');

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NOTIFICATION_EVENT_HISTORY_APPLIED',
  'notification_events',
  'notification_events',
  jsonb_build_object(
    'migration', '264_notification_event_history.sql',
    'read_ack_history', true,
    'critical_escalation_history', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NOTIFICATION_EVENT_HISTORY_APPLIED'
    AND resource = 'notification_events'
);

COMMIT;
