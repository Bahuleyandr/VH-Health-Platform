-- NL-8 P1: appointment-bound kiosk/front-desk arrival detail.
-- Arrival is recorded here; appointments.status remains the clinician workflow
-- state and is not overloaded as "checked in".

CREATE TABLE IF NOT EXISTS patient_flow_checkins (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  appointment_id             INTEGER NOT NULL,
  patient_uid                UUID NOT NULL,
  queue_id                   INTEGER,
  kiosk_session_id           BIGINT,
  checkin_channel            VARCHAR(30) NOT NULL,
  identity_method            VARCHAR(30) NOT NULL,
  status                     VARCHAR(30) NOT NULL DEFAULT 'pending',
  token_number               VARCHAR(20),
  visit_no                   VARCHAR(50),
  profile_delta_summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
  duplicate_candidate_count  INTEGER NOT NULL DEFAULT 0,
  acknowledgement_refs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_refs               JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_in_at              TIMESTAMPTZ(6),
  checked_in_by              UUID,
  created_by                 UUID,
  updated_by                 UUID,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_patient_flow_checkins_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_patient_flow_checkins_appointment
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_patient_flow_checkins_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION,
  CONSTRAINT fk_patient_flow_checkins_queue
    FOREIGN KEY (queue_id) REFERENCES appointment_queues(id) ON DELETE SET NULL,
  CONSTRAINT fk_patient_flow_checkins_session
    FOREIGN KEY (kiosk_session_id) REFERENCES patient_flow_kiosk_sessions(id) ON DELETE SET NULL,
  CONSTRAINT patient_flow_checkins_channel_check
    CHECK (checkin_channel IN ('kiosk_self', 'kiosk_supervised', 'patient_app', 'front_desk')),
  CONSTRAINT patient_flow_checkins_identity_method_check
    CHECK (identity_method IN ('firebase_otp', 'staff_supervised', 'qr_plus_otp')),
  CONSTRAINT patient_flow_checkins_status_check
    CHECK (status IN ('pending', 'checked_in', 'front_desk_required', 'rejected', 'cancelled')),
  CONSTRAINT patient_flow_checkins_duplicate_count_check
    CHECK (duplicate_candidate_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_patient_flow_checkins_checked_in_once
  ON patient_flow_checkins (tenant_id, appointment_id)
  WHERE status = 'checked_in';

CREATE INDEX IF NOT EXISTS idx_patient_flow_checkins_patient
  ON patient_flow_checkins (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_flow_checkins_queue
  ON patient_flow_checkins (tenant_id, queue_id, checked_in_at DESC)
  WHERE queue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patient_flow_checkins_front_desk
  ON patient_flow_checkins (tenant_id, status, created_at DESC)
  WHERE status = 'front_desk_required';

ALTER TABLE patient_flow_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_flow_checkins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON patient_flow_checkins;
CREATE POLICY tenant_isolation ON patient_flow_checkins
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
