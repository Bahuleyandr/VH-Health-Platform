-- 717_new_fk_supporting_indexes.sql
--
-- Additive, index-only. Migrations 693-716 are published and immutable.
--
-- Supporting indexes for foreign keys and one hot routing lookup introduced by
-- the migration 710-716 wave. Each new FK below has no covering index, so a
-- parent-side delete/update (users, tenants) plans a sequential scan of the
-- child table, and the webhook-token router scans payment_gateway_provider_configs
-- on every inbound settlement callback:
--
--   * abdm_patient_share_intakes(tenant_id, matched_patient_uid)
--       FK fk_abdm_share_intake_patient -> users(tenant_id, uid).
--   * payment_gateway_orders(tenant_id, reconciled_by)
--       FK fk_pg_order_reconciled_actor -> users(tenant_id, uid).
--   * payment_gateway_refunds(tenant_id, reconciled_by)
--       FK fk_pg_refund_reconciled_actor -> users(tenant_id, uid).
--   * payment_gateway_provider_configs metadata->>'webhook_token'
--       resolveWebhookConfigByToken()'s token-only routing lookup
--       (paymentGatewayService.js). The token routes to exactly one config, so
--       the index is UNIQUE — a duplicate token would mean two tenants claim the
--       same inbound webhook path.
--
-- All are partial (only rows carrying the nullable column) so they stay small,
-- and IF NOT EXISTS keeps the file re-runnable. These tables are small/new; a
-- brief build-time lock is acceptable, so plain (non-CONCURRENTLY) CREATE INDEX
-- is used and the file runs inside the migration runner's transaction.
--
-- Uniqueness risk on the webhook token: webhook_token values are minted as
-- cryptographically-random opaque tokens (paymentGatewayService.js), so a
-- pre-existing duplicate is effectively impossible; the partial predicate also
-- excludes rows without a token. If a duplicate somehow existed the CREATE
-- UNIQUE INDEX would fail loudly rather than silently mis-route — the intended
-- behaviour.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_abdm_share_intake_matched_patient
  ON abdm_patient_share_intakes (tenant_id, matched_patient_uid)
  WHERE matched_patient_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_order_reconciled_by
  ON payment_gateway_orders (tenant_id, reconciled_by)
  WHERE reconciled_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_refund_reconciled_by
  ON payment_gateway_refunds (tenant_id, reconciled_by)
  WHERE reconciled_by IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_provider_config_webhook_token
  ON payment_gateway_provider_configs ((metadata->>'webhook_token'))
  WHERE (metadata->>'webhook_token') IS NOT NULL;

COMMIT;
