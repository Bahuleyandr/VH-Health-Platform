-- 708_payment_gateway_refund_security_upgrade.sql
--
-- Additive upgrade for the refund idempotency and reconciliation constraints
-- developed after migration 697 was published. The raw migration runner tracks
-- applied filenames, not digests, so 697 remains immutable and this migration
-- converges both supported states:
--   * a retained database that applied the published 697; and
--   * a database that briefly applied the amended branch version.
--
-- A published-697 `initiated` row has no durable record of the provider key
-- used before a crash. Replaying it could issue a second irreversible refund,
-- so the upgrade parks that row for operator reconciliation. Rows from the
-- amended branch already have a valid key and remain safely replayable.

BEGIN;

ALTER TABLE payment_gateway_refunds
  ADD COLUMN IF NOT EXISTS provider_idempotency_key VARCHAR(120),
  ALTER COLUMN status TYPE VARCHAR(30),
  DROP CONSTRAINT IF EXISTS chk_pg_refund_status;

ALTER TABLE payment_gateway_refunds
  ADD CONSTRAINT chk_pg_refund_status
  CHECK (status IN (
    'initiated', 'pending', 'processed', 'failed', 'requires_reconciliation'
  ));

UPDATE payment_gateway_refunds
   SET status = 'requires_reconciliation',
       provider_idempotency_key = 'pgr_legacy_' || id::text,
       failure_code = 'legacy_intent_hold',
       failure_reason =
         'Retained pre-idempotency refund intent requires provider reconciliation before retry',
       updated_at = NOW()
 WHERE provider_idempotency_key IS NULL
   AND status = 'initiated';

UPDATE payment_gateway_refunds
   SET provider_idempotency_key = 'pgr_legacy_' || id::text,
       updated_at = NOW()
 WHERE provider_idempotency_key IS NULL;

DO $refund_key_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payment_gateway_refunds
     WHERE provider_idempotency_key !~ '^[A-Za-z0-9_-]{10,120}$'
  ) THEN
    RAISE EXCEPTION
      '708 preflight: refund provider idempotency key is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM payment_gateway_refunds
     GROUP BY tenant_id, provider, provider_idempotency_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '708 preflight: refund provider idempotency key is not unique per provider'
      USING ERRCODE = '23505';
  END IF;
END
$refund_key_preflight$;

ALTER TABLE payment_gateway_refunds
  ALTER COLUMN provider_idempotency_key SET NOT NULL,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_idempotency_key;

ALTER TABLE payment_gateway_refunds
  ADD CONSTRAINT chk_pg_refund_idempotency_key
  CHECK (provider_idempotency_key ~ '^[A-Za-z0-9_-]{10,120}$');

CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_refund_provider_idempotency
  ON payment_gateway_refunds (tenant_id, provider, provider_idempotency_key);

DROP INDEX IF EXISTS ux_pg_refund_billing_refund_live;
CREATE UNIQUE INDEX ux_pg_refund_billing_refund_live
  ON payment_gateway_refunds (tenant_id, billing_refund_id)
  WHERE billing_refund_id IS NOT NULL
    AND status IN ('initiated', 'pending', 'processed', 'requires_reconciliation');

COMMENT ON COLUMN payment_gateway_refunds.provider_idempotency_key IS
  'Durable provider retry key persisted before the irreversible refund API call; retries reuse the same key and request body.';

COMMIT;
