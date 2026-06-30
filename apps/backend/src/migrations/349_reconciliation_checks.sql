-- 349_reconciliation_checks.sql
-- Phase 4-5: durable per-tenant money-ledger reconciliation evidence. The
-- reconciliation cron appends one row per tenant per sweep. "N consecutive clean
-- sweeps over M days" is the operator's objective evidence for flipping a
-- tenant's ledger_authoritative_mode -> enforce. Tenant-scoped (RLS), indexed by
-- (tenant, time). Not a financial ledger table, so it is NOT append-only —
-- retention purges may trim old rows.
CREATE TABLE IF NOT EXISTS reconciliation_checks (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  swept_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode                VARCHAR(16) NOT NULL DEFAULT 'shadow',
  mismatch_count      INTEGER NOT NULL DEFAULT 0,
  unwired_count       INTEGER NOT NULL DEFAULT 0,
  events_drift_count  INTEGER NOT NULL DEFAULT 0,
  trial_balance_paise BIGINT  NOT NULL DEFAULT 0,
  passed              BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_checks_tenant_time
  ON reconciliation_checks (tenant_id, swept_at DESC);

ALTER TABLE reconciliation_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_checks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reconciliation_checks;
CREATE POLICY tenant_isolation ON reconciliation_checks
  USING (tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, tenant_id));
