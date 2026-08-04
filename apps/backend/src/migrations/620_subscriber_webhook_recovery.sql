-- 620_subscriber_webhook_recovery.sql
-- C6.1-G / I18: adapt the existing subscriber webhook registry and delivery
-- ledger in place. event_outbox.status='delivered' continues to mean fan-out
-- enqueue completed; it is not subscriber acknowledgement and is never an HWM.
--
-- This migration is activation-inert. Existing and new live dispatch remain
-- live, while late-recovery rows are held for owner reconciliation. No release
-- executor, subscriber classification values, or replay worker is activated.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $i18_preflight$
DECLARE
  invalid_count BIGINT;
  invalid_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_count
    FROM public.webhook_deliveries AS delivery
    LEFT JOIN public.event_outbox AS source
      ON source.tenant_id = delivery.tenant_id
     AND source.id = delivery.event_outbox_id
   WHERE delivery.event_outbox_id IS NOT NULL
     AND source.id IS NULL;

  SELECT STRING_AGG(sample, ', ' ORDER BY sample)
    INTO invalid_samples
    FROM (
      SELECT FORMAT('%s/%s/%s', delivery.tenant_id, delivery.id,
                    delivery.event_outbox_id) AS sample
        FROM public.webhook_deliveries AS delivery
        LEFT JOIN public.event_outbox AS source
          ON source.tenant_id = delivery.tenant_id
         AND source.id = delivery.event_outbox_id
       WHERE delivery.event_outbox_id IS NOT NULL
         AND source.id IS NULL
       ORDER BY delivery.tenant_id, delivery.id
       LIMIT 20
    ) AS invalid;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'migration 620 I18 preflight failed: % webhook source row(s) lack same-tenant event_outbox evidence; samples=%',
      invalid_count, COALESCE(invalid_samples, '<none>');
  END IF;
END
$i18_preflight$;

