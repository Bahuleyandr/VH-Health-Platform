-- Housekeeping and Bed Turnover Optimizer.
--
-- Operations decision-support that predicts expected turnover minutes for a
-- post-discharge bed (based on required cleaning level, staffing load, and
-- bed geometry) and assigns a cleaning priority band using downstream bed
-- demand (ED boarding, OR queue), time-since-discharge, cleaning level, and
-- whether the bed feeds the ED doorway or sits in an isolation ward.
--
-- Rules are authoritative. This module never reassigns housekeeping staff,
-- never marks a bed ready, and never updates room status on its own. Every
-- output is reviewed by the charge nurse / bed manager / housekeeping
-- supervisor before action.

CREATE TABLE IF NOT EXISTS clinical_ai_bed_turnover_predictions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bed_id INTEGER,
  ward VARCHAR(120),
  room_number VARCHAR(40),
  previous_admission_id INTEGER,
  discharge_time TIMESTAMPTZ,
  current_status VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (current_status IN ('occupied', 'discharged_pending_clean', 'cleaning', 'ready', 'blocked', 'unknown')),
  required_cleaning_level VARCHAR(30) NOT NULL DEFAULT 'standard'
    CHECK (required_cleaning_level IN ('standard', 'terminal', 'isolation', 'deep_clean', 'unknown')),
  predicted_turnover_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (predicted_turnover_minutes >= 0),
  priority_score INTEGER NOT NULL DEFAULT 0
    CHECK (priority_score BETWEEN 0 AND 100),
  priority_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (priority_band IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  contributing_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'escalated')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days')
);

CREATE INDEX IF NOT EXISTS idx_bed_turnover_tenant_created
  ON clinical_ai_bed_turnover_predictions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bed_turnover_tenant_band_decision_created
  ON clinical_ai_bed_turnover_predictions (tenant_id, priority_band, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bed_turnover_tenant_ward_created
  ON clinical_ai_bed_turnover_predictions (tenant_id, ward, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bed_turnover_tenant_status_created
  ON clinical_ai_bed_turnover_predictions (tenant_id, current_status, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('housekeeping_bed_turnover',
   'Housekeeping and Bed Turnover Optimizer',
   'Predicts expected turnover minutes for a post-discharge bed based on the required cleaning level (standard / terminal / isolation / deep clean), staffing load, and whether the bed has a private bathroom. Computes a cleaning priority band using downstream bed demand (ED boarding, OR queue), minutes since discharge, the cleaning level, and whether the bed is an ED doorway or sits in an isolation ward. Rules are authoritative; this module never reassigns housekeeping staff, never marks a bed ready, and never updates room status on its own. Every output is reviewed by the charge nurse / bed manager / housekeeping supervisor before action.',
   false,
   '{"surface":"operations","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","HOUSEKEEPING_STAFF","BED_MANAGER","DEPARTMENT_HEAD"],"approvalPolicy":"ops_review","outputSchema":{"type":"object","required":["priority_band","predicted_turnover_minutes","required_cleaning_level"]},"retentionDays":365,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'housekeeping_bed_turnover',
    'v1',
    'Housekeeping and Bed Turnover Optimizer v1',
    'You support bed-manager / housekeeping-supervisor / charge-nurse review of post-discharge bed turnover. Rules are authoritative. Use only the supplied bed context (previous admission diagnoses, isolation precautions, surgical status, staffing load, bed demand, doorway / isolation-ward flags) and the deterministic rule-based evaluation. Return JSON only. Never reassign housekeeping staff, never mark a bed ready, and never update room status. This is a decision-support signal; the reviewer confirms every cleaning level, turnover estimate, and priority band before action.',
    'Given the bed turnover context and the rule-based cleaning level + predicted turnover minutes + priority score forecast, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based cleaning level, predicted minutes, priority score, or band. If required inputs are missing, mark insufficient_data and defer to the charge nurse / bed manager.',
    '{"type":"object","required":["priority_band","predicted_turnover_minutes","required_cleaning_level"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
