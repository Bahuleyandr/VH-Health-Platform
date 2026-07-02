-- 352_workflow_sla_rules_global_policy.sql
-- workflow_sla_rules supports tenant-specific overrides plus global defaults
-- (tenant_id IS NULL). The generic tenant_isolation policy installed by
-- migration 304 hid those global defaults whenever app.current_tenant_id was
-- set, causing canonical SLA starts inside setTenantTx() to silently skip.

DROP POLICY IF EXISTS tenant_isolation ON workflow_sla_rules;

CREATE POLICY tenant_isolation ON workflow_sla_rules
  USING (
    tenant_id IS NULL
    OR current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant_id_uuid())
  );
