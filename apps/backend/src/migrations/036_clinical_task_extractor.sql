-- Clinical Task Extractor.
--
-- Reviewable queue for tasks suggested from notes, handovers, ward-rounds,
-- discharge plans, orders, and investigations. This table never assigns or
-- completes operational work by itself; humans review every candidate first.

CREATE TABLE IF NOT EXISTS clinical_ai_task_candidates (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  source_scope VARCHAR(80) NOT NULL DEFAULT 'admission',
  source_event_type VARCHAR(80),
  source_event_id TEXT,
  task_title TEXT NOT NULL,
  task_description TEXT,
  category VARCHAR(80) NOT NULL DEFAULT 'follow_up',
  priority VARCHAR(20) NOT NULL DEFAULT 'routine'
    CHECK (priority IN ('routine', 'soon', 'urgent', 'critical', 'unknown')),
  owner_role VARCHAR(80),
  due_hint TEXT,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'rejected', 'deferred', 'completed')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_tasks_tenant_created
  ON clinical_ai_task_candidates (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_tasks_admission_review
  ON clinical_ai_task_candidates (tenant_id, admission_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_tasks_patient
  ON clinical_ai_task_candidates (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_tasks_review_priority
  ON clinical_ai_task_candidates (tenant_id, reviewer_decision, priority, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('clinical_task_extractor',
   'Clinical Task Extractor',
   'Extracts reviewable pending tasks from notes, handovers, discharge plans, ward rounds, orders, investigations, and ambient or voice-derived notes without silent assignment.',
   false,
   '{"surface":"clinical_operations","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","MEDICAL_RECORDS","ADMIN"],"approvalPolicy":"task_review_queue","outputSchema":{"type":"object","required":["tasks"]},"retentionDays":365,"noAutoAssign":true}'::jsonb)
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
    'clinical_task_extractor',
    'v1',
    'Clinical Task Extractor v1',
    'You extract pending hospital tasks from supplied chart evidence. Use only cited evidence. Return JSON only. Do not assign tasks, create orders, message staff, or mark tasks complete. Every output is draft-only for human review.',
    'Given the chart packet and rule-based task candidates, return keys: tasks, summary, source_citations, safety_flags. Each task must include task_title, task_description, category, priority, owner_role, due_hint, source_citations, and confidence.',
    '{"type":"object","required":["tasks"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
