-- 479_scheduling2_slot_holds.sql
--
-- NL8-P4: short-lived appointment slot holds for kiosk, patient app, staff,
-- and call-centre checkout flows. Holds sit above the existing appointments
-- table and expire without becoming a booking system of their own.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS appointment_slot_holds (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  doctor_id         INTEGER NOT NULL,
  appointment_date  DATE NOT NULL,
  slot_start        TIME NOT NULL,
  slot_end          TIME NOT NULL,
  source_channel    VARCHAR(30) NOT NULL,
  idempotency_key   VARCHAR(160) NOT NULL,
  hold_token        UUID NOT NULL DEFAULT gen_random_uuid(),
  held_by_uid       UUID,
  held_by_role      VARCHAR(60),
  patient_uid       UUID,
  expires_at        TIMESTAMPTZ(6) NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'held',
  appointment_id    INTEGER,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_appointment_slot_holds_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_appointment_slot_holds_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION,
  CONSTRAINT fk_appointment_slot_holds_appointment
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
  CONSTRAINT chk_appointment_slot_holds_window
    CHECK (slot_end > slot_start),
  CONSTRAINT chk_appointment_slot_holds_source
    CHECK (source_channel IN ('kiosk', 'patient_app', 'staff', 'call_centre', 'admin')),
  CONSTRAINT chk_appointment_slot_holds_status
    CHECK (status IN ('held', 'confirmed', 'expired', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_appointment_slot_holds_idempotency_active
  ON appointment_slot_holds (tenant_id, idempotency_key)
  WHERE status = 'held';

CREATE UNIQUE INDEX IF NOT EXISTS ux_appointment_slot_holds_doctor_slot_active
  ON appointment_slot_holds (tenant_id, doctor_id, appointment_date, slot_start)
  WHERE status = 'held';

CREATE INDEX IF NOT EXISTS idx_appointment_slot_holds_expiry
  ON appointment_slot_holds (tenant_id, expires_at, status)
  WHERE status = 'held';

CREATE INDEX IF NOT EXISTS idx_appointment_slot_holds_patient
  ON appointment_slot_holds (tenant_id, patient_uid, created_at DESC)
  WHERE patient_uid IS NOT NULL;

ALTER TABLE appointment_slot_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_slot_holds FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON appointment_slot_holds;
CREATE POLICY tenant_isolation ON appointment_slot_holds
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL8_P4_SLOT_HOLDS_APPLIED',
  'appointment_slot_holds',
  'appointment_slot_holds',
  jsonb_build_object(
    'migration', '479_scheduling2_slot_holds.sql',
    'program', 'NL8-P4',
    'reason', 'Short-lived appointment slot holds with idempotency and expiry.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL8_P4_SLOT_HOLDS_APPLIED'
    AND resource = 'appointment_slot_holds'
);

COMMIT;
