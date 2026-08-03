-- Migration 619: I19 NHCX outbound recovery and inbound processing claims.
--
-- Outbound recovery uses the existing nhcx_messages.id as its exact local
-- source position and binds owner evidence to the canonical recovery inbox.
-- It can only freeze an already-materialized outbound ciphertext for review;
-- it cannot dispatch or redrive it. Inbound callbacks expose no provider
-- transport sequence, so correlation/workflow/API-call values remain durable
-- identities and never become an inbound cursor. Non-payment callbacks enter
-- a durable processing claim in the same insert as their envelope, making a
-- crash-stranded transition owner-claimable without replay. Payment notices
-- remain on the existing manual-review path.
--
-- Section 6.8 RLS posture: nhcx_messages already FORCEs RLS for live traffic.
-- Recovery-owned rows add a restrictive explicit, non-bypass tenant-context
-- policy because the retained ciphertext, finance/authorization linkage, and
-- owner disposition are tenant PHI. Ordinary live rows retain their existing
-- access contract so this inert recovery migration does not rewrite runtime
-- behavior outside the recovery boundary.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_nhcx_messages_tenant_id
  ON public.nhcx_messages (tenant_id, id);

ALTER TABLE public.nhcx_messages
  DROP CONSTRAINT IF EXISTS nhcx_messages_status_check,
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN recovery_owner_uid UUID,
  ADD COLUMN recovery_owner_reason VARCHAR(500),
  ADD COLUMN recovery_disposition VARCHAR(48),
  ADD COLUMN recovery_claimed_at TIMESTAMPTZ(6),
  ADD COLUMN recovery_prior_status VARCHAR(30),
  ADD COLUMN recovery_evidence JSONB,
  ADD COLUMN source_partition VARCHAR(160),
  ADD COLUMN source_position BIGINT,
  ADD COLUMN source_token VARCHAR(255),
  ADD COLUMN predecessor_token VARCHAR(255),
  ADD COLUMN duplicate_key VARCHAR(255),
  ADD COLUMN inbound_claim_token UUID,
  ADD COLUMN inbound_claimed_at TIMESTAMPTZ(6),
  ADD COLUMN inbound_completed_at TIMESTAMPTZ(6),
  ADD COLUMN inbound_owner_uid UUID,
  ADD COLUMN inbound_owner_reason VARCHAR(500),
  ADD COLUMN inbound_owner_disposition VARCHAR(48),
  ADD COLUMN inbound_owner_claimed_at TIMESTAMPTZ(6),
  ADD CONSTRAINT nhcx_messages_status_check
    CHECK (status IN (
      'pending', 'accepted', 'sent', 'processed', 'duplicate',
      'failed', 'dead', 'rejected', 'manual_review', 'processing',
      'recovery_pending'
    )),
  ADD CONSTRAINT fk_nhcx_messages_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_nhcx_messages_recovery_owner
    FOREIGN KEY (tenant_id, recovery_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_nhcx_messages_inbound_owner
    FOREIGN KEY (tenant_id, inbound_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_nhcx_messages_i19_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_disposition IS NULL
        AND recovery_claimed_at IS NULL
        AND recovery_prior_status IS NULL
        AND recovery_evidence IS NULL
        AND source_partition IS NULL
        AND source_position IS NULL
        AND source_token IS NULL
        AND predecessor_token IS NULL
        AND duplicate_key IS NULL
      )
      OR (
        direction = 'outbound'
        AND cycle <> 'payment_notice'
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I19'
        AND recovery_owner_uid IS NOT NULL
        AND recovery_owner_reason IS NOT NULL
        AND length(btrim(recovery_owner_reason)) > 0
        AND recovery_disposition IN (
          'investigate',
          'manual_redrive_requested',
          'cancel_requested'
        )
        AND recovery_claimed_at IS NOT NULL
        AND recovery_prior_status IN ('sent', 'failed', 'dead', 'rejected')
        AND recovery_evidence IS NOT NULL
        AND jsonb_typeof(recovery_evidence) = 'object'
        AND hcx_api_call_id IS NOT NULL
        AND length(btrim(hcx_api_call_id)) > 0
        AND payload_hash ~ '^[0-9a-f]{64}$'
        AND source_partition = 'nhcx:' || environment || ':outbound:' || endpoint
        AND source_position = id
        AND source_token IS NOT NULL
        AND length(btrim(source_token)) > 0
        AND predecessor_token IS NOT NULL
        AND length(btrim(predecessor_token)) > 0
        AND duplicate_key IS NOT NULL
        AND duplicate_key = 'i19:outbound:' || hcx_api_call_id
        AND payload_ciphertext IS NOT NULL
        AND length(payload_ciphertext) > 0
        AND status = 'recovery_pending'
        AND next_retry_at IS NULL
      )
    ),
  ADD CONSTRAINT chk_nhcx_messages_i19_inbound_claim_shape
    CHECK (
      (
        inbound_claim_token IS NULL
        AND inbound_claimed_at IS NULL
        AND inbound_completed_at IS NULL
        AND inbound_owner_uid IS NULL
        AND inbound_owner_reason IS NULL
        AND inbound_owner_disposition IS NULL
        AND inbound_owner_claimed_at IS NULL
      )
      OR (
        direction = 'inbound'
        AND cycle <> 'payment_notice'
        AND signature_verified = TRUE
        AND hcx_api_call_id IS NOT NULL
        AND length(btrim(hcx_api_call_id)) > 0
        AND payload_hash ~ '^[0-9a-f]{64}$'
        AND payload_ciphertext IS NOT NULL
        AND length(payload_ciphertext) > 0
        AND inbound_claim_token IS NOT NULL
        AND inbound_claimed_at IS NOT NULL
        AND (
          (
            status = 'processing'
            AND inbound_completed_at IS NULL
            AND inbound_owner_uid IS NULL
            AND inbound_owner_reason IS NULL
            AND inbound_owner_disposition IS NULL
            AND inbound_owner_claimed_at IS NULL
          )
          OR (
            status IN ('processed', 'manual_review')
            AND inbound_completed_at IS NOT NULL
            AND inbound_owner_uid IS NULL
            AND inbound_owner_reason IS NULL
            AND inbound_owner_disposition IS NULL
            AND inbound_owner_claimed_at IS NULL
          )
          OR (
            status = 'recovery_pending'
            AND inbound_completed_at IS NULL
            AND inbound_owner_uid IS NOT NULL
            AND inbound_owner_reason IS NOT NULL
            AND length(btrim(inbound_owner_reason)) > 0
            AND inbound_owner_disposition IN (
              'investigate',
              'manual_retry_requested',
              'cancel_requested'
            )
            AND inbound_owner_claimed_at IS NOT NULL
          )
        )
      )
    );

