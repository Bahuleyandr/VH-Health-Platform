-- 720_clinical_coding_downstream_documents.sql
--
-- Terminology C1 / WP2: structured diagnosis coding on downstream clinical
-- documents (death certificate, insurance pre-auth, insurance claim/PM-JAY
-- case, discharge summary).
--
-- 1. Widen migration 297's clinical_code_bindings resource_type CHECK so the
--    downstream document surfaces can persist structured codings alongside
--    their legacy free-text ICD-10 columns (which stay intact).
-- 2. tenant_terminology_settings (migration 370) gains a coding_enforcement
--    JSONB control column: per-surface 'off' | 'warn' | 'block', shaped and
--    validated app-side in terminologySettingsService. Default '{}' == every
--    surface 'off' == byte-identical behavior (dark-ship invariant; the env
--    kill-switch TERMINOLOGY_CODING_ENFORCEMENT is ANDed on top).
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + re-ADD (migration 674 idiom) and
-- ADD COLUMN IF NOT EXISTS. No data rewrite; the widened CHECK is a strict
-- superset of 297's value list so existing rows always satisfy it.

BEGIN;

ALTER TABLE clinical_code_bindings
  DROP CONSTRAINT IF EXISTS chk_clinical_code_bindings_resource_type;

ALTER TABLE clinical_code_bindings
  ADD CONSTRAINT chk_clinical_code_bindings_resource_type
  CHECK (resource_type IN (
    'diagnosis',
    'patient_problem',
    'death_certificate',
    'insurance_preauth',
    'insurance_claim',
    'discharge_summary'
  ));

ALTER TABLE tenant_terminology_settings
  ADD COLUMN IF NOT EXISTS coding_enforcement JSONB NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'CLINICAL_CODING_DOWNSTREAM_DOCUMENTS_APPLIED',
  'clinical_code_bindings',
  'clinical_code_bindings',
  jsonb_build_object(
    'migration', '720_clinical_coding_downstream_documents.sql',
    'reason', 'Structured ICD-10 codings + per-surface coding enforcement for death certificates, insurance pre-auth/claims, and discharge summaries.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'CLINICAL_CODING_DOWNSTREAM_DOCUMENTS_APPLIED'
    AND resource = 'clinical_code_bindings'
);

COMMIT;
