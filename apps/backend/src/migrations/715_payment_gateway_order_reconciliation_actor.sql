-- 715_payment_gateway_order_reconciliation_actor.sql
--
-- Additive attribution for gateway-order reconciliation. Migrations 693-714
-- are published and remain immutable. A resolved order stamp is valid only
-- when its actor is an existing user in the same tenant; historical actorless
-- stamps are preserved in metadata and reopened for accountable review.

BEGIN;

ALTER TABLE payment_gateway_orders
  ADD COLUMN IF NOT EXISTS reconciled_by UUID,
  DROP CONSTRAINT IF EXISTS chk_pg_order_reconciliation_resolution,
  DROP CONSTRAINT IF EXISTS fk_pg_order_reconciled_actor;

UPDATE payment_gateway_orders
   SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{legacy_actorless_reconciliation}',
         jsonb_strip_nulls(jsonb_build_object(
           'reconciled_at', reconciled_at,
           'reconciliation_note', reconciliation_note
         )),
         true
       ),
       reconciled_at = NULL,
       reconciliation_note = NULL,
       reconciled_by = NULL,
       updated_at = NOW()
 WHERE (reconciled_at IS NOT NULL OR reconciliation_note IS NOT NULL)
   AND reconciled_by IS NULL;

ALTER TABLE payment_gateway_orders
  ADD CONSTRAINT chk_pg_order_reconciliation_resolution
    CHECK (
      (
        reconciled_at IS NULL
        AND reconciliation_note IS NULL
        AND reconciled_by IS NULL
      )
      OR (
        status = 'requires_reconciliation'
        AND reconciled_at IS NOT NULL
        AND reconciliation_note IS NOT NULL
        AND length(btrim(reconciliation_note)) BETWEEN 10 AND 500
        AND reconciled_by IS NOT NULL
      )
    ),
  ADD CONSTRAINT fk_pg_order_reconciled_actor
    FOREIGN KEY (tenant_id, reconciled_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

COMMENT ON COLUMN payment_gateway_orders.reconciled_by IS
  'Required authenticated same-tenant user uid that recorded the manual gateway-order reconciliation.';
COMMENT ON COLUMN payment_gateway_orders.reconciled_at IS
  'When an authenticated operator completed manual review of a requires_reconciliation gateway order.';
COMMENT ON COLUMN payment_gateway_orders.reconciliation_note IS
  'Required operator evidence describing how the captured payment was resolved.';

COMMIT;
