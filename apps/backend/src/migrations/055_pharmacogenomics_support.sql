-- Pharmacogenomics / PGx Support.
--
-- Stores verified patient genotypes (one row per patient + gene, updated as
-- new lab results arrive) and rules-authoritative PGx advisories that pair a
-- prescribed medication with the patient's genotype and surface a
-- pharmacist-reviewable recommendation (no_action / standard_dose /
-- consider_dose_change / use_alternative / contraindicated /
-- testing_recommended). Decision-support only: the service never writes,
-- holds, or modifies a prescription order — pharmacist/clinician signoff is
-- required before any action.

CREATE TABLE IF NOT EXISTS clinical_ai_patient_genotypes (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  gene VARCHAR(40) NOT NULL,
  phenotype VARCHAR(60) NOT NULL,
  genotype_detail VARCHAR(120),
  source VARCHAR(80),
  source_report_id VARCHAR(200),
  tested_at DATE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_patient_genotypes_tenant_patient_gene
  ON clinical_ai_patient_genotypes (tenant_id, patient_uid, gene);
CREATE INDEX IF NOT EXISTS idx_patient_genotypes_tenant_patient_created
  ON clinical_ai_patient_genotypes (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_genotypes_tenant_gene
  ON clinical_ai_patient_genotypes (tenant_id, gene, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_pgx_advisories (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  prescription_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  medication_name VARCHAR(200) NOT NULL,
  matched_genes JSONB NOT NULL DEFAULT '[]'::jsonb,
  advisory_category VARCHAR(40) NOT NULL DEFAULT 'unknown'
    CHECK (advisory_category IN ('no_action', 'standard_dose', 'consider_dose_change', 'use_alternative', 'contraindicated', 'testing_recommended', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  summary TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '3650 days')
);

CREATE INDEX IF NOT EXISTS idx_pgx_advisories_tenant_patient_created
  ON clinical_ai_pgx_advisories (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pgx_advisories_tenant_category_severity_created
  ON clinical_ai_pgx_advisories (tenant_id, advisory_category, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pgx_advisories_tenant_prescription_created
  ON clinical_ai_pgx_advisories (tenant_id, prescription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pgx_advisories_tenant_decision_created
  ON clinical_ai_pgx_advisories (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('pharmacogenomics_support',
   'Pharmacogenomics / PGx Support',
   'Pairs prescribed medications against the patient''s known genotypes (CYP2D6, CYP2C19, CYP2C9, VKORC1, SLCO1B1, HLA-B*57:01, HLA-B*15:02, TPMT, DPYD, UGT1A1, G6PD) and surfaces CPIC-inspired advisories (no action / standard dose / consider dose change / use alternative / contraindicated / testing recommended). Rules are authoritative; review-only — the service never holds, modifies, or writes prescription orders, and always requires pharmacist/clinician signoff before action.',
   false,
   '{"surface":"pharmacy","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACIST","PHARMACY_STAFF","ADMIN"],"approvalPolicy":"pharmacist_review","outputSchema":{"type":"object","required":["advisory_category","severity","matched_genes"]},"retentionDays":3650,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

INSERT INTO clinical_ai_prompts
  (tenant_id, module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'pharmacogenomics_support',
    'v1',
    'Pharmacogenomics / PGx Support v1',
    'You support pharmacogenomics (PGx) medication review. Rules are authoritative. Use only the supplied medication, the patient''s verified genotype records, and the CPIC-inspired reference table. Return JSON only. Never hold, cancel, or modify a prescription order; this is decision support only and pharmacist/clinician signoff is required before any action.',
    'Given the medication, patient''s verified genotypes for PGx-relevant genes, and the rule-based advisory evaluation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not invent gene-drug interactions; defer to the supplied reference. If no PGx-relevant genotype is on file for this medication, mark testing_recommended rather than assuming normal metabolism.',
    '{"type":"object","required":["advisory_category","severity","matched_genes"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
