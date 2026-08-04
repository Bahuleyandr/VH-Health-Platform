-- 622_siem_canonical_cutover.sql
-- C6.1-G / I25. Retain all four SIEM tables. The legacy cursor proves
-- capture into siem_export_events; delivery truth is per target and comes
-- only from acknowledgement evidence on attempt lineage.
--
-- The cutover gate contract is, verbatim:
-- 1. stable fenced cutoff
-- 2. shape parity
-- 3. capture completeness (recomputed payload SHA-256 per row)
-- 4. per-target delivery completeness from attempt lineage (never export_status)
-- 5. real acknowledgement policy
-- 6. cursor equality only where gate 4 passes, else pause at the greatest proven contiguous point with a reconciliation reason
-- 7. non-destructive fenced cutover (old cursor/events/attempts remain queryable; migrate the existing SIEM cursor only after parity; never delete old evidence)
-- 8. single writer after cutover (legacy writer frozen, canonical offsets authoritative; never both)
-- 9. crash/restart injection proofs at every boundary
-- 10. negative migration proof (any mismatch aborts with zero partial canonical rows)

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

ALTER TABLE public.siem_export_targets
  ADD COLUMN acknowledgement_contract VARCHAR(48) NOT NULL DEFAULT 'unclassified',
  ADD COLUMN acknowledgement_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN acknowledgement_classified_by UUID,
  ADD COLUMN acknowledgement_owner_reason VARCHAR(500),
  ADD COLUMN acknowledgement_owner_evidence JSONB,
  ADD CONSTRAINT uq_siem_export_targets_tenant_id UNIQUE (tenant_id, id),
  ADD CONSTRAINT fk_siem_export_targets_ack_owner
    FOREIGN KEY (tenant_id, acknowledgement_classified_by)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_siem_export_targets_ack_contract
    CHECK (
      acknowledgement_contract IN (
        'unclassified',
        'webhook_http_2xx_ingested',
        'webhook_receipt_header',
        'syslog_udp_transport_only',
        'local_file_transport_only'
      )
      AND (
        acknowledgement_contract = 'unclassified'
        OR (transport = 'webhook' AND acknowledgement_contract IN (
          'webhook_http_2xx_ingested', 'webhook_receipt_header'
        ))
        OR (transport = 'syslog' AND acknowledgement_contract = 'syslog_udp_transport_only')
        OR (transport = 'object_drop' AND acknowledgement_contract = 'local_file_transport_only')
      )
    ),
  ADD CONSTRAINT chk_siem_export_targets_ack_owner_shape
    CHECK (
      (
        acknowledgement_contract = 'unclassified'
        AND acknowledgement_classified_by IS NULL
        AND acknowledgement_owner_reason IS NULL
        AND acknowledgement_owner_evidence IS NULL
      )
      OR (
        acknowledgement_contract <> 'unclassified'
        AND acknowledgement_classified_by IS NOT NULL
        AND acknowledgement_owner_reason IS NOT NULL
        AND length(btrim(acknowledgement_owner_reason)) > 0
        AND acknowledgement_owner_evidence IS NOT NULL
        AND jsonb_typeof(acknowledgement_owner_evidence) = 'object'
        AND acknowledgement_owner_evidence <> '{}'::jsonb
      )
    );

ALTER TABLE public.siem_export_events
  ADD CONSTRAINT uq_siem_export_events_tenant_id UNIQUE (tenant_id, id);

COMMENT ON COLUMN public.siem_export_events.export_status IS
  'Legacy aggregate diagnostic only. Never use for per-target delivery or I25 HWM truth.';

