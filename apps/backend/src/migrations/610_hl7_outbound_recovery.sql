-- Migration 610: C6.1-E / I04 outbound HL7 recovery.
--
-- Transport evidence, parsed MSA acknowledgement, permission to send, and
-- cursor position are separate state planes. HTTP success is transport evidence only.
-- A per-subscription cursor advances only from a correlated
-- MSA|AA receipt. Historical queue rows are held because the old worker did
-- not retain the response body and therefore cannot prove acknowledgement.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TABLE public.hl7_feed_subscriptions
  ADD CONSTRAINT ux_hl7_feed_subscriptions_tenant_id
    UNIQUE (tenant_id, id);

ALTER TABLE public.hl7_outbound_messages
  ALTER COLUMN status TYPE VARCHAR(32),
  DROP CONSTRAINT chk_hl7_outbound_messages_status,
  ADD COLUMN source_event_key VARCHAR(255),
  ADD COLUMN payload_sha256 CHAR(64),
  ADD COLUMN ledger_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN transport_state VARCHAR(32) NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN acknowledgement_state VARCHAR(32) NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN send_authority VARCHAR(40) NOT NULL DEFAULT 'held_owner_reconciliation',
  ADD COLUMN claim_token UUID,
  ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN claimed_at TIMESTAMPTZ(6),
  ADD COLUMN lease_expires_at TIMESTAMPTZ(6),
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN owner_release_actor_uid UUID,
  ADD COLUMN owner_release_reason VARCHAR(500),
  ADD COLUMN owner_released_at TIMESTAMPTZ(6);

UPDATE public.hl7_outbound_messages
   SET source_event_key = 'legacy-message:' || id::text,
       payload_sha256 = encode(digest(convert_to(hl7_payload, 'UTF8'), 'sha256'), 'hex'),
       status = 'reconciliation_required',
       ledger_version = 0,
       transport_state = 'legacy_unknown',
       acknowledgement_state = 'legacy_unknown',
       send_authority = 'held_owner_reconciliation',
       claim_token = NULL,
       claimed_at = NULL,
       lease_expires_at = NULL;

