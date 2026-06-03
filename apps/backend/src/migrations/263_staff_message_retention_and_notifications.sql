-- Migration 263: Staff message retention and tenant-scoped notifications.
--
-- Staff messages are operational communications, not a permanent clinical
-- record. Keep the default retention at 30 days and add indexes for the
-- scheduled purge job. Also tenant-scope notifications so the central staff
-- notification service can safely fan out operational alerts across tenants.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL
    DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'tenants'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_notifications_tenant'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT fk_notifications_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created
  ON notifications (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_read
  ON notifications (tenant_id, user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_uid_read
  ON notifications (tenant_id, uid, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_messages_tenant_created
  ON staff_messages (tenant_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_staff_messages_created_at
  ON staff_messages (created_at ASC);

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'STAFF_MESSAGE_RETENTION_APPLIED',
  'staff_messages',
  'staff_messages',
  jsonb_build_object(
    'migration', '263_staff_message_retention_and_notifications.sql',
    'message_retention_days', 30,
    'notifications_tenant_scoped', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'STAFF_MESSAGE_RETENTION_APPLIED'
    AND resource = 'staff_messages'
);

COMMIT;
