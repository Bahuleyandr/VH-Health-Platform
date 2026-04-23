-- Synthetic Clinical Case Generator.
--
-- Deterministic de-identified synthetic-case generator for AI eval, canary
-- suites, regression tests, demos, and edge-case exploration. Given a
-- pathway, complexity tier, persona template, and PRNG seed, produces
-- demographics, chief complaint, vitals, labs, a timeline of events, and
-- edge-flag annotations. Review-only — cases require eval-lead approval
-- before entering a canary set or training corpus, and the module never
-- touches real patient data.

CREATE TABLE IF NOT EXISTS clinical_ai_synthetic_cases (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_label VARCHAR(160) NOT NULL,
  pathway VARCHAR(80) NOT NULL,
  complexity VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (complexity IN ('simple', 'standard', 'complex', 'edge', 'unknown')),
  seed VARCHAR(120),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  persona JSONB NOT NULL DEFAULT '{}'::jsonb,
  vitals JSONB NOT NULL DEFAULT '[]'::jsonb,
  labs JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  narrative TEXT,
  edge_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  intended_use VARCHAR(80),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '730 days')
);

CREATE INDEX IF NOT EXISTS idx_synthetic_cases_tenant_created
  ON clinical_ai_synthetic_cases (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_synthetic_cases_tenant_pathway_complexity_created
  ON clinical_ai_synthetic_cases (tenant_id, pathway, complexity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_synthetic_cases_tenant_decision_created
  ON clinical_ai_synthetic_cases (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_synthetic_cases_tenant_label
  ON clinical_ai_synthetic_cases (tenant_id, case_label);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('synthetic_case_generator',
   'Synthetic Clinical Case Generator',
   'Deterministic de-identified synthetic-case generator for AI eval, canary suites, regression tests, demos, and edge-case exploration. Given a pathway, complexity tier, persona template, and PRNG seed, produces demographics, chief complaint, vitals, labs, a timeline of events, and edge-flag annotations. Review-only — cases require eval-lead approval before entering a canary set or training corpus, and the module never touches real patient data.',
   false,
   '{"surface":"eval","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":false,"reviewRoles":["ADMIN","AI_EVAL_LEAD","DOCTOR"],"approvalPolicy":"eval_lead_review","outputSchema":{"type":"object","required":["case_label","pathway","persona"]},"retentionDays":730,"rulesAuthoritative":true,"decisionSupportOnly":true,"neverRealPatientData":true}'::jsonb)
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
    'synthetic_case_generator',
    'v1',
    'Synthetic Clinical Case Generator v1',
    'You support the synthetic-case generator for AI eval and canary suites. Rules are authoritative and all case data (persona, vitals, labs, timeline) is produced by a deterministic rule-based generator. NEVER invent or infer real patient data. All output is synthetic only. Do not alter the rule-based persona, vitals, labs, or timeline; produce only a short narrative summary prefixed with [synthetic]. Return JSON only.',
    'Given a rule-generated synthetic case (persona, pathway, complexity, vitals, labs, timeline), write a short narrative (3-5 sentences) describing the case for reviewer clarity. Prefix the narrative literally with [synthetic]. Do not override any rule-generated field. Do not invent new labs, vitals, or timeline events. Do not include names, MRNs, phone numbers, or any identifier — use only template phrases (age band, gender code, pathway, complexity).',
    '{"type":"object","required":["case_label","pathway","persona"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
