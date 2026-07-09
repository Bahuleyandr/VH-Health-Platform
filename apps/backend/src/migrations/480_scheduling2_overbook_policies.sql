-- 480_scheduling2_overbook_policies.sql
--
-- NL8-P4: tenant-configurable overbook policies and audit evidence.
-- Policies are disabled by default; no-show risk can suggest capacity only
-- after a tenant enables a bounded policy.

BEGIN;

ALTER TABLE appointment_waitlist
  ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS notification_state VARCHAR(30) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS source_channel VARCHAR(30) NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS override_reason VARCHAR(240),
  ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE appointment_waitlist
  ADD CONSTRAINT chk_appointment_waitlist_notification_state
  CHECK (notification_state IN ('pending', 'queued', 'sent', 'failed', 'acknowledged', 'not_required')) NOT VALID;

ALTER TABLE appointment_waitlist
  VALIDATE CONSTRAINT chk_appointment_waitlist_notification_state;

ALTER TABLE appointment_waitlist
  ADD CONSTRAINT chk_appointment_waitlist_source_channel
  CHECK (source_channel IN ('kiosk', 'patient_app', 'staff', 'call_centre', 'admin')) NOT VALID;

ALTER TABLE appointment_waitlist
  VALIDATE CONSTRAINT chk_appointment_waitlist_source_channel;

CREATE INDEX IF NOT EXISTS idx_appointment_waitlist_offer_expiry
  ON appointment_waitlist (tenant_id, offer_expires_at, status)
  WHERE status = 'offered';

CREATE TABLE IF NOT EXISTS scheduling_overbook_policies (
  id                     BIGSERIAL PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  policy_scope           VARCHAR(30) NOT NULL DEFAULT 'tenant',
  department_id          INTEGER,
  department_name        VARCHAR(120),
  doctor_id              INTEGER,
  visit_type             VARCHAR(40),
  appointment_type       VARCHAR(60),
  max_overbook_fraction  NUMERIC(5,4) NOT NULL DEFAULT 0,
  max_overbook_slots     INTEGER NOT NULL DEFAULT 0,
  authority_role         VARCHAR(60) NOT NULL DEFAULT 'RECEPTION_INCHARGE',
  override_requires_reason BOOLEAN NOT NULL DEFAULT true,
  enabled                BOOLEAN NOT NULL DEFAULT false,
  effective_from         DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to           DATE,
  created_by             UUID,
  updated_by             UUID,
  created_at             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_scheduling_overbook_policies_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_scheduling_overbook_scope
    CHECK (policy_scope IN ('tenant', 'department', 'doctor', 'visit_type', 'appointment_type', 'department_doctor')),
  CONSTRAINT chk_scheduling_overbook_fraction
    CHECK (max_overbook_fraction >= 0 AND max_overbook_fraction <= 1),
  CONSTRAINT chk_scheduling_overbook_slots
    CHECK (max_overbook_slots >= 0),
  CONSTRAINT chk_scheduling_overbook_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_scheduling_overbook_policies_lookup
  ON scheduling_overbook_policies (
    tenant_id,
    enabled,
    doctor_id,
    visit_type,
    appointment_type,
    effective_from,
    effective_to
  );

ALTER TABLE scheduling_overbook_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_overbook_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON scheduling_overbook_policies;
CREATE POLICY tenant_isolation ON scheduling_overbook_policies
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

CREATE TABLE IF NOT EXISTS scheduling_overbook_audit_events (
  id                       BIGSERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  policy_id                BIGINT REFERENCES scheduling_overbook_policies(id) ON DELETE SET NULL,
  doctor_id                INTEGER NOT NULL,
  appointment_id           INTEGER,
  appointment_date         DATE NOT NULL,
  slot_start               TIME,
  requested_overbook_slots INTEGER NOT NULL DEFAULT 1,
  allowed_overbook_slots   INTEGER NOT NULL DEFAULT 0,
  decision                 VARCHAR(20) NOT NULL,
  override_by              UUID,
  override_role            VARCHAR(60),
  override_reason          VARCHAR(240),
  evidence                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_scheduling_overbook_audit_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_scheduling_overbook_audit_appointment
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
  CONSTRAINT chk_scheduling_overbook_audit_decision
    CHECK (decision IN ('allowed', 'denied', 'override'))
);

CREATE INDEX IF NOT EXISTS idx_scheduling_overbook_audit_doctor
  ON scheduling_overbook_audit_events (tenant_id, doctor_id, appointment_date DESC, created_at DESC);

ALTER TABLE scheduling_overbook_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_overbook_audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON scheduling_overbook_audit_events;
CREATE POLICY tenant_isolation ON scheduling_overbook_audit_events
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
  'NL8_P4_OVERBOOK_POLICIES_APPLIED',
  'scheduling_overbook_policies',
  'scheduling_overbook_policies',
  jsonb_build_object(
    'migration', '480_scheduling2_overbook_policies.sql',
    'program', 'NL8-P4',
    'reason', 'Default-off tenant overbook policies with decision audit evidence.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL8_P4_OVERBOOK_POLICIES_APPLIED'
    AND resource = 'scheduling_overbook_policies'
);

COMMIT;
