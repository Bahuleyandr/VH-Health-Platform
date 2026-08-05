-- 629_clinical_continuity_held_webhook_disposition.sql
-- C5.2 PR-2: bind retrospective paper facts to held I18 webhook deliveries.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TABLE public.event_outbox
  DROP CONSTRAINT chk_event_outbox_recovery_contract,
  ADD CONSTRAINT chk_event_outbox_recovery_contract
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_fingerprint IS NULL
        AND recovery_effect_disposition IS NULL
      )
      OR (
        recovery_inbox_id IS NOT NULL
        AND recovery_fingerprint IS NOT NULL
        AND recovery_effect_disposition IN (
          'normal',
          'late_pending_only',
          'signed_exception'
        )
        AND occurred_at_source = 'explicit'
      )
      OR (
        recovery_inbox_id IS NULL
        AND recovery_fingerprint IS NULL
        AND recovery_effect_disposition = 'late_pending_only'
        AND event_type = 'clinical_continuity.paper_fact.recorded'
        AND aggregate_type = 'clinical_continuity_retrospective_fact'
        AND aggregate_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND patient_uid IS NOT NULL
        AND occurred_at_source = 'explicit'
      )
    );

CREATE OR REPLACE FUNCTION public.assert_cc_paper_outbox_source_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.recovery_effect_disposition = 'late_pending_only'
       AND OLD.recovery_inbox_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_cc_paper_outbox_source_immutable',
        MESSAGE = 'retrospective paper outbox evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.recovery_effect_disposition = 'late_pending_only'
     AND OLD.recovery_inbox_id IS NULL
     AND (
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
       OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.occurred_at_source IS DISTINCT FROM OLD.occurred_at_source
       OR NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
       OR NEW.recovery_fingerprint IS DISTINCT FROM OLD.recovery_fingerprint
       OR NEW.recovery_effect_disposition IS DISTINCT FROM OLD.recovery_effect_disposition
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_paper_outbox_source_immutable',
      MESSAGE = 'retrospective paper outbox identity and disposition are immutable';
  END IF;

  IF NEW.recovery_effect_disposition = 'late_pending_only'
     AND NEW.recovery_inbox_id IS NULL
     AND NOT (
       OLD.recovery_effect_disposition = 'late_pending_only'
       AND OLD.recovery_inbox_id IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_paper_outbox_source_immutable',
      MESSAGE = 'an existing outbox row cannot acquire retrospective paper authority';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_cc_paper_outbox_source_immutable() FROM PUBLIC;

CREATE TRIGGER cc_paper_outbox_source_immutable
BEFORE UPDATE OR DELETE ON public.event_outbox
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_paper_outbox_source_immutable();

CREATE OR REPLACE FUNCTION public.assert_cc_paper_outbox_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  binding_count INTEGER;
BEGIN
  IF NEW.recovery_effect_disposition IS DISTINCT FROM 'late_pending_only'
     OR NEW.recovery_inbox_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)::integer
    INTO binding_count
    FROM public.clinical_continuity_retrospective_facts AS fact
    JOIN public.clinical_continuity_paper_items AS paper
      ON paper.tenant_id = fact.tenant_id
     AND paper.facility_id = fact.facility_id
     AND paper.incident_id = fact.incident_id
     AND paper.id = fact.paper_item_row_id
    JOIN public.clinical_continuity_replay_effect_evidence AS effect
      ON effect.tenant_id = fact.tenant_id
     AND effect.client_event_id = fact.receipt_client_event_id
     AND effect.retrospective_fact_id = fact.id
     AND effect.paper_item_row_id = fact.paper_item_row_id
     AND effect.fact_resource_type = 'clinical_continuity_retrospective_fact'
     AND effect.fact_resource_id = fact.id::text
     AND effect.occurred_at = fact.occurred_at
     AND effect.recorded_at = fact.recorded_at
     AND effect.retrospective_event_outbox_id = NEW.id
     AND effect.effect_disposition = 'late_pending_only'
    JOIN public.clinical_continuity_replay_receipts AS receipt
      ON receipt.tenant_id = fact.tenant_id
     AND receipt.client_event_id = fact.receipt_client_event_id
     AND receipt.facility_id = fact.facility_id
     AND receipt.incident_id = fact.incident_id
     AND receipt.patient_uid = fact.patient_uid
     AND receipt.source_kind = 'paper_back_entry'
     AND receipt.disposition = 'applied'
     AND receipt.outcome_code = effect.outcome_code
   WHERE fact.tenant_id = NEW.tenant_id
     AND fact.id::text = NEW.aggregate_id
     AND fact.patient_uid = NEW.patient_uid
     AND fact.occurred_at = NEW.occurred_at
     AND fact.effect_disposition = 'late_pending_only'
     AND paper.receipt_client_event_id = fact.receipt_client_event_id;

  IF binding_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_paper_outbox_binding',
      MESSAGE = 'late paper outbox disposition lacks exact C5.2 fact and C5.1 effect evidence';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_cc_paper_outbox_binding() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER cc_paper_outbox_binding
AFTER INSERT OR UPDATE ON public.event_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_paper_outbox_binding();

ALTER TABLE public.webhook_deliveries
  DROP CONSTRAINT chk_webhook_deliveries_i18_recovery_shape,
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
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_evidence IS NULL
        AND source_kind = 'event_outbox'
        AND subscription_id IS NOT NULL
        AND event_outbox_id IS NOT NULL
        AND send_authority = 'held_owner_reconciliation'
        AND effect_disposition = 'late_pending_only'
        AND status = 'pending'
        AND attempt_number = 0
        AND next_retry_at IS NULL
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
        AND started_at IS NULL
        AND completed_at IS NULL
        AND http_status IS NULL
        AND response_excerpt IS NULL
        AND error_message IS NULL
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
    );

