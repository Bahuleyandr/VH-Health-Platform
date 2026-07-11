-- NL-13 P4: radiotherapy external plan references + fraction schedules (integrate-only).
-- Stores EXTERNAL planning-system references, approval status, and appointment/fraction
-- STATUS only. The product NEVER computes a treatment plan and NEVER drives delivery —
-- dose/fraction-count values are owner-supplied summary fields, and the external planning
-- system / LINAC remain the source of truth.

BEGIN;

CREATE TABLE IF NOT EXISTS radiotherapy_plan_refs (
  id                            BIGSERIAL PRIMARY KEY,
  tenant_id                     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  referral_id                   BIGINT NOT NULL REFERENCES radiation_oncology_referrals(id) ON DELETE CASCADE,
  patient_uid                   UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id                  UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  external_plan_system          VARCHAR(160),
  external_plan_id              VARCHAR(160),
  plan_status                   VARCHAR(40) NOT NULL DEFAULT 'referenced',
  approving_radiation_oncologist_uid   UUID,
  approving_radiation_oncologist_name  VARCHAR(160),
  technique                     VARCHAR(120),
  planned_fraction_count        INTEGER,
  total_dose_gy_summary         NUMERIC(10,2),
  document_ref                  TEXT,
  document_storage_key          TEXT,
  image_study_instance_uid      VARCHAR(200),
  canonical_timeline_event_id   UUID,
  created_by                    UUID,
  updated_by                    UUID,
  created_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata                      JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radiotherapy_plan_refs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_radiotherapy_plan_refs_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_radiotherapy_plan_refs_status
    CHECK (plan_status IN ('referenced', 'approved', 'superseded', 'cancelled')),
  CONSTRAINT chk_radiotherapy_plan_refs_nonnegative
    CHECK (
      (planned_fraction_count IS NULL OR planned_fraction_count >= 0)
      AND (total_dose_gy_summary IS NULL OR total_dose_gy_summary >= 0)
    ),
  CONSTRAINT chk_radiotherapy_plan_refs_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_radiotherapy_plan_refs_referral
  ON radiotherapy_plan_refs (tenant_id, referral_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_radiotherapy_plan_refs_patient
  ON radiotherapy_plan_refs (tenant_id, patient_uid, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_radiotherapy_plan_refs_tenant_id
  ON radiotherapy_plan_refs (tenant_id, id);

CREATE TABLE IF NOT EXISTS radiotherapy_fraction_schedules (
  id                            BIGSERIAL PRIMARY KEY,
  tenant_id                     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  plan_ref_id                   BIGINT NOT NULL REFERENCES radiotherapy_plan_refs(id) ON DELETE CASCADE,
  referral_id                   BIGINT REFERENCES radiation_oncology_referrals(id) ON DELETE SET NULL,
  patient_uid                   UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id                  UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  appointment_id                INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  fraction_number               INTEGER NOT NULL,
  planned_fraction_count        INTEGER,
  external_treatment_ref        VARCHAR(160),
  scheduled_at                  TIMESTAMPTZ(6),
  delivered_at                  TIMESTAMPTZ(6),
  status                        VARCHAR(40) NOT NULL DEFAULT 'planned',
  hold_reason                   TEXT,
  cancel_reason                 TEXT,
  recorded_by                   UUID,
  canonical_timeline_event_id   UUID,
  created_by                    UUID,
  updated_by                    UUID,
  created_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata                      JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radiotherapy_fractions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_radiotherapy_fractions_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_radiotherapy_fractions_number
    CHECK (fraction_number >= 1),
  CONSTRAINT chk_radiotherapy_fractions_planned_count
    CHECK (planned_fraction_count IS NULL OR planned_fraction_count >= 0),
  CONSTRAINT chk_radiotherapy_fractions_status
    CHECK (status IN ('planned', 'scheduled', 'delivered', 'held', 'cancelled', 'missed')),
  CONSTRAINT chk_radiotherapy_fractions_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_radiotherapy_fractions_plan_number
  ON radiotherapy_fraction_schedules (tenant_id, plan_ref_id, fraction_number);

CREATE INDEX IF NOT EXISTS idx_radiotherapy_fractions_patient
  ON radiotherapy_fraction_schedules (tenant_id, patient_uid, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_radiotherapy_fractions_status
  ON radiotherapy_fraction_schedules (tenant_id, plan_ref_id, status);

ALTER TABLE radiotherapy_plan_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiotherapy_plan_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE radiotherapy_fraction_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiotherapy_fraction_schedules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON radiotherapy_plan_refs;
CREATE POLICY tenant_isolation ON radiotherapy_plan_refs
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

DROP POLICY IF EXISTS tenant_isolation ON radiotherapy_fraction_schedules;
CREATE POLICY tenant_isolation ON radiotherapy_fraction_schedules
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
  'NL13_P4_RADIOTHERAPY_PLAN_FRACTION_REFS_APPLIED',
  'radiotherapy_plan_refs',
  '509_radiotherapy_plan_fraction_refs.sql',
  jsonb_build_object(
    'migration', '509_radiotherapy_plan_fraction_refs.sql',
    'suite', 'NL-13 P4 nuclear medicine & radiotherapy coordination',
    'integrate_only', true,
    'never_calculates_plans', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL13_P4_RADIOTHERAPY_PLAN_FRACTION_REFS_APPLIED'
    AND resource_id = '509_radiotherapy_plan_fraction_refs.sql'
);

COMMIT;
