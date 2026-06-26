-- 347_widen_event_outbox_id_to_bigint.sql
--
-- FK-type mismatch: event_outbox.id is BIGINT (it is a high-volume append-only
-- outbox whose sequence can run past 2^31), but the bridge column
-- webhook_deliveries.event_outbox_id was INTEGER. Once event_outbox.id crosses
-- 2147483647 the drain's enqueueDelivery could no longer store the id in the
-- delivery row — the INSERT would overflow (22003) and the BigInt→Int coercion
-- in the service (Number.parseInt) silently truncates large ids, so a delivery
-- would point at the WRONG outbox row (or none). This is a data-integrity bug on
-- the clinical/billing event audit trail, not just a future capacity ceiling.
--
-- Widen the column to BIGINT to match event_outbox.id. The column stays NULLABLE
-- (ad-hoc admin replays and pre-bridge legacy rows carry NULL). There is no
-- DB-level FK constraint on this column (it is a logical bridge only — see the
-- absence of a webhook_deliveries_event_outbox_id_fkey), so nothing to drop/re-
-- add. Postgres rebuilds the dependent partial index
-- idx_webhook_deliveries_event_outbox automatically on the type change; an
-- INTEGER→BIGINT widening is a safe, value-preserving in-place rewrite.
--
-- Idempotent: only ALTER when the column is still 'integer' so a re-run (or a
-- DB already at BIGINT) is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'webhook_deliveries'
       AND column_name = 'event_outbox_id'
       AND data_type = 'integer'
  ) THEN
    ALTER TABLE webhook_deliveries
      ALTER COLUMN event_outbox_id TYPE BIGINT;
  END IF;
END $$;
