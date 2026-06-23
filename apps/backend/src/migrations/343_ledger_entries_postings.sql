-- 343_ledger_entries_postings.sql
-- Journal headers + balanced posting lines. Append-only (mig-324 pattern):
-- corrections are reversal entries, never UPDATE/DELETE. §3.2/§3.3/§4.3.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id               BIGSERIAL PRIMARY KEY,
  -- tenant_id defaults to the active-tenant GUC (set by setTenantTx) so a
  -- tenant-B movement stamps tenant-B; falls back to the default tenant when no
  -- GUC is set (single-tenant / migrations). M8 / FORCE-RLS pattern.
  tenant_id        UUID NOT NULL DEFAULT COALESCE((NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
  entry_type       VARCHAR(30) NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID,
  idempotency_key  VARCHAR(120),
  reverses_entry_id BIGINT REFERENCES ledger_entries(id),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ledger_postings (
  id                     BIGSERIAL PRIMARY KEY,
  entry_id               BIGINT NOT NULL REFERENCES ledger_entries(id),
  -- same active-tenant-GUC default as ledger_entries (M8 / FORCE-RLS pattern);
  -- the balance-maintenance trigger copies NEW.tenant_id into ledger_balances.
  tenant_id              UUID NOT NULL DEFAULT COALESCE((NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
  account_id             BIGINT NOT NULL REFERENCES ledger_accounts(id),
  amount_paise           BIGINT NOT NULL,   -- signed: +debit / -credit
  patient_uid            UUID,
  invoice_id             INTEGER,
  advance_id             INTEGER,
  payment_id             INTEGER,
  cash_drawer_session_id BIGINT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (amount_paise <> 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_postings_entry   ON ledger_postings (entry_id);
CREATE INDEX IF NOT EXISTS idx_ledger_postings_account ON ledger_postings (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_postings_patient ON ledger_postings (tenant_id, patient_uid) WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_postings_invoice ON ledger_postings (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_postings_advance ON ledger_postings (tenant_id, advance_id) WHERE advance_id IS NOT NULL;

-- Append-only guard. Allows the app.audit_bypass escape hatch ONLY (used by the
-- same test-teardown convention as audit_logs); normal UPDATE/DELETE aborts.
CREATE OR REPLACE FUNCTION ledger_block_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'ledger is append-only: % on % is not permitted (use a reversal entry)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

DROP TRIGGER IF EXISTS ledger_postings_append_only ON ledger_postings;
CREATE TRIGGER ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

-- RLS for both.
ALTER TABLE ledger_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries  FORCE  ROW LEVEL SECURITY;
ALTER TABLE ledger_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_postings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ledger_entries;
CREATE POLICY tenant_isolation ON ledger_entries
  USING (tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, tenant_id));
DROP POLICY IF EXISTS tenant_isolation ON ledger_postings;
CREATE POLICY tenant_isolation ON ledger_postings
  USING (tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, tenant_id));