ALTER TABLE public.siem_export_cursors
  ADD COLUMN last_captured_at TIMESTAMPTZ(6),
  ADD COLUMN cursor_semantics VARCHAR(48) NOT NULL DEFAULT 'capture_into_event_ledger',
  ADD COLUMN writer_state VARCHAR(40) NOT NULL DEFAULT 'legacy_capture',
  ADD COLUMN canonical_capture_offset_id UUID,
  ADD COLUMN cutover_fence_token UUID,
  ADD COLUMN cutover_at TIMESTAMPTZ(6),
  ADD COLUMN cutover_evidence JSONB,
  ADD COLUMN capture_schedule_decision VARCHAR(48) NOT NULL DEFAULT 'owner_activation_required',
  ADD COLUMN capture_schedule_owner_reason VARCHAR(500),
  ADD CONSTRAINT uq_siem_export_cursors_tenant_id UNIQUE (tenant_id, id),
  ADD CONSTRAINT fk_siem_export_cursors_canonical_offset
    FOREIGN KEY (tenant_id, canonical_capture_offset_id)
    REFERENCES public.event_consumer_offsets (tenant_id, offset_id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_siem_export_cursors_i25_semantics
    CHECK (
      cursor_semantics = 'capture_into_event_ledger'
      AND writer_state IN ('legacy_capture', 'canonical_offsets')
      AND capture_schedule_decision IN (
        'owner_activation_required', 'external_scheduler_approved'
      )
      AND (
        capture_schedule_decision = 'owner_activation_required'
        OR (
          capture_schedule_owner_reason IS NOT NULL
          AND length(btrim(capture_schedule_owner_reason)) > 0
        )
      )
    ),
  ADD CONSTRAINT chk_siem_export_cursors_i25_cutover_shape
    CHECK (
      (
        writer_state = 'legacy_capture'
        AND canonical_capture_offset_id IS NULL
        AND cutover_fence_token IS NULL
        AND cutover_at IS NULL
        AND cutover_evidence IS NULL
      )
      OR (
        writer_state = 'canonical_offsets'
        AND canonical_capture_offset_id IS NOT NULL
        AND cutover_fence_token IS NOT NULL
        AND cutover_at IS NOT NULL
        AND cutover_evidence IS NOT NULL
        AND jsonb_typeof(cutover_evidence) = 'object'
        AND cutover_evidence <> '{}'::jsonb
      )
    );

UPDATE public.siem_export_cursors
   SET last_captured_at = last_exported_at;

ALTER TABLE public.siem_export_delivery_attempts
  ADD COLUMN lease_owner VARCHAR(160),
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN lease_expires_at TIMESTAMPTZ(6),
  ADD COLUMN acknowledgement_state VARCHAR(32) NOT NULL DEFAULT 'not_evaluated',
  ADD COLUMN acknowledgement_evidence JSONB,
  ADD COLUMN acknowledged_at TIMESTAMPTZ(6),
  ADD COLUMN send_authority VARCHAR(40) NOT NULL DEFAULT 'normal',
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN recovery_owner_uid UUID,
  ADD COLUMN recovery_owner_reason VARCHAR(500),
  ADD COLUMN recovery_evidence JSONB,
  ADD COLUMN effect_disposition VARCHAR(32) NOT NULL DEFAULT 'live',
  ADD CONSTRAINT uq_siem_export_delivery_attempts_tenant_id UNIQUE (tenant_id, id),
  ADD CONSTRAINT fk_siem_export_delivery_attempts_event_tenant
    FOREIGN KEY (tenant_id, event_id)
    REFERENCES public.siem_export_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_siem_export_delivery_attempts_target_tenant
    FOREIGN KEY (tenant_id, target_id)
    REFERENCES public.siem_export_targets (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_siem_export_delivery_attempts_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_siem_export_delivery_attempts_recovery_owner
    FOREIGN KEY (tenant_id, recovery_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_siem_export_delivery_attempts_lease
    CHECK (
      lease_generation >= 0
      AND (
        status <> 'in_flight'
        OR (
          lease_owner IS NOT NULL
          AND length(btrim(lease_owner)) > 0
          AND lease_token IS NOT NULL
          AND lease_generation >= 1
          AND lease_expires_at IS NOT NULL
          AND started_at IS NOT NULL
        )
      )
    ),
  ADD CONSTRAINT chk_siem_export_delivery_attempts_ack
    CHECK (
      acknowledgement_state IN (
        'not_evaluated', 'legacy_unverified', 'transport_only',
        'positive', 'negative', 'uncertain'
      )
      AND (
        acknowledgement_state <> 'positive'
        OR (
          status = 'succeeded'
          AND acknowledged_at IS NOT NULL
          AND acknowledgement_evidence IS NOT NULL
          AND jsonb_typeof(acknowledgement_evidence) = 'object'
          AND acknowledgement_evidence <> '{}'::jsonb
        )
      )
    ),
  ADD CONSTRAINT chk_siem_export_delivery_attempts_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_evidence IS NULL
        AND send_authority = 'normal'
        AND effect_disposition = 'live'
      )
      OR (
        recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I25'
        AND recovery_owner_uid IS NOT NULL
        AND recovery_owner_reason IS NOT NULL
        AND length(btrim(recovery_owner_reason)) > 0
        AND recovery_evidence IS NOT NULL
        AND jsonb_typeof(recovery_evidence) = 'object'
        AND recovery_evidence <> '{}'::jsonb
        AND send_authority = 'held_owner_reconciliation'
        AND effect_disposition = 'late_pending_only'
        AND acknowledgement_state <> 'positive'
        AND status IN ('failed', 'dead', 'succeeded')
      )
    ),
  ADD CONSTRAINT chk_siem_export_delivery_attempts_authority
    CHECK (send_authority IN ('normal', 'held_owner_reconciliation')),
  ADD CONSTRAINT chk_siem_export_delivery_attempts_effect
    CHECK (effect_disposition IN ('live', 'late_pending_only'));

WITH stranded AS (
  UPDATE public.siem_export_delivery_attempts
     SET status = CASE WHEN attempt_number < 5 THEN 'failed' ELSE 'dead' END,
         error_message = 'migration_622_unleased_in_flight_held',
         completed_at = NOW(),
         acknowledgement_state = 'uncertain',
         acknowledgement_evidence = '{"reason":"pre_lease_in_flight_state"}'::jsonb,
         updated_at = NOW()
   WHERE status = 'in_flight'
  RETURNING *
)
INSERT INTO public.siem_export_delivery_attempts
  (tenant_id, event_id, target_id, transport, attempt_number, status,
   payload_snapshot, payload_sha256, request_id, next_retry_at, metadata)
SELECT tenant_id, event_id, target_id, transport, attempt_number + 1, 'pending',
       payload_snapshot, payload_sha256, gen_random_uuid()::text, NOW(),
       metadata || jsonb_build_object('retry_from_pre_lease_attempt_id', id::text)
  FROM stranded
 WHERE attempt_number < 5
ON CONFLICT (event_id, target_id, attempt_number) DO NOTHING;

UPDATE public.siem_export_delivery_attempts
   SET acknowledgement_state = 'legacy_unverified',
       acknowledgement_evidence = jsonb_build_object(
         'legacy_status', status,
         'positive_ack_not_proven', true
       )
 WHERE status = 'succeeded'
   AND acknowledgement_state = 'not_evaluated';

CREATE INDEX idx_siem_delivery_attempts_i25_lease
  ON public.siem_export_delivery_attempts
    (tenant_id, status, lease_expires_at)
  WHERE status = 'in_flight';

CREATE INDEX idx_siem_delivery_attempts_i25_ack
  ON public.siem_export_delivery_attempts
    (tenant_id, target_id, event_id, acknowledgement_state, attempt_number DESC);

CREATE OR REPLACE FUNCTION public.assert_siem_i25_recovery_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inbox RECORD;
  event_row RECORD;
  expected_partition TEXT;
  expected_duplicate TEXT;
BEGIN
  IF NEW.recovery_inbox_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT source_name, source_id, payload_sha256::text
    INTO event_row
    FROM public.siem_export_events
   WHERE tenant_id = NEW.tenant_id AND id = NEW.event_id;

  IF event_row.source_name IS DISTINCT FROM 'audit_log'
     OR event_row.source_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_recovery_source',
      MESSAGE = 'I25 canonical recovery requires numeric audit_log source identity';
  END IF;

  SELECT item.interface_family, item.direction, item.source_partition,
         item.source_position, item.duplicate_key, item.arrival_class,
         item.effect_disposition, item.status
    INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id;

  expected_partition := 'siem:audit_log:security:target:' || NEW.target_id::text;
  expected_duplicate := 'i25:' || NEW.event_id::text || ':' || NEW.target_id::text
                        || ':' || NEW.attempt_number::text || ':'
                        || NEW.payload_sha256::text;

  IF inbox.interface_family IS DISTINCT FROM 'I25'
     OR inbox.direction IS DISTINCT FROM 'outbound'
     OR inbox.source_partition IS DISTINCT FROM expected_partition
     OR inbox.source_position IS DISTINCT FROM event_row.source_id::bigint
     OR inbox.duplicate_key IS DISTINCT FROM expected_duplicate
     OR inbox.arrival_class IS DISTINCT FROM 'recovery_backlog'
     OR inbox.effect_disposition IS DISTINCT FROM 'late_pending_only'
     OR inbox.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_recovery_inbox_binding',
      MESSAGE = 'I25 recovery does not match canonical per-target attempt provenance';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER siem_i25_recovery_binding
BEFORE INSERT OR UPDATE OF recovery_inbox_id
ON public.siem_export_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION public.assert_siem_i25_recovery_binding();

CREATE OR REPLACE FUNCTION public.assert_siem_i25_attempt_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.recovery_inbox_id IS NOT NULL OR OLD.acknowledgement_state = 'positive' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_siem_i25_attempt_evidence_immutable',
        MESSAGE = 'I25 recovery and positive acknowledgement evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.event_id IS DISTINCT FROM NEW.event_id
     OR OLD.target_id IS DISTINCT FROM NEW.target_id
     OR OLD.attempt_number IS DISTINCT FROM NEW.attempt_number
     OR OLD.transport IS DISTINCT FROM NEW.transport
     OR OLD.payload_snapshot IS DISTINCT FROM NEW.payload_snapshot
     OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_attempt_identity_immutable',
      MESSAGE = 'I25 per-target attempt identity and payload evidence is immutable';
  END IF;

  IF OLD.acknowledgement_state = 'positive' AND (
    NEW.acknowledgement_state IS DISTINCT FROM OLD.acknowledgement_state
    OR NEW.acknowledgement_evidence IS DISTINCT FROM OLD.acknowledgement_evidence
    OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_positive_ack_immutable',
      MESSAGE = 'I25 positive acknowledgement evidence is immutable';
  END IF;

  IF OLD.recovery_inbox_id IS NOT NULL AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.acknowledgement_state IS DISTINCT FROM OLD.acknowledgement_state
    OR NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
    OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
    OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
    OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
    OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence
    OR NEW.send_authority IS DISTINCT FROM OLD.send_authority
    OR NEW.effect_disposition IS DISTINCT FROM OLD.effect_disposition
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_recovery_immutable',
      MESSAGE = 'I25 owner recovery evidence and held authority is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER siem_i25_attempt_transition
BEFORE UPDATE OR DELETE ON public.siem_export_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION public.assert_siem_i25_attempt_transition();

CREATE OR REPLACE FUNCTION public.assert_siem_i25_cursor_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.writer_state = 'canonical_offsets' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_legacy_cursor_preserved',
      MESSAGE = 'I25 cutover cursor evidence cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.writer_state = 'canonical_offsets' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_legacy_cursor_frozen',
      MESSAGE = 'I25 legacy cursor is frozen after canonical cutover';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER siem_i25_cursor_freeze
BEFORE UPDATE OR DELETE ON public.siem_export_cursors
FOR EACH ROW EXECUTE FUNCTION public.assert_siem_i25_cursor_freeze();

CREATE OR REPLACE FUNCTION public.assert_siem_i25_event_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.siem_export_delivery_attempts
     WHERE tenant_id = OLD.tenant_id AND event_id = OLD.id
  ) AND (
    NEW.source_name IS DISTINCT FROM OLD.source_name
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.source_created_at IS DISTINCT FROM OLD.source_created_at
    OR NEW.minimized_payload IS DISTINCT FROM OLD.minimized_payload
    OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_siem_i25_captured_event_immutable',
      MESSAGE = 'I25 captured event identity and payload are immutable after targeting';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER siem_i25_event_identity
BEFORE UPDATE ON public.siem_export_events
FOR EACH ROW EXECUTE FUNCTION public.assert_siem_i25_event_identity();

CREATE POLICY siem_i25_recovery_explicit_context
  ON public.siem_export_delivery_attempts
  AS RESTRICTIVE
  USING (
    recovery_inbox_id IS NULL
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    recovery_inbox_id IS NULL
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  );

COMMIT;
