-- 713_payment_gateway_settlement_integrity.sql
--
-- Forward-only convergence for databases that already recorded migration 712.
-- 712 remains byte-for-byte immutable. This upgrade:
--   * serializes manual and gateway refund payout authority;
--   * binds each provider intent to a webhook credential version;
--   * requires attributable reconciliation evidence; and
--   * enforces exact same-tenant gateway execution ownership.

BEGIN;

ALTER TABLE payment_gateway_provider_configs
  ADD COLUMN IF NOT EXISTS webhook_credential_version INTEGER NOT NULL DEFAULT 1,
  DROP CONSTRAINT IF EXISTS chk_pg_config_webhook_credential_version;

ALTER TABLE payment_gateway_provider_configs
  ADD CONSTRAINT chk_pg_config_webhook_credential_version
  CHECK (webhook_credential_version > 0);

-- Some retained databases recorded the originally published 693 constraint,
-- which did not yet require webhook verification material. Disable any such
-- incomplete live row before converging the database invariant; runtime was
-- already treating it as effectively disabled.
UPDATE payment_gateway_provider_configs
   SET enabled = FALSE,
       metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{disabled_by_713}',
         jsonb_build_object('reason', 'incomplete_live_credentials'),
         true
       ),
       updated_at = NOW()
 WHERE provider <> 'dry_run'
   AND enabled = TRUE
   AND (
     key_id IS NULL
     OR key_secret_ciphertext IS NULL
     OR webhook_secret_ciphertext IS NULL
   );

ALTER TABLE payment_gateway_provider_configs
  DROP CONSTRAINT IF EXISTS chk_pg_provider_config_live_credentials;

ALTER TABLE payment_gateway_provider_configs
  ADD CONSTRAINT chk_pg_provider_config_live_credentials
  CHECK (
    provider = 'dry_run'
    OR NOT enabled
    OR (
      key_id IS NOT NULL
      AND key_secret_ciphertext IS NOT NULL
      AND webhook_secret_ciphertext IS NOT NULL
    )
  );

ALTER TABLE payment_gateway_orders
  ADD COLUMN IF NOT EXISTS webhook_credential_version INTEGER;

UPDATE payment_gateway_orders AS orders
   SET webhook_credential_version = configs.webhook_credential_version
  FROM payment_gateway_provider_configs AS configs
 WHERE orders.webhook_credential_version IS NULL
   AND orders.provider_config_id = configs.id
   AND orders.tenant_id = configs.tenant_id;

UPDATE payment_gateway_orders
   SET webhook_credential_version = 1
 WHERE webhook_credential_version IS NULL;

ALTER TABLE payment_gateway_orders
  ALTER COLUMN webhook_credential_version SET NOT NULL,
  DROP CONSTRAINT IF EXISTS chk_pg_order_webhook_credential_version;

ALTER TABLE payment_gateway_orders
  ADD CONSTRAINT chk_pg_order_webhook_credential_version
  CHECK (webhook_credential_version > 0);

ALTER TABLE payment_gateway_refunds
  ADD COLUMN IF NOT EXISTS webhook_credential_version INTEGER,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_webhook_credential_version,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_reconciliation_resolution,
  DROP CONSTRAINT IF EXISTS fk_pg_refund_reconciled_actor;

UPDATE payment_gateway_refunds AS refunds
   SET webhook_credential_version = orders.webhook_credential_version
  FROM payment_gateway_orders AS orders
 WHERE refunds.webhook_credential_version IS NULL
   AND refunds.gateway_order_id = orders.id
   AND refunds.tenant_id = orders.tenant_id;

UPDATE payment_gateway_refunds
   SET webhook_credential_version = 1
 WHERE webhook_credential_version IS NULL;

-- Migration 712 allowed an actorless resolved stamp. Preserve that historical
-- material in metadata, but reopen it: without an authenticated actor it is
-- not a valid resolution under the forward invariant.
UPDATE payment_gateway_refunds
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
 WHERE reconciled_at IS NOT NULL
   AND reconciled_by IS NULL;

ALTER TABLE payment_gateway_refunds
  ALTER COLUMN webhook_credential_version SET NOT NULL;

