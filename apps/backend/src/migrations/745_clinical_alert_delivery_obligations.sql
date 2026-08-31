-- Migration 745: durable clinical-alert recipient recovery.
--
-- A failed duty-doctor fan-out must retain the exact rendered alert until a
-- real recipient can be resolved. The obligation is tenant-scoped, immutable
-- in identity and intent, and may complete only from matching outbox rows.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE public.clinical_alert_delivery_obligations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  obligation_key CHAR(64) NOT NULL,
  source_table VARCHAR(80) NOT NULL,
  source_id VARCHAR(120) NOT NULL,
  source_event_key VARCHAR(255) NOT NULL,
  failure_kind VARCHAR(80) NOT NULL,
  patient_uid UUID,
  encounter_id UUID,
  origin_actor_uid UUID,
  failure_code VARCHAR(120) NOT NULL,
  recipient_policy JSONB NOT NULL,
  notification_intent JSONB NOT NULL,
  supersedes_obligation_id BIGINT,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ(6),
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  last_error_code VARCHAR(120),
  completion_notification_outbox_id INTEGER,
  completion_notification_outbox_ids INTEGER[],
  completion_recipient_ids TEXT[],
  completion_evidence JSONB,
  completed_at TIMESTAMPTZ(6),
  manual_hold_code VARCHAR(120),
  manual_hold_reason TEXT,
  held_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_clinical_alert_delivery_obligations_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_alert_delivery_obligations_key
    UNIQUE (tenant_id, obligation_key),
  CONSTRAINT ux_clinical_alert_delivery_obligations_source_event
    UNIQUE (tenant_id, source_event_key),
  CONSTRAINT fk_clinical_alert_delivery_obligations_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT fk_clinical_alert_delivery_obligations_outbox
    FOREIGN KEY (tenant_id, completion_notification_outbox_id)
    REFERENCES public.notification_outbox (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_alert_delivery_obligations_supersedes
    FOREIGN KEY (tenant_id, supersedes_obligation_id)
    REFERENCES public.clinical_alert_delivery_obligations (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_clinical_alert_delivery_obligation_key
    CHECK (obligation_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_clinical_alert_delivery_source
    CHECK (
      source_table IN ('clinical_orders', 'icu_admissions')
      AND source_id ~ '^[1-9][0-9]*$'
      AND BTRIM(source_event_key) <> ''
    ),
  CONSTRAINT chk_clinical_alert_delivery_failure_kind
    CHECK (
      (
        source_table = 'clinical_orders'
        AND failure_kind IN ('order_mar_schedule', 'order_mar_carryover')
      )
      OR (
        source_table = 'icu_admissions'
        AND failure_kind = 'icu_mar_carryover_query'
      )
    ),
  CONSTRAINT chk_clinical_alert_delivery_json_shape
    CHECK (
      jsonb_typeof(recipient_policy) = 'object'
      AND jsonb_typeof(notification_intent) = 'object'
      AND (
        completion_evidence IS NULL
        OR jsonb_typeof(completion_evidence) = 'object'
      )
    ),
  CONSTRAINT chk_clinical_alert_delivery_attempt_count
    CHECK (attempt_count >= 0),
  CONSTRAINT chk_clinical_alert_delivery_supersession_shape
    CHECK (
      (
        supersedes_obligation_id IS NULL
        AND NOT (COALESCE(notification_intent->'data', '{}'::jsonb)
                 ? 'supersedes_obligation_id')
      )
      OR (
        supersedes_obligation_id IS NOT NULL
        AND notification_intent->'data'->>'supersedes_obligation_id'
              = supersedes_obligation_id::text
      )
    ),
  CONSTRAINT chk_clinical_alert_delivery_status
    CHECK (status IN ('pending', 'completed', 'manual_hold')),
  CONSTRAINT chk_clinical_alert_delivery_terminal_shape
    CHECK (
      (
        status = 'pending'
        AND completed_at IS NULL
        AND completion_notification_outbox_id IS NULL
        AND completion_notification_outbox_ids IS NULL
        AND completion_recipient_ids IS NULL
        AND completion_evidence IS NULL
        AND manual_hold_code IS NULL
        AND manual_hold_reason IS NULL
        AND held_at IS NULL
      )
      OR (
        status = 'completed'
        AND completed_at IS NOT NULL
        AND completion_notification_outbox_id IS NOT NULL
        AND completion_notification_outbox_ids IS NOT NULL
        AND cardinality(completion_notification_outbox_ids) > 0
        AND completion_notification_outbox_id = completion_notification_outbox_ids[1]
        AND completion_recipient_ids IS NOT NULL
        AND cardinality(completion_recipient_ids) =
              cardinality(completion_notification_outbox_ids)
        AND completion_evidence IS NOT NULL
        AND manual_hold_code IS NULL
        AND manual_hold_reason IS NULL
        AND held_at IS NULL
      )
      OR (
        status = 'manual_hold'
        AND completed_at IS NULL
        AND completion_notification_outbox_id IS NULL
        AND completion_notification_outbox_ids IS NULL
        AND completion_recipient_ids IS NULL
        AND completion_evidence IS NULL
        AND manual_hold_code IS NOT NULL
        AND manual_hold_code IN (
          'CLINICAL_ALERT_OBLIGATION_INTENT_INVALID',
          'CLINICAL_ALERT_OBLIGATION_POLICY_INVALID',
          'CLINICAL_ALERT_OBLIGATION_SOURCE_MISSING',
          'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH'
        )
        AND BTRIM(manual_hold_code) <> ''
        AND manual_hold_reason IS NOT NULL
        AND BTRIM(manual_hold_reason) <> ''
        AND held_at IS NOT NULL
      )
    )
);

CREATE INDEX idx_clinical_alert_delivery_obligations_recovery
  ON public.clinical_alert_delivery_obligations
    (tenant_id, next_attempt_at, created_at, id)
  WHERE status = 'pending';

CREATE INDEX idx_clinical_alert_delivery_obligations_source
  ON public.clinical_alert_delivery_obligations
    (tenant_id, source_table, source_id, created_at DESC);

CREATE UNIQUE INDEX ux_clinical_alert_delivery_obligations_supersession
  ON public.clinical_alert_delivery_obligations
    (tenant_id, supersedes_obligation_id)
  WHERE supersedes_obligation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_obligation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  matching_outbox_count INTEGER;
  distinct_outbox_count INTEGER;
  distinct_recipient_count INTEGER;
  expected_recipient_count INTEGER;
  superseded clinical_alert_delivery_obligations%ROWTYPE;
  source_record RECORD;
  expected_intent JSONB;
  expected_source_event_key TEXT;
  expected_recipient_policy CONSTANT JSONB := jsonb_build_object(
    'version', 1,
    'strategy', 'duty_doctor_then_doctor_tiers',
    'primary_role', 'DUTY_DOCTOR',
    'fallback_roles', jsonb_build_array(
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT'
    )
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_source_event_key := CASE NEW.failure_kind
      WHEN 'order_mar_schedule' THEN
        'clinical_orders:' || NEW.source_id || ':mar_schedule_failed:alert'
      WHEN 'order_mar_carryover' THEN
        'clinical_orders:' || NEW.source_id || ':mar_carryover_failed:alert'
      WHEN 'icu_mar_carryover_query' THEN
        'icu_admissions:' || NEW.source_id || ':icu.mar_carryover_failed:alert'
      ELSE NULL
    END;

    IF NEW.supersedes_obligation_id IS NOT NULL THEN
      SELECT obligation.*
        INTO superseded
        FROM clinical_alert_delivery_obligations obligation
       WHERE obligation.tenant_id = NEW.tenant_id
         AND obligation.id = NEW.supersedes_obligation_id
       FOR KEY SHARE;

      IF NOT FOUND
         OR superseded.status IS DISTINCT FROM 'manual_hold'
         OR superseded.source_table IS DISTINCT FROM NEW.source_table
         OR superseded.source_id IS DISTINCT FROM NEW.source_id
         OR superseded.failure_kind IS DISTINCT FROM NEW.failure_kind
         OR superseded.patient_uid IS DISTINCT FROM NEW.patient_uid
         OR superseded.encounter_id IS DISTINCT FROM NEW.encounter_id
         OR superseded.origin_actor_uid IS DISTINCT FROM NEW.origin_actor_uid
         OR superseded.failure_code IS DISTINCT FROM NEW.failure_code
         OR superseded.recipient_policy IS DISTINCT FROM NEW.recipient_policy
      THEN
        RAISE EXCEPTION
          'clinical alert supersession must derive from one immutable manual-hold source'
          USING ERRCODE = '23514';
      END IF;
      expected_source_event_key := expected_source_event_key
        || ':supersession:' || superseded.id::text;
    END IF;

    IF expected_source_event_key IS NULL
       OR NEW.source_event_key IS DISTINCT FROM expected_source_event_key
       OR NEW.obligation_key IS DISTINCT FROM encode(
            public.digest(
              convert_to(NEW.tenant_id::text || ':' || expected_source_event_key, 'UTF8'),
              'sha256'
            ),
            'hex'
          )::char(64)
       OR NEW.recipient_policy IS DISTINCT FROM expected_recipient_policy
       OR NEW.notification_intent->>'source_event_key'
            IS DISTINCT FROM expected_source_event_key
       OR NEW.notification_intent->'data'->>'source_event_key'
            IS DISTINCT FROM expected_source_event_key
       OR (
         NEW.supersedes_obligation_id IS NULL
         AND NEW.notification_intent->'data' ? 'supersedes_obligation_id'
       )
       OR (
         NEW.supersedes_obligation_id IS NOT NULL
         AND NEW.notification_intent->'data'->>'supersedes_obligation_id'
               IS DISTINCT FROM NEW.supersedes_obligation_id::text
       )
    THEN
      RAISE EXCEPTION 'clinical alert obligation identity, policy, or source-event contract is invalid'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.source_table = 'clinical_orders' THEN
      SELECT clinical_order.id, clinical_order.order_number,
              clinical_order.order_type, clinical_order.priority,
              clinical_order.patient_uid::text AS patient_uid,
              clinical_order.encounter_id::text AS encounter_id,
              clinical_order.ordered_by::text AS ordered_by
        INTO source_record
        FROM clinical_orders clinical_order
       WHERE clinical_order.tenant_id = NEW.tenant_id
         AND clinical_order.id::text = NEW.source_id
       FOR KEY SHARE;
      IF NOT FOUND
         OR source_record.patient_uid IS DISTINCT FROM NEW.patient_uid::text
         OR source_record.encounter_id IS DISTINCT FROM NEW.encounter_id::text
         OR source_record.ordered_by IS DISTINCT FROM NEW.origin_actor_uid::text
      THEN
        RAISE EXCEPTION 'clinical alert obligation source order is unavailable or mismatched'
          USING ERRCODE = '23514';
      END IF;

      expected_intent := jsonb_build_object(
        'type', 'push',
        'channel', 'push',
        'title', CASE NEW.failure_kind
          WHEN 'order_mar_schedule'
            THEN 'Medication order has NO scheduled MAR doses'
          ELSE 'ER medication did not carry into the ICU MAR'
        END,
        'body', CASE NEW.failure_kind
          WHEN 'order_mar_schedule' THEN
            'MAR scheduling FAILED for medication order '
              || source_record.order_number
              || ' — no doses are on the drug chart. Open the order and use Repair MAR; '
              || 'if the schedule definition is invalid, discontinue it and place a corrected CPOE order.'
          ELSE
            'ER-to-ICU MAR carryover FAILED for medication order '
              || source_record.order_number
              || '. Open the order and use Repair MAR; if the schedule definition is invalid, '
              || 'discontinue it and place a corrected CPOE order.'
        END,
        'source_event_key', NEW.source_event_key,
        'template_version', 'clinical-alert-order-integration-failure.v1',
        'data', jsonb_build_object(
          'source_event_key', NEW.source_event_key,
          'order_id', source_record.id,
          'order_number', source_record.order_number,
          'order_type', source_record.order_type,
          'priority', source_record.priority,
          'patient_uid', source_record.patient_uid,
          'failure_stage', CASE NEW.failure_kind
            WHEN 'order_mar_schedule' THEN 'mar_schedule'
            ELSE 'mar_carryover'
          END,
          'error_code', NEW.failure_code,
          'recovery_endpoint', '/api/v1/emr/orders/' || source_record.id::text
            || '/retry-mar-scheduling',
          'deep_link', '/emr/orders/' || source_record.patient_uid
            || '?mar_recovery_order=' || source_record.id::text,
          'requires_doctor_authority', TRUE
        ) || CASE
          WHEN NEW.supersedes_obligation_id IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'supersedes_obligation_id', NEW.supersedes_obligation_id::text
          )
        END
      );
    ELSE
      SELECT admission.id, admission.patient_uid::text AS patient_uid,
             visit.id AS emergency_visit_id,
             visit.patient_uid::text AS visit_patient_uid,
             visit.encounter_id::text AS encounter_id
        INTO source_record
        FROM icu_admissions admission
        JOIN emergency_visits visit
          ON visit.tenant_id = admission.tenant_id
         AND visit.id = admission.er_visit_id
       WHERE admission.tenant_id = NEW.tenant_id
         AND admission.id::text = NEW.source_id
       FOR KEY SHARE OF admission, visit;
      IF NOT FOUND
         OR source_record.patient_uid IS DISTINCT FROM source_record.visit_patient_uid
         OR source_record.patient_uid IS DISTINCT FROM NEW.patient_uid::text
         OR source_record.encounter_id IS DISTINCT FROM NEW.encounter_id::text
      THEN
        RAISE EXCEPTION 'clinical alert obligation ICU source is unavailable or mismatched'
          USING ERRCODE = '23514';
      END IF;

      expected_intent := jsonb_build_object(
        'type', 'push',
        'channel', 'push',
        'title', 'ICU MAR carryover could not inspect ER medication orders',
        'body', 'Review the patient''s active ER medication orders and repair any missing MAR schedule from the governed order screen.',
        'source_event_key', NEW.source_event_key,
        'template_version', 'clinical-alert-icu-mar-carryover-failure.v1',
        'data', jsonb_build_object(
          'source_event_key', NEW.source_event_key,
          'icu_admission_id', source_record.id,
          'emergency_visit_id', source_record.emergency_visit_id,
          'patient_uid', source_record.patient_uid,
          'encounter_id', source_record.encounter_id,
          'error_code', NEW.failure_code,
          'deep_link', '/emr/orders/' || source_record.patient_uid
            || '?icu_mar_review=' || source_record.id::text,
          'requires_doctor_authority', TRUE
        ) || CASE
          WHEN NEW.supersedes_obligation_id IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'supersedes_obligation_id', NEW.supersedes_obligation_id::text
          )
        END
      );
    END IF;

    IF NEW.notification_intent IS DISTINCT FROM expected_intent THEN
      RAISE EXCEPTION
        'clinical alert intent must be derived exactly from its current source'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clinical alert delivery obligations are retained evidence'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.obligation_key IS DISTINCT FROM NEW.obligation_key
     OR OLD.source_table IS DISTINCT FROM NEW.source_table
     OR OLD.source_id IS DISTINCT FROM NEW.source_id
     OR OLD.source_event_key IS DISTINCT FROM NEW.source_event_key
     OR OLD.failure_kind IS DISTINCT FROM NEW.failure_kind
     OR OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR OLD.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR OLD.origin_actor_uid IS DISTINCT FROM NEW.origin_actor_uid
     OR OLD.failure_code IS DISTINCT FROM NEW.failure_code
     OR OLD.recipient_policy IS DISTINCT FROM NEW.recipient_policy
     OR OLD.notification_intent IS DISTINCT FROM NEW.notification_intent
     OR OLD.supersedes_obligation_id IS DISTINCT FROM NEW.supersedes_obligation_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'clinical alert delivery obligation identity and intent are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('completed', 'manual_hold') THEN
    RAISE EXCEPTION 'clinical alert delivery obligation is terminal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'completed' THEN
    IF NEW.notification_intent->>'type' IS DISTINCT FROM 'push'
       OR NEW.notification_intent->>'channel' IS DISTINCT FROM 'push'
       OR BTRIM(COALESCE(NEW.notification_intent->>'title', '')) = ''
       OR BTRIM(COALESCE(NEW.notification_intent->>'body', '')) = ''
       OR NEW.notification_intent->>'source_event_key'
            IS DISTINCT FROM NEW.source_event_key
       OR BTRIM(COALESCE(NEW.notification_intent->>'template_version', '')) = ''
       OR jsonb_typeof(NEW.notification_intent->'data') IS DISTINCT FROM 'object'
    THEN
      RAISE EXCEPTION 'completed clinical alert obligation has no exact push intent'
        USING ERRCODE = '23514';
    END IF;

    WITH primary_recipients AS MATERIALIZED (
      SELECT candidate.uid, candidate.role
        FROM public.users candidate
       WHERE candidate.tenant_id = NEW.tenant_id
         AND candidate.role = NEW.recipient_policy->>'primary_role'
         AND candidate.is_active = TRUE
         AND COALESCE(candidate.is_deleted, FALSE) = FALSE
         AND candidate.deleted_at IS NULL
         AND LOWER(COALESCE(candidate.status, 'active')) = 'active'
       ORDER BY candidate.last_sign_in_at DESC NULLS LAST, candidate.id ASC
       LIMIT 500
    ), fallback_recipients AS MATERIALIZED (
      SELECT candidate.uid, candidate.role
        FROM public.users candidate
       WHERE candidate.tenant_id = NEW.tenant_id
         AND candidate.role IN (
           SELECT jsonb_array_elements_text(
             NEW.recipient_policy->'fallback_roles'
           )
         )
         AND candidate.is_active = TRUE
         AND COALESCE(candidate.is_deleted, FALSE) = FALSE
         AND candidate.deleted_at IS NULL
         AND LOWER(COALESCE(candidate.status, 'active')) = 'active'
       ORDER BY candidate.last_sign_in_at DESC NULLS LAST, candidate.id ASC
       LIMIT 500
    ), selected_recipients AS MATERIALIZED (
      SELECT primary_recipient.uid, primary_recipient.role
        FROM primary_recipients primary_recipient
      UNION ALL
      SELECT fallback_recipient.uid, fallback_recipient.role
        FROM fallback_recipients fallback_recipient
       WHERE NOT EXISTS (SELECT 1 FROM primary_recipients)
    )
    SELECT COUNT(*),
           COUNT(DISTINCT outbox.id),
           COUNT(DISTINCT outbox.recipient_id),
           (SELECT COUNT(*) FROM selected_recipients)
      INTO matching_outbox_count,
           distinct_outbox_count,
           distinct_recipient_count,
           expected_recipient_count
      FROM public.notification_outbox outbox
      JOIN public.users recipient
        ON recipient.tenant_id = outbox.tenant_id
       AND recipient.uid::text = outbox.recipient_id
       AND recipient.role = outbox.payload->>'recipient_role'
       AND recipient.role IN (
         'DOCTOR',
         'DUTY_DOCTOR',
         'CONSULTANT',
         'JUNIOR_DOCTOR',
         'RESIDENT'
       )
       AND recipient.is_active = TRUE
       AND COALESCE(recipient.is_deleted, FALSE) = FALSE
       AND recipient.deleted_at IS NULL
       AND LOWER(COALESCE(recipient.status, 'active')) = 'active'
      JOIN selected_recipients selected
        ON selected.uid = recipient.uid
       AND selected.role = recipient.role
     WHERE outbox.tenant_id = NEW.tenant_id
       AND outbox.id = ANY(NEW.completion_notification_outbox_ids)
       AND outbox.recipient_id = ANY(NEW.completion_recipient_ids)
       AND outbox.type = NEW.notification_intent->>'type'
       AND outbox.channel = NEW.notification_intent->>'channel'
       AND outbox.title = NEW.notification_intent->>'title'
       AND outbox.body = NEW.notification_intent->>'body'
       AND outbox.source_event_key = NEW.source_event_key
       AND outbox.template_version = NEW.notification_intent->>'template_version'
       AND COALESCE(outbox.payload, '{}'::jsonb) @>
             (NEW.notification_intent->'data');

    IF matching_outbox_count <> cardinality(NEW.completion_notification_outbox_ids)
       OR distinct_outbox_count <> cardinality(NEW.completion_notification_outbox_ids)
       OR distinct_recipient_count <> cardinality(NEW.completion_recipient_ids)
       OR distinct_recipient_count <> expected_recipient_count
       OR NEW.completion_evidence->>'recovery_source'
            IS DISTINCT FROM 'clinical-alert-delivery-obligation-recovery.v1'
    THEN
      RAISE EXCEPTION 'clinical alert obligation completion lacks exact outbox evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER clinical_alert_delivery_obligation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.clinical_alert_delivery_obligations
  FOR EACH ROW EXECUTE FUNCTION public.clinical_alert_delivery_obligation_guard();

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_assert_canonical_evidence(
  p_tenant_id UUID,
  p_obligation_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  obligation clinical_alert_delivery_obligations%ROWTYPE;
  base_source_key TEXT;
  expected_action TEXT;
  expected_stage TEXT;
BEGIN
  SELECT current_obligation.*
    INTO obligation
    FROM clinical_alert_delivery_obligations current_obligation
   WHERE current_obligation.tenant_id = p_tenant_id
     AND current_obligation.id = p_obligation_id;
  IF NOT FOUND OR obligation.supersedes_obligation_id IS NOT NULL THEN
    RETURN;
  END IF;

  IF obligation.source_table = 'clinical_orders' THEN
    expected_stage := CASE obligation.failure_kind
      WHEN 'order_mar_schedule' THEN 'mar_schedule'
      ELSE 'mar_carryover'
    END;
    expected_action := CASE obligation.failure_kind
      WHEN 'order_mar_schedule' THEN 'mar_scheduling_failed'
      ELSE 'mar_carryover_failed'
    END;
    base_source_key := 'clinical_orders:' || obligation.source_id || ':'
      || expected_stage || '_failed';

    IF NOT EXISTS (
      SELECT 1
        FROM clinical_audit_events audit
       WHERE audit.tenant_id = obligation.tenant_id
         AND audit.patient_uid IS NOT DISTINCT FROM obligation.patient_uid
         AND audit.encounter_id IS NOT DISTINCT FROM obligation.encounter_id
         AND audit.actor_uid IS NOT DISTINCT FROM obligation.origin_actor_uid
         AND audit.action = expected_action
         AND audit.action_status = 'failed'
         AND audit.resource_type = 'clinical_order'
         AND audit.resource_table = 'clinical_orders'
         AND audit.resource_id = obligation.source_id
         AND audit.idempotency_key = base_source_key
         AND audit.metadata->>'failure_stage' = expected_stage
         AND audit.metadata->>'alert_queued' = 'false'
         AND audit.metadata->>'alert_recovery_obligation_id' = obligation.id::text
    ) THEN
      RAISE EXCEPTION 'initial clinical alert obligation lacks canonical order-failure evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  base_source_key := 'icu_admissions:' || obligation.source_id
    || ':icu.mar_carryover_failed';
  IF NOT EXISTS (
    SELECT 1
      FROM clinical_timeline_events timeline
     WHERE timeline.tenant_id = obligation.tenant_id
       AND timeline.patient_uid IS NOT DISTINCT FROM obligation.patient_uid
       AND timeline.encounter_id IS NOT DISTINCT FROM obligation.encounter_id
       AND timeline.actor_uid IS NOT DISTINCT FROM obligation.origin_actor_uid
       AND timeline.event_type = 'icu.mar_carryover_failed'
       AND timeline.event_status = 'action_required'
       AND timeline.source_table = 'icu_admissions'
       AND timeline.source_id = obligation.source_id
       AND timeline.resource_type = 'icu_admission'
       AND timeline.resource_id = obligation.source_id
       AND timeline.idempotency_key = base_source_key
       AND timeline.payload->>'alert_queued' = 'false'
       AND timeline.payload->>'alert_recovery_obligation_id' = obligation.id::text
  ) OR NOT EXISTS (
    SELECT 1
      FROM clinical_audit_events audit
     WHERE audit.tenant_id = obligation.tenant_id
       AND audit.patient_uid IS NOT DISTINCT FROM obligation.patient_uid
       AND audit.encounter_id IS NOT DISTINCT FROM obligation.encounter_id
       AND audit.actor_uid IS NOT DISTINCT FROM obligation.origin_actor_uid
       AND audit.action = 'icu_mar_carryover_failed'
       AND audit.action_status = 'failed'
       AND audit.resource_type = 'icu_admission'
       AND audit.resource_table = 'icu_admissions'
       AND audit.resource_id = obligation.source_id
       AND audit.idempotency_key = base_source_key || ':audit'
       AND audit.metadata->>'alert_queued' = 'false'
       AND audit.metadata->>'alert_recovery_obligation_id' = obligation.id::text
  ) THEN
    RAISE EXCEPTION 'initial clinical alert obligation lacks canonical ICU-failure evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN;
END
$fn$;

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_obligation_evidence_constraint()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM public.clinical_alert_delivery_assert_canonical_evidence(
    NEW.tenant_id,
    NEW.id
  );
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_obligation_evidence_constraint
  AFTER INSERT OR UPDATE OF
    tenant_id,
    source_table,
    source_id,
    failure_kind,
    patient_uid,
    encounter_id,
    origin_actor_uid,
    supersedes_obligation_id
  ON public.clinical_alert_delivery_obligations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_obligation_evidence_constraint();

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_canonical_evidence_constraint()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  old_tenant_id UUID;
  new_tenant_id UUID;
  old_obligation_id BIGINT;
  new_obligation_id BIGINT;
  old_reference TEXT;
  new_reference TEXT;
BEGIN
  IF TG_TABLE_NAME = 'clinical_audit_events' THEN
    IF TG_OP <> 'INSERT' THEN
      old_tenant_id := OLD.tenant_id;
      old_reference := OLD.metadata->>'alert_recovery_obligation_id';
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_tenant_id := NEW.tenant_id;
      new_reference := NEW.metadata->>'alert_recovery_obligation_id';
    END IF;
  ELSIF TG_TABLE_NAME = 'clinical_timeline_events' THEN
    IF TG_OP <> 'INSERT' THEN
      old_tenant_id := OLD.tenant_id;
      old_reference := OLD.payload->>'alert_recovery_obligation_id';
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_tenant_id := NEW.tenant_id;
      new_reference := NEW.payload->>'alert_recovery_obligation_id';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported clinical alert canonical evidence source'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(old_reference, '') ~ '^[1-9][0-9]*$' THEN
    old_obligation_id := old_reference::bigint;
    PERFORM public.clinical_alert_delivery_assert_canonical_evidence(
      old_tenant_id,
      old_obligation_id
    );
  END IF;
  IF COALESCE(new_reference, '') ~ '^[1-9][0-9]*$' THEN
    new_obligation_id := new_reference::bigint;
    IF new_tenant_id IS DISTINCT FROM old_tenant_id
       OR new_obligation_id IS DISTINCT FROM old_obligation_id
    THEN
      PERFORM public.clinical_alert_delivery_assert_canonical_evidence(
        new_tenant_id,
        new_obligation_id
      );
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_audit_evidence_constraint
  AFTER INSERT OR UPDATE OR DELETE ON public.clinical_audit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_canonical_evidence_constraint();

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_timeline_evidence_constraint
  AFTER INSERT OR UPDATE OR DELETE ON public.clinical_timeline_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_canonical_evidence_constraint();

ALTER TABLE public.clinical_alert_delivery_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_alert_delivery_obligations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.clinical_alert_delivery_obligations
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  );

CREATE POLICY explicit_tenant_context ON public.clinical_alert_delivery_obligations
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  );

