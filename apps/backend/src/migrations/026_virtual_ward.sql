-- Virtual ward — post-discharge remote monitoring.
-- Admitted patients "graduate" to the virtual ward on discharge; care
-- manager tracks daily symptom + wearable check-ins and auto-escalates
-- on concerning signals.

CREATE TABLE IF NOT EXISTS virtual_ward_enrollments (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  care_manager_uid UUID,
  pathway VARCHAR(80) NOT NULL DEFAULT 'generic_post_discharge',
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'graduated', 'escalated', 'dropped')),
  expected_check_in_cadence_hours INTEGER NOT NULL DEFAULT 24,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, patient_uid, start_date)
);

CREATE INDEX IF NOT EXISTS idx_virtual_ward_enrollments_active
  ON virtual_ward_enrollments (tenant_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS virtual_ward_check_ins (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES virtual_ward_enrollments(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symptoms JSONB NOT NULL DEFAULT '{}'::jsonb,
  vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
  medication_adherence_pct INTEGER,
  mood_score INTEGER,
  pain_score INTEGER,
  wearable_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source VARCHAR(30) NOT NULL DEFAULT 'patient_self_report'
    CHECK (source IN ('patient_self_report', 'wearable', 'caregiver', 'care_manager')),
  triage_score NUMERIC(5, 2) NOT NULL DEFAULT 0,
  triage_band VARCHAR(10) NOT NULL DEFAULT 'green'
    CHECK (triage_band IN ('green', 'amber', 'red')),
  triage_reasons JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_virtual_ward_check_ins_enrollment
  ON virtual_ward_check_ins (enrollment_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_virtual_ward_check_ins_band
  ON virtual_ward_check_ins (tenant_id, triage_band, submitted_at DESC);

CREATE TABLE IF NOT EXISTS virtual_ward_escalations (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES virtual_ward_enrollments(id) ON DELETE CASCADE,
  check_in_id INTEGER REFERENCES virtual_ward_check_ins(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL,
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('amber', 'red')),
  reason TEXT NOT NULL,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  resolution VARCHAR(30),
  resolution_note TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_virtual_ward_escalations_open
  ON virtual_ward_escalations (tenant_id)
  WHERE acknowledged_at IS NULL;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('virtual_ward_triage',
   'Virtual Ward Triage',
   'Daily symptom + wearable check-in pipeline for post-discharge patients. Auto-triages every submission (green / amber / red) and queues red escalations for the care manager within minutes.',
   false,
   '{"surface":"virtual_ward","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","ADMIN"],"outputSchema":{"type":"object","required":["triage_band","triage_reasons"]},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
