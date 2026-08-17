-- 712_payment_gateway_operational_safety.sql
--
-- Additive operator evidence for refund legs parked by migration 708 or by
-- provider-response/webhook evidence checks. Published migrations 693-708
-- remain immutable. A parked row stays in requires_reconciliation so its
-- provider evidence cannot be mistaken for an automatically completed
-- payout; these columns record the accountable human resolution and let the
-- default work queue hide completed reviews without destroying that state.

BEGIN;

ALTER TABLE payment_gateway_refunds
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_note VARCHAR(500),
  ADD COLUMN IF NOT EXISTS reconciled_by UUID,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_reconciliation_resolution;

ALTER TABLE payment_gateway_refunds
  ADD CONSTRAINT chk_pg_refund_reconciliation_resolution
  CHECK (
    (reconciled_at IS NULL AND reconciliation_note IS NULL AND reconciled_by IS NULL)
    OR (
      status = 'requires_reconciliation'
      AND reconciled_at IS NOT NULL
      AND reconciliation_note IS NOT NULL
      AND length(btrim(reconciliation_note)) BETWEEN 10 AND 500
    )
  );

CREATE INDEX IF NOT EXISTS idx_pg_refund_reconciliation_queue
  ON payment_gateway_refunds (tenant_id, initiated_at, id)
  WHERE status = 'requires_reconciliation' AND reconciled_at IS NULL;

COMMENT ON COLUMN payment_gateway_refunds.reconciled_at IS
  'When an authorized operator completed manual review of a requires_reconciliation provider refund leg.';
COMMENT ON COLUMN payment_gateway_refunds.reconciliation_note IS
  'Required operator evidence describing the provider/billing resolution; never changes the refund leg into processed.';
COMMENT ON COLUMN payment_gateway_refunds.reconciled_by IS
  'Authenticated staff uid that recorded the manual refund reconciliation.';

COMMIT;
