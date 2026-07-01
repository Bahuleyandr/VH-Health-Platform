-- 351_composition_search_settings.sql
-- Per-tenant feature flag for composition-based drug search (Phase 2, inert).
-- The global feature_flags table is insufficient: coverage/readiness differ per
-- tenant, so each tenant is enabled independently once its catalog is curated.
-- Stores an acceptance-gate snapshot captured at flip time for the audit trail.
-- tenant_id is the PK and has NO GUC default → writers must always supply it.

CREATE TABLE IF NOT EXISTS composition_search_settings (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at          TIMESTAMPTZ(6),
  enabled_by          UUID,
  acceptance_snapshot JSONB,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Canonical tenant_isolation policy (Pattern A) — copied verbatim from migration
-- 350 (which copied it from 328/335/336): full USING + WITH CHECK, four-branch
-- predicate resolving through the shared app_current_tenant_id_uuid() helper
-- (migration 075). SUPER_ADMIN cross-tenant reads keep working via `bypass`.
ALTER TABLE composition_search_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE composition_search_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON composition_search_settings;
CREATE POLICY tenant_isolation ON composition_search_settings
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );
