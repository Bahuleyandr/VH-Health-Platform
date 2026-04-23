-- OT Block Scheduling Optimizer.
--
-- Operations decision-support that reviews OR (operating theatre) block
-- utilization across surgeons and service lines. Given prime-time
-- utilization %, add-on (non-block) case volume, turnover times, case-
-- duration accuracy (actual vs scheduled), overrun frequency, and total
-- block hours used vs allocated, this module produces a per-block
-- reallocation suggestion (keep / expand / reduce / reallocate /
-- review_release_policy) with a rationale.
--
-- Rules are authoritative. This module never reassigns block time, never
-- releases blocks, and never updates OR scheduling records on its own.
-- Every output is reviewed by the OR director before action.

CREATE TABLE IF NOT EXISTS clinical_ai_ot_block_suggestions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  surgeon_uid UUID,
  surgeon_name VARCHAR(200),
  service_line VARCHAR(120),
  block_label VARCHAR(120),
  or_room VARCHAR(80),
  window_start DATE,
  window_end DATE,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  utilization_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  prime_time_utilization_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  overrun_count INTEGER NOT NULL DEFAULT 0,
  addon_count INTEGER NOT NULL DEFAULT 0,
  avg_turnover_minutes NUMERIC(6,2) NOT NULL DEFAULT 0,
  case_duration_variance_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  recommendation VARCHAR(40) NOT NULL DEFAULT 'keep'
    CHECK (recommendation IN ('keep', 'expand', 'reduce', 'reallocate', 'review_release_policy', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1095 days')
);

CREATE INDEX IF NOT EXISTS idx_ot_block_suggestions_tenant_created
  ON clinical_ai_ot_block_suggestions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ot_block_suggestions_tenant_recommendation_severity_created
  ON clinical_ai_ot_block_suggestions (tenant_id, recommendation, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ot_block_suggestions_tenant_surgeon_created
  ON clinical_ai_ot_block_suggestions (tenant_id, surgeon_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ot_block_suggestions_tenant_service_line_created
  ON clinical_ai_ot_block_suggestions (tenant_id, service_line, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ot_block_suggestions_tenant_block_label_created
  ON clinical_ai_ot_block_suggestions (tenant_id, block_label, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ot_block_suggestions_tenant_decision_created
  ON clinical_ai_ot_block_suggestions (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('ot_block_scheduling',
   'OT Block Scheduling Optimizer',
   'Reviews OR block utilization across surgeons and service lines. Evaluates prime-time utilization %, add-on case volume, turnover times, case-duration accuracy, overrun frequency, and block hours used vs allocated, and produces a reallocation suggestion (keep / expand / reduce / reallocate / review_release_policy). Rules are authoritative; review-only — the OR director approves, and the module never reassigns block time automatically.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["ADMIN","OT_MANAGER","DOCTOR"],"approvalPolicy":"ot_director_review","outputSchema":{"type":"object","required":["recommendation","severity"]},"retentionDays":1095,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'ot_block_scheduling',
    'v1',
    'OT Block Scheduling Optimizer v1',
    'You support OR director / OT manager review of operating-theatre block allocation. Rules are authoritative. Use only the supplied surgeon-block context (prime-time utilization %, add-on case volume, turnover times, case-duration accuracy, overrun frequency, and total block hours used vs allocated) and the deterministic rule-based evaluation. Return JSON only. Never reassign block time, never release blocks, and never update OR scheduling records. This is a decision-support signal; the OR director confirms every recommendation and severity before action.',
    'Given the OR block context and the rule-based recommendation (keep / expand / reduce / reallocate / review_release_policy) + severity + contributing signals, return a short reasoning narrative. Keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation, severity, or signal list. If required inputs are missing, defer to the OR director.',
    '{"type":"object","required":["recommendation","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
