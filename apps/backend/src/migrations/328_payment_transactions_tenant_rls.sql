-- 328_payment_transactions_tenant_rls.sql
--
-- W2 (multi-tenancy program) — schema completeness, BLOCKER.
--
-- The legacy money table `payment_transactions` had NO tenant_id / RLS (audit
-- 2026-06-18 schema gap; `000_baseline.sql:14008`). Its only linkage is
-- invoice_id -> invoices(id), and `invoices` IS tenant-isolated — so a payment
-- row was cross-tenant readable/writable and could not be DB-isolated. (The
-- newer `billing_payments` table was already isolated; this closes the legacy
-- one.)
--
-- Add tenant_id + RLS + FORCE + the canonical tenant_isolation policy + the
-- GUC-reading DEFAULT (the post-migration-310 platform standard, so an INSERT
-- under setTenant(X) auto-stamps tenant X and passes WITH CHECK). Backfill from
-- the linked invoice. SAFE on existing single-tenant data — every current row
-- resolves to the default tenant, no collisions.
--
-- Pattern mirrors migrations 239 (add-isolation) + 310 (GUC default).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'payment_transactions'
  ) THEN
    RAISE NOTICE 'Skipping payment_transactions: table does not exist';
    RETURN;
  END IF;

  ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS tenant_id uuid;

  -- Backfill from the linked invoice (invoice_id int -> invoices.id).
  UPDATE payment_transactions pt
     SET tenant_id = COALESCE(i.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
    FROM invoices i
   WHERE pt.tenant_id IS NULL AND i.id = pt.invoice_id;

  -- Orphan/legacy rows with no resolvable invoice -> default tenant.
  UPDATE payment_transactions
     SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
   WHERE tenant_id IS NULL;

  ALTER TABLE payment_transactions
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN tenant_id SET DEFAULT
      COALESCE(
        NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid
      );

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_transactions_tenant'
  ) THEN
    ALTER TABLE payment_transactions
      ADD CONSTRAINT fk_payment_transactions_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;

  CREATE INDEX IF NOT EXISTS idx_payment_transactions_tenant_id
    ON payment_transactions (tenant_id);

  ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE payment_transactions FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON payment_transactions;
  CREATE POLICY tenant_isolation ON payment_transactions
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
END
$$;

COMMIT;
