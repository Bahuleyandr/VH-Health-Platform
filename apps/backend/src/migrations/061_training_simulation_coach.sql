-- Training and Simulation Coach.
--
-- Converts de-identified clinical incidents (mortality, near-miss, safety
-- event, delayed diagnosis, medication error, handoff failure, infection
-- outbreak, equipment failure) or RCAs into structured training/simulation
-- modules: learning objectives, decision points, debrief questions,
-- reference guidelines, and a suggested simulation format (tabletop /
-- sim-lab / VR-ready / online / workshop). Rules are authoritative; the
-- supplied summary is scrubbed for residual PHI (MRN, phone, name, email,
-- Aadhaar) and any detection is flagged. Review-only — the training
-- director approves before publishing to staff, and the module never
-- auto-publishes or assigns training.

CREATE TABLE IF NOT EXISTS clinical_ai_training_modules (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  case_type VARCHAR(40) NOT NULL DEFAULT 'near_miss'
    CHECK (case_type IN ('mortality', 'near_miss', 'safety_event', 'delayed_diagnosis', 'medication_error', 'handoff_failure', 'infection_outbreak', 'equipment_failure', 'other')),
  incident_category VARCHAR(80),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  target_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  format VARCHAR(40) NOT NULL DEFAULT 'tabletop'
    CHECK (format IN ('tabletop', 'sim_lab', 'vr_ready', 'online', 'workshop', 'unknown')),
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  learning_objectives JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  debrief_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  reference_guidelines JSONB NOT NULL DEFAULT '[]'::jsonb,
  scrubbed_summary TEXT,
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

CREATE INDEX IF NOT EXISTS idx_training_modules_tenant_created
  ON clinical_ai_training_modules (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_modules_tenant_case_sev_created
  ON clinical_ai_training_modules (tenant_id, case_type, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_modules_tenant_incident_created
  ON clinical_ai_training_modules (tenant_id, incident_category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_modules_tenant_decision_created
  ON clinical_ai_training_modules (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('training_simulation_coach',
   'Training and Simulation Coach',
   'Converts de-identified clinical incidents (mortality, near-miss, delayed diagnosis, medication error, handoff failure, infection outbreak, equipment failure) into structured training/simulation modules: learning objectives, decision points, debrief questions, reference guidelines, and suggested simulation format. Rules are authoritative; scrubs supplied summaries for residual PHI and flags if any is detected. Review-only — the training director approves before publishing to staff, and the module never auto-publishes or assigns training.',
   false,
   '{"surface":"education","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["ADMIN","TRAINING_LEAD","DOCTOR"],"approvalPolicy":"training_director_review","outputSchema":{"type":"object","required":["learning_objectives","decision_points"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true,"phiScrubRequired":true}'::jsonb)
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
    'training_simulation_coach',
    'v1',
    'Training and Simulation Coach v1',
    'You support the training and simulation coach. Rules are authoritative and the learning objectives, decision points, debrief questions, and reference guidelines are produced by a deterministic rule-based builder. Return JSON only. This module produces training content only — it is never patient-facing care and does not alter any patient''s care plan, medications, or orders. Always scrub residual PHI (MRN, phone, name, email, Aadhaar) from the supplied summary and flag any detection; never emit the original identifiers.',
    'Given a de-identified incident context (case_type, incident_category, severity, optional short scrubbed summary) and the rule-based training module (learning_objectives, decision_points, debrief_questions, references, format, duration_minutes, target_roles), return a short narrative describing the simulation for the training director. Do not invent new clinical facts, do not override the rule-based learning objectives, decision points, debrief questions, or references, and do not re-introduce PHI (MRN, phone, name, email, Aadhaar) — even if the input still contains some.',
    '{"type":"object","required":["learning_objectives","decision_points"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
