-- ABDM longitudinal risk snapshots (M5).
--
-- Per-admission risk assessment combining adherence ONNX (or heuristic
-- fallback), readmission-rate heuristics from local admission history,
-- and optionally ABDM-pulled prior records where consent exists. Rows
-- are tenant-scoped and retention-capped; snapshots are immutable once
-- written so the clinician's decision point remains audit-able.

CREATE TABLE IF NOT EXISTS clinical_longitudinal_risk (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  overall_score NUMERIC(5, 2) NOT NULL,
  band VARCHAR(10) NOT NULL CHECK (band IN ('low', 'medium', 'high', 'critical')),
  adherence_score NUMERIC(5, 2),
  adherence_source VARCHAR(20),
  readmission_score NUMERIC(5, 2),
  comorbidity_score NUMERIC(5, 2),
  abdm_enrichment JSONB NOT NULL DEFAULT '{}'::jsonb,
  contributors JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days')
);

CREATE INDEX IF NOT EXISTS idx_clinical_longitudinal_risk_patient_time
  ON clinical_longitudinal_risk (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_longitudinal_risk_admission
  ON clinical_longitudinal_risk (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_longitudinal_risk_band
  ON clinical_longitudinal_risk (tenant_id, band, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_longitudinal_risk_retention
  ON clinical_longitudinal_risk (retention_until);

INSERT INTO clinical_ai_modules
  (module_key, display_name, description, enabled, settings)
VALUES
  ('abdm_longitudinal_risk',
   'ABDM Longitudinal Risk Score',
   'Computes a per-admission readmission-risk score combining medication-adherence model + local admission history + optional ABDM-linked prior records (consent required). Output is a clinician decision-support card, never an autonomous action.',
   false,
   '{"surface":"emr","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object","required":["overall_score","band","contributors"]},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
