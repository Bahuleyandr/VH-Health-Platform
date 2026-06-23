-- 342_ledger_accounts.sql
-- Double-entry ledger Phase 1: the chart of accounts (small, fixed per tenant).
-- See docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md §3.1.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  code        VARCHAR(40) NOT NULL,
  -- ASSET / CONTRA accumulate +debit/-credit in normal direction;
  -- LIABILITY / REVENUE / EQUITY accumulate +credit/-debit.
  type        VARCHAR(20) NOT NULL CHECK (type IN ('ASSET','LIABILITY','REVENUE','CONTRA','EQUITY')),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

-- normal_side helper used by the balance-maintenance trigger (migration 345).
-- +1 = debit-normal (asset/contra), -1 = credit-normal (liability/revenue/equity).
CREATE OR REPLACE FUNCTION ledger_account_normal_side(p_type VARCHAR)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_type IN ('ASSET','CONTRA') THEN 1 ELSE -1 END
$$;

-- Seed the fixed chart for the default tenant. Per-tenant seeding for other
-- tenants happens in the onboarding flow (out of scope here).
INSERT INTO ledger_accounts (tenant_id, code, type, description) VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid, 'PATIENT_AR',      'ASSET',     'Patient accounts receivable'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'CASH',            'ASSET',     'Physical cash (by drawer session)'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'BANK',            'ASSET',     'Electronic receipts (by mode)'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'PATIENT_ADVANCE', 'LIABILITY', 'Unapplied patient advances/deposits'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'INSURANCE_AR',    'ASSET',     'Insurer/TPA receivable'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'TAX_PAYABLE',     'LIABILITY', 'GST collected, owed to authority'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'REFUNDS_PAYABLE', 'LIABILITY', 'Approved refunds not yet paid'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'WRITE_OFF',       'CONTRA',    'Bad-debt / discount write-offs'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'REVENUE',         'REVENUE',   'Billed services revenue'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'OPENING_EQUITY',  'EQUITY',    'Cutover opening-balance counter-account')
ON CONFLICT (tenant_id, code) DO NOTHING;

-- RLS (mig-075 tenant_isolation pattern). Permissive when the GUC is unset.
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ledger_accounts;
CREATE POLICY tenant_isolation ON ledger_accounts
  USING (
    tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      tenant_id)
  );
