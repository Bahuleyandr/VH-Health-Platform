-- Unified Care Pathways S1b-r: leased outbox recovery and webhook fan-out
-- fencing. This migration requires a scheduler-quiesced, non-rolling cutover:
-- old workers cannot satisfy the new lease coherence constraints.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $event_outbox_preflight$
DECLARE
  invalid_count BIGINT;
  invalid_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_count
    FROM event_outbox
   WHERE status NOT IN ('pending', 'processing', 'delivered', 'failed')
      OR attempts < 0
      OR (status = 'delivered' AND delivered_at IS NULL)
      OR (status <> 'delivered' AND delivered_at IS NOT NULL);
  SELECT STRING_AGG(sample, ', ' ORDER BY sample)
    INTO invalid_samples
    FROM (
      SELECT FORMAT('%s/%s', tenant_id, id) AS sample
        FROM event_outbox
       WHERE status NOT IN ('pending', 'processing', 'delivered', 'failed')
          OR attempts < 0
          OR (status = 'delivered' AND delivered_at IS NULL)
          OR (status <> 'delivered' AND delivered_at IS NOT NULL)
       ORDER BY tenant_id, id
       LIMIT 20
    ) AS invalid;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'migration 588 event_outbox preflight failed: % invalid row(s); samples=%',
      invalid_count, COALESCE(invalid_samples, '<none>');
  END IF;
END
$event_outbox_preflight$;

DO $webhook_duplicate_preflight$
DECLARE
  duplicate_count BIGINT;
  duplicate_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO duplicate_count
    FROM (
      SELECT 1
        FROM webhook_deliveries
       WHERE event_outbox_id IS NOT NULL
         AND subscription_id IS NOT NULL
       GROUP BY tenant_id, event_outbox_id, subscription_id
      HAVING COUNT(*) > 1
    ) AS duplicate_groups;
  SELECT STRING_AGG(sample, ', ' ORDER BY sample)
    INTO duplicate_samples
    FROM (
      SELECT FORMAT('%s/%s/%s(count=%s)', tenant_id, event_outbox_id,
                    subscription_id, COUNT(*)) AS sample
        FROM webhook_deliveries
       WHERE event_outbox_id IS NOT NULL
         AND subscription_id IS NOT NULL
       GROUP BY tenant_id, event_outbox_id, subscription_id
      HAVING COUNT(*) > 1
       ORDER BY tenant_id, event_outbox_id, subscription_id
       LIMIT 20
    ) AS duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'migration 588 webhook delivery duplicate preflight failed: % duplicate group(s); samples=%',
      duplicate_count, COALESCE(duplicate_samples, '<none>');
  END IF;
END
$webhook_duplicate_preflight$;

DO $webhook_filter_preflight$
DECLARE
  invalid_count BIGINT;
  invalid_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_count
    FROM webhook_subscriptions
   WHERE is_active = TRUE
     AND event_filter <> '{}'::jsonb;
  SELECT STRING_AGG(sample, ', ' ORDER BY sample)
    INTO invalid_samples
    FROM (
      SELECT FORMAT('%s/%s', tenant_id, id) AS sample
        FROM webhook_subscriptions
       WHERE is_active = TRUE
         AND event_filter <> '{}'::jsonb
       ORDER BY tenant_id, id
       LIMIT 20
    ) AS invalid;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'migration 588 active webhook filter preflight failed: % unsupported subscription(s); samples=%',
      invalid_count, COALESCE(invalid_samples, '<none>');
  END IF;
END
$webhook_filter_preflight$;

ALTER TABLE event_outbox
  ADD COLUMN lease_owner UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ(6),
  ADD COLUMN redrive_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE webhook_deliveries
  ADD COLUMN lease_owner UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ(6),
  ADD COLUMN redrive_count INTEGER NOT NULL DEFAULT 0;

CREATE TEMP TABLE migration_588_recovery_counts ON COMMIT DROP AS
WITH source_recovered AS (
  UPDATE event_outbox
     SET status = CASE WHEN attempts >= 7 THEN 'failed' ELSE 'pending' END,
         available_at = NOW(),
         last_error = LEFT(
           CONCAT_WS('; ', NULLIF(last_error, ''),
                     'migration_588_recovered_unleased_processing'),
           2000
         )
   WHERE status = 'processing'
  RETURNING tenant_id
), delivery_recovered AS (
  UPDATE webhook_deliveries
     SET status = CASE WHEN attempt_number >= 7 THEN 'dead' ELSE 'failed' END,
         next_retry_at = CASE WHEN attempt_number >= 7 THEN NULL ELSE NOW() END,
         completed_at = CASE
           WHEN attempt_number >= 7 THEN COALESCE(completed_at, NOW())
           ELSE NULL
         END,
         error_message = LEFT(
           CONCAT_WS('; ', NULLIF(error_message, ''),
                     'migration_588_recovered_unleased_in_flight'),
           2000
         ),
         updated_at = NOW()
   WHERE status = 'in_flight'
  RETURNING tenant_id
), tenants_affected AS (
  SELECT tenant_id FROM source_recovered
  UNION
  SELECT tenant_id FROM delivery_recovered
)
SELECT tenant.tenant_id,
       (SELECT COUNT(*) FROM source_recovered AS source
         WHERE source.tenant_id = tenant.tenant_id)::integer AS source_count,
       (SELECT COUNT(*) FROM delivery_recovered AS delivery
         WHERE delivery.tenant_id = tenant.tenant_id)::integer AS delivery_count
  FROM tenants_affected AS tenant;

ALTER TABLE event_outbox
  ADD CONSTRAINT event_outbox_status_check
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  ADD CONSTRAINT event_outbox_attempts_nonnegative_check
    CHECK (attempts >= 0),
  ADD CONSTRAINT event_outbox_redrive_count_nonnegative_check
    CHECK (redrive_count >= 0),
  ADD CONSTRAINT event_outbox_lease_pair_check
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  ADD CONSTRAINT event_outbox_processing_lease_check
    CHECK (
      (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    );

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_attempt_nonnegative_check
    CHECK (attempt_number >= 0),
  ADD CONSTRAINT webhook_deliveries_redrive_count_nonnegative_check
    CHECK (redrive_count >= 0),
  ADD CONSTRAINT webhook_deliveries_lease_pair_check
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  ADD CONSTRAINT webhook_deliveries_in_flight_lease_check
    CHECK (
      (status = 'in_flight' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'in_flight' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    );

CREATE INDEX idx_event_outbox_stale_processing
  ON event_outbox (lease_expires_at, id)
  WHERE status = 'processing';

CREATE INDEX idx_webhook_deliveries_stale_in_flight
  ON webhook_deliveries (lease_expires_at, id)
  WHERE status = 'in_flight';

CREATE UNIQUE INDEX ux_webhook_deliveries_source_subscription
  ON webhook_deliveries (tenant_id, event_outbox_id, subscription_id)
  WHERE event_outbox_id IS NOT NULL AND subscription_id IS NOT NULL;

INSERT INTO audit_logs
  (tenant_id, uid, role, action, resource, resource_id, metadata, created_at)
SELECT tenant_id, NULL, 'system', 'OUTBOX_RECOVERY_MIGRATION_APPLIED',
       'outbox_recovery', '588',
       jsonb_build_object(
         'migration', '588_event_outbox_recovery_hardening.sql',
         'source_processing_recovered', source_count,
         'webhook_in_flight_recovered', delivery_count
       ),
       NOW()
  FROM migration_588_recovery_counts
 WHERE source_count > 0 OR delivery_count > 0;

COMMIT;