INSERT INTO public.workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, enabled, metadata)
VALUES
  (NULL, 'clinical_alert_delivery_manual_hold_review',
   'Clinical alert delivery manual-hold review',
   'clinical_alert.delivery_manual_hold', 15, 'critical',
   ARRAY['ADMIN']::TEXT[], ARRAY['SUPER_ADMIN']::TEXT[], TRUE,
   '{"task_contract":"clinical_alert_delivery_recovery_v1","case_kind":"manual_hold"}'::jsonb),
  (NULL, 'clinical_alert_delivery_recipient_coverage',
   'Clinical alert recipient coverage restoration',
   'clinical_alert.delivery_no_recipient', 15, 'critical',
   ARRAY['ADMIN']::TEXT[], ARRAY['SUPER_ADMIN']::TEXT[], TRUE,
   '{"task_contract":"clinical_alert_delivery_recovery_v1","case_kind":"recipient_coverage"}'::jsonb)
ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), rule_code)
DO UPDATE SET
  title = EXCLUDED.title,
  trigger_event_type = EXCLUDED.trigger_event_type,
  target_minutes = EXCLUDED.target_minutes,
  severity = EXCLUDED.severity,
  owner_role_codes = EXCLUDED.owner_role_codes,
  escalation_role_codes = EXCLUDED.escalation_role_codes,
  enabled = TRUE,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

