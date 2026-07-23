-- Migration 593: durable, generation-scoped patient notification receipts.
--
-- A patient notification is queued only after the shared structured-result
-- visibility predicate passes. The receipt and notification_outbox intent are
-- committed together, and the unique generation/kind key makes scheduler
-- replay harmless. This migration sends nothing and performs no backfill.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_outbox_tenant_id
  ON notification_outbox (tenant_id, id);

CREATE TABLE diagnostic_result_patient_notifications (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  generation_id UUID NOT NULL,
  patient_uid UUID NOT NULL,
  notification_kind VARCHAR(40) NOT NULL,
  policy_version VARCHAR(80) NOT NULL,
  notification_outbox_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_diagnostic_patient_notification_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_diagnostic_patient_notification_generation_kind
    UNIQUE (tenant_id, generation_id, notification_kind),
  CONSTRAINT fk_diagnostic_patient_notification_generation
    FOREIGN KEY (tenant_id, generation_id, patient_uid)
    REFERENCES diagnostic_result_generations (tenant_id, id, patient_uid),
  CONSTRAINT fk_diagnostic_patient_notification_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_diagnostic_patient_notification_outbox
    FOREIGN KEY (tenant_id, notification_outbox_id)
    REFERENCES notification_outbox (tenant_id, id),
  CONSTRAINT chk_diagnostic_patient_notification_kind CHECK (
    notification_kind = 'result_ready'
  ),
  CONSTRAINT chk_diagnostic_patient_notification_policy CHECK (
    policy_version = 'structured_diagnostic_result_ready.v1'
  )
);

CREATE INDEX idx_diagnostic_patient_notification_patient_time
  ON diagnostic_result_patient_notifications
     (tenant_id, patient_uid, created_at DESC, id DESC);

ALTER TABLE diagnostic_result_patient_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostic_result_patient_notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON diagnostic_result_patient_notifications
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

CREATE TRIGGER trg_diagnostic_patient_notifications_append_only
BEFORE UPDATE OR DELETE ON diagnostic_result_patient_notifications
FOR EACH ROW EXECUTE FUNCTION diagnostic_result_evidence_append_only();

COMMENT ON TABLE diagnostic_result_patient_notifications IS
  'Append-only delivery receipt linking one visible diagnostic generation to one durable patient notification intent.';

COMMIT;
