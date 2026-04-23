-- Policy Diff / Regulation Watcher.
--
-- Takes two versions of a policy, regulation, or payer rule (or a direct
-- diff) and computes added / removed / modified sections. Classifies
-- overall impact area (clinical / billing / access / privacy /
-- infection_control / pharmacy / none / mixed) and severity (critical /
-- high / moderate / low). Identifies impacted roles (doctors, nurses,
-- billing, pharmacy, etc.) so the right teams are notified. Rules are
-- authoritative; review-only — compliance and legal approve before
-- downstream rollout, and the module never auto-activates or revokes a
-- policy.

CREATE TABLE IF NOT EXISTS clinical_ai_policy_diffs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_key VARCHAR(160) NOT NULL,
  policy_title VARCHAR(200),
  source VARCHAR(80),
  previous_version VARCHAR(60),
  current_version VARCHAR(60),
  effective_date DATE,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  impact_area VARCHAR(40) NOT NULL DEFAULT 'none'
    CHECK (impact_area IN ('clinical', 'billing', 'access', 'privacy', 'infection_control', 'pharmacy', 'none', 'mixed', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  added_section_count INTEGER NOT NULL DEFAULT 0,
  removed_section_count INTEGER NOT NULL DEFAULT 0,
  modified_section_count INTEGER NOT NULL DEFAULT 0,
  diff_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  impacted_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
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

CREATE INDEX IF NOT EXISTS idx_policy_diffs_tenant_created
  ON clinical_ai_policy_diffs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_diffs_tenant_impact_severity_created
  ON clinical_ai_policy_diffs (tenant_id, impact_area, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_diffs_tenant_policy_key_created
  ON clinical_ai_policy_diffs (tenant_id, policy_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_diffs_tenant_decision_created
  ON clinical_ai_policy_diffs (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_diffs_tenant_effective_date
  ON clinical_ai_policy_diffs (tenant_id, effective_date);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('policy_regulation_watcher',
   'Policy Diff / Regulation Watcher',
   'Takes two versions of a policy, regulation, or payer rule (or a direct diff) and computes added / removed / modified sections. Classifies overall impact area (clinical / billing / access / privacy / infection_control / pharmacy / none / mixed) and severity (critical / high / moderate / low). Identifies impacted roles (doctors, nurses, billing, pharmacy, etc.) so the right teams are notified. Rules are authoritative; review-only — compliance and legal approve before downstream rollout, and the module never auto-activates or revokes a policy.',
   false,
   '{"surface":"governance","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","COMPLIANCE_LEAD","LEGAL"],"approvalPolicy":"compliance_review","outputSchema":{"type":"object","required":["impact_area","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'policy_regulation_watcher',
    'v1',
    'Policy Diff / Regulation Watcher v1',
    'You support compliance and legal review of policy, regulation, and payer-rule changes. Rules are authoritative. Use only the supplied diff content (added / removed / modified sections). Return JSON only. Never auto-activate, auto-revoke, auto-publish, or otherwise enforce a policy — this is decision support only and compliance + legal review is required before any downstream rollout.',
    'Given the rule-based diff evaluation (impact_area, severity, added / removed / modified sections, impacted roles, signals) for a policy or regulation change, return a concise narrative summary and keys: summary, recommended_actions, source_citations, safety_flags. Do not invent diff content, do not override the rule-based impact_area or severity, and always defer to compliance + legal review for approval decisions.',
    '{"type":"object","required":["impact_area","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
