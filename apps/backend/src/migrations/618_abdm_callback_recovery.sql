-- Migration 618: I16 ABDM callback and stranded-transfer recovery.
--
-- The short-lived HMAC replay guard remains a pre-authentication control. It is
-- not a recovery cursor. Authenticated public callbacks are recorded in the
-- existing abdm_webhook_events ledger using provider transaction identity.
-- ABDM exposes no provider transport sequence, so owner-reconciled positions
-- order recovery intake without pretending to be provider high-water marks.
-- Stranded PROCESSING requests can only become frozen pending-review claims;
-- this migration supplies no automatic resume or delivery executor.
--
-- Section 6.8 RLS posture: both existing tables already FORCE RLS for their
-- legacy live rows. Recovery claims add a restrictive explicit, non-bypass
-- tenant-context policy because callback bytes, transfer state, and owner
-- decisions are tenant PHI. The predicate is scoped to recovery rows so the
-- historical live access contract is not silently rewritten in this PR.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_abdm_data_requests_tenant_id
  ON public.abdm_data_requests (tenant_id, id);

ALTER TABLE public.abdm_data_requests
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN recovery_owner_uid UUID,
  ADD COLUMN recovery_owner_reason VARCHAR(500),
  ADD COLUMN recovery_disposition VARCHAR(48),
  ADD COLUMN recovery_claimed_at TIMESTAMPTZ(6),
  ADD CONSTRAINT fk_abdm_data_requests_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_abdm_data_requests_recovery_owner
    FOREIGN KEY (tenant_id, recovery_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_abdm_data_requests_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_disposition IS NULL
        AND recovery_claimed_at IS NULL
      )
      OR (
        recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I16'
        AND recovery_owner_uid IS NOT NULL
        AND recovery_owner_reason IS NOT NULL
        AND length(btrim(recovery_owner_reason)) > 0
        AND recovery_disposition IN (
          'investigate',
          'manual_retry_requested',
          'cancel_requested'
        )
        AND recovery_claimed_at IS NOT NULL
        AND status = 'RECOVERY_PENDING_REVIEW'
      )
    );

CREATE UNIQUE INDEX ux_abdm_data_requests_recovery_inbox
  ON public.abdm_data_requests
    (tenant_id, recovery_inbox_id, recovery_interface_family)
  WHERE recovery_inbox_id IS NOT NULL;

