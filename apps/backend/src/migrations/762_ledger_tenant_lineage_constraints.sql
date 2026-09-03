-- 762_ledger_tenant_lineage_constraints.sql
--
-- The ledger tables all carry tenant_id, but migrations 342-345 linked them
-- through id alone. Because ledger ids are globally unique, those foreign keys
-- still allowed a tenant-A row to name a tenant-B parent. Tighten each link to
-- the tenant-qualified identity the services already use.
--
-- This is forward-only. Existing rows are never rewritten: each new foreign
-- key is installed NOT VALID, an explicit count preflight fails with 23503 if
-- legacy cross-tenant lineage exists, and only a clean table is validated.

BEGIN;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT uq_ledger_accounts_tenant_id_id
  UNIQUE (tenant_id, id);

ALTER TABLE ledger_entries
  ADD CONSTRAINT uq_ledger_entries_tenant_id_id
  UNIQUE (tenant_id, id);

ALTER TABLE ledger_entries
  ADD CONSTRAINT fk_ledger_entries_reverses_entry_tenant
  FOREIGN KEY (tenant_id, reverses_entry_id)
  REFERENCES ledger_entries (tenant_id, id)
  ON UPDATE NO ACTION
  ON DELETE NO ACTION
  NOT VALID;

ALTER TABLE ledger_postings
  ADD CONSTRAINT fk_ledger_postings_entry_tenant
  FOREIGN KEY (tenant_id, entry_id)
  REFERENCES ledger_entries (tenant_id, id)
  ON UPDATE NO ACTION
  ON DELETE NO ACTION
  NOT VALID,
  ADD CONSTRAINT fk_ledger_postings_account_tenant
  FOREIGN KEY (tenant_id, account_id)
  REFERENCES ledger_accounts (tenant_id, id)
  ON UPDATE NO ACTION
  ON DELETE NO ACTION
  NOT VALID;

ALTER TABLE ledger_balances
  ADD CONSTRAINT fk_ledger_balances_account_tenant
  FOREIGN KEY (tenant_id, account_id)
  REFERENCES ledger_accounts (tenant_id, id)
  ON UPDATE NO ACTION
  ON DELETE NO ACTION
  NOT VALID;

DO $ledger_reversal_tenant_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM ledger_entries child
   WHERE child.reverses_entry_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM ledger_entries parent
        WHERE parent.tenant_id = child.tenant_id
          AND parent.id = child.reverses_entry_id
     );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '762 preflight: % ledger_entries row(s) reverse an entry owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$ledger_reversal_tenant_preflight$;

DO $ledger_posting_entry_tenant_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM ledger_postings posting
   WHERE NOT EXISTS (
     SELECT 1
       FROM ledger_entries entry
      WHERE entry.tenant_id = posting.tenant_id
        AND entry.id = posting.entry_id
   );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '762 preflight: % ledger_postings row(s) name an entry owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$ledger_posting_entry_tenant_preflight$;

DO $ledger_posting_account_tenant_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM ledger_postings posting
   WHERE NOT EXISTS (
     SELECT 1
       FROM ledger_accounts account
      WHERE account.tenant_id = posting.tenant_id
        AND account.id = posting.account_id
   );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '762 preflight: % ledger_postings row(s) name an account owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$ledger_posting_account_tenant_preflight$;

DO $ledger_balance_account_tenant_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM ledger_balances balance
   WHERE NOT EXISTS (
     SELECT 1
       FROM ledger_accounts account
      WHERE account.tenant_id = balance.tenant_id
        AND account.id = balance.account_id
   );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '762 preflight: % ledger_balances row(s) name an account owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$ledger_balance_account_tenant_preflight$;

ALTER TABLE ledger_entries
  VALIDATE CONSTRAINT fk_ledger_entries_reverses_entry_tenant;

ALTER TABLE ledger_postings
  VALIDATE CONSTRAINT fk_ledger_postings_entry_tenant;

ALTER TABLE ledger_postings
  VALIDATE CONSTRAINT fk_ledger_postings_account_tenant;

ALTER TABLE ledger_balances
  VALIDATE CONSTRAINT fk_ledger_balances_account_tenant;

ALTER TABLE ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_reverses_entry_id_fkey;

ALTER TABLE ledger_postings
  DROP CONSTRAINT IF EXISTS ledger_postings_entry_id_fkey,
  DROP CONSTRAINT IF EXISTS ledger_postings_account_id_fkey;

ALTER TABLE ledger_balances
  DROP CONSTRAINT IF EXISTS ledger_balances_account_id_fkey;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_tenant_reversal
  ON ledger_entries (tenant_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_postings_tenant_entry
  ON ledger_postings (tenant_id, entry_id);

COMMIT;
