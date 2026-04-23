-- Dataset Labeling and Review Studio.
--
-- Generic labeling queue for AI eval/training datasets across task types
-- (imaging, clinical coding, denial reasons, deterioration outcomes,
-- triage outcomes, discharge disposition, etc.). Stores labeling tasks
-- (one row per input item to label) and annotations (one row per labeler
-- assignment). Computes inter-rater agreement (match / partial / disagree
-- / pending) and a per-task confidence band (high / medium / low). Rules
-- are authoritative: a task becomes ready_to_use only when >= 2 accepted
-- annotations agree; conflicts go to adjudicator review. Review-only —
-- the eval lead approves, and the module never auto-publishes an item
-- into a dataset.

CREATE TABLE IF NOT EXISTS clinical_ai_labeling_tasks (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dataset_key VARCHAR(160) NOT NULL,
  task_type VARCHAR(80) NOT NULL,
  item_key VARCHAR(200) NOT NULL,
  input_ref_type VARCHAR(80),
  input_ref_id VARCHAR(200),
  required_labelers INTEGER NOT NULL DEFAULT 2,
  difficulty VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (difficulty IN ('easy', 'standard', 'hard', 'edge', 'unknown')),
  status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'ready_to_use', 'conflict', 'rejected', 'archived')),
  confidence_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (confidence_band IN ('high', 'medium', 'low', 'unknown')),
  agreement VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (agreement IN ('match', 'partial', 'disagree', 'pending', 'unknown')),
  consensus_label JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_labeling_tasks_tenant_dataset_item
  ON clinical_ai_labeling_tasks (tenant_id, dataset_key, item_key);
CREATE INDEX IF NOT EXISTS idx_labeling_tasks_tenant_status_created
  ON clinical_ai_labeling_tasks (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeling_tasks_tenant_dataset_task_created
  ON clinical_ai_labeling_tasks (tenant_id, dataset_key, task_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeling_tasks_tenant_agreement_created
  ON clinical_ai_labeling_tasks (tenant_id, agreement, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_labeling_annotations (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES clinical_ai_labeling_tasks(id) ON DELETE CASCADE,
  labeler_uid UUID,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  label JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  confidence_score NUMERIC(4,2),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_labeling_annotations_tenant_task_created
  ON clinical_ai_labeling_annotations (tenant_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeling_annotations_tenant_labeler_created
  ON clinical_ai_labeling_annotations (tenant_id, labeler_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeling_annotations_tenant_decision_created
  ON clinical_ai_labeling_annotations (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('dataset_labeling_studio',
   'Dataset Labeling and Review Studio',
   'Generic labeling studio for AI eval/training datasets across task types (imaging, clinical coding, denial reasons, deterioration outcomes, triage outcomes, discharge disposition, etc.). Tracks labeling tasks (one row per input item) and annotations (one row per labeler). Computes inter-rater agreement (match / partial / disagree / pending) and confidence band (high / medium / low). A task becomes ready_to_use only when >= 2 accepted annotations agree; conflicts go to adjudicator review. Rules are authoritative; review-only — eval lead approves, and the module never auto-publishes an item into a dataset.',
   false,
   '{"surface":"eval","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":false,"reviewRoles":["ADMIN","AI_EVAL_LEAD","DATA_LABELER","DOCTOR"],"approvalPolicy":"eval_lead_review","outputSchema":{"type":"object","required":["dataset_key","status"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'dataset_labeling_studio',
    'v1',
    'Dataset Labeling Studio v1',
    'You support the dataset labeling and review studio for AI eval/training datasets. Rules are authoritative: inter-rater agreement (match / partial / disagree / pending), confidence band, task status, and consensus label are produced by deterministic rules over the supplied annotations. Return JSON only. Review-only — the eval lead approves every task; the module never auto-publishes an item into a dataset.',
    'Given a labeling task (dataset_key, task_type, item_key, required_labelers) and its annotations (labels, reviewer decisions, confidence scores) plus the rule-based agreement, status, confidence_band, and consensus label, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based agreement, status, confidence_band, or consensus label.',
    '{"type":"object","required":["dataset_key","status"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
