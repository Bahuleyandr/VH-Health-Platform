-- NL-13 P4: nuclear-medicine & radiotherapy COORDINATION (integrate-only).
-- Per-tenant coordination settings + radiation-oncology referrals.
-- Ships inert per tenant; planning/LINAC/scanner systems are INTEGRATED, never
-- rebuilt. This suite stores EXTERNAL references and coordination status only;
-- it never calculates treatment plans or controls delivery. AERB radiation-safety
-- evidence is owner-sourced (see migration 511).

BEGIN;

-- Per-tenant enablement + owner-sourced anchors (mirror of oncology_completion_settings,
-- migration 489). Fail-closed: the suite is disabled until an operator flips `enabled`.
CREATE TABLE IF NOT EXISTS radiation_coordination_settings (
  tenant_id                    UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                      BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at                   TIMESTAMPTZ(6),
  enabled_by                   UUID,
  aerb_evidence_owner          TEXT,
  owner_source_policy_ref      TEXT,
  planning_system_vendor_ref   TEXT,
  acceptance_snapshot          JSONB,
  created_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS radiation_oncology_referrals (
  id                          BIGSERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid                 UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id                UUID,
  diagnosis_id                BIGINT,
  staging_record_id           BIGINT,
  intent                      VARCHAR(40) NOT NULL DEFAULT 'curative',
  modality                    VARCHAR(40) NOT NULL DEFAULT 'external_beam',
  urgency                     VARCHAR(30) NOT NULL DEFAULT 'routine',
  referring_clinician_uid     UUID,
  referring_clinician_name    VARCHAR(160),
  reason                      TEXT,
  external_reference_system   VARCHAR(160),
  external_reference_id       VARCHAR(160),
  status                      VARCHAR(40) NOT NULL DEFAULT 'draft',
  canonical_timeline_event_id UUID,
  created_by                  UUID,
  updated_by                  UUID,
  created_at                  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radiation_referrals_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_radiation_referrals_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_radiation_referrals_diagnosis
    FOREIGN KEY (diagnosis_id) REFERENCES oncology_diagnoses(id) ON DELETE SET NULL,
  CONSTRAINT fk_radiation_referrals_staging
    FOREIGN KEY (staging_record_id) REFERENCES oncology_staging_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_radiation_referrals_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_radiation_referrals_intent
    CHECK (intent IN ('curative', 'adjuvant', 'neoadjuvant', 'palliative', 'other')),
  CONSTRAINT chk_radiation_referrals_modality
    CHECK (modality IN ('external_beam', 'brachytherapy', 'systemic_radioisotope', 'nuclear_medicine_therapy', 'other')),
  CONSTRAINT chk_radiation_referrals_urgency
    CHECK (urgency IN ('routine', 'urgent', 'emergency')),
  CONSTRAINT chk_radiation_referrals_status
    CHECK (status IN ('draft', 'submitted', 'accepted', 'planned', 'in_treatment', 'completed', 'cancelled', 'declined')),
  CONSTRAINT chk_radiation_referrals_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_radiation_referrals_patient
  ON radiation_oncology_referrals (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_radiation_referrals_status
  ON radiation_oncology_referrals (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_radiation_referrals_diagnosis
  ON radiation_oncology_referrals (tenant_id, diagnosis_id)
  WHERE diagnosis_id IS NOT NULL;

-- Composite unique for tenant-safe downstream FK references.
CREATE UNIQUE INDEX IF NOT EXISTS ux_radiation_referrals_tenant_id
  ON radiation_oncology_referrals (tenant_id, id);

ALTER TABLE radiation_coordination_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiation_coordination_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE radiation_oncology_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiation_oncology_referrals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON radiation_coordination_settings;
CREATE POLICY tenant_isolation ON radiation_coordination_settings
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

DROP POLICY IF EXISTS tenant_isolation ON radiation_oncology_referrals;
CREATE POLICY tenant_isolation ON radiation_oncology_referrals
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
  'NL13_P4_RADIATION_COORDINATION_SETTINGS_REFERRALS_APPLIED',
  'radiation_oncology_referrals',
  '508_radiation_coordination_settings_referrals.sql',
  jsonb_build_object(
    'migration', '508_radiation_coordination_settings_referrals.sql',
    'suite', 'NL-13 P4 nuclear medicine & radiotherapy coordination',
    'integrate_only', true,
    'owner_sourced', true,
    'inert_by_default', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL13_P4_RADIATION_COORDINATION_SETTINGS_REFERRALS_APPLIED'
    AND resource_id = '508_radiation_coordination_settings_referrals.sql'
);

COMMIT;