ALTER TABLE public.hl7_outbound_messages
  ALTER COLUMN source_event_key SET NOT NULL,
  ALTER COLUMN payload_sha256 SET NOT NULL,
  ALTER COLUMN ledger_version SET DEFAULT 1,
  ALTER COLUMN transport_state SET DEFAULT 'not_attempted',
  ALTER COLUMN acknowledgement_state SET DEFAULT 'pending',
  ALTER COLUMN send_authority SET DEFAULT 'authorized',
  ADD CONSTRAINT chk_hl7_outbound_messages_status
    CHECK (status IN (
      'queued', 'claimed', 'sent', 'failed', 'dead',
      'reconciliation_required'
    )),
  ADD CONSTRAINT chk_hl7_outbound_messages_ledger_version
    CHECK (ledger_version IN (0, 1)),
  ADD CONSTRAINT chk_hl7_outbound_messages_control_id
    CHECK (ledger_version = 0 OR message_control_id IS NOT NULL),
  ADD CONSTRAINT chk_hl7_outbound_messages_payload_sha256
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT chk_hl7_outbound_messages_transport_state
    CHECK (transport_state IN (
      'not_attempted', 'http_response', 'transport_failure',
      'lease_expiry_unknown', 'legacy_unknown'
    )),
  ADD CONSTRAINT chk_hl7_outbound_messages_ack_state
    CHECK (acknowledgement_state IN (
      'pending', 'aa', 'ae', 'ar', 'missing', 'invalid',
      'control_id_mismatch', 'legacy_unknown'
    )),
  ADD CONSTRAINT chk_hl7_outbound_messages_send_authority
    CHECK (send_authority IN (
      'authorized', 'held_owner_reconciliation', 'revoked'
    )),
  ADD CONSTRAINT chk_hl7_outbound_messages_claim_generation
    CHECK (claim_generation >= 0),
  ADD CONSTRAINT chk_hl7_outbound_messages_claim_shape
    CHECK (
      (
        status = 'claimed'
        AND claim_token IS NOT NULL
        AND claimed_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
      OR (
        status <> 'claimed'
        AND claim_token IS NULL
        AND claimed_at IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  ADD CONSTRAINT chk_hl7_outbound_messages_recovery_shape
    CHECK (
      (recovery_inbox_id IS NULL AND recovery_interface_family IS NULL)
      OR (
        recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I04'
      )
    ),
  ADD CONSTRAINT chk_hl7_outbound_messages_owner_release_shape
    CHECK (
      (
        owner_release_actor_uid IS NULL
        AND owner_release_reason IS NULL
        AND owner_released_at IS NULL
      )
      OR (
        owner_release_actor_uid IS NOT NULL
        AND BTRIM(owner_release_reason) <> ''
        AND owner_released_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT ux_hl7_outbound_messages_contract
    UNIQUE (tenant_id, id, subscription_id),
  ADD CONSTRAINT ux_hl7_outbound_message_source
    UNIQUE (tenant_id, subscription_id, source_event_key, message_type),
  ADD CONSTRAINT fk_hl7_outbound_message_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox
      (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.hl7_outbound_messages
  DROP CONSTRAINT IF EXISTS hl7_outbound_messages_subscription_id_fkey;

ALTER TABLE public.hl7_outbound_messages
  ADD CONSTRAINT fk_hl7_outbound_messages_subscription_tenant
    FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES public.hl7_feed_subscriptions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE CASCADE;

CREATE UNIQUE INDEX ux_hl7_outbound_message_control_id
  ON public.hl7_outbound_messages
    (tenant_id, subscription_id, message_control_id)
  WHERE ledger_version = 1 AND message_control_id IS NOT NULL;

DROP INDEX IF EXISTS public.idx_hl7_outbound_messages_due;
CREATE INDEX idx_hl7_outbound_messages_due
  ON public.hl7_outbound_messages
    (tenant_id, subscription_id, status, next_attempt_at, id)
  WHERE status IN ('queued', 'failed') AND send_authority = 'authorized';

CREATE INDEX idx_hl7_outbound_messages_expired_claim
  ON public.hl7_outbound_messages (tenant_id, lease_expires_at, id)
  WHERE status = 'claimed';

CREATE TABLE public.hl7_outbound_transport_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  message_id INTEGER NOT NULL,
  subscription_id INTEGER NOT NULL,
  claim_token UUID NOT NULL,
  claim_generation INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_hl7_outbound_transport_attempt_number
    UNIQUE (tenant_id, message_id, attempt_number),
  CONSTRAINT ux_hl7_outbound_transport_attempt_claim
    UNIQUE (tenant_id, message_id, claim_token),
  CONSTRAINT ux_hl7_outbound_transport_attempt_contract
    UNIQUE (tenant_id, attempt_id, message_id, subscription_id),
  CONSTRAINT fk_hl7_outbound_transport_attempt_message
    FOREIGN KEY (tenant_id, message_id, subscription_id)
    REFERENCES public.hl7_outbound_messages (tenant_id, id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_hl7_outbound_transport_attempt_generation
    CHECK (claim_generation > 0 AND attempt_number > 0),
  CONSTRAINT chk_hl7_outbound_transport_attempt_hash
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.hl7_outbound_transport_results (
  transport_result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  message_id INTEGER NOT NULL,
  subscription_id INTEGER NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  http_status INTEGER,
  response_body_sha256 CHAR(64),
  error_code VARCHAR(160),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_hl7_outbound_transport_result_attempt
    UNIQUE (tenant_id, attempt_id),
  CONSTRAINT ux_hl7_outbound_transport_result_attempt_contract
    UNIQUE (tenant_id, attempt_id, message_id, subscription_id),
  CONSTRAINT ux_hl7_outbound_transport_result_contract
    UNIQUE (
      tenant_id, transport_result_id, attempt_id, message_id, subscription_id
    ),
  CONSTRAINT fk_hl7_outbound_transport_result_attempt
    FOREIGN KEY (tenant_id, attempt_id, message_id, subscription_id)
    REFERENCES public.hl7_outbound_transport_attempts
      (tenant_id, attempt_id, message_id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_hl7_outbound_transport_result_outcome
    CHECK (outcome IN (
      'http_response', 'transport_failure', 'lease_expiry_unknown'
    )),
  CONSTRAINT chk_hl7_outbound_transport_result_http_shape
    CHECK (
      (outcome = 'http_response' AND http_status BETWEEN 100 AND 599)
      OR (outcome <> 'http_response' AND http_status IS NULL)
    ),
  CONSTRAINT chk_hl7_outbound_transport_result_hash
    CHECK (
      response_body_sha256 IS NULL
      OR response_body_sha256 ~ '^[0-9a-f]{64}$'
    )
);

CREATE TABLE public.hl7_outbound_acknowledgements (
  acknowledgement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  attempt_id UUID,
  transport_result_id UUID,
  message_id INTEGER NOT NULL,
  subscription_id INTEGER NOT NULL,
  msa_code CHAR(2) NOT NULL,
  acknowledged_control_id VARCHAR(60) NOT NULL,
  correlation_matches BOOLEAN NOT NULL,
  acknowledgement_payload_sha256 CHAR(64) NOT NULL,
  receipt_source VARCHAR(32) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  recovery_inbox_id UUID,
  recovery_interface_family VARCHAR(8),
  owner_actor_uid UUID,
  owner_reason VARCHAR(500),

  CONSTRAINT ux_hl7_outbound_acknowledgement_contract
    UNIQUE (tenant_id, acknowledgement_id, message_id, subscription_id),
  CONSTRAINT fk_hl7_outbound_acknowledgement_message
    FOREIGN KEY (tenant_id, message_id, subscription_id)
    REFERENCES public.hl7_outbound_messages (tenant_id, id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_outbound_acknowledgement_attempt
    FOREIGN KEY (tenant_id, attempt_id, message_id, subscription_id)
    REFERENCES public.hl7_outbound_transport_attempts
      (tenant_id, attempt_id, message_id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_outbound_acknowledgement_transport_result
    FOREIGN KEY (
      tenant_id, transport_result_id, attempt_id, message_id, subscription_id
    )
    REFERENCES public.hl7_outbound_transport_results
      (tenant_id, transport_result_id, attempt_id, message_id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_outbound_acknowledgement_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox
      (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_hl7_outbound_acknowledgement_msa_code
    CHECK (msa_code IN ('AA', 'AE', 'AR')),
  CONSTRAINT chk_hl7_outbound_acknowledgement_hash
    CHECK (acknowledgement_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_hl7_outbound_acknowledgement_source
    CHECK (receipt_source IN ('provider_response', 'owner_reconciliation')),
  CONSTRAINT chk_hl7_outbound_acknowledgement_transport_shape
    CHECK (
      (
        receipt_source = 'provider_response'
        AND attempt_id IS NOT NULL
        AND transport_result_id IS NOT NULL
        AND recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND owner_actor_uid IS NULL
        AND owner_reason IS NULL
      )
      OR (
        receipt_source = 'owner_reconciliation'
        AND attempt_id IS NULL
        AND transport_result_id IS NULL
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I04'
        AND owner_actor_uid IS NOT NULL
        AND BTRIM(owner_reason) <> ''
      )
    )
);

CREATE UNIQUE INDEX ux_hl7_outbound_acknowledgement_receipt
  ON public.hl7_outbound_acknowledgements (
    tenant_id,
    message_id,
    receipt_source,
    COALESCE(attempt_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(recovery_inbox_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE TABLE public.hl7_outbound_delivery_cursors (
  tenant_id UUID NOT NULL,
  subscription_id INTEGER NOT NULL,
  last_contiguous_message_id INTEGER,
  state VARCHAR(32) NOT NULL DEFAULT 'ready',
  blocked_message_id INTEGER,
  inflight_message_id INTEGER,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT hl7_outbound_delivery_cursors_pkey
    PRIMARY KEY (tenant_id, subscription_id),
  CONSTRAINT ux_hl7_outbound_delivery_cursor_last
    UNIQUE (tenant_id, last_contiguous_message_id, subscription_id),
  CONSTRAINT ux_hl7_outbound_delivery_cursor_blocked
    UNIQUE (tenant_id, blocked_message_id, subscription_id),
  CONSTRAINT ux_hl7_outbound_delivery_cursor_inflight
    UNIQUE (tenant_id, inflight_message_id, subscription_id),
  CONSTRAINT fk_hl7_outbound_delivery_cursor_subscription
    FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES public.hl7_feed_subscriptions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_outbound_delivery_cursor_last
    FOREIGN KEY (tenant_id, last_contiguous_message_id, subscription_id)
    REFERENCES public.hl7_outbound_messages (tenant_id, id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_outbound_delivery_cursor_blocked
    FOREIGN KEY (tenant_id, blocked_message_id, subscription_id)
    REFERENCES public.hl7_outbound_messages (tenant_id, id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_outbound_delivery_cursor_inflight
    FOREIGN KEY (tenant_id, inflight_message_id, subscription_id)
    REFERENCES public.hl7_outbound_messages (tenant_id, id, subscription_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_hl7_outbound_delivery_cursor_state
    CHECK (state IN ('ready', 'delivering', 'paused_rejected', 'paused_uncertain')),
  CONSTRAINT chk_hl7_outbound_delivery_cursor_shape
    CHECK (
      (state = 'ready' AND blocked_message_id IS NULL AND inflight_message_id IS NULL)
      OR (
        state = 'delivering'
        AND blocked_message_id IS NOT NULL
        AND inflight_message_id = blocked_message_id
      )
      OR (
        state IN ('paused_rejected', 'paused_uncertain')
        AND blocked_message_id IS NOT NULL
        AND inflight_message_id IS NULL
      )
    )
);

CREATE OR REPLACE FUNCTION public.validate_hl7_outbound_transport_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.hl7_outbound_messages AS message
     WHERE message.tenant_id = NEW.tenant_id
       AND message.id = NEW.message_id
       AND message.subscription_id = NEW.subscription_id
       AND message.status = 'claimed'
       AND message.send_authority = 'authorized'
       AND message.claim_token = NEW.claim_token
       AND message.claim_generation = NEW.claim_generation
       AND message.payload_sha256 = NEW.payload_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_transport_attempt_claim_fence',
      MESSAGE = 'HL7 transport attempt does not match the active send claim';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hl7_outbound_transport_attempt_claim_fence
BEFORE INSERT ON public.hl7_outbound_transport_attempts
FOR EACH ROW EXECUTE FUNCTION public.validate_hl7_outbound_transport_attempt();

CREATE OR REPLACE FUNCTION public.hl7_outbound_evidence_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_hl7_outbound_evidence_append_only',
    MESSAGE = FORMAT('%I is append-only', TG_TABLE_NAME);
END
$$;

CREATE TRIGGER hl7_outbound_transport_attempts_append_only
BEFORE UPDATE OR DELETE ON public.hl7_outbound_transport_attempts
FOR EACH ROW EXECUTE FUNCTION public.hl7_outbound_evidence_append_only();

CREATE TRIGGER hl7_outbound_transport_results_append_only
BEFORE UPDATE OR DELETE ON public.hl7_outbound_transport_results
FOR EACH ROW EXECUTE FUNCTION public.hl7_outbound_evidence_append_only();

CREATE TRIGGER hl7_outbound_acknowledgements_append_only
BEFORE UPDATE OR DELETE ON public.hl7_outbound_acknowledgements
FOR EACH ROW EXECUTE FUNCTION public.hl7_outbound_evidence_append_only();

CREATE OR REPLACE FUNCTION public.validate_hl7_outbound_acknowledgement()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  expected_control_id TEXT;
BEGIN
  SELECT message_control_id
    INTO expected_control_id
    FROM public.hl7_outbound_messages
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.message_id
     AND subscription_id = NEW.subscription_id;

  IF expected_control_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_acknowledgement_expected_control_id',
      MESSAGE = 'HL7 acknowledgement requires an original control ID';
  END IF;

  IF NEW.correlation_matches IS DISTINCT FROM
     (NEW.acknowledged_control_id = expected_control_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_acknowledgement_correlation',
      MESSAGE = 'HL7 acknowledgement correlation flag does not match MSA-2';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hl7_outbound_acknowledgement_validate
BEFORE INSERT ON public.hl7_outbound_acknowledgements
FOR EACH ROW EXECUTE FUNCTION public.validate_hl7_outbound_acknowledgement();

CREATE OR REPLACE FUNCTION public.validate_hl7_outbound_cursor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ready'
       OR NEW.last_contiguous_message_id IS NOT NULL
       OR NEW.blocked_message_id IS NOT NULL
       OR NEW.inflight_message_id IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_hl7_outbound_cursor_initial_state',
        MESSAGE = 'HL7 delivery cursor must start empty and ready';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.last_contiguous_message_id IS NOT NULL
     AND (
       NEW.last_contiguous_message_id IS NULL
       OR NEW.last_contiguous_message_id < OLD.last_contiguous_message_id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_cursor_monotonic',
      MESSAGE = 'HL7 delivery cursor cannot move backwards';
  END IF;

  IF NEW.last_contiguous_message_id IS DISTINCT FROM OLD.last_contiguous_message_id
     AND NEW.last_contiguous_message_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.hl7_outbound_acknowledgements AS acknowledgement
        WHERE acknowledgement.tenant_id = NEW.tenant_id
          AND acknowledgement.message_id = NEW.last_contiguous_message_id
          AND acknowledgement.subscription_id = NEW.subscription_id
          AND acknowledgement.msa_code = 'AA'
          AND acknowledgement.correlation_matches
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_cursor_positive_ack',
      MESSAGE = 'HL7 delivery cursor advance requires correlated MSA|AA evidence';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hl7_outbound_cursor_validate
BEFORE INSERT OR UPDATE ON public.hl7_outbound_delivery_cursors
FOR EACH ROW EXECUTE FUNCTION public.validate_hl7_outbound_cursor();

CREATE OR REPLACE FUNCTION public.validate_hl7_outbound_message_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  late_disposition TEXT := current_setting(
    'app.external_recovery_effect_disposition', true
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ledger_version = 1
       AND NEW.payload_sha256 <> encode(
         digest(convert_to(NEW.hl7_payload, 'UTF8'), 'sha256'), 'hex'
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_hl7_outbound_message_payload_hash',
        MESSAGE = 'HL7 payload hash does not match the exact payload bytes';
    END IF;
    IF late_disposition = 'late_pending_only'
       AND NEW.send_authority = 'authorized'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_hl7_outbound_late_send_suppression',
        MESSAGE = 'Late recovery cannot create an authorized outbound HL7 send';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.subscription_id IS DISTINCT FROM NEW.subscription_id
     OR OLD.message_type IS DISTINCT FROM NEW.message_type
     OR OLD.message_control_id IS DISTINCT FROM NEW.message_control_id
     OR OLD.hl7_payload IS DISTINCT FROM NEW.hl7_payload
     OR OLD.source_table IS DISTINCT FROM NEW.source_table
     OR OLD.source_id IS DISTINCT FROM NEW.source_id
     OR OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR OLD.source_event_key IS DISTINCT FROM NEW.source_event_key
     OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
     OR OLD.ledger_version IS DISTINCT FROM NEW.ledger_version
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_message_identity_immutable',
      MESSAGE = 'HL7 outbound message identity and payload are immutable';
  END IF;

  IF OLD.recovery_inbox_id IS NOT NULL
     AND (
       NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
       OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_recovery_provenance_immutable',
      MESSAGE = 'HL7 recovery provenance is immutable once attached';
  END IF;

  IF OLD.send_authority IS DISTINCT FROM NEW.send_authority
     AND NEW.send_authority = 'authorized'
     AND (
       NEW.owner_release_actor_uid IS NULL
       OR NEW.owner_release_reason IS NULL
       OR BTRIM(NEW.owner_release_reason) = ''
       OR NEW.owner_released_at IS NULL
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_owner_release_required',
      MESSAGE = 'Outbound HL7 send authority requires an explicit owner release';
  END IF;

  IF late_disposition = 'late_pending_only'
     AND OLD.send_authority IS DISTINCT FROM NEW.send_authority
     AND NEW.send_authority = 'authorized'
     AND NEW.recovery_inbox_id IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_late_owner_release_provenance',
      MESSAGE = 'Late outbound HL7 release requires recovery-inbox provenance';
  END IF;

  IF NEW.status = 'sent'
     AND (
       NEW.acknowledgement_state <> 'aa'
       OR NOT EXISTS (
         SELECT 1
           FROM public.hl7_outbound_acknowledgements AS acknowledgement
          WHERE acknowledgement.tenant_id = NEW.tenant_id
            AND acknowledgement.message_id = NEW.id
            AND acknowledgement.subscription_id = NEW.subscription_id
            AND acknowledgement.msa_code = 'AA'
            AND acknowledgement.correlation_matches
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_sent_positive_ack',
      MESSAGE = 'Outbound HL7 message cannot be sent without correlated MSA|AA';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hl7_outbound_message_transition_guard
BEFORE INSERT OR UPDATE ON public.hl7_outbound_messages
FOR EACH ROW EXECUTE FUNCTION public.validate_hl7_outbound_message_transition();

CREATE OR REPLACE FUNCTION public.validate_hl7_outbound_recovery_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.recovery_inbox_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.pathway_projector_inbox AS inbox
     WHERE inbox.tenant_id = NEW.tenant_id
       AND inbox.inbox_id = NEW.recovery_inbox_id
       AND inbox.interface_family = 'I04'
       AND inbox.scope_kind = 'external_interface'
       AND inbox.direction = 'outbound'
       AND inbox.source_partition = 'subscription:' || NEW.subscription_id::text
       AND inbox.source_position = NEW.id::bigint
       AND inbox.arrival_class = 'recovery_backlog'
       AND inbox.effect_disposition = 'late_pending_only'
       AND inbox.status = 'handled'
       AND inbox.pending_task_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_recovery_provenance',
      MESSAGE = 'I04 message lacks same-tenant handled recovery provenance';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER hl7_outbound_recovery_provenance
AFTER INSERT OR UPDATE OF recovery_inbox_id
ON public.hl7_outbound_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.recovery_inbox_id IS NOT NULL)
EXECUTE FUNCTION public.validate_hl7_outbound_recovery_provenance();

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hl7_feed_subscriptions',
    'hl7_outbound_messages',
    'hl7_outbound_transport_attempts',
    'hl7_outbound_transport_results',
    'hl7_outbound_acknowledgements',
    'hl7_outbound_delivery_cursors'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT(
      'DROP POLICY IF EXISTS tenant_isolation ON public.%I',
      table_name
    );
    EXECUTE FORMAT($policy$
      CREATE POLICY tenant_isolation
        ON public.%I
        AS PERMISSIVE
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = public.app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = public.app_current_tenant_id_uuid()
        )
    $policy$, table_name);
    EXECUTE FORMAT(
      'DROP POLICY IF EXISTS hl7_outbound_explicit_context ON public.%I',
      table_name
    );
    EXECUTE FORMAT($policy$
      CREATE POLICY hl7_outbound_explicit_context
        ON public.%I
        AS RESTRICTIVE
        USING (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = public.app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = public.app_current_tenant_id_uuid()
        )
    $policy$, table_name);
  END LOOP;
END
$rls$;

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_hl7_outbound_transport_attempt() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.hl7_outbound_evidence_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_hl7_outbound_acknowledgement() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_hl7_outbound_cursor() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_hl7_outbound_message_transition() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_hl7_outbound_recovery_provenance() FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
  evidence_table TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE FORMAT(
      'GRANT SELECT, INSERT, UPDATE ON public.hl7_feed_subscriptions TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE DELETE, TRUNCATE ON public.hl7_feed_subscriptions FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT, UPDATE ON public.hl7_outbound_messages TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE DELETE, TRUNCATE ON public.hl7_outbound_messages FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE
         public.hl7_feed_subscriptions_id_seq,
         public.hl7_outbound_messages_id_seq TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT, UPDATE ON public.hl7_outbound_delivery_cursors TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE DELETE, TRUNCATE ON public.hl7_outbound_delivery_cursors FROM %I',
      runtime_role
    );

    FOREACH evidence_table IN ARRAY ARRAY[
      'hl7_outbound_transport_attempts',
      'hl7_outbound_transport_results',
      'hl7_outbound_acknowledgements'
    ]
    LOOP
      EXECUTE FORMAT(
        'GRANT SELECT, INSERT ON public.%I TO %I',
        evidence_table,
        runtime_role
      );
      EXECUTE FORMAT(
        'REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM %I',
        evidence_table,
        runtime_role
      );
    END LOOP;

    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION
         public.validate_hl7_outbound_transport_attempt() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION
         public.hl7_outbound_evidence_append_only() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION
         public.validate_hl7_outbound_acknowledgement() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION
         public.validate_hl7_outbound_cursor() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION
         public.validate_hl7_outbound_message_transition() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION
         public.validate_hl7_outbound_recovery_provenance() FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
