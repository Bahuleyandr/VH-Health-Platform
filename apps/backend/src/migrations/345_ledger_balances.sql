-- 345_ledger_balances.sql
-- Invariant 2 (§4.2): running balance per (account, dimension) maintained in the
-- account's NORMAL direction; a DEFERRED no-negative constraint trigger on the
-- constrained accounts makes overpayment / advance-overdraw / over-refund
-- UNCOMMITTABLE. The per-row upsert lock also closes the lost-update race.
CREATE TABLE IF NOT EXISTS ledger_balances (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  account_id   BIGINT NOT NULL REFERENCES ledger_accounts(id),
  patient_uid  UUID,
  invoice_id   INTEGER,
  advance_id   INTEGER,
  balance_paise BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one balance row per (account, dimension-tuple). NULLS NOT DISTINCT (PG15+)
  -- is LOAD-BEARING: dimension columns are nullable (e.g. CASH has all three
  -- NULL), and without it the default NULLS-DISTINCT semantics would treat each
  -- NULL-dimension posting as a new row, so the ON CONFLICT upsert below would
  -- fragment the balance instead of aggregating it.
  UNIQUE NULLS NOT DISTINCT (tenant_id, account_id, patient_uid, invoice_id, advance_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_balances_account ON ledger_balances (tenant_id, account_id);

-- Maintenance (IMMEDIATE): on each posting, add the NORMAL-direction delta to
-- the matching balance row (creating it if absent). normal-direction delta =
-- amount_paise * normal_side(account.type). The upsert takes the balance row
-- lock, which serializes concurrent movements on the same dimension and closes
-- the lost-update race.
CREATE OR REPLACE FUNCTION ledger_maintain_balance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_side INTEGER;
  v_delta BIGINT;
BEGIN
  SELECT ledger_account_normal_side(a.type) INTO v_side
    FROM ledger_accounts a WHERE a.id = NEW.account_id;
  v_delta := NEW.amount_paise * v_side;

  INSERT INTO ledger_balances (tenant_id, account_id, patient_uid, invoice_id, advance_id, balance_paise, updated_at)
  VALUES (NEW.tenant_id, NEW.account_id, NEW.patient_uid, NEW.invoice_id, NEW.advance_id, v_delta, NOW())
  ON CONFLICT (tenant_id, account_id, patient_uid, invoice_id, advance_id)
  DO UPDATE SET balance_paise = ledger_balances.balance_paise + EXCLUDED.balance_paise,
                updated_at = NOW();
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_maintain_balance ON ledger_postings;
CREATE TRIGGER ledger_postings_maintain_balance
  AFTER INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_maintain_balance();

-- No-negative (DEFERRED, at COMMIT): assert the FINAL balance of each touched
-- (constrained account, dimension) is >= 0. Deferred + final-state means line
-- insertion order within an entry is irrelevant, and a standalone movement that
-- nets fine is never spuriously rejected mid-entry. Constrained set per spec
-- §4.2: PATIENT_AR / PATIENT_ADVANCE / REFUNDS_PAYABLE.
CREATE OR REPLACE FUNCTION ledger_assert_balance_non_negative() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_code VARCHAR;
  v_bal  BIGINT;
BEGIN
  SELECT a.code INTO v_code FROM ledger_accounts a WHERE a.id = NEW.account_id;
  IF v_code NOT IN ('PATIENT_AR','PATIENT_ADVANCE','REFUNDS_PAYABLE') THEN
    RETURN NULL;
  END IF;
  SELECT b.balance_paise INTO v_bal
    FROM ledger_balances b
   WHERE b.tenant_id = NEW.tenant_id AND b.account_id = NEW.account_id
     AND b.patient_uid IS NOT DISTINCT FROM NEW.patient_uid
     AND b.invoice_id  IS NOT DISTINCT FROM NEW.invoice_id
     AND b.advance_id  IS NOT DISTINCT FROM NEW.advance_id;
  IF v_bal < 0 THEN
    RAISE EXCEPTION 'ledger no-negative violation: % balance would be % paise (overpayment/overdraw/over-refund blocked)', v_code, v_bal
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_non_negative ON ledger_postings;
CREATE CONSTRAINT TRIGGER ledger_postings_non_negative
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balance_non_negative();

-- RLS.
ALTER TABLE ledger_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_balances FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ledger_balances;
CREATE POLICY tenant_isolation ON ledger_balances
  USING (tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, tenant_id));
