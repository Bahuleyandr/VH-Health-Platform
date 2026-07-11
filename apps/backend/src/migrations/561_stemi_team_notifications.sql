-- NL-13 P1c: durable Code-STEMI cath-team fan-out and acknowledgement proof.
-- Realtime delivery is notification-only; these rows remain the source of
-- truth for who was notified and who acknowledged.

BEGIN;

CREATE TABLE IF NOT EXISTS stemi_team_notifications (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  activation_id BIGINT NOT NULL,
  staff_id INTEGER,
  staff_uid UUID NOT NULL,
  role_code VARCHAR(80),
  assignment_source VARCHAR(32) NOT NULL DEFAULT 'on_call_role',
  notification_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  notification_outbox_id INTEGER,
  notified_at TIMESTAMPTZ(6),
  acknowledged_by_uid UUID,
  acknowledged_at TIMESTAMPTZ(6),
  acknowledgement_note TEXT,
  notification_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  canonical_timeline_event_id UUID,
  canonical_audit_event_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stemi_team_notifications_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_stemi_team_notifications_activation
    FOREIGN KEY (activation_id) REFERENCES stemi_activations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stemi_team_notifications_staff
    FOREIGN KEY (staff_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_team_notifications_staff_uid
    FOREIGN KEY (staff_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_stemi_team_notifications_outbox
    FOREIGN KEY (notification_outbox_id) REFERENCES notification_outbox(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_team_notifications_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT fk_stemi_team_notifications_audit
    FOREIGN KEY (canonical_audit_event_id) REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  CONSTRAINT stemi_team_notifications_assignment_source_check CHECK (
    assignment_source IN ('explicit', 'on_call_role')
  ),
  CONSTRAINT stemi_team_notifications_status_check CHECK (
    notification_status IN ('pending', 'notified', 'acknowledged', 'failed')
  ),
  CONSTRAINT stemi_team_notifications_payload_object CHECK (
    jsonb_typeof(notification_payload) = 'object'
  ),
  CONSTRAINT stemi_team_notifications_ack_check CHECK (
    notification_status <> 'acknowledged'
    OR (acknowledged_by_uid IS NOT NULL AND acknowledged_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stemi_team_notifications_member
  ON stemi_team_notifications (tenant_id, activation_id, staff_uid);

CREATE INDEX IF NOT EXISTS idx_stemi_team_notifications_activation
  ON stemi_team_notifications (tenant_id, activation_id, notification_status, created_at);

CREATE INDEX IF NOT EXISTS idx_stemi_team_notifications_staff
  ON stemi_team_notifications (tenant_id, staff_uid, notification_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stemi_team_notifications_outbox
  ON stemi_team_notifications (notification_outbox_id)
  WHERE notification_outbox_id IS NOT NULL;

ALTER TABLE stemi_team_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE stemi_team_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stemi_team_notifications;
CREATE POLICY tenant_isolation ON stemi_team_notifications
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMIT;
