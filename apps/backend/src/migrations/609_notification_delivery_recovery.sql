-- Migration 609: C6.1-D notification delivery recovery.
--
-- Provider evidence, permission to send, and cursor position are deliberately
-- separate. Provider attempts/receipts are append-only. notification_outbox
-- remains the send-permission surface (including irreversible SUPPRESSED and
-- RECONCILIATION_REQUIRED states). Per-tenant/channel cursors advance only
-- after positive provider acknowledgement. No retrospective-send exception is
-- introduced here.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Durable intent identity and real claim leases.
-- ---------------------------------------------------------------------------

ALTER TABLE public.notification_outbox
  ADD COLUMN channel VARCHAR(32),
  ADD COLUMN source_event_key VARCHAR(255),
  ADD COLUMN recipient_key VARCHAR(320),
  ADD COLUMN template_version VARCHAR(80),
  ADD COLUMN rendered_intent_hash CHAR(64),
  ADD COLUMN ledger_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN claim_token UUID,
  ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN claimed_at TIMESTAMPTZ(6),
  ADD COLUMN lease_expires_at TIMESTAMPTZ(6);

UPDATE public.notification_outbox
   SET channel = CASE
         WHEN LOWER(type) IN ('push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print')
           THEN LOWER(type)
         WHEN LOWER(type) = 'in_app' THEN 'inapp'
         WHEN recipient_phone IS NOT NULL AND recipient_id IS NULL THEN 'sms'
         ELSE 'push'
       END,
       source_event_key = 'legacy-outbox:' || id::text,
       recipient_key = CASE
         WHEN recipient_id IS NOT NULL THEN 'id:' || recipient_id
         WHEN recipient_phone IS NOT NULL THEN
           'phone-sha256:' || encode(digest(recipient_phone, 'sha256'), 'hex')
         ELSE 'broadcast:legacy-outbox:' || id::text
       END,
       template_version = 'legacy.' ||
         regexp_replace(LOWER(type), '[^a-z0-9_.-]+', '_', 'g') || '.v1',
       rendered_intent_hash = encode(
         digest(
           jsonb_build_object(
             'type', type,
             'channel', CASE
               WHEN LOWER(type) IN ('push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print')
                 THEN LOWER(type)
               WHEN LOWER(type) = 'in_app' THEN 'inapp'
               WHEN recipient_phone IS NOT NULL AND recipient_id IS NULL THEN 'sms'
               ELSE 'push'
             END,
             'recipient_id', recipient_id,
             'recipient_phone', recipient_phone,
             'title', title,
             'body', body,
             'payload', COALESCE(payload, '{}'::jsonb)
           )::text,
           'sha256'
         ),
         'hex'
       ),
       ledger_version = CASE WHEN status IN ('PENDING', 'FAILED') THEN 1 ELSE 0 END
 WHERE channel IS NULL
    OR source_event_key IS NULL
    OR recipient_key IS NULL
    OR template_version IS NULL
    OR rendered_intent_hash IS NULL;

