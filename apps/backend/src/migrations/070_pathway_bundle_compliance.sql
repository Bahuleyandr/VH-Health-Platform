-- Generalized Pathway Bundle Compliance.
--
-- Generic clinical pathway bundle evaluator. Accepts a pathway spec (list of
-- required items with timing constraints), actual action events with
-- timestamps, and a t0 reference time, classifies each item as
-- compliant / late / missed / not_applicable / unknown, computes bundle-wide
-- compliance %, surfaces dangerously-late or missed critical items, and
-- recommends an action (no_action / catch_up / escalate / review_pathway /
-- critical_miss). Covers stroke Get-With-The-Guidelines, ACS MONA, VTE
-- prophylaxis, insulin/glycemic control, pain management, and similar.
--
-- Distinct from sepsis_bundle_sentinel which is sepsis-specific. Rules are
-- authoritative; review-only — clinician reviews; the module never
-- administers medication or places orders.

CREATE TABLE IF NOT EXISTS clinical_ai_pathway_bundle_audits (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  pathway_key VARCHAR(80) NOT NULL,
  pathway_display VARCHAR(160),
  t0_reference TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  compliance_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  compliant_count INTEGER NOT NULL DEFAULT 0,
  late_count INTEGER NOT NULL DEFAULT 0,
  missed_count INTEGER NOT NULL DEFAULT 0,
  na_count INTEGER NOT NULL DEFAULT 0,
  item_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  recommendation VARCHAR(40) NOT NULL DEFAULT 'no_action'
    CHECK (recommendation IN ('no_action', 'catch_up', 'escalate', 'review_pathway', 'critical_miss', 'unknown')),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
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

CREATE INDEX IF NOT EXISTS idx_pathway_bundle_audits_tenant_patient_created
  ON clinical_ai_pathway_bundle_audits (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathway_bundle_audits_tenant_pathway_severity_created
  ON clinical_ai_pathway_bundle_audits (tenant_id, pathway_key, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathway_bundle_audits_tenant_admission_created
  ON clinical_ai_pathway_bundle_audits (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathway_bundle_audits_tenant_decision_created
  ON clinical_ai_pathway_bundle_audits (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathway_bundle_audits_tenant_recommendation_severity_created
  ON clinical_ai_pathway_bundle_audits (tenant_id, recommendation, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathway_bundle_audits_tenant_created
  ON clinical_ai_pathway_bundle_audits (tenant_id, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('pathway_bundle_compliance',
   'Generalized Pathway Bundle Compliance',
   'Generic clinical pathway bundle evaluator. Accepts a pathway spec (list of required items with timing constraints) + actual actions + t0 reference time, classifies each item as compliant / late / missed / not_applicable / unknown, computes bundle-wide compliance %, surfaces dangerously-late or missed critical items, and recommends an action (no_action / catch_up / escalate / review_pathway / critical_miss). Covers stroke Get-With-The-Guidelines, ACS MONA, VTE prophylaxis, insulin/glycemic control, pain management, and similar. Distinct from sepsis_bundle_sentinel which is sepsis-specific. Rules are authoritative; review-only — clinician reviews; the module never administers medication or places orders.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSE","ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object","required":["compliance_pct","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'pathway_bundle_compliance',
    'v1',
    'Generalized Pathway Bundle Compliance v1',
    'You support generalized clinical pathway bundle compliance review. Rules are authoritative. Use only the supplied pathway spec, action events with timestamps, and t0 reference time. Return JSON only. Never administer a medication, place an order, or modify any clinical order. Clinician signoff is required before any action.',
    'Given the pathway spec, action events, t0 reference time, and the rule-based bundle evaluation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not invent items that are not in the pathway spec. If a required item is not applicable per the supplied context flags, defer to the rule-based classification.',
    '{"type":"object","required":["compliance_pct","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