ALTER TABLE public.abdm_webhook_events
  ADD COLUMN receipt_source VARCHAR(40),
  ADD COLUMN callback_path VARCHAR(80),
  ADD COLUMN provider_identity_kind VARCHAR(32),
  ADD COLUMN provider_identity_value VARCHAR(160),
  ADD COLUMN raw_body_ciphertext TEXT,
  ADD COLUMN raw_body_sha256 CHAR(64),
  ADD COLUMN raw_body_bytes INTEGER,
  ADD COLUMN auth_binding_sha256 CHAR(64),
  ADD COLUMN authenticated_at TIMESTAMPTZ(6),
  ADD COLUMN related_data_request_id INTEGER,
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN recovery_owner_uid UUID,
  ADD COLUMN recovery_owner_reason VARCHAR(500),
  ADD COLUMN recovery_disposition VARCHAR(48),
  ADD COLUMN source_partition VARCHAR(160),
  ADD COLUMN source_position BIGINT,
  ADD COLUMN source_token VARCHAR(255),
  ADD COLUMN predecessor_token VARCHAR(255),
  ADD COLUMN duplicate_key VARCHAR(255),
  ADD CONSTRAINT fk_abdm_webhook_events_data_request
    FOREIGN KEY (tenant_id, related_data_request_id)
    REFERENCES public.abdm_data_requests (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_abdm_webhook_events_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_abdm_webhook_events_recovery_owner
    FOREIGN KEY (tenant_id, recovery_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_abdm_webhook_events_i16_receipt_shape
    CHECK (
      receipt_source IS NULL
      OR (
        receipt_source IN ('live_authenticated_callback', 'owner_reconciled_callback')
        AND callback_path IN ('/consent/on-notify', '/health-info/on-request')
        AND (
          (callback_path = '/consent/on-notify' AND provider_identity_kind = 'consentRequestId')
          OR (callback_path = '/health-info/on-request' AND provider_identity_kind = 'transactionId')
        )
        AND provider_identity_value IS NOT NULL
        AND length(btrim(provider_identity_value)) > 0
        AND external_event_id = provider_identity_value
        AND raw_body_ciphertext IS NOT NULL
        AND raw_body_sha256 ~ '^[0-9a-f]{64}$'
        AND raw_body_bytes > 0
        AND auth_binding_sha256 ~ '^[0-9a-f]{64}$'
        AND authenticated_at IS NOT NULL
        AND signature_verified = TRUE
      )
    ),
  ADD CONSTRAINT chk_abdm_webhook_events_i16_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_disposition IS NULL
        AND source_partition IS NULL
        AND source_position IS NULL
        AND source_token IS NULL
        AND predecessor_token IS NULL
        AND duplicate_key IS NULL
      )
      OR (
        receipt_source IS NOT NULL
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I16'
        AND recovery_owner_uid IS NOT NULL
        AND recovery_owner_reason IS NOT NULL
        AND length(btrim(recovery_owner_reason)) > 0
        AND recovery_disposition IN (
          'review_late_callback',
          'investigate',
          'manual_retry_requested',
          'cancel_requested'
        )
        AND source_partition IS NOT NULL
        AND source_position IS NOT NULL
        AND source_position >= 0
        AND source_token IS NOT NULL
        AND length(btrim(source_token)) > 0
        AND predecessor_token IS NOT NULL
        AND length(btrim(predecessor_token)) > 0
        AND duplicate_key IS NOT NULL
        AND length(btrim(duplicate_key)) > 0
        AND status = 'recovery_pending'
        AND processed_at IS NULL
        AND (
          (recovery_disposition = 'review_late_callback' AND related_data_request_id IS NULL)
          OR (
            recovery_disposition IN ('investigate', 'manual_retry_requested', 'cancel_requested')
            AND callback_path = '/health-info/on-request'
            AND related_data_request_id IS NOT NULL
          )
        )
      )
    );

CREATE UNIQUE INDEX ux_abdm_webhook_events_recovery_inbox
  ON public.abdm_webhook_events
    (tenant_id, recovery_inbox_id, recovery_interface_family)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE INDEX idx_abdm_webhook_events_provider_identity
  ON public.abdm_webhook_events
    (tenant_id, environment, provider_identity_kind, provider_identity_value, id)
  WHERE receipt_source IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assert_abdm_i16_recovery_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inbox RECORD;
  request_row RECORD;
  expected_partition TEXT;
  expected_duplicate TEXT;
BEGIN
  IF NEW.receipt_source IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.callback_path OPERATOR(pg_catalog.=) '/consent/on-notify' THEN
    IF NEW.event_type IS DISTINCT FROM 'consent_on_notify' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_abdm_i16_callback_event_type',
        MESSAGE = 'I16 consent callback event type is invalid';
    END IF;
  ELSIF NEW.event_type IS DISTINCT FROM 'health_info_on_request' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_abdm_i16_callback_event_type',
      MESSAGE = 'I16 health-info callback event type is invalid';
  END IF;

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

  expected_partition := 'abdm:' || NEW.environment || ':inbound';
  expected_duplicate := 'i16:' || NEW.provider_identity_kind || ':'
    || NEW.provider_identity_value;

  IF inbox.interface_family IS DISTINCT FROM 'I16'
     OR inbox.direction IS DISTINCT FROM 'inbound'
     OR inbox.source_partition IS DISTINCT FROM expected_partition
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
      CONSTRAINT = 'chk_abdm_i16_recovery_inbox_binding',
      MESSAGE = 'I16 recovery receipt does not match canonical inbox provenance';
  END IF;

  IF NEW.related_data_request_id IS NOT NULL THEN
    SELECT request.id, request.transaction_id, request.status,
           request.recovery_inbox_id
      INTO request_row
      FROM public.abdm_data_requests AS request
     WHERE request.tenant_id = NEW.tenant_id
       AND request.id = NEW.related_data_request_id;

    IF request_row.id IS NULL
       OR request_row.transaction_id IS DISTINCT FROM NEW.provider_identity_value
       OR request_row.status IS DISTINCT FROM 'RECOVERY_PENDING_REVIEW'
       OR request_row.recovery_inbox_id IS DISTINCT FROM NEW.recovery_inbox_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_abdm_i16_stranded_request_binding',
        MESSAGE = 'I16 stranded request claim is not bound to the callback receipt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER abdm_i16_recovery_binding
