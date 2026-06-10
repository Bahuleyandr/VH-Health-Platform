-- 276_patient_problem_list.sql
--
-- Roadmap Pillar B / item B7 (docs/EPIC_LEVEL_ROADMAP.md) — longitudinal
-- structured problem list, distinct from per-visit `diagnoses` rows.
--
-- `diagnoses` answers "what was diagnosed in this encounter"; nothing today
-- answers "what conditions does this patient live with right now". Epic
-- treats the problem list as the patient's clinical spine: it feeds CDS
-- context (drug-disease checks, B2), discharge summaries, and the one-screen
-- patient summary (E5). This migration adds that spine:
--
--   * patient_problems — active/resolved problems with onset, managing
--     doctor (canonical users.id per roadmap A9), ICD-10/SNOMED codes
--     (B8 terminology service validates softly at write time), chronicity,
--     severity, and provenance back to the per-visit diagnosis row a
--     problem was promoted from.
--   * Dedupe guard: at most one ACTIVE problem per (tenant, patient,
--     icd10_code) — recurrences resolve the old row or reactivate it.
--   * Tenant RLS (policy + FORCE) matching migrations 262/272 conventions.
--
-- Every write path emits clinical_timeline_events + clinical_audit_events
-- in the same transaction (docs/CANONICAL_CLINICAL_TIMELINE.md).

BEGIN;

CREATE TABLE IF NOT EXISTS patient_problems (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid         UUID NOT NULL,
  patient_id          INTEGER,
  title               VARCHAR(255) NOT NULL,
  icd10_code          VARCHAR(20),
  snomed_code         VARCHAR(80),
  status              VARCHAR(20) NOT NULL DEFAULT 'active',
  severity            VARCHAR(20),
  is_chronic          BOOLEAN NOT NULL DEFAULT false,
  onset_date          DATE,
  resolved_date       DATE,
  managing_doctor_id  INTEGER,
  source_encounter_id UUID,
  source_diagnosis_id INTEGER,
  notes               TEXT,
  resolution_notes    TEXT,
  recorded_by         UUID,
  resolved_by         UUID,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_patient_problems_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_patient_problems_status
    CHECK (status IN ('active', 'resolved', 'inactive', 'entered_in_error')),
  CONSTRAINT chk_patient_problems_severity
    CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe'))
);

CREATE INDEX IF NOT EXISTS idx_patient_problems_patient_status
  ON patient_problems (tenant_id, patient_uid, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_problems_patient_onset
  ON patient_problems (patient_uid, status, onset_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_patient_problems_source_diagnosis
  ON patient_problems (source_diagnosis_id) WHERE source_diagnosis_id IS NOT NULL;

-- One ACTIVE problem per coded condition per patient. Uncoded (free-text)
-- problems are exempt — clinicians may track several narrative problems.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_problems_active_code
  ON patient_problems (tenant_id, patient_uid, icd10_code)
  WHERE status = 'active' AND icd10_code IS NOT NULL;

-- Tenant isolation (same pattern as migrations 262/272).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE patient_problems ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE patient_problems FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON patient_problems';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON patient_problems
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
      )
  $f$;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'PATIENT_PROBLEM_LIST_APPLIED',
  'patient_problems',
  'patient_problems',
  jsonb_build_object(
    'migration', '276_patient_problem_list.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B7',
    'reason', 'Longitudinal structured problem list distinct from per-visit diagnoses; feeds CDS context and discharge summaries.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'PATIENT_PROBLEM_LIST_APPLIED'
    AND resource = 'patient_problems'
);

COMMIT;