ALTER TABLE payment_gateway_refunds
  ADD CONSTRAINT chk_pg_refund_webhook_credential_version
    CHECK (webhook_credential_version > 0),
  ADD CONSTRAINT chk_pg_refund_reconciliation_resolution
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
  ADD CONSTRAINT fk_pg_refund_reconciled_actor
    FOREIGN KEY (tenant_id, reconciled_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE billing_refunds
  ADD COLUMN IF NOT EXISTS payout_rail VARCHAR(20),
  ADD COLUMN IF NOT EXISTS payout_rail_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gateway_refund_id INTEGER,
  DROP CONSTRAINT IF EXISTS fk_billing_refund_gateway_execution,
  DROP CONSTRAINT IF EXISTS chk_billing_refund_payout_rail;

-- A retained PAID billing refund without a processed gateway leg was completed
-- through the historical manual route. Keep that irreversible payout as the
-- authority and quarantine unresolved provider work; attributing it to the
-- gateway would hide a possible pre-upgrade double payout.
UPDATE billing_refunds AS refunds
   SET payout_rail = 'manual',
       payout_rail_claimed_at = COALESCE(refunds.payout_rail_claimed_at, refunds.paid_at, refunds.updated_at, NOW()),
       gateway_refund_id = NULL
 WHERE refunds.approval_status = 'PAID'
   AND NOT EXISTS (
     SELECT 1
       FROM payment_gateway_refunds AS leg
      WHERE leg.tenant_id = refunds.tenant_id
        AND leg.billing_refund_id = refunds.id
        AND leg.status = 'processed'
   );

UPDATE payment_gateway_refunds AS legs
   SET status = 'requires_reconciliation',
       failure_code = 'retained_manual_payout_conflict',
       failure_reason =
         'Billing refund was already paid without a processed gateway leg; verify provider payout evidence',
       updated_at = NOW()
  FROM billing_refunds AS refunds
 WHERE refunds.id = legs.billing_refund_id
   AND refunds.tenant_id = legs.tenant_id
   AND refunds.approval_status = 'PAID'
   AND refunds.payout_rail = 'manual'
   AND legs.status IN ('initiated', 'pending');

-- A PAID row is attributed to the gateway only when a processed execution leg
-- supplies evidence. The newest processed leg is the exact authority.
WITH latest_processed_gateway_leg AS (
  SELECT DISTINCT ON (tenant_id, billing_refund_id)
         tenant_id, billing_refund_id, id
    FROM payment_gateway_refunds
   WHERE billing_refund_id IS NOT NULL
     AND status = 'processed'
   ORDER BY tenant_id, billing_refund_id, id DESC
)
UPDATE billing_refunds AS refunds
   SET payout_rail = 'gateway',
       payout_rail_claimed_at = COALESCE(refunds.payout_rail_claimed_at, refunds.paid_at, refunds.updated_at, NOW()),
       gateway_refund_id = legs.id
  FROM latest_processed_gateway_leg AS legs
 WHERE refunds.id = legs.billing_refund_id
   AND refunds.tenant_id = legs.tenant_id
   AND refunds.approval_status = 'PAID';

-- Every non-PAID retained gateway leg owns its billing refund before manual
-- payout can resume. The newest leg is the recovery authority after a failed
-- retry and can be replaced only by runtime's explicit failed-leg transition.
WITH latest_gateway_leg AS (
  SELECT DISTINCT ON (tenant_id, billing_refund_id)
         tenant_id, billing_refund_id, id
    FROM payment_gateway_refunds
   WHERE billing_refund_id IS NOT NULL
   ORDER BY tenant_id, billing_refund_id, id DESC
)
UPDATE billing_refunds AS refunds
   SET payout_rail = 'gateway',
       payout_rail_claimed_at = COALESCE(refunds.payout_rail_claimed_at, NOW()),
       gateway_refund_id = legs.id
  FROM latest_gateway_leg AS legs
 WHERE refunds.id = legs.billing_refund_id
   AND refunds.tenant_id = legs.tenant_id
   AND refunds.approval_status <> 'PAID'
   AND (refunds.payout_rail IS NULL OR refunds.payout_rail = 'gateway');

CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_refund_tenant_billing_execution
  ON payment_gateway_refunds (tenant_id, billing_refund_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_refund_gateway_execution
  ON billing_refunds (gateway_refund_id)
  WHERE gateway_refund_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_refund_tenant_authority
  ON billing_refunds (tenant_id, id, gateway_refund_id);

DO $gateway_authority_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM billing_refunds AS authority
      LEFT JOIN payment_gateway_refunds AS execution
        ON execution.tenant_id = authority.tenant_id
       AND execution.billing_refund_id = authority.id
       AND execution.id = authority.gateway_refund_id
     WHERE authority.gateway_refund_id IS NOT NULL
       AND execution.id IS NULL
  ) THEN
    RAISE EXCEPTION
      '713 preflight: billing refund gateway authority is dangling or cross-tenant'
      USING ERRCODE = '23503';
  END IF;
END
$gateway_authority_preflight$;

ALTER TABLE billing_refunds
  ADD CONSTRAINT chk_billing_refund_payout_rail
    CHECK (
      (
        payout_rail IS NULL
        AND payout_rail_claimed_at IS NULL
        AND gateway_refund_id IS NULL
      )
      OR (
        payout_rail = 'manual'
        AND payout_rail_claimed_at IS NOT NULL
        AND gateway_refund_id IS NULL
      )
      OR (
        payout_rail = 'gateway'
        AND payout_rail_claimed_at IS NOT NULL
        AND gateway_refund_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT fk_billing_refund_gateway_execution
    FOREIGN KEY (tenant_id, id, gateway_refund_id)
    REFERENCES payment_gateway_refunds (tenant_id, billing_refund_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_pg_refund_reconciliation_queue
  ON payment_gateway_refunds (tenant_id, initiated_at, id)
  WHERE status = 'requires_reconciliation' AND reconciled_at IS NULL;

COMMENT ON COLUMN payment_gateway_provider_configs.webhook_credential_version IS
  'Monotonic per-config webhook signing-secret version. Rotations increment it; retired versions remain inbound-only.';
COMMENT ON COLUMN payment_gateway_orders.webhook_credential_version IS
  'Webhook signing-secret version bound when the provider order intent was created.';
COMMENT ON COLUMN payment_gateway_refunds.webhook_credential_version IS
  'Webhook signing-secret version bound before this provider refund request.';
COMMENT ON COLUMN billing_refunds.payout_rail IS
  'Atomic payout authority: manual or gateway. Claimed before any irreversible payout and never silently switched.';
COMMENT ON COLUMN billing_refunds.gateway_refund_id IS
  'Exact same-tenant payment_gateway_refunds execution row authorized to settle this billing refund.';
COMMENT ON COLUMN payment_gateway_refunds.reconciled_at IS
  'When an authenticated operator completed manual review of a requires_reconciliation provider refund leg.';
COMMENT ON COLUMN payment_gateway_refunds.reconciliation_note IS
  'Required operator evidence describing the provider and billing resolution; never changes the leg into processed.';
COMMENT ON COLUMN payment_gateway_refunds.reconciled_by IS
  'Required authenticated same-tenant staff uid that recorded the manual refund reconciliation.';

COMMIT;