BEFORE INSERT OR UPDATE ON public.abdm_webhook_events
FOR EACH ROW EXECUTE FUNCTION public.assert_abdm_i16_recovery_binding();

CREATE OR REPLACE FUNCTION public.assert_abdm_i16_receipt_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.receipt_source IS NOT NULL THEN
    IF TG_OP OPERATOR(pg_catalog.=) 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_abdm_i16_receipt_append_only',
        MESSAGE = 'I16 callback receipts are append-only';
    END IF;

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.external_event_id IS DISTINCT FROM OLD.external_event_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.receipt_source IS DISTINCT FROM OLD.receipt_source
       OR NEW.callback_path IS DISTINCT FROM OLD.callback_path
       OR NEW.provider_identity_kind IS DISTINCT FROM OLD.provider_identity_kind
       OR NEW.provider_identity_value IS DISTINCT FROM OLD.provider_identity_value
       OR NEW.raw_body_ciphertext IS DISTINCT FROM OLD.raw_body_ciphertext
       OR NEW.raw_body_sha256 IS DISTINCT FROM OLD.raw_body_sha256
       OR NEW.raw_body_bytes IS DISTINCT FROM OLD.raw_body_bytes
       OR NEW.auth_binding_sha256 IS DISTINCT FROM OLD.auth_binding_sha256
       OR NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at
       OR NEW.signature_verified IS DISTINCT FROM OLD.signature_verified
       OR (OLD.recovery_inbox_id IS NOT NULL AND (
         NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
         OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
         OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
         OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
         OR NEW.recovery_disposition IS DISTINCT FROM OLD.recovery_disposition
         OR NEW.source_partition IS DISTINCT FROM OLD.source_partition
         OR NEW.source_position IS DISTINCT FROM OLD.source_position
         OR NEW.source_token IS DISTINCT FROM OLD.source_token
         OR NEW.predecessor_token IS DISTINCT FROM OLD.predecessor_token
         OR NEW.duplicate_key IS DISTINCT FROM OLD.duplicate_key
         OR NEW.related_data_request_id IS DISTINCT FROM OLD.related_data_request_id
         OR NEW.status IS DISTINCT FROM OLD.status
       )) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_abdm_i16_receipt_append_only',
        MESSAGE = 'I16 callback receipt identity, exact bytes, and recovery disposition are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER abdm_i16_receipt_immutable
BEFORE UPDATE OR DELETE ON public.abdm_webhook_events
FOR EACH ROW EXECUTE FUNCTION public.assert_abdm_i16_receipt_immutable();

CREATE OR REPLACE FUNCTION public.assert_abdm_i16_request_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.recovery_inbox_id IS NULL AND NEW.recovery_inbox_id IS NOT NULL THEN
    IF OLD.status IS DISTINCT FROM 'PROCESSING'
       OR NEW.status IS DISTINCT FROM 'RECOVERY_PENDING_REVIEW' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_abdm_i16_request_claim_transition',
        MESSAGE = 'only a stranded PROCESSING ABDM request can enter recovery review';
    END IF;
  ELSIF OLD.recovery_inbox_id IS NOT NULL AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
    OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
    OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
    OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
    OR NEW.recovery_disposition IS DISTINCT FROM OLD.recovery_disposition
    OR NEW.recovery_claimed_at IS DISTINCT FROM OLD.recovery_claimed_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_abdm_i16_request_claim_immutable',
      MESSAGE = 'I16 stranded request claim cannot be resumed or rewritten';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER abdm_i16_request_claim
BEFORE UPDATE ON public.abdm_data_requests
FOR EACH ROW EXECUTE FUNCTION public.assert_abdm_i16_request_claim();

CREATE POLICY abdm_i16_recovery_explicit_context
  ON public.abdm_webhook_events
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

CREATE POLICY abdm_i16_recovery_explicit_context
  ON public.abdm_data_requests
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