CREATE OR REPLACE FUNCTION public.assert_webhook_i18_source_disposition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  source_disposition TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.recovery_inbox_id IS NULL
       AND OLD.send_authority = 'held_owner_reconciliation'
       AND OLD.effect_disposition = 'late_pending_only' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_webhook_i18_source_held_immutable',
        MESSAGE = 'source-held I18 delivery evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.source_kind = 'event_outbox' THEN
    SELECT source.recovery_effect_disposition
      INTO source_disposition
      FROM public.event_outbox AS source
     WHERE source.tenant_id = NEW.tenant_id
       AND source.id = NEW.event_outbox_id;
  END IF;

  IF NEW.recovery_inbox_id IS NULL
     AND NEW.send_authority = 'held_owner_reconciliation'
     AND NEW.effect_disposition = 'late_pending_only'
     AND source_disposition IS DISTINCT FROM 'late_pending_only' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_webhook_i18_source_disposition_binding',
      MESSAGE = 'source-held I18 delivery requires a late-pending event-outbox source';
  END IF;

  IF source_disposition = 'late_pending_only'
     AND NEW.recovery_inbox_id IS NULL
     AND (
       NEW.send_authority IS DISTINCT FROM 'held_owner_reconciliation'
       OR NEW.effect_disposition IS DISTINCT FROM 'late_pending_only'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_webhook_i18_source_disposition_binding',
      MESSAGE = 'late-pending event-outbox source cannot create or regain live webhook authority';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_webhook_i18_source_disposition() FROM PUBLIC;

CREATE TRIGGER webhook_i18_source_disposition
BEFORE INSERT OR UPDATE OR DELETE ON public.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION public.assert_webhook_i18_source_disposition();

ALTER TABLE public.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY cc_paper_outbox_insert_explicit_context
  ON public.event_outbox
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    recovery_effect_disposition IS DISTINCT FROM 'late_pending_only'
    OR recovery_inbox_id IS NOT NULL
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  );

DROP POLICY webhook_i18_recovery_explicit_context
  ON public.webhook_deliveries;

CREATE POLICY webhook_i18_recovery_explicit_context
  ON public.webhook_deliveries
  AS RESTRICTIVE
  USING (
    (
      recovery_inbox_id IS NULL
      AND send_authority = 'live_authorized'
      AND effect_disposition = 'live'
    )
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    (
      recovery_inbox_id IS NULL
      AND send_authority = 'live_authorized'
      AND effect_disposition = 'live'
    )
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  );

COMMIT;
