-- NL-13 P3: CTCAE toxicity capture, owner-sourced grading metadata only.

BEGIN;

CREATE TABLE IF NOT EXISTS oncology_toxicity_events (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid                UUID NOT NULL,
  encounter_id               UUID,
  diagnosis_id               BIGINT,
  chemo_plan_id              INTEGER,
  chemo_cycle_id             INTEGER,
  chemo_administration_id    INTEGER,
  toxicity_term              TEXT NOT NULL,
  ctcae_grade                INTEGER NOT NULL,
  ctcae_source               TEXT,
  ctcae_source_version       VARCHAR(80),
  ctcae_source_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  attribution                VARCHAR(60),
  action_taken               VARCHAR(60),
  clinical_note              TEXT,
  signoff_status             VARCHAR(24) NOT NULL DEFAULT 'draft',
  captured_by                UUID,
  signed_by                  UUID,
  signed_at                  TIMESTAMPTZ(6),
  canonical_timeline_event_id UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_oncology_toxicity_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_oncology_toxicity_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_toxicity_diagnosis
    FOREIGN KEY (diagnosis_id) REFERENCES oncology_diagnoses(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_toxicity_chemo_plan
    FOREIGN KEY (chemo_plan_id) REFERENCES chemo_treatment_plans(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_toxicity_chemo_cycle
    FOREIGN KEY (chemo_cycle_id) REFERENCES chemo_cycles(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_toxicity_chemo_admin
    FOREIGN KEY (chemo_administration_id) REFERENCES chemo_administrations(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_toxicity_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_oncology_toxicity_grade
    CHECK (ctcae_grade BETWEEN 1 AND 5),
  CONSTRAINT chk_oncology_toxicity_action
    CHECK (action_taken IS NULL OR action_taken IN ('none', 'monitor', 'supportive_care', 'dose_delay', 'dose_reduce', 'withhold', 'stop', 'admit', 'other')),
  CONSTRAINT chk_oncology_toxicity_signoff
    CHECK (signoff_status IN ('draft', 'signed', 'superseded', 'entered_in_error')),
  CONSTRAINT chk_oncology_toxicity_attachment_array
    CHECK (jsonb_typeof(ctcae_source_attachment_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_oncology_toxicity_patient
  ON oncology_toxicity_events (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oncology_toxicity_chemo_cycle
  ON oncology_toxicity_events (tenant_id, chemo_cycle_id)
  WHERE chemo_cycle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oncology_toxicity_diagnosis
  ON oncology_toxicity_events (tenant_id, diagnosis_id, created_at DESC)
  WHERE diagnosis_id IS NOT NULL;

ALTER TABLE oncology_toxicity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE oncology_toxicity_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oncology_toxicity_events;
CREATE POLICY tenant_isolation ON oncology_toxicity_events
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
  'ONCOLOGY_TOXICITY_EVENTS_APPLIED',
  'oncology_toxicity_events',
  '490_oncology_toxicity_events.sql',
  jsonb_build_object(
    'migration', '490_oncology_toxicity_events.sql',
    'suite', 'NL-13 P3 oncology completion',
    'owner_sourced_ctcae', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ONCOLOGY_TOXICITY_EVENTS_APPLIED'
    AND resource_id = '490_oncology_toxicity_events.sql'
);

COMMIT;
