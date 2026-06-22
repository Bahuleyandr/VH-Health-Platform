-- 340_payment_transactions_idempotency.sql
--
-- Audit 2026-06-22 H2: the legacy V1 billingService.recordPayment had NO
-- idempotency backstop — a replayed payment (same transaction_ref) created a
-- duplicate payment_transactions row and double-incremented invoices.paid_amount
-- (the same class billingV2 already fixed via mig-317 on billing_payments).
--
-- Add a per-tenant PARTIAL unique on transaction_ref so a replay collides at the
-- database (23505 → the service maps it to 409 DUPLICATE_PAYMENT_REF) instead of
-- silently charging twice. transaction_ref is nullable (e.g. counter cash with no
-- external reference); NULLs are excluded so multiple no-ref payments remain
-- allowed. Per-tenant so two tenants may legitimately reuse the same gateway ref.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_transactions_tenant_ref
  ON payment_transactions (tenant_id, transaction_ref)
  WHERE transaction_ref IS NOT NULL;