CREATE UNIQUE INDEX ux_nhcx_messages_recovery_inbox
  ON public.nhcx_messages
    (tenant_id, recovery_inbox_id, recovery_interface_family)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE INDEX idx_nhcx_messages_inbound_processing
  ON public.nhcx_messages (tenant_id, inbound_claimed_at, id)
  WHERE direction = 'inbound' AND status = 'processing';

CREATE OR REPLACE FUNCTION public.assert_nhcx_i19_recovery_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inbox RECORD;
  expected_partition TEXT;
  expected_duplicate TEXT;
BEGIN
  IF NEW.recovery_inbox_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT item.interface_family, item.direction, item.source_partition,
         item.source_position, item.source_token, item.predecessor_token,
         item.duplicate_key, item.arrival_class, item.effect_disposition,
         item.status
    INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id;

  expected_partition := 'nhcx:' || NEW.environment || ':outbound:' || NEW.endpoint;
  expected_duplicate := 'i19:outbound:' || NEW.hcx_api_call_id;

  IF inbox.interface_family IS DISTINCT FROM 'I19'
     OR inbox.direction IS DISTINCT FROM 'outbound'
     OR inbox.source_partition IS DISTINCT FROM expected_partition
     OR inbox.source_position IS DISTINCT FROM NEW.id
     OR inbox.source_position IS DISTINCT FROM NEW.source_position
     OR inbox.source_token IS DISTINCT FROM NEW.source_token
     OR inbox.predecessor_token IS DISTINCT FROM NEW.predecessor_token
     OR inbox.duplicate_key IS DISTINCT FROM expected_duplicate
     OR inbox.arrival_class IS DISTINCT FROM 'recovery_backlog'
     OR inbox.effect_disposition IS DISTINCT FROM 'late_pending_only'
     OR inbox.status IS DISTINCT FROM 'pending'
     OR NEW.source_partition IS DISTINCT FROM expected_partition
     OR NEW.duplicate_key IS DISTINCT FROM expected_duplicate THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_nhcx_i19_recovery_inbox_binding',
      MESSAGE = 'I19 outbound recovery does not match canonical inbox provenance';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER nhcx_i19_recovery_binding
BEFORE INSERT OR UPDATE ON public.nhcx_messages
FOR EACH ROW EXECUTE FUNCTION public.assert_nhcx_i19_recovery_binding();