CREATE TABLE public.clinical_alert_delivery_recovery_cases (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  obligation_id BIGINT NOT NULL,
  case_kind VARCHAR(40) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  workflow_sla_instance_id UUID NOT NULL,
  task_id INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  first_observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  due_at TIMESTAMPTZ(6) NOT NULL,
  escalation_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_escalation_attempt_at TIMESTAMPTZ(6),
  last_escalation_error_code VARCHAR(120),
  escalated_at TIMESTAMPTZ(6),
  resolution_kind VARCHAR(40),
  resolution_action_id BIGINT,
  replacement_obligation_id BIGINT,
  resolved_by_uid UUID,
  resolution_reason TEXT,
  resolution_evidence JSONB,
  resolved_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_clinical_alert_delivery_recovery_cases_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_alert_delivery_recovery_cases_obligation_kind
    UNIQUE (tenant_id, obligation_id, case_kind),
  CONSTRAINT ux_alert_recovery_case_task
    UNIQUE (tenant_id, task_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ux_alert_recovery_case_sla
    UNIQUE (tenant_id, workflow_sla_instance_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_clinical_alert_delivery_recovery_cases_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT fk_clinical_alert_delivery_recovery_cases_obligation
    FOREIGN KEY (tenant_id, obligation_id)
    REFERENCES public.clinical_alert_delivery_obligations (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_alert_delivery_recovery_cases_sla
    FOREIGN KEY (tenant_id, workflow_sla_instance_id)
    REFERENCES public.workflow_sla_instances (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_alert_delivery_recovery_cases_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES public.tasks (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_alert_delivery_recovery_cases_replacement
    FOREIGN KEY (tenant_id, replacement_obligation_id)
    REFERENCES public.clinical_alert_delivery_obligations (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_clinical_alert_delivery_recovery_case_kind
    CHECK (case_kind IN ('manual_hold', 'recipient_coverage')),
  CONSTRAINT chk_clinical_alert_delivery_recovery_case_counts
    CHECK (observation_count > 0 AND escalation_attempt_count >= 0),
  CONSTRAINT chk_clinical_alert_delivery_recovery_case_status
    CHECK (status IN ('open', 'resolved')),
  CONSTRAINT chk_clinical_alert_delivery_recovery_case_evidence
    CHECK (
      resolution_evidence IS NULL
      OR jsonb_typeof(resolution_evidence) = 'object'
    ),
  CONSTRAINT chk_clinical_alert_delivery_recovery_case_terminal_shape
    CHECK (
      (
        status = 'open'
        AND resolution_kind IS NULL
        AND resolution_action_id IS NULL
        AND replacement_obligation_id IS NULL
        AND resolved_by_uid IS NULL
        AND resolution_reason IS NULL
        AND resolution_evidence IS NULL
        AND resolved_at IS NULL
      )
      OR (
        status = 'resolved'
        AND resolution_kind IN ('recovered', 'manual_hold', 'superseded')
        AND resolution_action_id IS NOT NULL
        AND (
          (resolution_kind = 'superseded' AND replacement_obligation_id IS NOT NULL)
          OR (resolution_kind <> 'superseded' AND replacement_obligation_id IS NULL)
        )
        AND resolution_reason IS NOT NULL
        AND BTRIM(resolution_reason) <> ''
        AND resolution_evidence IS NOT NULL
        AND resolved_at IS NOT NULL
      )
    )
);

CREATE INDEX idx_clinical_alert_delivery_recovery_cases_workbench
  ON public.clinical_alert_delivery_recovery_cases
    (tenant_id, status, due_at, id);

CREATE INDEX idx_clinical_alert_delivery_recovery_cases_task
  ON public.clinical_alert_delivery_recovery_cases
    (tenant_id, task_id);

CREATE TABLE public.clinical_alert_delivery_recovery_actions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  case_id BIGINT NOT NULL,
  action_type VARCHAR(48) NOT NULL,
  actor_uid UUID,
  operator_reason TEXT NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  command_sha256 CHAR(64) NOT NULL,
  request_id VARCHAR(120),
  outcome VARCHAR(40) NOT NULL,
  response_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_clinical_alert_delivery_recovery_actions_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_alert_delivery_recovery_actions_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_clinical_alert_delivery_recovery_actions_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT fk_clinical_alert_delivery_recovery_actions_case
    FOREIGN KEY (tenant_id, case_id)
    REFERENCES public.clinical_alert_delivery_recovery_cases (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_clinical_alert_delivery_recovery_action_type
    CHECK (action_type IN (
      'retry_delivery',
      'supersede_from_source',
      'system_delivery_recovered',
      'system_manual_hold'
    )),
  CONSTRAINT chk_clinical_alert_delivery_recovery_action_actor
    CHECK (
      (action_type IN ('retry_delivery', 'supersede_from_source') AND actor_uid IS NOT NULL)
      OR (action_type IN ('system_delivery_recovered', 'system_manual_hold') AND actor_uid IS NULL)
    ),
  CONSTRAINT chk_clinical_alert_delivery_recovery_action_reason
    CHECK (char_length(BTRIM(operator_reason)) BETWEEN 10 AND 1000),
  CONSTRAINT chk_clinical_alert_delivery_recovery_action_idempotency
    CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  CONSTRAINT chk_clinical_alert_delivery_recovery_action_command
    CHECK (command_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_clinical_alert_delivery_recovery_action_outcome
    CHECK (
      (action_type = 'retry_delivery'
        AND outcome IN ('recovered', 'awaiting_recipients', 'manual_hold'))
      OR (action_type = 'supersede_from_source' AND outcome = 'superseded')
      OR (action_type = 'system_delivery_recovered' AND outcome = 'recovered')
      OR (action_type = 'system_manual_hold' AND outcome = 'manual_hold')
    ),
  CONSTRAINT chk_clinical_alert_delivery_recovery_action_response
    CHECK (jsonb_typeof(response_payload) = 'object')
);

ALTER TABLE public.clinical_alert_delivery_recovery_cases
  ADD CONSTRAINT fk_clinical_alert_delivery_recovery_cases_resolution_action
  FOREIGN KEY (tenant_id, resolution_action_id)
  REFERENCES public.clinical_alert_delivery_recovery_actions (tenant_id, id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX idx_clinical_alert_delivery_recovery_actions_case
  ON public.clinical_alert_delivery_recovery_actions
    (tenant_id, case_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_action_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  recovery_case clinical_alert_delivery_recovery_cases%ROWTYPE;
  obligation_record clinical_alert_delivery_obligations%ROWTYPE;
  replacement_record clinical_alert_delivery_obligations%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.action_type IN ('retry_delivery', 'supersede_from_source')
       AND NOT EXISTS (
         SELECT 1
           FROM users actor
          WHERE actor.tenant_id = NEW.tenant_id
            AND actor.uid = NEW.actor_uid
            AND actor.role IN ('ADMIN', 'SUPER_ADMIN')
            AND actor.is_active = TRUE
            AND COALESCE(actor.is_deleted, FALSE) = FALSE
            AND actor.deleted_at IS NULL
            AND LOWER(COALESCE(actor.status, 'active')) = 'active'
       )
    THEN
      RAISE EXCEPTION 'clinical alert recovery operator must be an active platform administrator'
        USING ERRCODE = '23514';
    END IF;

    SELECT recovery.*
      INTO recovery_case
      FROM clinical_alert_delivery_recovery_cases recovery
     WHERE recovery.tenant_id = NEW.tenant_id
       AND recovery.id = NEW.case_id
       AND recovery.status = 'open';
    SELECT obligation.*
      INTO obligation_record
      FROM clinical_alert_delivery_obligations obligation
     WHERE obligation.tenant_id = NEW.tenant_id
       AND obligation.id = recovery_case.obligation_id;

    IF recovery_case.id IS NULL
       OR obligation_record.id IS NULL
       OR NEW.response_payload->>'case_id' IS DISTINCT FROM NEW.case_id::text
       OR NEW.response_payload->>'obligation_id'
            IS DISTINCT FROM recovery_case.obligation_id::text
       OR NEW.response_payload->>'outcome' IS DISTINCT FROM NEW.outcome
       OR NEW.action_type IN (
            'retry_delivery',
            'system_delivery_recovered',
            'system_manual_hold'
          ) AND recovery_case.case_kind IS DISTINCT FROM 'recipient_coverage'
       OR NEW.action_type = 'supersede_from_source'
            AND recovery_case.case_kind IS DISTINCT FROM 'manual_hold'
       OR NEW.outcome = 'recovered'
            AND obligation_record.status IS DISTINCT FROM 'completed'
       OR NEW.outcome = 'manual_hold'
            AND obligation_record.status IS DISTINCT FROM 'manual_hold'
       OR NEW.outcome = 'awaiting_recipients' AND (
            obligation_record.status IS DISTINCT FROM 'pending'
            OR obligation_record.last_error_code
                 IS DISTINCT FROM 'no_active_clinical_recipients'
          )
    THEN
      RAISE EXCEPTION 'clinical alert recovery action does not match its open case and obligation'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.outcome = 'superseded' THEN
      SELECT replacement.*
        INTO replacement_record
        FROM clinical_alert_delivery_obligations replacement
       WHERE replacement.tenant_id = NEW.tenant_id
         AND replacement.id::text =
               NEW.response_payload->>'replacement_obligation_id';
      IF obligation_record.status IS DISTINCT FROM 'manual_hold'
         OR replacement_record.id IS NULL
         OR replacement_record.supersedes_obligation_id
              IS DISTINCT FROM recovery_case.obligation_id
      THEN
        RAISE EXCEPTION 'clinical alert supersession action lacks its exact replacement obligation'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'clinical alert recovery actions are append-only evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER clinical_alert_delivery_recovery_action_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.clinical_alert_delivery_recovery_actions
  FOR EACH ROW EXECUTE FUNCTION public.clinical_alert_delivery_recovery_action_guard();

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_case_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  action_record clinical_alert_delivery_recovery_actions%ROWTYPE;
  obligation_record clinical_alert_delivery_obligations%ROWTYPE;
  replacement_record clinical_alert_delivery_obligations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clinical alert recovery cases are retained evidence'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.obligation_id IS DISTINCT FROM NEW.obligation_id
     OR OLD.case_kind IS DISTINCT FROM NEW.case_kind
     OR OLD.workflow_sla_instance_id IS DISTINCT FROM NEW.workflow_sla_instance_id
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.first_observed_at IS DISTINCT FROM NEW.first_observed_at
     OR OLD.due_at IS DISTINCT FROM NEW.due_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'clinical alert recovery case identity and clocks are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'clinical alert recovery case is terminal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.observation_count < OLD.observation_count
     OR NEW.escalation_attempt_count < OLD.escalation_attempt_count
     OR NEW.last_observed_at < OLD.last_observed_at
  THEN
    RAISE EXCEPTION 'clinical alert recovery observation evidence cannot move backward'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.escalated_at IS NOT NULL
     AND (
       NEW.escalated_at IS DISTINCT FROM OLD.escalated_at
       OR NEW.escalation_attempt_count IS DISTINCT FROM OLD.escalation_attempt_count
       OR NEW.last_escalation_attempt_at
            IS DISTINCT FROM OLD.last_escalation_attempt_at
       OR NEW.last_escalation_error_code
            IS DISTINCT FROM OLD.last_escalation_error_code
     )
  THEN
    RAISE EXCEPTION 'clinical alert recovery escalation snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'resolved' THEN
    SELECT obligation.*
      INTO obligation_record
      FROM clinical_alert_delivery_obligations obligation
     WHERE obligation.tenant_id = NEW.tenant_id
       AND obligation.id = NEW.obligation_id;
    SELECT action.*
      INTO action_record
      FROM clinical_alert_delivery_recovery_actions action
     WHERE action.tenant_id = NEW.tenant_id
       AND action.id = NEW.resolution_action_id
       AND action.case_id = NEW.id;
    IF obligation_record.id IS NULL
       OR action_record.id IS NULL
       OR action_record.actor_uid IS DISTINCT FROM NEW.resolved_by_uid
       OR action_record.operator_reason IS DISTINCT FROM NEW.resolution_reason
       OR action_record.outcome IS DISTINCT FROM NEW.resolution_kind
       OR action_record.response_payload IS DISTINCT FROM NEW.resolution_evidence
       OR action_record.response_payload->>'case_id' IS DISTINCT FROM NEW.id::text
       OR action_record.response_payload->>'obligation_id'
            IS DISTINCT FROM NEW.obligation_id::text
       OR action_record.response_payload->>'outcome'
            IS DISTINCT FROM NEW.resolution_kind
    THEN
      RAISE EXCEPTION 'clinical alert recovery resolution lacks its exact action receipt'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.case_kind = 'manual_hold' THEN
      IF NEW.resolution_kind IS DISTINCT FROM 'superseded'
         OR action_record.action_type IS DISTINCT FROM 'supersede_from_source'
         OR obligation_record.status IS DISTINCT FROM 'manual_hold'
      THEN
        RAISE EXCEPTION 'manual-hold clinical alert recovery can resolve only by governed supersession'
          USING ERRCODE = '23514';
      END IF;

      SELECT obligation.*
        INTO replacement_record
        FROM clinical_alert_delivery_obligations obligation
       WHERE obligation.tenant_id = NEW.tenant_id
         AND obligation.id = NEW.replacement_obligation_id;
       IF replacement_record.id IS NULL
          OR replacement_record.supersedes_obligation_id
               IS DISTINCT FROM NEW.obligation_id
          OR action_record.response_payload->>'replacement_obligation_id'
               IS DISTINCT FROM NEW.replacement_obligation_id::text
       THEN
        RAISE EXCEPTION 'clinical alert recovery replacement does not supersede its held obligation'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.case_kind = 'recipient_coverage' THEN
      IF NEW.resolution_kind = 'recovered' AND (
           obligation_record.status IS DISTINCT FROM 'completed'
           OR action_record.action_type NOT IN (
             'retry_delivery',
             'system_delivery_recovered'
           )
         )
         OR NEW.resolution_kind = 'manual_hold' AND (
           obligation_record.status IS DISTINCT FROM 'manual_hold'
           OR action_record.action_type NOT IN ('retry_delivery', 'system_manual_hold')
         )
         OR NEW.resolution_kind NOT IN ('recovered', 'manual_hold')
      THEN
        RAISE EXCEPTION 'recipient-coverage clinical alert recovery does not match its terminal obligation'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'clinical alert recovery case kind is unsupported'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER clinical_alert_delivery_recovery_case_guard
  BEFORE UPDATE OR DELETE ON public.clinical_alert_delivery_recovery_cases
  FOR EACH ROW EXECUTE FUNCTION public.clinical_alert_delivery_recovery_case_guard();

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_task_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  sla_record workflow_sla_instances%ROWTYPE;
  metadata_value JSONB := COALESCE(NEW.metadata, '{}'::jsonb);
  expected_rule_code TEXT;
BEGIN
  IF metadata_value->>'task_contract'
       IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
     OR NEW.task_kind IS DISTINCT FROM 'escalation'
     OR NEW.priority IS DISTINCT FROM 'critical'
     OR NEW.workflow_run_id IS NOT NULL
     OR NEW.workflow_step_id IS NOT NULL
     OR NEW.cancelled_at IS NOT NULL
     OR NEW.cancellation_reason IS NOT NULL
     OR NEW.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR NEW.workflow_sla_instance_id IS NULL
     OR NEW.related_resource_type
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
     OR NULLIF(BTRIM(NEW.related_resource_id), '') IS NULL
     OR COALESCE(metadata_value->>'obligation_id', '') !~ '^[1-9][0-9]*$'
     OR COALESCE(metadata_value->>'case_kind', '')
          NOT IN ('manual_hold', 'recipient_coverage')
     OR metadata_value->>'assignment_origin'
          IS DISTINCT FROM 'admin_coverage_queue'
     OR metadata_value ?| ARRAY[
       'acknowledged_at',
       'acknowledged_by',
       'acknowledged_via',
       'acknowledgement_receipt_repaired',
       'previous_acknowledged_at',
       'acknowledgement_receipt_repaired_from'
     ]
  THEN
    RAISE EXCEPTION 'clinical alert recovery task contract is invalid'
      USING ERRCODE = '23514';
  END IF;

  expected_rule_code := CASE metadata_value->>'case_kind'
    WHEN 'manual_hold' THEN 'clinical_alert_delivery_manual_hold_review'
    ELSE 'clinical_alert_delivery_recipient_coverage'
  END;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = NEW.workflow_sla_instance_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR sla_record.rule_code IS DISTINCT FROM expected_rule_code
     OR sla_record.priority IS DISTINCT FROM 'critical'
     OR sla_record.source_table
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
     OR sla_record.source_id IS DISTINCT FROM NEW.related_resource_id
     OR sla_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR sla_record.due_at IS NULL
     OR (
       NEW.sla_breached_at IS NOT NULL
       AND (
         sla_record.breached_at IS NULL
         OR date_trunc('milliseconds', NEW.sla_breached_at)
              IS DISTINCT FROM date_trunc('milliseconds', sla_record.breached_at)
       )
     )
     OR NEW.encounter_id IS NOT NULL
     OR NULLIF(LOWER(BTRIM(metadata_value->>'canonical_encounter_id')), '')
          IS DISTINCT FROM sla_record.encounter_id::text
  THEN
    RAISE EXCEPTION 'clinical alert recovery task and SLA source do not match'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     AND (NEW.assigned_to_uid IS NOT NULL OR NEW.assigned_to_role IS DISTINCT FROM 'ADMIN')
  THEN
    RAISE EXCEPTION 'clinical alert recovery task must start in the admin queue'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'blocked' THEN
    RAISE EXCEPTION 'clinical alert recovery tasks cannot enter an unroutable blocked state'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('open', 'in_progress', 'overdue')
     AND (
       NEW.completed_at IS NOT NULL
       OR sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION 'actionable clinical alert recovery task requires an open SLA'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_sla_instance_id IS DISTINCT FROM NEW.workflow_sla_instance_id
  THEN
    RAISE EXCEPTION 'clinical alert recovery task SLA binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.metadata->>'assignment_origin'
          IS DISTINCT FROM metadata_value->>'assignment_origin'
  THEN
    RAISE EXCEPTION 'clinical alert recovery assignment origin is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.status = 'cancelled'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION 'clinical alert recovery task cannot be cancelled while unresolved'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.status = 'completed'
     AND OLD.status IS DISTINCT FROM 'completed'
     AND NOT EXISTS (
       SELECT 1
         FROM clinical_alert_delivery_recovery_cases recovery
        WHERE recovery.tenant_id = NEW.tenant_id
          AND recovery.id::text = NEW.related_resource_id
          AND recovery.task_id = NEW.id
          AND recovery.status = 'resolved'
          AND recovery.resolution_action_id IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'clinical alert recovery task completion requires resolution evidence'
      USING ERRCODE = '23514';
  END IF;

  NEW.due_at := sla_record.due_at;
  NEW.metadata := metadata_value
    || jsonb_build_object(
         'sla_instance_id', sla_record.id::text,
         'sla_key', sla_record.rule_code
       );
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_insert ON public.tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_insert
  BEFORE INSERT ON public.tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') NOT IN (
    'ward_medication_obligation_v1',
    'mar_medication_exception_v1',
    'clinical_alert_delivery_recovery_v1'
  ))
  EXECUTE FUNCTION public.tasks_sync_workflow_sla_compat();

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_update ON public.tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_update
  BEFORE UPDATE OF
    tenant_id,
    status,
    workflow_step_id,
    related_resource_type,
    related_resource_id,
    workflow_sla_instance_id,
    sla_completion_semantics,
    due_at,
    metadata
  ON public.tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') NOT IN (
    'ward_medication_obligation_v1',
    'mar_medication_exception_v1',
    'clinical_alert_delivery_recovery_v1'
  ))
  EXECUTE FUNCTION public.tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_clinical_alert_insert
  BEFORE INSERT ON public.tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'clinical_alert_delivery_recovery_v1')
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_task_sync();

CREATE TRIGGER trg_tasks_workflow_sla_compat_clinical_alert_update
  BEFORE UPDATE OF
    tenant_id,
    task_kind,
    priority,
    status,
    completed_at,
    cancelled_at,
    cancellation_reason,
    sla_breached_at,
    workflow_run_id,
    workflow_step_id,
    encounter_id,
    related_resource_type,
    related_resource_id,
    workflow_sla_instance_id,
    sla_completion_semantics,
    due_at,
    metadata,
    assigned_to_uid,
    assigned_to_role
  ON public.tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'clinical_alert_delivery_recovery_v1')
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_task_sync();

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_assert_recipient_coverage_gap(
  target_tenant_id UUID,
  target_obligation_id BIGINT
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  obligation_record clinical_alert_delivery_obligations%ROWTYPE;
BEGIN
  SELECT obligation.*
    INTO obligation_record
    FROM clinical_alert_delivery_obligations obligation
   WHERE obligation.tenant_id = target_tenant_id
     AND obligation.id = target_obligation_id;

  IF obligation_record.id IS NULL
     OR obligation_record.status IS DISTINCT FROM 'pending'
     OR obligation_record.last_error_code
          IS DISTINCT FROM 'no_active_clinical_recipients'
  THEN
    RAISE EXCEPTION 'recipient-coverage case has no matching pending obligation'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH primary_recipients AS MATERIALIZED (
      SELECT candidate.uid
        FROM users candidate
       WHERE candidate.tenant_id = target_tenant_id
         AND candidate.role = obligation_record.recipient_policy->>'primary_role'
         AND candidate.is_active = TRUE
         AND COALESCE(candidate.is_deleted, FALSE) = FALSE
         AND candidate.deleted_at IS NULL
         AND LOWER(COALESCE(candidate.status, 'active')) = 'active'
       ORDER BY candidate.last_sign_in_at DESC NULLS LAST, candidate.id ASC
       LIMIT 500
    ), fallback_recipients AS MATERIALIZED (
      SELECT candidate.uid
        FROM users candidate
       WHERE candidate.tenant_id = target_tenant_id
         AND candidate.role IN (
           SELECT jsonb_array_elements_text(
             obligation_record.recipient_policy->'fallback_roles'
           )
         )
         AND candidate.is_active = TRUE
         AND COALESCE(candidate.is_deleted, FALSE) = FALSE
         AND candidate.deleted_at IS NULL
         AND LOWER(COALESCE(candidate.status, 'active')) = 'active'
       ORDER BY candidate.last_sign_in_at DESC NULLS LAST, candidate.id ASC
       LIMIT 500
    ), selected_recipients AS MATERIALIZED (
      SELECT primary_recipient.uid
        FROM primary_recipients primary_recipient
      UNION ALL
      SELECT fallback_recipient.uid
        FROM fallback_recipients fallback_recipient
       WHERE NOT EXISTS (SELECT 1 FROM primary_recipients)
    )
    SELECT 1 FROM selected_recipients
  ) THEN
    RAISE EXCEPTION 'open recipient-coverage case has an eligible clinical recipient'
      USING ERRCODE = '23514';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_task_case_constraint()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  recovery_case clinical_alert_delivery_recovery_cases%ROWTYPE;
  obligation_record clinical_alert_delivery_obligations%ROWTYPE;
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  action_record clinical_alert_delivery_recovery_actions%ROWTYPE;
  replacement_record clinical_alert_delivery_obligations%ROWTYPE;
  expected_rule_code TEXT;
  expected_escalation_recipient_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'clinical_alert_delivery_recovery_cases' THEN
    SELECT recovery.*
      INTO recovery_case
      FROM clinical_alert_delivery_recovery_cases recovery
     WHERE recovery.tenant_id = NEW.tenant_id
       AND recovery.id::text = NEW.id::text;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP = 'INSERT'
       AND NEW.metadata->>'task_contract'
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
       AND NEW.related_resource_type
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
    THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.metadata->>'task_contract'
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
       AND NEW.related_resource_type
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
       AND OLD.metadata->>'task_contract'
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
       AND OLD.related_resource_type
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
    THEN
      RETURN NULL;
    END IF;
    SELECT recovery.*
      INTO recovery_case
      FROM clinical_alert_delivery_recovery_cases recovery
     WHERE recovery.tenant_id = NEW.tenant_id
       AND recovery.task_id::text = NEW.id::text;
  ELSIF TG_TABLE_NAME = 'workflow_sla_instances' THEN
    IF TG_OP = 'INSERT'
       AND COALESCE(NEW.rule_code, '') NOT IN (
         'clinical_alert_delivery_manual_hold_review',
         'clinical_alert_delivery_recipient_coverage'
       )
    THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE'
       AND COALESCE(NEW.rule_code, '') NOT IN (
         'clinical_alert_delivery_manual_hold_review',
         'clinical_alert_delivery_recipient_coverage'
       )
       AND COALESCE(OLD.rule_code, '') NOT IN (
         'clinical_alert_delivery_manual_hold_review',
         'clinical_alert_delivery_recipient_coverage'
       )
    THEN
      RETURN NULL;
    END IF;
    SELECT recovery.*
      INTO recovery_case
      FROM clinical_alert_delivery_recovery_cases recovery
     WHERE recovery.tenant_id = NEW.tenant_id
       AND recovery.workflow_sla_instance_id::text = NEW.id::text;
  ELSE
    RAISE EXCEPTION 'unsupported clinical alert recovery constraint source'
      USING ERRCODE = '23514';
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinical alert recovery obligation has no durable recovery case'
      USING ERRCODE = '23514';
  END IF;

  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = recovery_case.tenant_id
     AND task.id = recovery_case.task_id;
  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = recovery_case.tenant_id
     AND sla.id = recovery_case.workflow_sla_instance_id;
  SELECT obligation.*
    INTO obligation_record
    FROM clinical_alert_delivery_obligations obligation
   WHERE obligation.tenant_id = recovery_case.tenant_id
     AND obligation.id = recovery_case.obligation_id;

  IF recovery_case.status = 'open'
     AND recovery_case.case_kind = 'recipient_coverage'
  THEN
    PERFORM public.clinical_alert_delivery_assert_recipient_coverage_gap(
      recovery_case.tenant_id,
      recovery_case.obligation_id
    );
  END IF;

  expected_rule_code := CASE recovery_case.case_kind
    WHEN 'manual_hold' THEN 'clinical_alert_delivery_manual_hold_review'
    WHEN 'recipient_coverage' THEN 'clinical_alert_delivery_recipient_coverage'
    ELSE NULL
  END;

  IF task_record.id IS NULL
     OR obligation_record.id IS NULL
     OR sla_record.id IS NULL
     OR task_record.task_kind IS DISTINCT FROM 'escalation'
     OR task_record.priority IS DISTINCT FROM 'critical'
     OR task_record.cancelled_at IS NOT NULL
     OR task_record.cancellation_reason IS NOT NULL
     OR (
       task_record.sla_breached_at IS NOT NULL
       AND (
         sla_record.breached_at IS NULL
         OR date_trunc('milliseconds', task_record.sla_breached_at)
              IS DISTINCT FROM date_trunc('milliseconds', sla_record.breached_at)
       )
     )
     OR task_record.workflow_run_id IS NOT NULL
     OR task_record.workflow_step_id IS NOT NULL
     OR task_record.metadata ?| ARRAY[
       'acknowledged_at',
       'acknowledged_by',
       'acknowledged_via',
       'acknowledgement_receipt_repaired',
       'previous_acknowledged_at',
       'acknowledgement_receipt_repaired_from'
     ]
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
     OR task_record.related_resource_type
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
     OR task_record.related_resource_id IS DISTINCT FROM recovery_case.id::text
     OR task_record.workflow_sla_instance_id
          IS DISTINCT FROM recovery_case.workflow_sla_instance_id
     OR task_record.due_at IS DISTINCT FROM recovery_case.due_at
     OR task_record.metadata->>'obligation_id'
          IS DISTINCT FROM recovery_case.obligation_id::text
     OR task_record.metadata->>'case_kind' IS DISTINCT FROM recovery_case.case_kind
     OR sla_record.rule_code IS DISTINCT FROM expected_rule_code
     OR sla_record.priority IS DISTINCT FROM 'critical'
     OR sla_record.source_table
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
     OR sla_record.source_id IS DISTINCT FROM recovery_case.id::text
     OR sla_record.due_at IS DISTINCT FROM recovery_case.due_at
     OR sla_record.patient_uid IS DISTINCT FROM task_record.patient_uid
     OR obligation_record.patient_uid IS DISTINCT FROM task_record.patient_uid
     OR task_record.metadata->>'assignment_origin'
          IS DISTINCT FROM 'admin_coverage_queue'
     OR (
       recovery_case.status = 'open'
       AND (
         task_record.status NOT IN ('open', 'in_progress', 'overdue')
         OR sla_record.completed_at IS NOT NULL
         OR sla_record.status NOT IN ('active', 'breached', 'escalated')
         OR (
           recovery_case.case_kind = 'manual_hold'
           AND obligation_record.status IS DISTINCT FROM 'manual_hold'
         )
         OR (
           recovery_case.case_kind = 'recipient_coverage'
           AND (
             obligation_record.status IS DISTINCT FROM 'pending'
             OR obligation_record.last_error_code
                  IS DISTINCT FROM 'no_active_clinical_recipients'
           )
         )
       )
     )
     OR (
       recovery_case.status = 'resolved'
       AND (
         task_record.status IS DISTINCT FROM 'completed'
         OR sla_record.completed_at IS NULL
         OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
       )
     )
     OR (
       task_record.assigned_to_uid IS NULL
       AND (
         task_record.assigned_to_role IS DISTINCT FROM 'ADMIN'
         OR sla_record.assigned_user_uid IS NOT NULL
         OR task_record.metadata ? 'role_claim_receipt'
         OR task_record.metadata ? 'role_claim_command_fingerprint'
         OR task_record.metadata ? 'role_claimed_by'
         OR task_record.metadata ? 'role_claimed_from_role'
         OR task_record.metadata ? 'role_claimed_at'
         OR task_record.metadata ? 'role_claimed_actor_role'
         OR task_record.metadata ? 'role_claimed_actor_raw_role'
         OR cardinality(COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[]))
              IS DISTINCT FROM 1
         OR NOT COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])
              @> ARRAY['ADMIN']::text[]
         OR NOT COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])
              <@ ARRAY['ADMIN']::text[]
       )
     )
     OR (
       task_record.assigned_to_uid IS NOT NULL
       AND (
         task_record.assigned_to_role IS NOT NULL
         OR sla_record.assigned_user_uid
              IS DISTINCT FROM task_record.assigned_to_uid
         OR cardinality(COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])) <> 0
          OR COALESCE(task_record.metadata->>'role_claim_receipt', '')
               !~ '^task-claim-v1:[0-9a-f]{64}$'
          OR COALESCE(
               task_record.metadata->>'role_claim_command_fingerprint',
               ''
             ) !~ '^[0-9a-f]{64}$'
         OR LOWER(task_record.metadata->>'role_claimed_by')
              IS DISTINCT FROM LOWER(task_record.assigned_to_uid::text)
         OR task_record.metadata->>'role_claimed_from_role'
              IS DISTINCT FROM 'ADMIN'
         OR pg_input_is_valid(
           task_record.metadata->>'role_claimed_at',
           'timestamp with time zone'
         ) IS NOT TRUE
         OR NOT EXISTS (
           SELECT 1
             FROM users assigned_admin
            WHERE assigned_admin.tenant_id = recovery_case.tenant_id
              AND assigned_admin.uid = task_record.assigned_to_uid
              AND assigned_admin.role IN ('ADMIN', 'SUPER_ADMIN')
              AND assigned_admin.is_active = TRUE
              AND COALESCE(assigned_admin.is_deleted, FALSE) = FALSE
              AND assigned_admin.deleted_at IS NULL
              AND LOWER(COALESCE(assigned_admin.status, 'active')) = 'active'
              AND task_record.metadata->>'role_claimed_actor_raw_role' =
                    assigned_admin.role
              AND task_record.metadata->>'role_claimed_actor_role' =
                    CASE assigned_admin.role
                      WHEN 'SUPER_ADMIN' THEN 'ADMIN'
                      ELSE assigned_admin.role
                    END
         )
         OR NOT EXISTS (
           SELECT 1
             FROM task_comments claim_comment
            WHERE claim_comment.tenant_id = recovery_case.tenant_id
              AND claim_comment.task_id = task_record.id
              AND claim_comment.author_uid = task_record.assigned_to_uid
              AND claim_comment.body_kind = 'state_change'
              AND claim_comment.metadata->>'from_assigned_to_role' = 'ADMIN'
              AND LOWER(claim_comment.metadata->>'to_assigned_to_uid') =
                    LOWER(task_record.assigned_to_uid::text)
              AND claim_comment.metadata->>'claim_receipt' =
                    task_record.metadata->>'role_claim_receipt'
              AND claim_comment.metadata->>'command_fingerprint' =
                    task_record.metadata->>'role_claim_command_fingerprint'
              AND claim_comment.metadata->>'claimed_at' =
                    task_record.metadata->>'role_claimed_at'
              AND claim_comment.metadata->>'actor_role' =
                    task_record.metadata->>'role_claimed_actor_role'
              AND claim_comment.metadata->>'actor_raw_role' =
                    task_record.metadata->>'role_claimed_actor_raw_role'
         )
       )
     )
  THEN
    RAISE EXCEPTION 'clinical alert recovery task, SLA, and case ownership are not aligned'
      USING ERRCODE = '23514';
  END IF;

  IF recovery_case.status = 'resolved' THEN
    SELECT action.*
      INTO action_record
      FROM clinical_alert_delivery_recovery_actions action
     WHERE action.tenant_id = recovery_case.tenant_id
       AND action.id = recovery_case.resolution_action_id
       AND action.case_id = recovery_case.id;

    IF action_record.id IS NULL
       OR action_record.actor_uid IS DISTINCT FROM recovery_case.resolved_by_uid
       OR action_record.operator_reason IS DISTINCT FROM recovery_case.resolution_reason
       OR action_record.outcome IS DISTINCT FROM recovery_case.resolution_kind
       OR action_record.response_payload IS DISTINCT FROM recovery_case.resolution_evidence
       OR action_record.response_payload->>'case_id' IS DISTINCT FROM recovery_case.id::text
       OR action_record.response_payload->>'obligation_id'
            IS DISTINCT FROM recovery_case.obligation_id::text
       OR action_record.response_payload->>'outcome'
            IS DISTINCT FROM recovery_case.resolution_kind
    THEN
      RAISE EXCEPTION 'terminal clinical alert recovery case lacks its exact action evidence'
        USING ERRCODE = '23514';
    END IF;

    IF recovery_case.case_kind = 'manual_hold' THEN
      SELECT replacement.*
        INTO replacement_record
        FROM clinical_alert_delivery_obligations replacement
       WHERE replacement.tenant_id = recovery_case.tenant_id
         AND replacement.id = recovery_case.replacement_obligation_id;
      IF recovery_case.resolution_kind IS DISTINCT FROM 'superseded'
         OR action_record.action_type IS DISTINCT FROM 'supersede_from_source'
         OR obligation_record.status IS DISTINCT FROM 'manual_hold'
         OR replacement_record.id IS NULL
         OR replacement_record.supersedes_obligation_id
              IS DISTINCT FROM recovery_case.obligation_id
         OR action_record.response_payload->>'replacement_obligation_id'
              IS DISTINCT FROM recovery_case.replacement_obligation_id::text
      THEN
        RAISE EXCEPTION 'terminal manual-hold clinical alert case lacks governed supersession'
          USING ERRCODE = '23514';
      END IF;
    ELSIF recovery_case.case_kind = 'recipient_coverage' THEN
      IF recovery_case.resolution_kind = 'recovered' AND (
           obligation_record.status IS DISTINCT FROM 'completed'
           OR action_record.action_type NOT IN (
             'retry_delivery',
             'system_delivery_recovered'
           )
         )
         OR recovery_case.resolution_kind = 'manual_hold' AND (
           obligation_record.status IS DISTINCT FROM 'manual_hold'
           OR action_record.action_type NOT IN ('retry_delivery', 'system_manual_hold')
         )
         OR recovery_case.resolution_kind NOT IN ('recovered', 'manual_hold')
      THEN
        RAISE EXCEPTION 'terminal recipient-coverage case does not match its obligation outcome'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'clinical alert recovery case kind is unsupported'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF recovery_case.escalated_at IS NOT NULL
     OR sla_record.status = 'escalated'
     OR sla_record.escalated_at IS NOT NULL
     OR COALESCE(sla_record.metadata, '{}'::jsonb)
          ? 'recovery_escalation_version'
     OR COALESCE(task_record.metadata, '{}'::jsonb)
          ? 'recovery_escalation_version'
  THEN
    IF COALESCE(
         sla_record.metadata->>'recovery_escalation_recipient_count',
         ''
       ) !~ '^[1-9][0-9]*$'
    THEN
      RAISE EXCEPTION 'clinical alert recovery escalation lacks its exact durable outbox receipt'
        USING ERRCODE = '23514';
    END IF;
    expected_escalation_recipient_count := (
      sla_record.metadata->>'recovery_escalation_recipient_count'
    )::integer;
    IF pg_input_is_valid(
         sla_record.metadata->>'recovery_escalated_at',
         'timestamp with time zone'
       ) IS NOT TRUE
    THEN
      RAISE EXCEPTION 'clinical alert recovery escalation lacks its exact durable outbox receipt'
        USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(sla_record.metadata->'recovery_escalation_outbox_ids')
         IS DISTINCT FROM 'array'
    THEN
      RAISE EXCEPTION 'clinical alert recovery escalation lacks its exact durable outbox receipt'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(
                  sla_record.metadata->'recovery_escalation_outbox_ids'
                ) outbox_id(value)
          WHERE COALESCE(outbox_id.value, '') !~ '^[1-9][0-9]*$'
       )
       OR jsonb_array_length(
            sla_record.metadata->'recovery_escalation_outbox_ids'
          ) IS DISTINCT FROM expected_escalation_recipient_count
    THEN
      RAISE EXCEPTION 'clinical alert recovery escalation lacks its exact durable outbox receipt'
        USING ERRCODE = '23514';
    END IF;

    IF recovery_case.escalated_at IS NULL
       OR recovery_case.last_escalation_attempt_at IS NULL
       OR recovery_case.last_escalation_error_code IS NOT NULL
       OR recovery_case.escalation_attempt_count <= 0
       OR sla_record.status IS DISTINCT FROM 'escalated'
       OR sla_record.breached_at IS NULL
       OR sla_record.escalated_at IS NULL
       OR date_trunc('milliseconds', sla_record.escalated_at)
            IS DISTINCT FROM date_trunc('milliseconds', recovery_case.escalated_at)
       OR date_trunc('milliseconds', recovery_case.last_escalation_attempt_at)
            IS DISTINCT FROM date_trunc('milliseconds', recovery_case.escalated_at)
       OR task_record.sla_breached_at IS NULL
       OR date_trunc('milliseconds', task_record.sla_breached_at)
            IS DISTINCT FROM date_trunc('milliseconds', sla_record.breached_at)
       OR task_record.status NOT IN ('in_progress', 'overdue', 'completed')
       OR sla_record.metadata->>'recovery_escalation_version'
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_escalation_v1'
       OR task_record.metadata->>'recovery_escalation_version'
            IS DISTINCT FROM 'clinical_alert_delivery_recovery_escalation_v1'
       OR COALESCE(
            sla_record.metadata->>'recovery_escalation_recipient_count',
            ''
          ) !~ '^[1-9][0-9]*$'
       OR jsonb_typeof(sla_record.metadata->'recovery_escalation_outbox_ids')
            IS DISTINCT FROM 'array'
       OR task_record.metadata->'recovery_escalation_outbox_ids'
            IS DISTINCT FROM sla_record.metadata->'recovery_escalation_outbox_ids'
       OR task_record.metadata->>'recovery_escalation_recipient_count'
            IS DISTINCT FROM sla_record.metadata->>'recovery_escalation_recipient_count'
       OR task_record.metadata->'recovery_escalated_at'
            IS DISTINCT FROM sla_record.metadata->'recovery_escalated_at'
       OR date_trunc(
            'milliseconds',
            (sla_record.metadata->>'recovery_escalated_at')::timestamptz
          ) IS DISTINCT FROM
            date_trunc('milliseconds', recovery_case.escalated_at)
       OR (
         SELECT COUNT(DISTINCT outbox.id)::integer
           FROM notification_outbox outbox
          WHERE outbox.tenant_id = recovery_case.tenant_id
            AND outbox.id::text IN (
              SELECT outbox_id.value
                FROM jsonb_array_elements_text(
                       sla_record.metadata->'recovery_escalation_outbox_ids'
                     ) outbox_id(value)
            )
            AND outbox.source_event_key =
                  'clinical-alert-recovery-case:' || recovery_case.id::text
                  || ':overdue:' || outbox.recipient_id
            AND outbox.type = 'clinical_alert_delivery_recovery_overdue'
            AND outbox.channel = 'push'
            AND outbox.payload->>'presentation_locale' IN (
                  'en', 'hi', 'ta', 'te', 'ml'
                )
            AND outbox.title = CASE outbox.payload->>'presentation_locale'
              WHEN 'hi' THEN
                'क्लिनिकल अलर्ट डिलीवरी रिकवरी की समय-सीमा बीत गई है'
              WHEN 'ta' THEN
                'மருத்துவ எச்சரிக்கை வழங்கல் மீட்பு காலக்கெடுவை கடந்துவிட்டது'
              WHEN 'te' THEN
                'క్లినికల్ అలర్ట్ డెలివరీ పునరుద్ధరణ గడువు దాటింది'
              WHEN 'ml' THEN
                'ക്ലിനിക്കൽ അലർട്ട് ഡെലിവറി വീണ്ടെടുക്കലിന്റെ സമയപരിധി കഴിഞ്ഞു'
              ELSE
                'Clinical alert delivery recovery is overdue'
            END
            AND outbox.body = CASE outbox.payload->>'presentation_locale'
              WHEN 'hi' THEN CASE recovery_case.case_kind
                WHEN 'manual_hold' THEN
                  'अपरिवर्तनीय रूप से रोके गए क्लिनिकल अलर्ट के लिए नियंत्रित स्रोत समीक्षा और प्रतिस्थापन आवश्यक है।'
                ELSE
                  'किसी क्लिनिकल अलर्ट के लिए अभी भी कोई सक्रिय ड्यूटी डॉक्टर या डॉक्टर-स्तर का प्राप्तकर्ता उपलब्ध नहीं है।'
              END
              WHEN 'ta' THEN CASE recovery_case.case_kind
                WHEN 'manual_hold' THEN
                  'மாற்ற இயலாமல் நிறுத்திவைக்கப்பட்ட மருத்துவ எச்சரிக்கைக்கு நிர்வகிக்கப்பட்ட மூல ஆய்வும் மாற்றுப் பதிவும் தேவை.'
                ELSE
                  'ஒரு மருத்துவ எச்சரிக்கைக்கு இன்னும் செயலில் உள்ள பணிப்பொறுப்பு மருத்துவர் அல்லது மருத்துவர்-நிலை பெறுநர் இல்லை.'
              END
              WHEN 'te' THEN CASE recovery_case.case_kind
                WHEN 'manual_hold' THEN
                  'మార్చలేని విధంగా హోల్డ్ చేసిన క్లినికల్ అలర్ట్‌కు నియంత్రిత మూల సమీక్ష మరియు ప్రత్యామ్నాయ నమోదు అవసరం.'
                ELSE
                  'ఒక క్లినికల్ అలర్ట్‌కు ఇప్పటికీ క్రియాశీల డ్యూటీ డాక్టర్ లేదా డాక్టర్-స్థాయి గ్రహీత లేరు.'
              END
              WHEN 'ml' THEN CASE recovery_case.case_kind
                WHEN 'manual_hold' THEN
                  'മാറ്റാനാവാതെ ഹോൾഡ് ചെയ്തിരിക്കുന്ന ക്ലിനിക്കൽ അലർട്ടിന് നിയന്ത്രിത ഉറവിട അവലോകനവും പകരം രേഖപ്പെടുത്തലും ആവശ്യമാണ്.'
                ELSE
                  'ഒരു ക്ലിനിക്കൽ അലർട്ടിന് ഇപ്പോഴും സജീവ ഡ്യൂട്ടി ഡോക്ടറോ ഡോക്ടർ-തലത്തിലുള്ള സ്വീകർത്താവോ ഇല്ല.'
              END
              ELSE CASE recovery_case.case_kind
                WHEN 'manual_hold' THEN
                  'An immutable held clinical alert requires governed source review and supersession.'
                ELSE
                  'A clinical alert still has no active duty-doctor or doctor-tier recipient.'
              END
            END
            AND outbox.template_version =
                  'clinical-alert-delivery-recovery-escalation.v1'
            AND outbox.payload->>'kind' =
                  'clinical_alert_delivery_recovery_overdue'
            AND outbox.payload->>'recovery_case_id' = recovery_case.id::text
            AND outbox.payload->>'obligation_id' = recovery_case.obligation_id::text
            AND outbox.payload->>'case_kind' = recovery_case.case_kind
            AND outbox.payload->>'patient_uid'
                  IS NOT DISTINCT FROM obligation_record.patient_uid::text
            AND outbox.payload->>'action_path' =
                  '/api/v1/admin/clinical-alert-delivery/recovery-cases/'
                  || recovery_case.id::text
            AND outbox.payload->>'route' =
                  '/clinical-inbox/recovery?case_id=' || recovery_case.id::text
            AND outbox.payload->>'deep_link' =
                  '/clinical-inbox/recovery?case_id=' || recovery_case.id::text
            AND outbox.payload->>'action_label_key' = 'clinical_inbox.open_workflow'
            AND outbox.payload->>'presentation_key' =
                  'clinical_alert_delivery_recovery_overdue'
            AND outbox.payload->>'presentation_copy_version' =
                  'clinical-alert-delivery-recovery-escalation.v1'
            AND jsonb_typeof(outbox.payload->'presentations') = 'object'
            AND outbox.payload->'presentations' ?& ARRAY[
                  'en', 'hi', 'ta', 'te', 'ml'
                ]
            AND outbox.created_at <= recovery_case.escalated_at
       ) IS DISTINCT FROM expected_escalation_recipient_count
       OR (
         SELECT COUNT(DISTINCT outbox.recipient_id)::integer
           FROM notification_outbox outbox
          WHERE outbox.tenant_id = recovery_case.tenant_id
            AND outbox.id::text IN (
              SELECT outbox_id.value
                FROM jsonb_array_elements_text(
                       sla_record.metadata->'recovery_escalation_outbox_ids'
                     ) outbox_id(value)
            )
       ) IS DISTINCT FROM expected_escalation_recipient_count
    THEN
      RAISE EXCEPTION 'clinical alert recovery escalation lacks its exact durable outbox receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_obligation_constraint()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'manual_hold'
     AND NOT EXISTS (
       SELECT 1
         FROM clinical_alert_delivery_recovery_cases recovery_case
        WHERE recovery_case.tenant_id = NEW.tenant_id
          AND recovery_case.obligation_id = NEW.id
          AND recovery_case.case_kind = 'manual_hold'
     )
  THEN
    RAISE EXCEPTION 'manual-hold clinical alert obligation has no durable recovery case'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM clinical_alert_delivery_recovery_cases recovery_case
     WHERE recovery_case.tenant_id = NEW.tenant_id
       AND recovery_case.obligation_id = NEW.id
       AND recovery_case.status = 'open'
       AND (
         (
           recovery_case.case_kind = 'manual_hold'
           AND NEW.status IS DISTINCT FROM 'manual_hold'
         )
         OR (
           recovery_case.case_kind = 'recipient_coverage'
           AND (
             NEW.status IS DISTINCT FROM 'pending'
             OR NEW.last_error_code
                  IS DISTINCT FROM 'no_active_clinical_recipients'
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'open clinical alert recovery case no longer matches its recovery condition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_recovery_obligation_constraint
  AFTER INSERT OR UPDATE OF status, last_error_code
  ON public.clinical_alert_delivery_obligations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_obligation_constraint();

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_claim_comment_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM tasks task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.id = OLD.task_id
       AND task.task_kind = 'escalation'
       AND task.related_resource_type = 'clinical_alert_delivery_recovery_cases'
       AND task.metadata->>'task_contract' =
             'clinical_alert_delivery_recovery_v1'
       AND OLD.body_kind = 'state_change'
       AND OLD.metadata ? 'claim_receipt'
  ) THEN
    RAISE EXCEPTION 'clinical alert recovery claim receipts are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
     AND EXISTS (
       SELECT 1
         FROM tasks task
        WHERE task.tenant_id = NEW.tenant_id
          AND task.id = NEW.task_id
          AND task.task_kind = 'escalation'
          AND task.related_resource_type = 'clinical_alert_delivery_recovery_cases'
          AND task.metadata->>'task_contract' =
                'clinical_alert_delivery_recovery_v1'
          AND NEW.body_kind = 'state_change'
          AND NEW.metadata ? 'claim_receipt'
     )
  THEN
    RAISE EXCEPTION 'clinical alert recovery claim receipts are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER clinical_alert_delivery_recovery_claim_comment_guard
  BEFORE UPDATE OR DELETE ON public.task_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_claim_comment_guard();

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_assignee_viability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM clinical_alert_delivery_recovery_cases recovery_case
      JOIN tasks task
        ON task.tenant_id = recovery_case.tenant_id
       AND task.id = recovery_case.task_id
     WHERE recovery_case.tenant_id = OLD.tenant_id
       AND recovery_case.status = 'open'
       AND task.assigned_to_uid = OLD.uid
       AND task.metadata->>'task_contract' =
             'clinical_alert_delivery_recovery_v1'
       AND (
         NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.uid IS DISTINCT FROM OLD.uid
         OR NEW.role IS NULL
         OR NEW.role NOT IN ('ADMIN', 'SUPER_ADMIN')
         OR NEW.is_active IS DISTINCT FROM TRUE
         OR COALESCE(NEW.is_deleted, FALSE) IS DISTINCT FROM FALSE
         OR NEW.deleted_at IS NOT NULL
         OR LOWER(COALESCE(NEW.status, 'active')) IS DISTINCT FROM 'active'
       )
  ) THEN
    RAISE EXCEPTION 'open clinical alert recovery assignee must remain an active administrator'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_escalation_snapshot_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  recovery_case clinical_alert_delivery_recovery_cases%ROWTYPE;
  obligation_record clinical_alert_delivery_obligations%ROWTYPE;
  task_record tasks%ROWTYPE;
  old_version TEXT := OLD.metadata->>'recovery_escalation_version';
  new_version TEXT := NEW.metadata->>'recovery_escalation_version';
  recipient_count INTEGER;
  eligible_count INTEGER;
  exact_outbox_count INTEGER;
  exact_recipient_count INTEGER;
  missing_recipient_count INTEGER;
  extra_recipient_count INTEGER;
BEGIN
  IF NEW.rule_code NOT IN (
       'clinical_alert_manual_hold_recovery',
       'clinical_alert_recipient_coverage_recovery'
     )
     AND OLD.rule_code NOT IN (
       'clinical_alert_manual_hold_recovery',
       'clinical_alert_recipient_coverage_recovery'
     )
  THEN
    RETURN NULL;
  END IF;

  IF old_version = 'clinical_alert_delivery_recovery_escalation_v1' THEN
    IF NEW.escalated_at IS DISTINCT FROM OLD.escalated_at
       OR NEW.metadata->'recovery_escalation_version'
            IS DISTINCT FROM OLD.metadata->'recovery_escalation_version'
       OR NEW.metadata->'recovery_escalation_recipient_count'
            IS DISTINCT FROM OLD.metadata->'recovery_escalation_recipient_count'
       OR NEW.metadata->'recovery_escalation_outbox_ids'
            IS DISTINCT FROM OLD.metadata->'recovery_escalation_outbox_ids'
       OR NEW.metadata->'recovery_escalated_at'
            IS DISTINCT FROM OLD.metadata->'recovery_escalated_at'
    THEN
      RAISE EXCEPTION 'clinical alert recovery escalation snapshot is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  IF new_version IS NULL
     AND NEW.escalated_at IS NULL
     AND NEW.status IS DISTINCT FROM 'escalated'
  THEN
    RETURN NULL;
  END IF;

  SELECT recovery.*
    INTO recovery_case
    FROM clinical_alert_delivery_recovery_cases recovery
   WHERE recovery.tenant_id = NEW.tenant_id
     AND recovery.workflow_sla_instance_id = NEW.id;
  SELECT obligation.*
    INTO obligation_record
    FROM clinical_alert_delivery_obligations obligation
   WHERE obligation.tenant_id = recovery_case.tenant_id
     AND obligation.id = recovery_case.obligation_id;
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = recovery_case.tenant_id
     AND task.id = recovery_case.task_id;

  IF recovery_case.id IS NULL
     OR obligation_record.id IS NULL
     OR task_record.id IS NULL
     OR new_version IS DISTINCT FROM
          'clinical_alert_delivery_recovery_escalation_v1'
     OR OLD.escalated_at IS NOT NULL
     OR NEW.escalated_at IS NULL
     OR NEW.status IS DISTINCT FROM 'escalated'
     OR NEW.breached_at IS NULL
     OR recovery_case.escalated_at IS NULL
     OR recovery_case.last_escalation_error_code IS NOT NULL
     OR recovery_case.escalation_attempt_count <= 0
     OR date_trunc('milliseconds', recovery_case.escalated_at)
          IS DISTINCT FROM date_trunc('milliseconds', NEW.escalated_at)
     OR date_trunc('milliseconds', recovery_case.last_escalation_attempt_at)
          IS DISTINCT FROM date_trunc('milliseconds', NEW.escalated_at)
     OR COALESCE(NEW.metadata->>'recovery_escalation_recipient_count', '')
          !~ '^[1-9][0-9]*$'
     OR jsonb_typeof(NEW.metadata->'recovery_escalation_outbox_ids')
          IS DISTINCT FROM 'array'
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
     OR task_record.workflow_sla_instance_id IS DISTINCT FROM NEW.id
     OR task_record.metadata->'recovery_escalation_version'
          IS DISTINCT FROM NEW.metadata->'recovery_escalation_version'
     OR task_record.metadata->'recovery_escalation_recipient_count'
          IS DISTINCT FROM NEW.metadata->'recovery_escalation_recipient_count'
     OR task_record.metadata->'recovery_escalation_outbox_ids'
          IS DISTINCT FROM NEW.metadata->'recovery_escalation_outbox_ids'
     OR task_record.metadata->'recovery_escalated_at'
          IS DISTINCT FROM NEW.metadata->'recovery_escalated_at'
     OR CASE
          WHEN pg_input_is_valid(
            NEW.metadata->>'recovery_escalated_at',
            'timestamp with time zone'
          )
            THEN date_trunc(
                   'milliseconds',
                   (NEW.metadata->>'recovery_escalated_at')::timestamptz
                 ) IS DISTINCT FROM date_trunc('milliseconds', NEW.escalated_at)
          ELSE TRUE
        END
  THEN
    RAISE EXCEPTION 'clinical alert recovery escalation snapshot is incomplete'
      USING ERRCODE = '23514';
  END IF;

  recipient_count := (
    NEW.metadata->>'recovery_escalation_recipient_count'
  )::integer;
  IF jsonb_array_length(NEW.metadata->'recovery_escalation_outbox_ids')
       IS DISTINCT FROM recipient_count
  THEN
    RAISE EXCEPTION 'clinical alert recovery escalation outbox set is incomplete'
      USING ERRCODE = '23514';
  END IF;

  WITH eligible AS MATERIALIZED (
    SELECT recipient.uid::text AS recipient_id,
           recipient.role,
           CASE
             WHEN LOWER(
                    SPLIT_PART(
                      REPLACE(COALESCE(recipient.preferred_language, ''), '_', '-'),
                      '-',
                      1
                    )
                  ) IN ('en', 'hi', 'ta', 'te', 'ml')
               THEN LOWER(
                      SPLIT_PART(
                        REPLACE(COALESCE(recipient.preferred_language, ''), '_', '-'),
                        '-',
                        1
                      )
                    )
             ELSE 'en'
           END AS presentation_locale
      FROM users recipient
     WHERE recipient.tenant_id = recovery_case.tenant_id
       AND recipient.role IN ('ADMIN', 'SUPER_ADMIN')
       AND recipient.is_active = TRUE
       AND COALESCE(recipient.is_deleted, FALSE) = FALSE
       AND recipient.deleted_at IS NULL
       AND LOWER(COALESCE(recipient.status, 'active')) = 'active'
     ORDER BY recipient.last_sign_in_at DESC NULLS LAST, recipient.id ASC
     LIMIT 25
  ), outbox_ids AS MATERIALIZED (
    SELECT outbox_id.value
      FROM jsonb_array_elements_text(
             NEW.metadata->'recovery_escalation_outbox_ids'
           ) outbox_id(value)
  ), actual AS MATERIALIZED (
    SELECT outbox.id::text AS outbox_id,
           outbox.recipient_id,
           outbox.payload->>'recipient_role' AS recipient_role,
           outbox.payload->>'presentation_locale' AS presentation_locale
      FROM notification_outbox outbox
      JOIN outbox_ids selected ON selected.value = outbox.id::text
     WHERE outbox.tenant_id = recovery_case.tenant_id
       AND outbox.recipient_id IS NOT NULL
       AND outbox.source_event_key =
             'clinical-alert-recovery-case:' || recovery_case.id::text
             || ':overdue:' || outbox.recipient_id
       AND outbox.type = 'clinical_alert_delivery_recovery_overdue'
       AND outbox.channel = 'push'
       AND outbox.payload->>'presentation_locale' IN (
             'en', 'hi', 'ta', 'te', 'ml'
           )
       AND outbox.title = CASE outbox.payload->>'presentation_locale'
             WHEN 'hi' THEN
               'क्लिनिकल अलर्ट डिलीवरी रिकवरी की समय-सीमा बीत गई है'
             WHEN 'ta' THEN
               'மருத்துவ எச்சரிக்கை வழங்கல் மீட்பு காலக்கெடுவை கடந்துவிட்டது'
             WHEN 'te' THEN
               'క్లినికల్ అలర్ట్ డెలివరీ పునరుద్ధరణ గడువు దాటింది'
             WHEN 'ml' THEN
               'ക്ലിനിക്കൽ അലർട്ട് ഡെലിവറി വീണ്ടെടുക്കലിന്റെ സമയപരിധി കഴിഞ്ഞു'
             ELSE
               'Clinical alert delivery recovery is overdue'
           END
       AND outbox.body = CASE outbox.payload->>'presentation_locale'
             WHEN 'hi' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'अपरिवर्तनीय रूप से रोके गए क्लिनिकल अलर्ट के लिए नियंत्रित स्रोत समीक्षा और प्रतिस्थापन आवश्यक है।'
               ELSE
                 'किसी क्लिनिकल अलर्ट के लिए अभी भी कोई सक्रिय ड्यूटी डॉक्टर या डॉक्टर-स्तर का प्राप्तकर्ता उपलब्ध नहीं है।'
             END
             WHEN 'ta' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'மாற்ற இயலாமல் நிறுத்திவைக்கப்பட்ட மருத்துவ எச்சரிக்கைக்கு நிர்வகிக்கப்பட்ட மூல ஆய்வும் மாற்றுப் பதிவும் தேவை.'
               ELSE
                 'ஒரு மருத்துவ எச்சரிக்கைக்கு இன்னும் செயலில் உள்ள பணிப்பொறுப்பு மருத்துவர் அல்லது மருத்துவர்-நிலை பெறுநர் இல்லை.'
             END
             WHEN 'te' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'మార్చలేని విధంగా హోల్డ్ చేసిన క్లినికల్ అలర్ట్‌కు నియంత్రిత మూల సమీక్ష మరియు ప్రత్యామ్నాయ నమోదు అవసరం.'
               ELSE
                 'ఒక క్లినికల్ అలర్ట్‌కు ఇప్పటికీ క్రియాశీల డ్యూటీ డాక్టర్ లేదా డాక్టర్-స్థాయి గ్రహీత లేరు.'
             END
             WHEN 'ml' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'മാറ്റാനാവാതെ ഹോൾഡ് ചെയ്തിരിക്കുന്ന ക്ലിനിക്കൽ അലർട്ടിന് നിയന്ത്രിത ഉറവിട അവലോകനവും പകരം രേഖപ്പെടുത്തലും ആവശ്യമാണ്.'
               ELSE
                 'ഒരു ക്ലിനിക്കൽ അലർട്ടിന് ഇപ്പോഴും സജീവ ഡ്യൂട്ടി ഡോക്ടറോ ഡോക്ടർ-തലത്തിലുള്ള സ്വീകർത്താവോ ഇല്ല.'
             END
             ELSE CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'An immutable held clinical alert requires governed source review and supersession.'
               ELSE
                 'A clinical alert still has no active duty-doctor or doctor-tier recipient.'
             END
           END
       AND outbox.template_version =
             'clinical-alert-delivery-recovery-escalation.v1'
       AND outbox.payload->>'kind' =
             'clinical_alert_delivery_recovery_overdue'
       AND outbox.payload->>'recovery_case_id' = recovery_case.id::text
       AND outbox.payload->>'obligation_id' = recovery_case.obligation_id::text
       AND outbox.payload->>'case_kind' = recovery_case.case_kind
       AND outbox.payload->>'patient_uid'
             IS NOT DISTINCT FROM obligation_record.patient_uid::text
       AND outbox.payload->>'action_path' =
             '/api/v1/admin/clinical-alert-delivery/recovery-cases/'
             || recovery_case.id::text
       AND outbox.payload->>'route' =
             '/clinical-inbox/recovery?case_id=' || recovery_case.id::text
       AND outbox.payload->>'deep_link' =
             '/clinical-inbox/recovery?case_id=' || recovery_case.id::text
       AND outbox.payload->>'action_label_key' = 'clinical_inbox.open_workflow'
       AND outbox.payload->>'presentation_key' =
             'clinical_alert_delivery_recovery_overdue'
       AND outbox.payload->>'presentation_copy_version' =
             'clinical-alert-delivery-recovery-escalation.v1'
       AND jsonb_typeof(outbox.payload->'presentations') = 'object'
       AND outbox.payload->'presentations' ?& ARRAY[
             'en', 'hi', 'ta', 'te', 'ml'
           ]
       AND outbox.payload->>'recipient_role' IN ('ADMIN', 'SUPER_ADMIN')
       AND outbox.created_at <= NEW.escalated_at
  )
  SELECT (SELECT COUNT(*)::integer FROM eligible),
         (SELECT COUNT(DISTINCT outbox_id)::integer FROM actual),
         (SELECT COUNT(DISTINCT recipient_id)::integer FROM actual),
         (
           SELECT COUNT(*)::integer
             FROM eligible expected
            WHERE NOT EXISTS (
              SELECT 1
                FROM actual delivered
               WHERE delivered.recipient_id = expected.recipient_id
                 AND delivered.recipient_role = expected.role
                 AND delivered.presentation_locale = expected.presentation_locale
            )
         ),
         (
           SELECT COUNT(*)::integer
             FROM actual delivered
            WHERE NOT EXISTS (
              SELECT 1
                FROM eligible expected
               WHERE expected.recipient_id = delivered.recipient_id
                 AND expected.role = delivered.recipient_role
                 AND expected.presentation_locale = delivered.presentation_locale
            )
         )
    INTO eligible_count,
         exact_outbox_count,
         exact_recipient_count,
         missing_recipient_count,
         extra_recipient_count;

  IF eligible_count IS DISTINCT FROM recipient_count
     OR exact_outbox_count IS DISTINCT FROM recipient_count
     OR exact_recipient_count IS DISTINCT FROM recipient_count
     OR missing_recipient_count IS DISTINCT FROM 0
     OR extra_recipient_count IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION 'clinical alert recovery escalation must notify the exact active recipient set'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_recovery_assignee_viability_guard
  AFTER UPDATE OF tenant_id, uid, role, is_active, status, is_deleted, deleted_at
  ON public.users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_assignee_viability_guard();

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_recovery_escalation_snapshot_guard
  AFTER UPDATE OF status, breached_at, escalated_at, metadata
  ON public.workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_escalation_snapshot_guard();

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_recovery_case_binding_constraint
  AFTER INSERT OR UPDATE OF
    tenant_id,
    obligation_id,
    case_kind,
    workflow_sla_instance_id,
    task_id,
    due_at,
    escalation_attempt_count,
    last_escalation_attempt_at,
    last_escalation_error_code,
    escalated_at,
    status,
    resolution_kind,
    resolution_action_id,
    replacement_obligation_id,
    resolved_by_uid,
    resolution_reason,
    resolution_evidence,
    resolved_at
  ON public.clinical_alert_delivery_recovery_cases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_task_case_constraint();

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_recovery_task_case_constraint
  AFTER INSERT OR UPDATE OF
    tenant_id,
    task_kind,
    priority,
    status,
    completed_at,
    cancelled_at,
    cancellation_reason,
    sla_breached_at,
    workflow_run_id,
    workflow_step_id,
    related_resource_type,
    related_resource_id,
    workflow_sla_instance_id,
    due_at,
    metadata,
    assigned_to_uid,
    assigned_to_role
  ON public.tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_task_case_constraint();

CREATE CONSTRAINT TRIGGER clinical_alert_delivery_recovery_sla_case_constraint
  AFTER INSERT OR UPDATE OF
    tenant_id,
    rule_code,
    priority,
    patient_uid,
    source_table,
    source_id,
    due_at,
    status,
    completed_at,
    breached_at,
    escalated_at,
    metadata,
    assigned_user_uid,
    assigned_role_codes
  ON public.workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.clinical_alert_delivery_recovery_task_case_constraint();

ALTER FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_source_binding_pre_745;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_source_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  expected_rule_code TEXT;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
  THEN
    PERFORM public.care_pathway_assert_task_sla_source_binding_pre_745(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  expected_rule_code := CASE task_record.metadata->>'case_kind'
    WHEN 'manual_hold' THEN 'clinical_alert_delivery_manual_hold_review'
    WHEN 'recipient_coverage' THEN 'clinical_alert_delivery_recipient_coverage'
    ELSE NULL
  END;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;

  IF NOT FOUND
     OR expected_rule_code IS NULL
     OR task_record.task_kind IS DISTINCT FROM 'escalation'
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.related_resource_type
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
     OR sla_record.rule_code IS DISTINCT FROM expected_rule_code
     OR sla_record.source_table IS DISTINCT FROM task_record.related_resource_type
     OR sla_record.source_id IS DISTINCT FROM task_record.related_resource_id
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     OR task_record.patient_uid IS DISTINCT FROM sla_record.patient_uid
     OR task_record.metadata->>'sla_instance_id'
          IS DISTINCT FROM sla_record.id::text
     OR task_record.metadata->>'sla_key'
          IS DISTINCT FROM sla_record.rule_code
  THEN
    RAISE EXCEPTION 'clinical alert recovery task and linked SLA do not describe the same case'
      USING ERRCODE = '23514';
  END IF;
END
$fn$;

ALTER FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_745;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  recovery_record clinical_alert_delivery_recovery_cases%ROWTYPE;
  action_record clinical_alert_delivery_recovery_actions%ROWTYPE;
  evidence JSONB;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
  THEN
    PERFORM public.care_pathway_assert_task_sla_completion_receipt_pre_745(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;
  SELECT recovery.*
    INTO recovery_record
    FROM clinical_alert_delivery_recovery_cases recovery
   WHERE recovery.tenant_id = task_record.tenant_id
     AND recovery.id::text = task_record.related_resource_id
     AND recovery.task_id = task_record.id
     AND recovery.workflow_sla_instance_id = task_record.workflow_sla_instance_id;

  IF sla_record.id IS NULL
     OR recovery_record.id IS NULL
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     OR sla_record.source_table
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_cases'
     OR sla_record.source_id IS DISTINCT FROM task_record.related_resource_id
  THEN
    RAISE EXCEPTION 'clinical alert recovery task has no exact SLA receipt contract'
      USING ERRCODE = '23514';
  END IF;

  IF task_record.status IN ('open', 'in_progress', 'overdue') THEN
    IF recovery_record.status IS DISTINCT FROM 'open'
       OR sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
       OR task_record.completed_at IS NOT NULL
       OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
            'completed_via',
            'completed_by_task',
            'completed_by',
            'completion_evidence'
          ]
    THEN
      RAISE EXCEPTION 'actionable clinical alert recovery task requires a clean open SLA receipt'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  SELECT action.*
    INTO action_record
    FROM clinical_alert_delivery_recovery_actions action
   WHERE action.tenant_id = recovery_record.tenant_id
     AND action.id = recovery_record.resolution_action_id
     AND action.case_id = recovery_record.id;
  evidence := sla_record.metadata->'completion_evidence';

  IF action_record.id IS NULL
     OR task_record.status IS DISTINCT FROM 'completed'
     OR recovery_record.status IS DISTINCT FROM 'resolved'
     OR sla_record.completed_at IS NULL
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
     OR task_record.completed_at IS DISTINCT FROM sla_record.completed_at
     OR recovery_record.resolved_at IS DISTINCT FROM sla_record.completed_at
     OR sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
     OR sla_record.metadata->>'completed_by'
          IS DISTINCT FROM action_record.actor_uid::text
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR evidence->>'kind'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_action'
     OR evidence->>'resource_type'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_actions'
     OR evidence->>'resource_id' IS DISTINCT FROM action_record.id::text
     OR evidence->>'case_id' IS DISTINCT FROM recovery_record.id::text
     OR evidence->>'obligation_id' IS DISTINCT FROM recovery_record.obligation_id::text
     OR evidence->>'resolution_kind' IS DISTINCT FROM recovery_record.resolution_kind
     OR evidence->>'occurred_at' IS NULL
     OR pg_input_is_valid(evidence->>'occurred_at', 'timestamp with time zone')
          IS NOT TRUE
     OR (evidence->>'occurred_at')::timestamptz
          IS DISTINCT FROM recovery_record.resolved_at
     OR task_record.metadata->>'domain_evidence_kind'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_action'
     OR task_record.metadata->>'domain_evidence_id'
          IS DISTINCT FROM action_record.id::text
     OR task_record.metadata->>'resolution_kind'
          IS DISTINCT FROM recovery_record.resolution_kind
     OR task_record.metadata->'completion_evidence' IS DISTINCT FROM evidence
     OR action_record.outcome IS DISTINCT FROM recovery_record.resolution_kind
  THEN
    RAISE EXCEPTION 'terminal clinical alert recovery task lacks its exact action receipt'
      USING ERRCODE = '23514';
  END IF;
END
$fn$;

ALTER TABLE public.clinical_alert_delivery_recovery_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_alert_delivery_recovery_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_alert_delivery_recovery_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_alert_delivery_recovery_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.clinical_alert_delivery_recovery_cases
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  );

CREATE POLICY explicit_tenant_context ON public.clinical_alert_delivery_recovery_cases
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  );

