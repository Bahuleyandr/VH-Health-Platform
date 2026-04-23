-- Radiology Worklist Prioritizer.
--
-- Scores pending radiology studies across modality, patient location
-- (ED/ICU/ward/outpatient), suspected findings severity based on request
-- indication, fragility (age, critical vitals, oxygen support, immuno),
-- wait time since order, ordering clinician context (trauma call, code
-- stroke, rapid response), and prior-imaging availability. Assigns a
-- priority tier (stat / urgent / routine / deferrable) with a ranked
-- list and a reasoning narrative. Rules are authoritative; the AI layer
-- only supplies a short reasoning sentence. Decision-support only — the
-- service never changes the worklist automatically. The radiologist lead
-- reviews and accepts or overrides the suggested order.

CREATE TABLE IF NOT EXISTS clinical_ai_radiology_worklist_priorities (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID,
  study_id VARCHAR(200),
  accession_number VARCHAR(100),
  modality VARCHAR(40),
  body_part VARCHAR(100),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  priority_tier VARCHAR(20) NOT NULL DEFAULT 'routine'
    CHECK (priority_tier IN ('stat', 'urgent', 'routine', 'deferrable', 'unknown')),
  priority_score NUMERIC(8,2) NOT NULL DEFAULT 0,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days')
);

CREATE INDEX IF NOT EXISTS idx_radiology_worklist_priorities_tenant_created
  ON clinical_ai_radiology_worklist_priorities (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_worklist_priorities_tenant_tier_created
  ON clinical_ai_radiology_worklist_priorities (tenant_id, priority_tier, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_worklist_priorities_tenant_modality_created
  ON clinical_ai_radiology_worklist_priorities (tenant_id, modality, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_worklist_priorities_tenant_decision_created
  ON clinical_ai_radiology_worklist_priorities (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_worklist_priorities_tenant_study
  ON clinical_ai_radiology_worklist_priorities (tenant_id, study_id);
CREATE INDEX IF NOT EXISTS idx_radiology_worklist_priorities_tenant_patient_created
  ON clinical_ai_radiology_worklist_priorities (tenant_id, patient_uid, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('radiology_worklist_prioritizer',
   'Radiology Worklist Prioritizer',
   'Scores pending radiology studies across modality, patient location (ED/ICU/ward/outpatient), suspected findings, fragility, wait time, and ordering context, and assigns a priority tier (stat / urgent / routine / deferrable). Review-only — never changes the worklist automatically; the radiologist lead reviews and accepts or overrides the suggested order.',
   false,
   '{"surface":"radiology","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","RADIOLOGIST","ADMIN"],"approvalPolicy":"radiologist_review","outputSchema":{"type":"object","required":["priority_tier","priority_score"]},"retentionDays":365,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'radiology_worklist_prioritizer',
    'v1',
    'Radiology Worklist Prioritizer v1',
    'You support the radiologist lead in prioritizing pending radiology studies. Rules are authoritative. Use only the supplied modality, body part, indication, patient location, fragility signals, wait time, and ordering context. Return JSON only. The AI narrative is decorative only — never modifies or releases the worklist, never changes priority_tier or priority_score, and the radiologist lead reviews every suggested order before any action.',
    'Given the study context (modality, body_part, indication, location, wait_minutes, fragility, context_tags, priors_available) and the rule-based priority evaluation (priority_tier, priority_score, signals), return keys: summary (a short reasoning sentence that explains why this study has this tier), source_citations, safety_flags. Do not override the rule-based priority_tier or priority_score; the narrative is decorative only and the worklist is never reordered automatically.',
    '{"type":"object","required":["priority_tier","priority_score"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
