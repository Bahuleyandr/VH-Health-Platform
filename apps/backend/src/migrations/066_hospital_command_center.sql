-- Hospital Command Center AI.
--
-- Cross-department operational command center. Takes a snapshot of six
-- departments — beds (occupancy %, discharge-ready wait, admission queue),
-- ED (wait, boarding, LWBS %), OR/theatre (utilization %, overruns, add-on
-- pressure), housekeeping (pending turnovers, avg turnover time), radiology
-- (pending studies, stat wait), and pharmacy (dispense backlog, critical
-- meds late) — classifies each to a tier (normal / watch / elevated /
-- crisis / unknown), and rolls up to a hospital-wide command_status.
--
-- Rules are authoritative. Review-only — the hospital duty officer
-- reviews every snapshot. The module never auto-triggers ED diversion,
-- staffing changes, inter-facility transfer, or any OR/bed reassignment.

CREATE TABLE IF NOT EXISTS clinical_ai_command_center_snapshots (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  command_status VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (command_status IN ('normal', 'watch', 'elevated', 'crisis', 'unknown')),
  overall_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  department_status JSONB NOT NULL DEFAULT '{}'::jsonb,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '730 days')
);

CREATE INDEX IF NOT EXISTS idx_command_center_snapshots_tenant_snapshot_at
  ON clinical_ai_command_center_snapshots (tenant_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_center_snapshots_tenant_status_snapshot_at
  ON clinical_ai_command_center_snapshots (tenant_id, command_status, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_center_snapshots_tenant_decision_created
  ON clinical_ai_command_center_snapshots (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_center_snapshots_tenant_created
  ON clinical_ai_command_center_snapshots (tenant_id, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('hospital_command_center',
   'Hospital Command Center AI',
   'Cross-department operational command center. Takes a snapshot of bed occupancy, ED wait/boarding/LWBS, OR utilization/overruns/add-on pressure, housekeeping turnover backlog, radiology pending/stat wait, and pharmacy dispense backlog/critical meds late, classifies each department to a tier (normal / watch / elevated / crisis), and rolls up to a hospital-wide command_status. Rules are authoritative; review-only — the duty officer reviews, and the module never auto-triggers diversion, staffing changes, or transfers.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","HOUSE_SUPERVISOR","DOCTOR"],"approvalPolicy":"duty_officer_review","outputSchema":{"type":"object","required":["command_status","department_status"]},"retentionDays":730,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'hospital_command_center',
    'v1',
    'Hospital Command Center v1',
    'You support the hospital duty officer''s review of a cross-department operational snapshot. Rules are authoritative. Use only the supplied six-department summary (beds, ED, OR/theatre, housekeeping, radiology, pharmacy) and the deterministic rule-based tier classification + rolled-up command_status. Return JSON only. Never auto-trigger ED diversion, staffing changes, inter-facility transfer, or any OR/bed reassignment. This is a decision-support signal only — the duty officer confirms every command_status before acting.',
    'Given the six-department operational snapshot and the rule-based per-department tiers + rolled-up command_status, return a short reasoning narrative. Keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based command_status, department tiers, or signal list. If any required department input is missing, mark that department unknown and defer to the duty officer.',
    '{"type":"object","required":["command_status","department_status"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