CREATE OR REPLACE FUNCTION public.assert_nhcx_i19_claim_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP OPERATOR(pg_catalog.=) 'DELETE' THEN
    IF OLD.recovery_inbox_id IS NOT NULL OR OLD.inbound_owner_uid IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_recovery_immutable',
        MESSAGE = 'I19 owner recovery evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.recovery_inbox_id IS NULL AND NEW.recovery_inbox_id IS NOT NULL THEN
    IF OLD.direction IS DISTINCT FROM 'outbound'
       OR OLD.status NOT IN ('sent', 'failed', 'dead', 'rejected')
       OR NEW.recovery_prior_status IS DISTINCT FROM OLD.status
       OR NEW.status IS DISTINCT FROM 'recovery_pending' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_outbound_claim_transition',
        MESSAGE = 'only eligible outbound NHCX evidence can enter recovery review';
    END IF;
  ELSIF OLD.recovery_inbox_id IS NOT NULL AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.cycle IS DISTINCT FROM OLD.cycle
    OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
    OR NEW.hcx_api_call_id IS DISTINCT FROM OLD.hcx_api_call_id
    OR NEW.hcx_correlation_id IS DISTINCT FROM OLD.hcx_correlation_id
    OR NEW.hcx_workflow_id IS DISTINCT FROM OLD.hcx_workflow_id
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
    OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
    OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
    OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
    OR NEW.recovery_disposition IS DISTINCT FROM OLD.recovery_disposition
    OR NEW.recovery_claimed_at IS DISTINCT FROM OLD.recovery_claimed_at
    OR NEW.recovery_prior_status IS DISTINCT FROM OLD.recovery_prior_status
    OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence
    OR NEW.source_partition IS DISTINCT FROM OLD.source_partition
    OR NEW.source_position IS DISTINCT FROM OLD.source_position
    OR NEW.source_token IS DISTINCT FROM OLD.source_token
    OR NEW.predecessor_token IS DISTINCT FROM OLD.predecessor_token
    OR NEW.duplicate_key IS DISTINCT FROM OLD.duplicate_key
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_nhcx_i19_recovery_immutable',
      MESSAGE = 'I19 outbound recovery evidence and disposition are immutable';
  END IF;

  IF OLD.inbound_claim_token IS NULL AND NEW.inbound_claim_token IS NOT NULL THEN
    IF OLD.direction IS DISTINCT FROM 'inbound'
       OR OLD.cycle = 'payment_notice'
       OR (
         (OLD.status = 'accepted' AND NEW.status NOT IN ('processing', 'recovery_pending'))
         OR (OLD.status <> 'accepted')
       ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'chk_nhcx_i19_inbound_claim_transition',
          MESSAGE = 'I19 inbound processing must be claimed atomically from an accepted envelope';
    END IF;
    IF NEW.status = 'recovery_pending'
       AND OLD.created_at > NOW() - INTERVAL '5 minutes' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_claim_not_stale',
        MESSAGE = 'I19 inbound envelope is not stale enough for owner recovery';
    END IF;
  ELSIF OLD.inbound_claim_token IS NOT NULL THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.cycle IS DISTINCT FROM OLD.cycle
       OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
       OR NEW.hcx_api_call_id IS DISTINCT FROM OLD.hcx_api_call_id
       OR NEW.hcx_correlation_id IS DISTINCT FROM OLD.hcx_correlation_id
       OR NEW.hcx_workflow_id IS DISTINCT FROM OLD.hcx_workflow_id
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
       OR NEW.signature_verified IS DISTINCT FROM OLD.signature_verified
       OR NEW.inbound_claim_token IS DISTINCT FROM OLD.inbound_claim_token
       OR NEW.inbound_claimed_at IS DISTINCT FROM OLD.inbound_claimed_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_claim_immutable',
        MESSAGE = 'I19 inbound processing claim identity is immutable';
    END IF;

    IF OLD.status = 'processing'
       AND NEW.status IN ('processed', 'manual_review')
       AND NEW.inbound_completed_at IS NOT NULL
       AND NEW.inbound_owner_uid IS NULL THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'processing'
       AND NEW.status = 'recovery_pending'
       AND OLD.inbound_claimed_at <= NOW() - INTERVAL '5 minutes'
       AND NEW.inbound_owner_uid IS NOT NULL THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'recovery_pending' AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.inbound_owner_uid IS DISTINCT FROM OLD.inbound_owner_uid
      OR NEW.inbound_owner_reason IS DISTINCT FROM OLD.inbound_owner_reason
      OR NEW.inbound_owner_disposition IS DISTINCT FROM OLD.inbound_owner_disposition
      OR NEW.inbound_owner_claimed_at IS DISTINCT FROM OLD.inbound_owner_claimed_at
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_recovery_immutable',
        MESSAGE = 'I19 stranded inbound owner claim cannot be replayed or rewritten';
    ELSIF OLD.status IS DISTINCT FROM NEW.status
       OR NEW.inbound_completed_at IS DISTINCT FROM OLD.inbound_completed_at
       OR NEW.inbound_owner_uid IS DISTINCT FROM OLD.inbound_owner_uid
       OR NEW.inbound_owner_reason IS DISTINCT FROM OLD.inbound_owner_reason
       OR NEW.inbound_owner_disposition IS DISTINCT FROM OLD.inbound_owner_disposition
       OR NEW.inbound_owner_claimed_at IS DISTINCT FROM OLD.inbound_owner_claimed_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_claim_transition',
        MESSAGE = 'I19 inbound processing transition is not authorized';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER nhcx_i19_claim_transition
BEFORE UPDATE OR DELETE ON public.nhcx_messages
FOR EACH ROW EXECUTE FUNCTION public.assert_nhcx_i19_claim_transition();

CREATE POLICY nhcx_i19_recovery_explicit_context
  ON public.nhcx_messages
  AS RESTRICTIVE
  USING (
    (recovery_inbox_id IS NULL AND inbound_owner_uid IS NULL)
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    (recovery_inbox_id IS NULL AND inbound_owner_uid IS NULL)
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  );

COMMIT;
