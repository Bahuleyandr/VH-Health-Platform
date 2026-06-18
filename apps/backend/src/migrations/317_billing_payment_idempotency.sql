-- Migration 317: billing_payments reference uniqueness (double-charge guard).
--
-- Audit 2026-06-18 §C-1: billing V2 money routes had no idempotency and
-- `billing_payments.reference` carried no uniqueness, so a retry / double-click
-- / gateway-webhook replay could insert a SECOND real payment row for the same
-- gateway txn id → invoice over-credited, phantom collection.
--
-- This adds a PARTIAL UNIQUE INDEX on (tenant_id, reference, mode) restricted to
-- rows that actually carry a reference (txn id / UPI ref / cheque no / NEFT id).
-- Cash payments and any payment without a reference are intentionally exempt:
-- there is no external idempotency token for them, and two genuine ₹500 cash
-- receipts with no reference are legitimately distinct rows. The application-
-- layer Idempotency-Key middleware (mig E4) is the first line of defence; this
-- index is the durable DB backstop for gateway/webhook replays that re-present
-- the same reference.
--
-- SAFE-ON-EXISTING-DATA: a UNIQUE INDEX cannot be created if duplicate
-- (tenant_id, reference, mode) groups already exist — Postgres would fail with a
-- bare "could not create unique index" that does not name the offending data.
-- The DO-block below pre-checks and RAISEs an actionable error first so the
-- operator dedupes before applying, rather than getting an opaque index-build
-- failure mid-migration.
--
-- No CONCURRENTLY: the migration runner wraps every file in a single
-- transaction (SET LOCAL statement_timeout = '120s'); CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block.

BEGIN;

-- Pre-flight: refuse to apply if a duplicate would block the unique index.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM billing_payments
     WHERE reference IS NOT NULL AND reference <> ''
     GROUP BY tenant_id, reference, mode
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'dedupe billing_payments duplicate (tenant_id,reference,mode) before applying 317';
  END IF;
END $$;

-- Durable double-charge backstop: one payment per (tenant, reference, mode).
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payments_tenant_reference_mode
  ON billing_payments (tenant_id, reference, mode)
  WHERE reference IS NOT NULL AND reference <> '';

COMMIT;