CREATE POLICY tenant_isolation ON public.clinical_alert_delivery_recovery_actions
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  );

CREATE POLICY explicit_tenant_context ON public.clinical_alert_delivery_recovery_actions
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = app_current_tenant_id_uuid()
  );

REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_obligation_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_obligation_evidence_constraint() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_assert_canonical_evidence(UUID, BIGINT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_canonical_evidence_constraint() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_case_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_action_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_task_sync() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_task_case_constraint() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_obligation_constraint() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_claim_comment_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_assignee_viability_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_recovery_escalation_snapshot_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.clinical_alert_delivery_assert_recipient_coverage_gap(UUID, BIGINT)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding_pre_745(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_745(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_med03(UUID, INTEGER)
  FROM PUBLIC;

DO $clinical_alert_delivery_runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_alert_delivery_obligations FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.clinical_alert_delivery_obligations TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (
         tenant_id, obligation_key, source_table, source_id, source_event_key,
         failure_kind, patient_uid, encounter_id, origin_actor_uid, failure_code,
         recipient_policy, notification_intent, supersedes_obligation_id
       ) ON TABLE public.clinical_alert_delivery_obligations TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT UPDATE (
         status, attempt_count, last_attempted_at, next_attempt_at,
         last_error_code, completion_notification_outbox_id,
         completion_notification_outbox_ids, completion_recipient_ids,
         completion_evidence, completed_at, manual_hold_code,
         manual_hold_reason, held_at
       ) ON TABLE public.clinical_alert_delivery_obligations TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.clinical_alert_delivery_obligations_id_seq FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE, SELECT ON SEQUENCE public.clinical_alert_delivery_obligations_id_seq TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_alert_delivery_recovery_cases FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.clinical_alert_delivery_recovery_cases TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (
         id, tenant_id, obligation_id, case_kind, status,
         workflow_sla_instance_id, task_id, due_at
       ) ON TABLE public.clinical_alert_delivery_recovery_cases TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT UPDATE (
         observation_count, last_observed_at,
         escalation_attempt_count, last_escalation_attempt_at,
         last_escalation_error_code, escalated_at,
         status, resolution_kind, resolution_action_id,
         replacement_obligation_id, resolved_by_uid,
         resolution_reason, resolution_evidence, resolved_at
       ) ON TABLE public.clinical_alert_delivery_recovery_cases TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_alert_delivery_recovery_actions FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.clinical_alert_delivery_recovery_actions TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (
         tenant_id, case_id, action_type, actor_uid, operator_reason,
         idempotency_key, command_sha256, request_id, outcome, response_payload
       ) ON TABLE public.clinical_alert_delivery_recovery_actions TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.clinical_alert_delivery_recovery_cases_id_seq FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE, SELECT ON SEQUENCE public.clinical_alert_delivery_recovery_cases_id_seq TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.clinical_alert_delivery_recovery_actions_id_seq FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE, SELECT ON SEQUENCE public.clinical_alert_delivery_recovery_actions_id_seq TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_obligation_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_obligation_evidence_constraint() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_assert_canonical_evidence(UUID, BIGINT) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.clinical_alert_delivery_assert_canonical_evidence(UUID, BIGINT) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_canonical_evidence_constraint() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_case_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_action_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_task_sync() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_task_case_constraint() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_obligation_constraint() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_claim_comment_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_assignee_viability_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_recovery_escalation_snapshot_guard() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_alert_delivery_assert_recipient_coverage_gap(UUID, BIGINT) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.clinical_alert_delivery_assert_recipient_coverage_gap(UUID, BIGINT) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_source_binding_pre_745(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_source_binding_pre_745(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_745(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_745(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(UUID, INTEGER) TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_med03(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_med03(UUID, INTEGER) TO %I',
      runtime_role
    );
  END LOOP;
END
$clinical_alert_delivery_runtime_privileges$;

COMMIT;