ALTER TABLE public.webhook_subscriptions
  ADD COLUMN downstream_effect_classification VARCHAR(48) NOT NULL DEFAULT 'unclassified',
  ADD COLUMN acknowledgement_contract VARCHAR(48) NOT NULL DEFAULT 'unclassified',
  ADD COLUMN acknowledgement_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN recovery_contract_owner_uid UUID,
  ADD COLUMN recovery_contract_owner_reason VARCHAR(500),
  ADD COLUMN recovery_contract_classified_at TIMESTAMPTZ(6),
  ADD CONSTRAINT fk_webhook_subscriptions_recovery_contract_owner
    FOREIGN KEY (tenant_id, recovery_contract_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_webhook_subscriptions_i18_owner_contract
    CHECK (
      (
        downstream_effect_classification = 'unclassified'
        AND acknowledgement_contract = 'unclassified'
        AND acknowledgement_config = '{}'::jsonb
        AND recovery_contract_owner_uid IS NULL
        AND recovery_contract_owner_reason IS NULL
        AND recovery_contract_classified_at IS NULL
      )
      OR (
        downstream_effect_classification IN (
          'no_downstream_effect',
          'clinical_or_operational_effect',
          'external_effect_unverified'
        )
        AND acknowledgement_contract IN (
          'response_header_sha256',
          'response_body_sha256'
        )
        AND jsonb_typeof(acknowledgement_config) = 'object'
        AND acknowledgement_config <> '{}'::jsonb
        AND recovery_contract_owner_uid IS NOT NULL
        AND recovery_contract_owner_reason IS NOT NULL
        AND length(btrim(recovery_contract_owner_reason)) > 0
        AND recovery_contract_classified_at IS NOT NULL
      )
    );

ALTER TABLE public.webhook_deliveries
  ADD COLUMN source_kind VARCHAR(24),
  ADD COLUMN source_identity VARCHAR(255),
  ADD COLUMN source_position BIGINT,
  ADD COLUMN payload_sha256 CHAR(64),
  ADD COLUMN downstream_effect_classification VARCHAR(48) NOT NULL DEFAULT 'unclassified',
  ADD COLUMN acknowledgement_contract VARCHAR(48) NOT NULL DEFAULT 'unclassified',
  ADD COLUMN acknowledgement_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN acknowledgement_state VARCHAR(24) NOT NULL DEFAULT 'unclassified',
  ADD COLUMN acknowledgement_evidence JSONB,
  ADD COLUMN acknowledged_at TIMESTAMPTZ(6),
  ADD COLUMN send_authority VARCHAR(40) NOT NULL DEFAULT 'live_authorized',
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN recovery_owner_uid UUID,
  ADD COLUMN recovery_owner_reason VARCHAR(500),
  ADD COLUMN recovery_evidence JSONB,
  ADD COLUMN effect_disposition VARCHAR(32) NOT NULL DEFAULT 'live',
  ADD CONSTRAINT fk_webhook_deliveries_source_event
    FOREIGN KEY (tenant_id, event_outbox_id)
    REFERENCES public.event_outbox (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_webhook_deliveries_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_webhook_deliveries_recovery_owner
    FOREIGN KEY (tenant_id, recovery_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

UPDATE public.webhook_deliveries
   SET source_kind = CASE
         WHEN event_outbox_id IS NOT NULL AND subscription_id IS NOT NULL THEN 'event_outbox'
         WHEN event_outbox_id IS NULL AND subscription_id IS NOT NULL THEN 'adhoc'
         ELSE 'legacy_orphan'
       END,
       source_identity = CASE
         WHEN event_outbox_id IS NOT NULL AND subscription_id IS NOT NULL
           THEN 'event_outbox:' || event_outbox_id::text
         WHEN event_outbox_id IS NULL AND subscription_id IS NOT NULL
           THEN 'legacy-adhoc:' || id::text
         ELSE 'legacy-orphan:' || id::text
       END,
       source_position = CASE
         WHEN event_outbox_id IS NOT NULL AND subscription_id IS NOT NULL
           THEN event_outbox_id
         ELSE NULL
       END,
       payload_sha256 = encode(digest(payload::text, 'sha256'), 'hex');

ALTER TABLE public.webhook_deliveries
  ALTER COLUMN source_kind SET NOT NULL,
  ALTER COLUMN source_identity SET NOT NULL,
  ALTER COLUMN payload_sha256 SET NOT NULL,
  ADD CONSTRAINT chk_webhook_deliveries_i18_source_shape
    CHECK (
      length(btrim(source_identity)) > 0
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
      AND (
        (
          source_kind = 'event_outbox'
          AND subscription_id IS NOT NULL
          AND event_outbox_id IS NOT NULL
          AND source_position = event_outbox_id
          AND source_identity = 'event_outbox:' || event_outbox_id::text
        )
        OR (
          source_kind = 'adhoc'
          AND subscription_id IS NOT NULL
          AND event_outbox_id IS NULL
          AND source_position IS NULL
        )
        OR (
          source_kind = 'legacy_orphan'
          AND subscription_id IS NULL
          AND source_position IS NULL
        )
      )
    ),
  ADD CONSTRAINT chk_webhook_deliveries_i18_ack_shape
    CHECK (
      acknowledgement_state IN (
        'unclassified', 'pending', 'positive', 'negative', 'missing'
      )
      AND acknowledgement_contract IN (
        'unclassified', 'response_header_sha256', 'response_body_sha256'
      )
      AND downstream_effect_classification IN (
        'unclassified', 'no_downstream_effect',
        'clinical_or_operational_effect', 'external_effect_unverified'
      )
      AND jsonb_typeof(acknowledgement_config) = 'object'
      AND (
        (
          acknowledgement_state = 'positive'
          AND acknowledgement_contract <> 'unclassified'
          AND acknowledgement_evidence IS NOT NULL
          AND jsonb_typeof(acknowledgement_evidence) = 'object'
          AND acknowledgement_evidence <> '{}'::jsonb
          AND acknowledged_at IS NOT NULL
        )
        OR (
          acknowledgement_state <> 'positive'
          AND acknowledged_at IS NULL
        )
      )
    ),
  ADD CONSTRAINT chk_webhook_deliveries_i18_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_evidence IS NULL
        AND send_authority = 'live_authorized'
        AND effect_disposition = 'live'
      )
      OR (
        recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I18'
        AND recovery_owner_uid IS NOT NULL
        AND recovery_owner_reason IS NOT NULL
        AND length(btrim(recovery_owner_reason)) > 0
        AND recovery_evidence IS NOT NULL
        AND jsonb_typeof(recovery_evidence) = 'object'
        AND recovery_evidence <> '{}'::jsonb
        AND source_kind = 'event_outbox'
        AND send_authority = 'held_owner_reconciliation'
        AND effect_disposition = 'late_pending_only'
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  ADD CONSTRAINT chk_webhook_deliveries_i18_send_authority
    CHECK (send_authority IN ('live_authorized', 'held_owner_reconciliation')),
  ADD CONSTRAINT chk_webhook_deliveries_i18_effect_disposition
    CHECK (effect_disposition IN ('live', 'late_pending_only'));

CREATE UNIQUE INDEX ux_webhook_deliveries_adhoc_source_identity
  ON public.webhook_deliveries (tenant_id, subscription_id, source_identity)
  WHERE source_kind = 'adhoc';

CREATE UNIQUE INDEX ux_webhook_deliveries_i18_recovery_inbox
  ON public.webhook_deliveries
    (tenant_id, recovery_inbox_id, recovery_interface_family)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE INDEX idx_webhook_deliveries_i18_ack_hwm
  ON public.webhook_deliveries
    (tenant_id, subscription_id, source_position, acknowledgement_state)
  WHERE source_kind = 'event_outbox';

CREATE OR REPLACE FUNCTION public.assert_webhook_i18_recovery_binding()
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
         item.source_position, item.duplicate_key, item.arrival_class,
         item.effect_disposition, item.status
    INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id;

  expected_partition := 'webhook-subscription:' || NEW.subscription_id::text || ':outbound';
  expected_duplicate := 'i18:' || NEW.subscription_id::text || ':event_outbox:'
                        || NEW.event_outbox_id::text || ':' || NEW.payload_sha256::text;

  IF inbox.interface_family IS DISTINCT FROM 'I18'
     OR inbox.direction IS DISTINCT FROM 'outbound'
     OR inbox.source_partition IS DISTINCT FROM expected_partition
     OR inbox.source_position IS DISTINCT FROM NEW.event_outbox_id
     OR inbox.duplicate_key IS DISTINCT FROM expected_duplicate
     OR inbox.arrival_class IS DISTINCT FROM 'recovery_backlog'
     OR inbox.effect_disposition IS DISTINCT FROM 'late_pending_only'
     OR inbox.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_webhook_i18_recovery_inbox_binding',
      MESSAGE = 'I18 webhook recovery does not match canonical inbox provenance';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_i18_recovery_binding
BEFORE INSERT OR UPDATE OF recovery_inbox_id ON public.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION public.assert_webhook_i18_recovery_binding();

CREATE OR REPLACE FUNCTION public.assert_webhook_i18_evidence_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.recovery_inbox_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_webhook_i18_recovery_immutable',
      MESSAGE = 'I18 recovery evidence is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF OLD.source_kind IS DISTINCT FROM NEW.source_kind
     OR OLD.source_identity IS DISTINCT FROM NEW.source_identity
     OR OLD.source_position IS DISTINCT FROM NEW.source_position
     OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
     OR OLD.event_outbox_id IS DISTINCT FROM NEW.event_outbox_id
     OR OLD.subscription_id IS DISTINCT FROM NEW.subscription_id
     OR OLD.acknowledgement_contract IS DISTINCT FROM NEW.acknowledgement_contract
     OR OLD.acknowledgement_config IS DISTINCT FROM NEW.acknowledgement_config
     OR OLD.downstream_effect_classification IS DISTINCT FROM NEW.downstream_effect_classification THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_webhook_i18_source_immutable',
      MESSAGE = 'I18 webhook source identity and occurrence contract are immutable';
  END IF;

  IF OLD.recovery_inbox_id IS NOT NULL AND (
    NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
    OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
    OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
    OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
    OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence
    OR NEW.send_authority IS DISTINCT FROM OLD.send_authority
    OR NEW.effect_disposition IS DISTINCT FROM OLD.effect_disposition
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_webhook_i18_recovery_immutable',
      MESSAGE = 'I18 recovery evidence and held authority are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_i18_evidence_transition
BEFORE UPDATE OR DELETE ON public.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION public.assert_webhook_i18_evidence_transition();

CREATE POLICY webhook_i18_recovery_explicit_context
  ON public.webhook_deliveries
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
