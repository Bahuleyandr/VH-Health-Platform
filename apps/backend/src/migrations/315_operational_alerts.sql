-- 315_operational_alerts.sql
-- Unified forward-looking operational forecast alert stream.
-- Advisory only — never auto-acts. Rules-authoritative severity; auto-resolve
-- + keep history. See docs/superpowers/specs/2026-06-18-operational-alerts-design.md.

CREATE TABLE IF NOT EXISTS clinical_ai_operational_alerts (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key          VARCHAR(80)  NOT NULL,
  domain              VARCHAR(40)  NOT NULL,
  owner_role          VARCHAR(40),
  scope_key           VARCHAR(200) NOT NULL,
  scope_label         VARCHAR(200),
  horizon             VARCHAR(40),
  predicted_for       TIMESTAMPTZ,
  alert_category      VARCHAR(60)  NOT NULL DEFAULT 'unknown',
  severity            VARCHAR(20)  NOT NULL DEFAULT 'low'
                        CHECK (severity IN ('low','moderate','high','critical','unknown')),
  metrics             JSONB NOT NULL DEFAULT '{}'::jsonb,
  signals             JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary             TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id       INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  system_status       VARCHAR(20)  NOT NULL DEFAULT 'active'
                        CHECK (system_status IN ('active','resolved','superseded')),
  reviewer_decision   VARCHAR(30)  NOT NULL DEFAULT 'pending'
                        CHECK (reviewer_decision IN ('pending','accepted','deferred','rejected','edited')),
  reviewed_by         UUID,
  reviewed_at         TIMESTAMPTZ,
  reviewer_note       TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolved_reason     TEXT,
  notified_at         TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until     DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1095 days')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alerts_active_scope
  ON clinical_ai_operational_alerts (tenant_id, module_key, scope_key)
  WHERE system_status = 'active';
CREATE INDEX IF NOT EXISTS idx_operational_alerts_tenant_status_sev_eval
  ON clinical_ai_operational_alerts (tenant_id, system_status, severity, last_evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_alerts_tenant_domain_eval
  ON clinical_ai_operational_alerts (tenant_id, domain, last_evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_alerts_tenant_decision_created
  ON clinical_ai_operational_alerts (tenant_id, reviewer_decision, created_at DESC);

-- RLS: mirrors the canonical convention from migrations 311/314 (USING + WITH CHECK,
-- FORCE RLS, GUC-reading tenant_id default). The bypass sentinel 'bypass' is
-- permissive so untenanted system queries and seeds continue to work.
ALTER TABLE clinical_ai_operational_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_ai_operational_alerts FORCE ROW LEVEL SECURITY;

ALTER TABLE clinical_ai_operational_alerts
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

DROP POLICY IF EXISTS tenant_isolation ON clinical_ai_operational_alerts;
CREATE POLICY tenant_isolation ON clinical_ai_operational_alerts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  );
