-- Radiology Report QA / Discrepancy Assistant.
--
-- Reviews draft and signed radiology reports against the study request
-- indication and metadata. Flags laterality mismatches, missing impression
-- sections, missing critical-finding communication notes, unaddressed
-- indications, missing comparison-to-prior when priors exist, vague
-- measurements, findings-vs-impression inconsistencies, and missing
-- follow-up recommendations when findings warrant one. Rules are
-- authoritative; review-only -- the service never modifies, signs, or
-- releases a report, and always requires radiologist signoff.

CREATE TABLE IF NOT EXISTS clinical_ai_radiology_report_reviews (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID,
  study_id VARCHAR(200),
  accession_number VARCHAR(100),
  modality VARCHAR(40),
  body_part VARCHAR(100),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  report_status VARCHAR(40) NOT NULL DEFAULT 'draft'
    CHECK (report_status IN ('draft', 'preliminary', 'final', 'amended', 'unknown')),
  overall_severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (overall_severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  discrepancy_count INTEGER NOT NULL DEFAULT 0,
  discrepancies JSONB NOT NULL DEFAULT '[]'::jsonb,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_radiology_report_reviews_tenant_created
  ON clinical_ai_radiology_report_reviews (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_report_reviews_tenant_severity_created
  ON clinical_ai_radiology_report_reviews (tenant_id, overall_severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_report_reviews_tenant_decision_created
  ON clinical_ai_radiology_report_reviews (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_report_reviews_tenant_modality_created
  ON clinical_ai_radiology_report_reviews (tenant_id, modality, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_report_reviews_tenant_study
  ON clinical_ai_radiology_report_reviews (tenant_id, study_id);
CREATE INDEX IF NOT EXISTS idx_radiology_report_reviews_tenant_accession
  ON clinical_ai_radiology_report_reviews (tenant_id, accession_number);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('radiology_report_qa',
   'Radiology Report QA / Discrepancy Assistant',
   'Reviews draft and signed radiology reports against the study request indication and metadata. Flags laterality mismatches, missing impression sections, missing critical-finding communication notes, unaddressed indications, missing comparison-to-prior, vague measurements, findings-vs-impression inconsistencies, and missing follow-up recommendations. Rules are authoritative; review-only -- never modifies, signs, or releases a report, and always requires radiologist signoff.',
   false,
   '{"surface":"radiology","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","RADIOLOGIST","ADMIN"],"approvalPolicy":"radiologist_review","outputSchema":{"type":"object","required":["discrepancies","overall_severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'radiology_report_qa',
    'v1',
    'Radiology Report QA / Discrepancy Assistant v1',
    'You support rule-authoritative radiology report QA. Use only the supplied study metadata, request indication, and report text. Return JSON only. Never modify, sign, or release a report; this is decision support only and radiologist signoff is required before any finalization.',
    'Given the study metadata, request indication, report text, prior-study availability, critical-finding flag, and the rule-based discrepancy evaluation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not invent findings or discrepancies; defer to the supplied rule-based evaluation. If the report lacks an impression, critical-finding communication, comparison-to-prior, or follow-up recommendation, flag it rather than inferring content.',
    '{"type":"object","required":["discrepancies","overall_severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