ALTER TABLE public.notification_outbox
  ALTER COLUMN channel SET NOT NULL,
  ALTER COLUMN source_event_key SET NOT NULL,
  ALTER COLUMN recipient_key SET NOT NULL,
  ALTER COLUMN template_version SET NOT NULL,
  ALTER COLUMN rendered_intent_hash SET NOT NULL,
  ALTER COLUMN ledger_version SET DEFAULT 1,
  DROP CONSTRAINT fk_notification_outbox_tenant,
  ADD CONSTRAINT fk_notification_outbox_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE CASCADE,
  ADD CONSTRAINT chk_notification_outbox_channel
    CHECK (channel IN ('push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print')),
  ADD CONSTRAINT chk_notification_outbox_rendered_intent_hash
    CHECK (rendered_intent_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT chk_notification_outbox_ledger_version
    CHECK (ledger_version IN (0, 1)),
  ADD CONSTRAINT chk_notification_outbox_claim_shape
    CHECK (
      (
        status = 'CLAIMED'
        AND claim_token IS NOT NULL
        AND claimed_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
      OR (
        status <> 'CLAIMED'
        AND claim_token IS NULL
        AND claimed_at IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  ADD CONSTRAINT chk_notification_outbox_claim_generation
    CHECK (claim_generation >= 0),
  ADD CONSTRAINT ux_notification_outbox_delivery_intent
    UNIQUE (
      tenant_id,
      source_event_key,
      recipient_key,
      channel,
      template_version,
      rendered_intent_hash
    );

CREATE INDEX idx_notification_outbox_claim_due
  ON public.notification_outbox
    (tenant_id, channel, status, last_attempt_at, id)
  WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX idx_notification_outbox_expired_claim
  ON public.notification_outbox (tenant_id, lease_expires_at, id)
  WHERE status = 'CLAIMED';

CREATE OR REPLACE FUNCTION public.notification_outbox_prepare_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  normalized_type TEXT := LOWER(COALESCE(NEW.type, 'push'));
  source_identity TEXT;
BEGIN
  IF NEW.channel IS NULL OR BTRIM(NEW.channel) = '' THEN
    NEW.channel := CASE
      WHEN normalized_type IN ('push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print')
        THEN normalized_type
      WHEN normalized_type = 'in_app' THEN 'inapp'
      WHEN NEW.recipient_phone IS NOT NULL AND NEW.recipient_id IS NULL THEN 'sms'
      ELSE 'push'
    END;
  ELSE
    NEW.channel := LOWER(BTRIM(NEW.channel));
  END IF;

  IF NEW.source_event_key IS NULL OR BTRIM(NEW.source_event_key) = '' THEN
    source_identity := COALESCE(
      NEW.payload->>'source_event_key',
      NEW.payload->>'event_id',
      NEW.payload->>'message_id',
      NEW.payload->>'task_id',
      NEW.payload->>'generation_id',
      NEW.payload->>'campaign_recipient_id'
    );
    NEW.source_event_key := CASE
      WHEN source_identity IS NOT NULL AND BTRIM(source_identity) <> ''
        THEN normalized_type || ':' || LEFT(BTRIM(source_identity), 220)
      ELSE 'direct-outbox:' || NEW.id::text
    END;
  END IF;

  IF NEW.recipient_key IS NULL OR BTRIM(NEW.recipient_key) = '' THEN
    NEW.recipient_key := CASE
      WHEN NEW.recipient_id IS NOT NULL THEN 'id:' || NEW.recipient_id
      WHEN NEW.recipient_phone IS NOT NULL THEN
        'phone-sha256:' || encode(digest(NEW.recipient_phone, 'sha256'), 'hex')
      ELSE 'broadcast:' || NEW.source_event_key
    END;
  END IF;

  IF NEW.template_version IS NULL OR BTRIM(NEW.template_version) = '' THEN
    NEW.template_version := normalized_type || '.v1';
  END IF;

  IF NEW.rendered_intent_hash IS NULL OR BTRIM(NEW.rendered_intent_hash) = '' THEN
    NEW.rendered_intent_hash := encode(
      digest(
        jsonb_build_object(
          'type', NEW.type,
          'channel', NEW.channel,
          'recipient_key', NEW.recipient_key,
          'template_version', NEW.template_version,
          'title', NEW.title,
          'body', NEW.body,
          'payload', COALESCE(NEW.payload, '{}'::jsonb)
        )::text,
        'sha256'
      ),
      'hex'
    );
  END IF;

  NEW.ledger_version := COALESCE(NEW.ledger_version, 1);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS notification_outbox_prepare_intent
  ON public.notification_outbox;
CREATE TRIGGER notification_outbox_prepare_intent
BEFORE INSERT ON public.notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.notification_outbox_prepare_intent();

-- ---------------------------------------------------------------------------
-- Append-only provider attempt and receipt evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE public.notification_delivery_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  notification_outbox_id INTEGER NOT NULL,
  channel VARCHAR(32) NOT NULL,
  claim_token UUID NOT NULL,
  claim_generation INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  provider VARCHAR(40) NOT NULL,
  rendered_intent_hash CHAR(64) NOT NULL,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_notification_delivery_attempt_identity
    UNIQUE (tenant_id, notification_outbox_id, channel, attempt_number),
  CONSTRAINT ux_notification_delivery_attempt_contract
    UNIQUE (tenant_id, attempt_id, notification_outbox_id, channel),
  CONSTRAINT ux_notification_delivery_attempt_claim
    UNIQUE (tenant_id, notification_outbox_id, channel, claim_token),
  CONSTRAINT fk_notification_delivery_attempt_outbox
    FOREIGN KEY (tenant_id, notification_outbox_id)
    REFERENCES public.notification_outbox (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_notification_delivery_attempt_channel
    CHECK (channel IN ('push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print')),
  CONSTRAINT chk_notification_delivery_attempt_generation
    CHECK (claim_generation > 0 AND attempt_number > 0),
  CONSTRAINT chk_notification_delivery_attempt_hash
    CHECK (rendered_intent_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_notification_delivery_attempt_outbox
  ON public.notification_delivery_attempts
    (tenant_id, notification_outbox_id, channel, started_at DESC);

CREATE OR REPLACE FUNCTION public.validate_notification_delivery_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.notification_outbox AS outbox
     WHERE outbox.tenant_id = NEW.tenant_id
       AND outbox.id = NEW.notification_outbox_id
       AND outbox.status = 'CLAIMED'
       AND outbox.claim_token = NEW.claim_token
       AND outbox.claim_generation = NEW.claim_generation
       AND outbox.rendered_intent_hash = NEW.rendered_intent_hash
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_delivery_attempt_claim_fence',
      MESSAGE = 'Provider attempt does not match the active notification claim';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER notification_delivery_attempt_claim_fence
BEFORE INSERT ON public.notification_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION public.validate_notification_delivery_attempt();

CREATE TABLE public.notification_provider_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  notification_outbox_id INTEGER NOT NULL,
  channel VARCHAR(32) NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  receipt_source VARCHAR(32) NOT NULL,
  provider_reference VARCHAR(255),
  provider_code VARCHAR(120),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  recovery_inbox_id UUID,
  recovery_interface_family VARCHAR(8),
  owner_actor_uid UUID,
  owner_reason VARCHAR(500),

  CONSTRAINT ux_notification_provider_receipt_identity
    UNIQUE (tenant_id, receipt_id, notification_outbox_id, channel),
  CONSTRAINT fk_notification_provider_receipt_attempt
    FOREIGN KEY (tenant_id, attempt_id, notification_outbox_id, channel)
    REFERENCES public.notification_delivery_attempts
      (tenant_id, attempt_id, notification_outbox_id, channel)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_notification_provider_receipt_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox
      (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_notification_provider_receipt_outcome
    CHECK (outcome IN ('acknowledged', 'rejected', 'uncertain')),
  CONSTRAINT chk_notification_provider_receipt_source
    CHECK (receipt_source IN ('provider_response', 'transport_failure', 'lease_expiry', 'owner_reconciliation')),
  CONSTRAINT chk_notification_provider_receipt_channel
    CHECK (channel IN ('push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print')),
  CONSTRAINT chk_notification_provider_receipt_owner_shape
    CHECK (
      (
        receipt_source = 'owner_reconciliation'
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I17'
        AND owner_actor_uid IS NOT NULL
        AND owner_reason IS NOT NULL
        AND BTRIM(owner_reason) <> ''
      )
      OR (
        receipt_source <> 'owner_reconciliation'
        AND recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND owner_actor_uid IS NULL
        AND owner_reason IS NULL
      )
    ),
  CONSTRAINT chk_notification_provider_ack_reference
    CHECK (
      outcome <> 'acknowledged'
      OR provider_reference IS NOT NULL
    )
);

CREATE UNIQUE INDEX ux_notification_provider_receipt_source_once
  ON public.notification_provider_receipts (
    attempt_id,
    receipt_source,
    COALESCE(recovery_inbox_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX idx_notification_provider_receipt_outbox
  ON public.notification_provider_receipts
    (tenant_id, notification_outbox_id, channel, observed_at DESC);

CREATE OR REPLACE FUNCTION public.notification_delivery_evidence_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_contiguous_outbox_id IS NOT NULL
       OR NEW.state <> 'ready'
       OR NEW.blocked_outbox_id IS NOT NULL
       OR NEW.inflight_outbox_id IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_notification_delivery_cursor_initial_state',
        MESSAGE = 'Notification delivery cursor must start empty and ready';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_notification_delivery_evidence_append_only',
    MESSAGE = FORMAT('%I is append-only', TG_TABLE_NAME);
END
$$;

CREATE TRIGGER notification_delivery_attempts_append_only
BEFORE UPDATE OR DELETE ON public.notification_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION public.notification_delivery_evidence_append_only();

CREATE TRIGGER notification_provider_receipts_append_only
BEFORE UPDATE OR DELETE ON public.notification_provider_receipts
FOR EACH ROW EXECUTE FUNCTION public.notification_delivery_evidence_append_only();

CREATE OR REPLACE FUNCTION public.validate_notification_recovery_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  matched_count INTEGER;
BEGIN
  IF NEW.recovery_inbox_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)::integer
    INTO matched_count
    FROM public.pathway_projector_inbox AS inbox
   WHERE inbox.tenant_id = NEW.tenant_id
     AND inbox.inbox_id = NEW.recovery_inbox_id
     AND inbox.interface_family = 'I17'
     AND inbox.scope_kind = 'external_interface'
     AND inbox.direction = 'outbound'
     AND inbox.source_partition = NEW.channel
     AND inbox.source_position = NEW.notification_outbox_id::bigint
     AND inbox.arrival_class = 'recovery_backlog'
     AND inbox.effect_disposition = 'late_pending_only'
     AND inbox.status = 'handled'
     AND inbox.pending_task_id IS NOT NULL;

  IF matched_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_recovery_receipt_provenance',
      MESSAGE = 'I17 provider receipt lacks same-tenant handled recovery provenance';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER notification_recovery_receipt_provenance
AFTER INSERT ON public.notification_provider_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.recovery_inbox_id IS NOT NULL)
EXECUTE FUNCTION public.validate_notification_recovery_receipt();

-- ---------------------------------------------------------------------------
-- Factual per-tenant/channel cursor. Receipt insert and cursor mutation are
-- separate operations; the trigger merely proves an advance is backed by a
-- positive receipt.
-- ---------------------------------------------------------------------------

CREATE TABLE public.notification_delivery_cursors (
  tenant_id UUID NOT NULL,
  channel VARCHAR(32) NOT NULL,
  last_contiguous_outbox_id INTEGER,
  state VARCHAR(32) NOT NULL DEFAULT 'ready',
  blocked_outbox_id INTEGER,
  inflight_outbox_id INTEGER,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT notification_delivery_cursors_pkey PRIMARY KEY (tenant_id, channel),
  CONSTRAINT fk_notification_delivery_cursor_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_notification_delivery_cursor_last
    FOREIGN KEY (tenant_id, last_contiguous_outbox_id)
    REFERENCES public.notification_outbox(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_notification_delivery_cursor_blocked
    FOREIGN KEY (tenant_id, blocked_outbox_id)
    REFERENCES public.notification_outbox(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_notification_delivery_cursor_inflight
    FOREIGN KEY (tenant_id, inflight_outbox_id)
    REFERENCES public.notification_outbox(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_notification_delivery_cursor_channel
    CHECK (channel IN ('push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print')),
  CONSTRAINT chk_notification_delivery_cursor_state
    CHECK (state IN ('ready', 'delivering', 'paused_rejected', 'paused_uncertain')),
  CONSTRAINT chk_notification_delivery_cursor_shape
    CHECK (
      (state = 'ready' AND blocked_outbox_id IS NULL AND inflight_outbox_id IS NULL)
      OR (
        state = 'delivering'
        AND blocked_outbox_id IS NOT NULL
        AND inflight_outbox_id = blocked_outbox_id
      )
      OR (
        state IN ('paused_rejected', 'paused_uncertain')
        AND blocked_outbox_id IS NOT NULL
        AND inflight_outbox_id IS NULL
      )
    )
);

CREATE OR REPLACE FUNCTION public.validate_notification_delivery_cursor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.last_contiguous_outbox_id IS NOT NULL
     AND (
       NEW.last_contiguous_outbox_id IS NULL
       OR NEW.last_contiguous_outbox_id < OLD.last_contiguous_outbox_id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_delivery_cursor_monotonic',
      MESSAGE = 'Notification delivery cursor cannot move backwards';
  END IF;

  IF NEW.last_contiguous_outbox_id IS DISTINCT FROM OLD.last_contiguous_outbox_id
     AND NEW.last_contiguous_outbox_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.notification_provider_receipts AS receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.notification_outbox_id = NEW.last_contiguous_outbox_id
          AND receipt.channel = NEW.channel
          AND receipt.outcome = 'acknowledged'
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_delivery_cursor_positive_receipt',
      MESSAGE = 'Notification delivery cursor advance requires positive provider acceptance';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER notification_delivery_cursor_validate
BEFORE INSERT OR UPDATE ON public.notification_delivery_cursors
FOR EACH ROW EXECUTE FUNCTION public.validate_notification_delivery_cursor();

CREATE OR REPLACE FUNCTION public.validate_notification_outbox_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.type IS DISTINCT FROM NEW.type
     OR OLD.recipient_id IS DISTINCT FROM NEW.recipient_id
     OR OLD.recipient_phone IS DISTINCT FROM NEW.recipient_phone
     OR OLD.title IS DISTINCT FROM NEW.title
     OR OLD.body IS DISTINCT FROM NEW.body
     OR OLD.payload IS DISTINCT FROM NEW.payload
     OR OLD.channel IS DISTINCT FROM NEW.channel
     OR OLD.source_event_key IS DISTINCT FROM NEW.source_event_key
     OR OLD.recipient_key IS DISTINCT FROM NEW.recipient_key
     OR OLD.template_version IS DISTINCT FROM NEW.template_version
     OR OLD.rendered_intent_hash IS DISTINCT FROM NEW.rendered_intent_hash
     OR OLD.ledger_version IS DISTINCT FROM NEW.ledger_version
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_outbox_intent_immutable',
      MESSAGE = 'Notification outbox rendered intent is immutable';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status IN ('PENDING', 'FAILED') AND NEW.status IN ('CLAIMED', 'SUPPRESSED') THEN
      NULL;
    ELSIF OLD.status = 'CLAIMED'
      AND NEW.status IN ('PENDING', 'SENT', 'FAILED', 'RECONCILIATION_REQUIRED') THEN
      NULL;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_notification_outbox_state_transition',
        MESSAGE = FORMAT('Notification outbox transition %s -> %s is not allowed', OLD.status, NEW.status);
    END IF;
  END IF;

  IF NEW.status = 'SENT'
     AND NOT EXISTS (
       SELECT 1
         FROM public.notification_provider_receipts AS receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.notification_outbox_id = NEW.id
          AND receipt.outcome = 'acknowledged'
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_notification_outbox_sent_provider_acceptance',
      MESSAGE = 'Notification outbox cannot be sent without provider acceptance';
  END IF;

  IF NEW.status = 'SUPPRESSED' AND OLD.status = 'SUPPRESSED' THEN
    RETURN NEW;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS notification_outbox_transition_guard
  ON public.notification_outbox;
CREATE TRIGGER notification_outbox_transition_guard
BEFORE UPDATE ON public.notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.validate_notification_outbox_transition();

-- ---------------------------------------------------------------------------
-- I17 uncertain/rejected provider state pauses the canonical recovery offset.
-- It is resolved by owner-directed evidence, never by inferred retry.
-- ---------------------------------------------------------------------------

ALTER TABLE public.event_consumer_offsets
  DROP CONSTRAINT chk_event_consumer_offsets_external_state,
  ADD CONSTRAINT chk_event_consumer_offsets_external_state
    CHECK (
      recovery_state IS NULL
      OR recovery_state IN (
        'paused',
        'ready',
        'replaying',
        'reconciliation_required_missing_marker',
        'reconciliation_required_retention_gap',
        'reconciliation_required_source_gap',
        'reconciliation_required_provider_state',
        'retired'
      )
    );

-- ---------------------------------------------------------------------------
-- Layered RLS. The migration-335 permissive policy is retained as a neutral
-- compatibility layer, while an explicit-context restrictive policy now makes
-- absent, empty, bypass, and wrong-tenant contexts fail closed.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON public.notification_outbox;
CREATE POLICY tenant_isolation ON public.notification_outbox
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
  );

DROP POLICY IF EXISTS notification_outbox_explicit_context
  ON public.notification_outbox;
CREATE POLICY notification_outbox_explicit_context
  ON public.notification_outbox
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
  );

ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox FORCE ROW LEVEL SECURITY;

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'notification_delivery_attempts',
    'notification_provider_receipts',
    'notification_delivery_cursors'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
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
    EXECUTE FORMAT($policy$
      CREATE POLICY notification_delivery_explicit_context
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

-- ---------------------------------------------------------------------------
-- Runtime privileges. Provider evidence is insert-only; cursor and outbox
-- mutation is column-scoped; destructive operations and guard functions remain
-- unavailable.
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON FUNCTION public.notification_outbox_prepare_intent() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_delivery_attempt() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.notification_delivery_evidence_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_recovery_receipt() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_delivery_cursor() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_outbox_transition() FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE FORMAT(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.notification_outbox FROM %I',
      runtime_role
    );
    EXECUTE FORMAT('GRANT SELECT ON public.notification_outbox TO %I', runtime_role);
    EXECUTE FORMAT(
      'GRANT INSERT (
         tenant_id, type, recipient_id, recipient_phone, title, body, payload,
         status, retry_count, failure_reason, last_attempt_at, sent_at,
         created_at, channel, source_event_key, recipient_key,
         template_version, rendered_intent_hash, ledger_version
       ) ON public.notification_outbox TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT UPDATE (
         status, retry_count, failure_reason, last_attempt_at, sent_at,
         claim_token, claim_generation, claimed_at, lease_expires_at
       ) ON public.notification_outbox TO %I',
      runtime_role
    );

    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.notification_delivery_attempts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.notification_delivery_attempts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.notification_provider_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.notification_provider_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT, UPDATE ON public.notification_delivery_cursors TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE DELETE, TRUNCATE ON public.notification_delivery_cursors FROM %I',
      runtime_role
    );

    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.notification_outbox_prepare_intent() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_delivery_attempt() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.notification_delivery_evidence_append_only() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_recovery_receipt() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_delivery_cursor() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.validate_notification_outbox_transition() FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
