-- Imaging AI pipeline.
--
-- Stores DICOM study metadata + AI-generated interpretations. The raw
-- pixel data stays in PACS/R2; this table holds the metadata + findings
-- + provenance. Tenant-scoped, citation-anchored to the study UID.

CREATE TABLE IF NOT EXISTS clinical_ai_imaging_studies (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  study_instance_uid VARCHAR(200) NOT NULL,
  modality VARCHAR(10) NOT NULL,
  body_part VARCHAR(80),
  study_date DATE,
  series_count INTEGER NOT NULL DEFAULT 1,
  instance_count INTEGER NOT NULL DEFAULT 1,
  pacs_url TEXT,
  storage_key TEXT,
  source_system VARCHAR(60),
  ordered_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, study_instance_uid)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_imaging_studies_patient
  ON clinical_ai_imaging_studies (tenant_id, patient_uid, study_date DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_imaging_findings (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  study_id INTEGER NOT NULL REFERENCES clinical_ai_imaging_studies(id) ON DELETE CASCADE,
  provider VARCHAR(60) NOT NULL,
  model VARCHAR(120),
  model_version VARCHAR(40),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_severity VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (overall_severity IN ('normal', 'incidental', 'actionable', 'critical', 'unreadable')),
  confidence_pct NUMERIC(5, 2),
  heatmap_url TEXT,
  narrative_draft TEXT,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  radiologist_decision VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (radiologist_decision IN ('pending', 'confirmed', 'revised', 'rejected', 'escalated')),
  radiologist_uid UUID,
  radiologist_note TEXT,
  reviewed_at TIMESTAMPTZ,
  generation_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, study_id, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_imaging_findings_study
  ON clinical_ai_imaging_findings (study_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_imaging_findings_pending
  ON clinical_ai_imaging_findings (tenant_id, overall_severity)
  WHERE radiologist_decision = 'pending';

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('radiology_ai_interpretation',
   'Radiology AI Interpretation',
   'Accepts DICOM study metadata + an external-model inference result (TorchXRayVision / MONAI / cloud PACS AI) and produces a structured radiologist draft. Critical findings fast-track to the top of the queue. Radiologist always signs off.',
   false,
   '{"surface":"radiology","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["RADIOLOGIST","DOCTOR","ADMIN"],"approvalPolicy":"radiologist_signoff","outputSchema":{"type":"object","required":["findings","overall_severity","narrative_draft"]},"retentionDays":3650}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
