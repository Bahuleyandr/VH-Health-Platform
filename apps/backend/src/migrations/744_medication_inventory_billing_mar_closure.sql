-- Migration 744: MED-03 medication inventory, billing, MAR, and notification closure.
--
-- This migration does not activate notification delivery, deploy production
-- code, or authorize controlled-drug, credit-payout, or clinical-override
-- operations. It adds the tenant-bound evidence rails those separately
-- authorized workflows require.

BEGIN;

CREATE OR REPLACE FUNCTION medication_evidence_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION 'medication evidence %.% is append-only: % is not permitted',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    TG_OP
    USING ERRCODE = '55000';
END
$fn$;

-- ---------------------------------------------------------------------------
-- Direct clinical-order identity on MAR
-- ---------------------------------------------------------------------------

ALTER TABLE medication_administrations
  ADD COLUMN clinical_order_id INTEGER,
  ADD COLUMN supply_quantity_per_dose NUMERIC(14, 4),
  ADD COLUMN held_by UUID,
  ADD COLUMN held_at TIMESTAMPTZ,
  ADD COLUMN missed_by UUID,
  ADD COLUMN missed_at TIMESTAMPTZ;

-- Older hold writes used administered_by for the holding nurse. Preserve that
-- attribution only when it still resolves to an active tenant identity, then
-- clear administered_by so it once again means "the nurse who gave the dose".
UPDATE medication_administrations administration
   SET held_by = administration.administered_by,
       held_at = COALESCE(administration.updated_at, administration.created_at, NOW())
 WHERE LOWER(administration.status) = 'held'
   AND administration.administered_by IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM users actor
      WHERE actor.tenant_id = administration.tenant_id
        AND actor.uid = administration.administered_by
   );

UPDATE medication_administrations
   SET administered_by = NULL,
       held_at = COALESCE(held_at, updated_at, created_at, NOW())
 WHERE LOWER(status) = 'held';

UPDATE medication_administrations administration
   SET missed_by = administration.administered_by
 WHERE LOWER(administration.status) = 'missed'
   AND administration.administered_by IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM users actor
      WHERE actor.tenant_id = administration.tenant_id
        AND actor.uid = administration.administered_by
   );

UPDATE medication_administrations
   SET administered_by = NULL,
       missed_at = COALESCE(updated_at, created_at, NOW())
 WHERE LOWER(status) = 'missed';

WITH order_markers AS (
  SELECT administration.id,
         administration.tenant_id,
         ARRAY_AGG(DISTINCT marker.capture[1]::INTEGER) AS order_ids
    FROM medication_administrations administration
    CROSS JOIN LATERAL REGEXP_MATCHES(
      COALESCE(administration.notes, ''),
      'clinical_order_id:([0-9]+)',
      'g'
    ) AS marker(capture)
   GROUP BY administration.id, administration.tenant_id
), unambiguous_markers AS (
  SELECT id, tenant_id, order_ids[1] AS clinical_order_id
    FROM order_markers
   WHERE CARDINALITY(order_ids) = 1
)
UPDATE medication_administrations administration
   SET clinical_order_id = marker.clinical_order_id
  FROM unambiguous_markers marker
  JOIN clinical_orders clinical_order
    ON clinical_order.tenant_id = marker.tenant_id
   AND clinical_order.id = marker.clinical_order_id
   AND clinical_order.order_type = 'medication'
 WHERE administration.id = marker.id
   AND administration.tenant_id = marker.tenant_id
   AND administration.patient_uid = clinical_order.patient_uid
   AND administration.clinical_order_id IS NULL;

-- A migration cannot safely invent either the clinician who recorded a legacy
-- exception or the medication order that governed it. Stop before installing
-- the exception obligation contract and report the exact repair population.
-- Operators can repair administered_by plus the clinical_order_id note marker
-- in the legacy row, then retry this transactional migration.
DO $mar_exception_legacy_readiness$
DECLARE
  unattributed_count INTEGER;
  missing_order_count INTEGER;
  blocked_count INTEGER;
  blocked_sample JSONB;
BEGIN
  SELECT COUNT(*) FILTER (
           WHERE CASE
             WHEN LOWER(administration.status) = 'held'
               THEN administration.held_by IS NULL OR administration.held_at IS NULL
             ELSE administration.missed_by IS NULL OR administration.missed_at IS NULL
           END
         )::INTEGER,
         COUNT(*) FILTER (
           WHERE administration.clinical_order_id IS NULL
         )::INTEGER,
         COUNT(*)::INTEGER
    INTO unattributed_count, missing_order_count, blocked_count
    FROM medication_administrations administration
   WHERE LOWER(administration.status) IN ('held', 'missed')
     AND (
       administration.clinical_order_id IS NULL
       OR CASE
            WHEN LOWER(administration.status) = 'held'
              THEN administration.held_by IS NULL OR administration.held_at IS NULL
            ELSE administration.missed_by IS NULL OR administration.missed_at IS NULL
          END
     );

  IF blocked_count > 0 THEN
    SELECT COALESCE(
             jsonb_agg(to_jsonb(blocked_row) ORDER BY blocked_row.tenant_id, blocked_row.id),
             '[]'::jsonb
           )
      INTO blocked_sample
      FROM (
        SELECT administration.tenant_id,
               administration.id,
               LOWER(administration.status) AS status,
               CASE
                 WHEN LOWER(administration.status) = 'held'
                   THEN administration.held_by IS NULL OR administration.held_at IS NULL
                 ELSE administration.missed_by IS NULL OR administration.missed_at IS NULL
               END AS missing_attribution,
               administration.clinical_order_id IS NULL AS missing_clinical_order
          FROM medication_administrations administration
         WHERE LOWER(administration.status) IN ('held', 'missed')
           AND (
             administration.clinical_order_id IS NULL
             OR CASE
                  WHEN LOWER(administration.status) = 'held'
                    THEN administration.held_by IS NULL OR administration.held_at IS NULL
                  ELSE administration.missed_by IS NULL OR administration.missed_at IS NULL
                END
           )
         ORDER BY administration.tenant_id, administration.id
         LIMIT 25
      ) blocked_row;

    RAISE EXCEPTION
      'MED-03 MAR exception readiness failed for % legacy held/missed row(s)',
      blocked_count
      USING ERRCODE = '23514',
            DETAIL = format(
              'missing_attribution=%s missing_clinical_order=%s sample=%s',
              unattributed_count,
              missing_order_count,
              blocked_sample::text
            ),
            HINT = 'Repair legacy administered_by attribution and add one valid clinical_order_id:<id> note marker for the same-tenant medication order, then retry migration 744.';
  END IF;
END
$mar_exception_legacy_readiness$;

CREATE UNIQUE INDEX ux_medication_administrations_tenant_id_med03
  ON medication_administrations (tenant_id, id);
CREATE UNIQUE INDEX ux_medication_administrations_order_identity_med03
  ON medication_administrations (tenant_id, id, clinical_order_id);
CREATE INDEX idx_medication_administrations_clinical_order
  ON medication_administrations (tenant_id, clinical_order_id, scheduled_time)
  WHERE clinical_order_id IS NOT NULL;
CREATE INDEX idx_medication_administrations_order_status
  ON medication_administrations (tenant_id, clinical_order_id, status, scheduled_time)
  WHERE clinical_order_id IS NOT NULL;
CREATE INDEX idx_medication_administrations_held_actor
  ON medication_administrations (tenant_id, held_by, held_at DESC)
  WHERE held_by IS NOT NULL;
CREATE INDEX idx_medication_administrations_missed_actor
  ON medication_administrations (tenant_id, missed_by, missed_at DESC)
  WHERE missed_by IS NOT NULL;

ALTER TABLE medication_administrations
  ADD CONSTRAINT fk_medication_administrations_clinical_order_tenant_med03
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT medication_administrations_supply_quantity_check
    CHECK (supply_quantity_per_dose IS NULL OR supply_quantity_per_dose > 0),
  ADD CONSTRAINT medication_administrations_hold_attribution_check
    CHECK (held_by IS NULL OR held_at IS NOT NULL),
  ADD CONSTRAINT medication_administrations_missed_attribution_check
    CHECK (missed_by IS NULL OR missed_at IS NOT NULL),
  ADD CONSTRAINT medication_administrations_held_exception_evidence_check
    CHECK (
      LOWER(status) <> 'held'
      OR (held_by IS NOT NULL AND held_at IS NOT NULL AND clinical_order_id IS NOT NULL)
    ),
  ADD CONSTRAINT medication_administrations_missed_exception_evidence_check
    CHECK (
      LOWER(status) <> 'missed'
      OR (missed_by IS NOT NULL AND missed_at IS NOT NULL AND clinical_order_id IS NOT NULL)
    ),
  ADD CONSTRAINT fk_medication_administrations_held_actor_med03
    FOREIGN KEY (tenant_id, held_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT fk_medication_administrations_missed_actor_med03
    FOREIGN KEY (tenant_id, missed_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION medication_administration_require_order_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  order_patient_uid UUID;
BEGIN
  IF NEW.clinical_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT clinical_order.patient_uid
    INTO order_patient_uid
    FROM clinical_orders clinical_order
   WHERE clinical_order.tenant_id = NEW.tenant_id
     AND clinical_order.id = NEW.clinical_order_id
     AND clinical_order.order_type = 'medication';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR clinical order is missing from the same tenant or is not medication'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.patient_uid IS DISTINCT FROM order_patient_uid THEN
    RAISE EXCEPTION 'MAR clinical order must match the administration patient'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS medication_administration_order_context
  ON medication_administrations;
CREATE TRIGGER medication_administration_order_context
  BEFORE INSERT OR UPDATE OF tenant_id, patient_uid, clinical_order_id
  ON medication_administrations
  FOR EACH ROW EXECUTE FUNCTION medication_administration_require_order_context();

-- A held or missed dose is not closed merely because the MAR row changed
-- state. Each occurrence owns one typed prescriber obligation, an exact SLA
-- clock, durable notification coverage, and append-only disposition evidence.
CREATE TABLE mar_medication_exception_cases (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  clinical_order_id INTEGER,
  patient_uid UUID NOT NULL,
  exception_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL,
  raised_by UUID NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  assigned_prescriber_uid UUID,
  task_id INTEGER NOT NULL,
  workflow_sla_instance_id UUID NOT NULL,
  notification_coverage_status TEXT NOT NULL DEFAULT 'pending',
  notified_at TIMESTAMPTZ,
  resolution_kind TEXT,
  resolution_event_id BIGINT,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT mar_medication_exception_kind_check
    CHECK (exception_kind IN ('held', 'missed')),
  CONSTRAINT mar_medication_exception_status_check
    CHECK (status IN ('open', 'resolved')),
  CONSTRAINT mar_medication_exception_reason_check
    CHECK (BTRIM(reason) <> ''),
  CONSTRAINT mar_medication_exception_notification_status_check
    CHECK (notification_coverage_status IN ('pending', 'notified', 'coverage_gap')),
  CONSTRAINT mar_medication_exception_resolution_kind_check
    CHECK (
      resolution_kind IS NULL
      OR resolution_kind IN (
        'hold_released',
        'reviewed_no_replacement',
        'replacement_ordered',
        'order_stopped'
      )
    ),
  CONSTRAINT mar_medication_exception_notification_shape_check
    CHECK (
      (notification_coverage_status = 'notified' AND notified_at IS NOT NULL)
      OR (notification_coverage_status IN ('pending', 'coverage_gap') AND notified_at IS NULL)
    ),
  CONSTRAINT mar_medication_exception_resolution_shape_check
    CHECK (
      (
        status = 'open'
        AND resolution_kind IS NULL
        AND resolution_event_id IS NULL
        AND resolved_by IS NULL
        AND resolved_at IS NULL
      )
      OR
      (
        status = 'resolved'
        AND resolution_kind IS NOT NULL
        AND resolution_event_id IS NOT NULL
        AND resolved_by IS NOT NULL
        AND resolved_at IS NOT NULL
      )
    ),
  CONSTRAINT fk_mar_medication_exception_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_administration
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES medication_administrations (tenant_id, id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_order_context
    FOREIGN KEY (tenant_id, medication_administration_id, clinical_order_id)
    REFERENCES medication_administrations (tenant_id, id, clinical_order_id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_raised_by
    FOREIGN KEY (tenant_id, raised_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_assigned_prescriber
    FOREIGN KEY (tenant_id, assigned_prescriber_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_sla
    FOREIGN KEY (tenant_id, workflow_sla_instance_id)
    REFERENCES workflow_sla_instances (tenant_id, id)
    ON DELETE NO ACTION,
  CONSTRAINT ux_mar_medication_exception_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_mar_medication_exception_task
    UNIQUE (tenant_id, task_id),
  CONSTRAINT ux_mar_medication_exception_sla
    UNIQUE (tenant_id, workflow_sla_instance_id)
);

CREATE UNIQUE INDEX ux_mar_medication_exception_open_occurrence
  ON mar_medication_exception_cases (tenant_id, medication_administration_id)
  WHERE status = 'open';
CREATE INDEX idx_mar_medication_exception_assignee_queue
  ON mar_medication_exception_cases
    (tenant_id, assigned_prescriber_uid, status, raised_at, id);
CREATE INDEX idx_mar_medication_exception_order
  ON mar_medication_exception_cases (tenant_id, clinical_order_id, status)
  WHERE clinical_order_id IS NOT NULL;

CREATE TABLE mar_medication_exception_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  exception_case_id BIGINT NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  disposition TEXT,
  actor_uid UUID NOT NULL,
  actor_role TEXT NOT NULL,
  reason TEXT NOT NULL,
  replacement_clinical_order_id INTEGER,
  command_key TEXT,
  request_fingerprint CHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mar_medication_exception_event_type_check
    CHECK (
      event_type IN (
        'raised',
        'resolved',
        'notification_coverage_gap',
        'assignment_handoff'
      )
    ),
  CONSTRAINT mar_medication_exception_event_reason_check
    CHECK (BTRIM(reason) <> ''),
  CONSTRAINT mar_medication_exception_event_actor_role_check
    CHECK (BTRIM(actor_role) <> ''),
  CONSTRAINT mar_medication_exception_event_payload_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT mar_medication_exception_event_command_shape_check
    CHECK (
      (command_key IS NULL AND request_fingerprint IS NULL)
      OR (
        command_key IS NOT NULL
        AND request_fingerprint IS NOT NULL
        AND BTRIM(command_key) <> ''
        AND request_fingerprint ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT mar_medication_exception_event_disposition_check
    CHECK (
      (event_type <> 'resolved' AND disposition IS NULL)
      OR (
        event_type = 'resolved'
        AND disposition IS NOT NULL
        AND disposition IN (
          'hold_released',
          'reviewed_no_replacement',
          'replacement_ordered',
          'order_stopped'
        )
      )
    ),
  CONSTRAINT mar_medication_exception_event_replacement_check
    CHECK (
      (disposition = 'replacement_ordered' AND replacement_clinical_order_id IS NOT NULL)
      OR (disposition IS DISTINCT FROM 'replacement_ordered' AND replacement_clinical_order_id IS NULL)
    ),
  CONSTRAINT fk_mar_medication_exception_event_case
    FOREIGN KEY (tenant_id, exception_case_id)
    REFERENCES mar_medication_exception_cases (tenant_id, id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_event_administration
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES medication_administrations (tenant_id, id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_event_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_medication_exception_event_replacement_order
    FOREIGN KEY (tenant_id, replacement_clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION,
  CONSTRAINT ux_mar_medication_exception_event_tenant_id
    UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX ux_mar_medication_exception_event_command
  ON mar_medication_exception_events (tenant_id, exception_case_id, command_key)
  WHERE command_key IS NOT NULL;
CREATE INDEX idx_mar_medication_exception_event_case
  ON mar_medication_exception_events (tenant_id, exception_case_id, occurred_at, id);

ALTER TABLE mar_medication_exception_cases
  ADD CONSTRAINT fk_mar_medication_exception_resolution_event
    FOREIGN KEY (tenant_id, resolution_event_id)
    REFERENCES mar_medication_exception_events (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER mar_medication_exception_events_append_only
  BEFORE UPDATE OR DELETE ON mar_medication_exception_events
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE OR REPLACE FUNCTION mar_medication_exception_event_actor_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  medication_administration_roles CONSTANT TEXT[] := ARRAY[
    'ADMIN',
    'SUPER_ADMIN',
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'CNO',
    'ICU_NURSE',
    'ICU_INCHARGE',
    'ICU_STAFF'
  ]::TEXT[];
  prescriber_roles CONSTANT TEXT[] := ARRAY[
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'JUNIOR_DOCTOR',
    'RESIDENT'
  ]::TEXT[];
  admin_roles CONSTANT TEXT[] := ARRAY[
    'ADMIN',
    'SUPER_ADMIN'
  ]::TEXT[];
  expected_handoff_receipt TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.uid = NEW.actor_uid
       AND actor.role = NEW.actor_role
       AND actor.role = ANY(
         CASE NEW.event_type
           WHEN 'resolved' THEN prescriber_roles
           WHEN 'assignment_handoff' THEN admin_roles
           ELSE medication_administration_roles
         END
       )
       AND actor.is_active = TRUE
       AND COALESCE(actor.is_deleted, FALSE) = FALSE
       AND actor.deleted_at IS NULL
       AND LOWER(COALESCE(actor.status, 'active')) = 'active'
  ) THEN
    RAISE EXCEPTION 'MAR medication exception event actor lacks exact active role authority'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type = 'assignment_handoff' THEN
    IF NEW.command_key IS NULL
       OR NEW.request_fingerprint IS NULL
       OR COALESCE(NEW.payload->>'from_prescriber_uid', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR COALESCE(NEW.payload->>'to_prescriber_uid', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR COALESCE(NEW.payload->>'task_id', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(NEW.payload->>'workflow_sla_instance_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR COALESCE(NEW.payload->>'notification_outbox_id', '') !~ '^[1-9][0-9]*$'
    THEN
      RAISE EXCEPTION 'MAR medication exception handoff command identity is invalid'
        USING ERRCODE = '23514';
    END IF;

    expected_handoff_receipt := 'mar-exception-handoff-v1:' || encode(
      digest(
        convert_to(
          NEW.tenant_id::text || ':' || NEW.exception_case_id::text || ':'
            || NEW.command_key || ':' || NEW.request_fingerprint::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    IF NEW.payload IS DISTINCT FROM jsonb_build_object(
         'version', 'mar_medication_exception_assignment_handoff_v1',
         'from_prescriber_uid', LOWER(NEW.payload->>'from_prescriber_uid'),
         'to_prescriber_uid', LOWER(NEW.payload->>'to_prescriber_uid'),
         'task_id', NEW.payload->>'task_id',
         'workflow_sla_instance_id', LOWER(NEW.payload->>'workflow_sla_instance_id'),
         'notification_outbox_id', NEW.payload->>'notification_outbox_id',
         'handoff_receipt', expected_handoff_receipt
       )
       OR NOT EXISTS (
         SELECT 1
           FROM mar_medication_exception_cases exception_case
           JOIN tasks task
             ON task.tenant_id = exception_case.tenant_id
            AND task.id = exception_case.task_id
           JOIN workflow_sla_instances sla
             ON sla.tenant_id = exception_case.tenant_id
            AND sla.id = exception_case.workflow_sla_instance_id
           JOIN users target_prescriber
             ON target_prescriber.tenant_id = exception_case.tenant_id
            AND target_prescriber.uid::text = NEW.payload->>'to_prescriber_uid'
            AND target_prescriber.role = ANY(prescriber_roles)
            AND target_prescriber.is_active = TRUE
            AND COALESCE(target_prescriber.is_deleted, FALSE) = FALSE
            AND target_prescriber.deleted_at IS NULL
            AND LOWER(COALESCE(target_prescriber.status, 'active')) = 'active'
           JOIN notification_outbox outbox
             ON outbox.tenant_id = exception_case.tenant_id
            AND outbox.id::text = NEW.payload->>'notification_outbox_id'
            AND outbox.recipient_id = target_prescriber.id::text
          WHERE exception_case.tenant_id = NEW.tenant_id
            AND exception_case.id = NEW.exception_case_id
            AND exception_case.medication_administration_id = NEW.medication_administration_id
            AND exception_case.status = 'open'
            AND exception_case.assigned_prescriber_uid::text =
                  NEW.payload->>'from_prescriber_uid'
            AND exception_case.assigned_prescriber_uid IS DISTINCT FROM
                  target_prescriber.uid
            AND task.id::text = NEW.payload->>'task_id'
            AND task.assigned_to_uid = exception_case.assigned_prescriber_uid
            AND task.assigned_to_role IS NULL
            AND task.status IN ('open', 'in_progress', 'overdue')
            AND sla.id::text = NEW.payload->>'workflow_sla_instance_id'
            AND sla.assigned_user_uid = exception_case.assigned_prescriber_uid
            AND sla.completed_at IS NULL
            AND sla.status IN ('active', 'breached', 'escalated')
            AND outbox.type = 'mar_medication_exception_assignment_handoff'
            AND outbox.channel = 'inapp'
            AND outbox.title = 'Medication exception reassigned for prescriber review'
            AND outbox.body =
                  'An administrator reassigned an open held or missed medication exception to you.'
            AND outbox.source_event_key =
                  'mar-exception:' || exception_case.id::text
                    || ':handoff:' || NEW.id::text
            AND outbox.template_version =
                  'mar-medication-exception-assignment-handoff.v1'
            AND outbox.payload->>'kind' =
                  'mar_medication_exception_assignment_handoff'
            AND outbox.payload->>'exception_case_id' = exception_case.id::text
            AND outbox.payload->>'medication_administration_id' =
                  exception_case.medication_administration_id::text
            AND outbox.payload->>'task_id' = task.id::text
            AND outbox.payload->>'from_prescriber_uid' =
                  exception_case.assigned_prescriber_uid::text
            AND outbox.payload->>'to_prescriber_uid' = target_prescriber.uid::text
            AND outbox.payload->>'recipient_role' = target_prescriber.role
            AND outbox.payload->>'action_label_key' = 'orders.mar_recovery.action'
            AND outbox.payload->>'deep_link' =
                  '/mar/due?exception_id=' || exception_case.id::text
       )
    THEN
      RAISE EXCEPTION 'MAR medication exception handoff lacks exact case, task, SLA, recipient, and outbox evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_medication_exception_event_actor_guard
  BEFORE INSERT ON mar_medication_exception_events
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_event_actor_guard();

CREATE OR REPLACE FUNCTION mar_medication_exception_case_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MAR medication exception cases cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.medication_administration_id IS DISTINCT FROM OLD.medication_administration_id
    OR NEW.clinical_order_id IS DISTINCT FROM OLD.clinical_order_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.exception_kind IS DISTINCT FROM OLD.exception_kind
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.raised_by IS DISTINCT FROM OLD.raised_by
    OR NEW.raised_at IS DISTINCT FROM OLD.raised_at
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
  ) THEN
    RAISE EXCEPTION 'MAR medication exception identity and obligation links are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'resolved' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'resolved MAR medication exceptions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.assigned_prescriber_uid IS NOT NULL
     AND NEW.assigned_prescriber_uid IS DISTINCT FROM OLD.assigned_prescriber_uid
     AND (
       NEW.assigned_prescriber_uid IS NULL
       OR OLD.status IS DISTINCT FROM 'open'
       OR NOT EXISTS (
         SELECT 1
           FROM mar_medication_exception_events handoff_event
           JOIN tasks task
             ON task.tenant_id = NEW.tenant_id
            AND task.id = NEW.task_id
           JOIN workflow_sla_instances sla
             ON sla.tenant_id = NEW.tenant_id
            AND sla.id = NEW.workflow_sla_instance_id
          WHERE handoff_event.tenant_id = NEW.tenant_id
            AND handoff_event.exception_case_id = NEW.id
            AND handoff_event.medication_administration_id =
                  NEW.medication_administration_id
            AND handoff_event.event_type = 'assignment_handoff'
            AND handoff_event.disposition IS NULL
            AND handoff_event.payload->>'from_prescriber_uid' =
                  OLD.assigned_prescriber_uid::text
            AND handoff_event.payload->>'to_prescriber_uid' =
                  NEW.assigned_prescriber_uid::text
            AND handoff_event.payload->>'task_id' = NEW.task_id::text
            AND handoff_event.payload->>'workflow_sla_instance_id' =
                  NEW.workflow_sla_instance_id::text
            AND task.assigned_to_uid = NEW.assigned_prescriber_uid
            AND task.assigned_to_role IS NULL
            AND task.metadata->>'assignment_handoff_event_id' =
                  handoff_event.id::text
            AND task.metadata->>'assignment_handoff_receipt' =
                  handoff_event.payload->>'handoff_receipt'
            AND sla.assigned_user_uid = NEW.assigned_prescriber_uid
            AND sla.metadata->>'assignment_handoff_event_id' =
                  handoff_event.id::text
            AND sla.metadata->>'assignment_handoff_receipt' =
                  handoff_event.payload->>'handoff_receipt'
       )
     )
  THEN
    RAISE EXCEPTION 'MAR medication exception prescriber assignment requires a governed handoff receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.assigned_prescriber_uid IS NULL
     AND NEW.assigned_prescriber_uid IS NOT NULL
     AND OLD.status IS DISTINCT FROM 'open'
  THEN
    RAISE EXCEPTION 'only an open MAR medication exception can be claimed'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.notification_coverage_status = 'notified'
     AND NEW.notification_coverage_status IS DISTINCT FROM 'notified'
  THEN
    RAISE EXCEPTION 'MAR medication exception notification coverage cannot regress'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_medication_exception_case_guard
  BEFORE UPDATE OR DELETE ON mar_medication_exception_cases
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_case_guard();

CREATE OR REPLACE FUNCTION mar_medication_exception_case_receipt_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  current_case mar_medication_exception_cases%ROWTYPE;
  administration_record medication_administrations%ROWTYPE;
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  prescriber_roles CONSTANT TEXT[] := ARRAY[
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'JUNIOR_DOCTOR',
    'RESIDENT'
  ]::TEXT[];
  medication_administration_roles CONSTANT TEXT[] := ARRAY[
    'ADMIN',
    'SUPER_ADMIN',
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'CNO',
    'ICU_NURSE',
    'ICU_INCHARGE',
    'ICU_STAFF'
  ]::TEXT[];
BEGIN
  IF TG_TABLE_NAME = 'mar_medication_exception_cases' THEN
    SELECT exception_case.*
      INTO current_case
      FROM mar_medication_exception_cases exception_case
     WHERE exception_case.tenant_id = NEW.tenant_id
       AND exception_case.id::text = NEW.id::text;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP = 'INSERT'
       AND NEW.metadata->>'task_contract' IS DISTINCT FROM 'mar_medication_exception_v1'
       AND NEW.related_resource_type IS DISTINCT FROM 'mar_medication_exception_cases'
    THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.metadata->>'task_contract' IS DISTINCT FROM 'mar_medication_exception_v1'
       AND NEW.related_resource_type IS DISTINCT FROM 'mar_medication_exception_cases'
       AND OLD.metadata->>'task_contract' IS DISTINCT FROM 'mar_medication_exception_v1'
       AND OLD.related_resource_type IS DISTINCT FROM 'mar_medication_exception_cases'
    THEN
      RETURN NULL;
    END IF;
    SELECT exception_case.*
      INTO current_case
      FROM mar_medication_exception_cases exception_case
     WHERE exception_case.tenant_id = NEW.tenant_id
       AND exception_case.task_id::text = NEW.id::text;
  ELSIF TG_TABLE_NAME = 'workflow_sla_instances' THEN
    IF TG_OP = 'INSERT'
       AND NEW.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
    THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
       AND OLD.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
    THEN
      RETURN NULL;
    END IF;
    SELECT exception_case.*
      INTO current_case
      FROM mar_medication_exception_cases exception_case
     WHERE exception_case.tenant_id = NEW.tenant_id
       AND exception_case.workflow_sla_instance_id::text = NEW.id::text;
  ELSIF TG_TABLE_NAME = 'medication_administrations' THEN
    SELECT exception_case.*
      INTO current_case
      FROM mar_medication_exception_cases exception_case
     WHERE exception_case.status = 'open'
       AND (
         (
           exception_case.tenant_id = NEW.tenant_id
           AND exception_case.medication_administration_id = NEW.id
         )
         OR (
           exception_case.tenant_id = OLD.tenant_id
           AND exception_case.medication_administration_id = OLD.id
         )
       )
     ORDER BY exception_case.id
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported MAR medication exception receipt trigger source'
      USING ERRCODE = '23514';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR medication exception obligation has no durable case'
      USING ERRCODE = '23514';
  END IF;

  SELECT task.* INTO task_record
    FROM tasks task
   WHERE task.tenant_id = current_case.tenant_id
     AND task.id = current_case.task_id;
  SELECT sla.* INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = current_case.tenant_id
     AND sla.id = current_case.workflow_sla_instance_id;
  SELECT administration.* INTO administration_record
    FROM medication_administrations administration
   WHERE administration.tenant_id = current_case.tenant_id
     AND administration.id = current_case.medication_administration_id;

  IF task_record.id IS NULL
     OR administration_record.id IS NULL
     OR sla_record.id IS NULL
     OR task_record.task_kind IS DISTINCT FROM 'review'
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
     OR task_record.workflow_sla_instance_id IS DISTINCT FROM sla_record.id
     OR task_record.metadata->>'task_contract' IS DISTINCT FROM 'mar_medication_exception_v1'
     OR task_record.metadata->>'exception_case_id' IS DISTINCT FROM current_case.id::text
     OR task_record.metadata->>'medication_administration_id'
          IS DISTINCT FROM current_case.medication_administration_id::text
     OR task_record.metadata->>'exception_kind'
          IS DISTINCT FROM current_case.exception_kind
     OR task_record.related_resource_type IS DISTINCT FROM 'mar_medication_exception_cases'
     OR task_record.related_resource_id IS DISTINCT FROM current_case.id::text
     OR task_record.patient_uid IS DISTINCT FROM current_case.patient_uid
     OR sla_record.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
     OR sla_record.priority IS DISTINCT FROM 'critical'
     OR sla_record.source_table IS DISTINCT FROM task_record.related_resource_type
     OR sla_record.source_id IS DISTINCT FROM task_record.related_resource_id
     OR sla_record.patient_uid IS DISTINCT FROM current_case.patient_uid
     OR administration_record.patient_uid IS DISTINCT FROM current_case.patient_uid
     OR administration_record.clinical_order_id IS DISTINCT FROM current_case.clinical_order_id
     OR task_record.metadata->>'assignment_origin' IS NULL
     OR task_record.metadata->>'assignment_origin' NOT IN (
       'source_prescriber',
       'prescriber_coverage_queue'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM mar_medication_exception_events raised_event
        WHERE raised_event.tenant_id = current_case.tenant_id
          AND raised_event.exception_case_id = current_case.id
          AND raised_event.medication_administration_id = current_case.medication_administration_id
          AND raised_event.event_type = 'raised'
          AND raised_event.disposition IS NULL
          AND raised_event.actor_uid = current_case.raised_by
          AND raised_event.actor_role = ANY(medication_administration_roles)
          AND raised_event.reason = current_case.reason
          AND date_trunc('milliseconds', raised_event.occurred_at) =
                date_trunc('milliseconds', current_case.raised_at)
     )
     OR (
       current_case.assigned_prescriber_uid IS NULL
       AND (
         task_record.metadata->>'assignment_origin'
              IS DISTINCT FROM 'prescriber_coverage_queue'
         OR task_record.assigned_to_uid IS NOT NULL
         OR task_record.assigned_to_role IS DISTINCT FROM 'DOCTOR'
         OR sla_record.assigned_user_uid IS NOT NULL
         OR cardinality(COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[]))
              IS DISTINCT FROM cardinality(prescriber_roles)
         OR NOT COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])
              @> prescriber_roles
         OR NOT COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])
              <@ prescriber_roles
       )
     )
     OR (
       current_case.assigned_prescriber_uid IS NOT NULL
       AND (
         task_record.assigned_to_uid IS DISTINCT FROM current_case.assigned_prescriber_uid
         OR task_record.assigned_to_role IS NOT NULL
         OR sla_record.assigned_user_uid IS DISTINCT FROM current_case.assigned_prescriber_uid
          OR NOT EXISTS (
            SELECT 1
              FROM users assigned_prescriber
            WHERE assigned_prescriber.tenant_id = current_case.tenant_id
              AND assigned_prescriber.uid = current_case.assigned_prescriber_uid
              AND assigned_prescriber.role = ANY(prescriber_roles)
              AND assigned_prescriber.is_active = TRUE
              AND COALESCE(assigned_prescriber.is_deleted, FALSE) = FALSE
              AND assigned_prescriber.deleted_at IS NULL
               AND LOWER(COALESCE(assigned_prescriber.status, 'active')) = 'active'
          )
          OR (
            NOT (task_record.metadata ? 'assignment_handoff_event_id')
            AND (
              (
                task_record.metadata->>'assignment_origin' = 'source_prescriber'
                AND (
                  cardinality(COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[]))
                    IS DISTINCT FROM cardinality(prescriber_roles)
                  OR NOT COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])
                    @> prescriber_roles
                  OR NOT COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])
                    <@ prescriber_roles
                  OR task_record.metadata ? 'role_claim_receipt'
                  OR task_record.metadata ? 'role_claim_command_fingerprint'
                  OR task_record.metadata ? 'role_claimed_by'
                  OR task_record.metadata ? 'role_claimed_from_role'
                  OR task_record.metadata ? 'role_claimed_at'
                  OR task_record.metadata ? 'role_claimed_actor_role'
                  OR task_record.metadata ? 'role_claimed_actor_raw_role'
                )
              )
              OR (
                task_record.metadata->>'assignment_origin' =
                  'prescriber_coverage_queue'
                AND (
                  cardinality(COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])) <> 0
                  OR COALESCE(task_record.metadata->>'role_claim_receipt', '')
                       !~ '^task-claim-v1:[0-9a-f]{64}$'
                  OR COALESCE(
                       task_record.metadata->>'role_claim_command_fingerprint',
                       ''
                     ) !~ '^[0-9a-f]{64}$'
                  OR LOWER(task_record.metadata->>'role_claimed_by')
                       IS DISTINCT FROM LOWER(current_case.assigned_prescriber_uid::text)
                  OR task_record.metadata->>'role_claimed_from_role'
                       IS DISTINCT FROM 'DOCTOR'
                  OR pg_input_is_valid(
                       task_record.metadata->>'role_claimed_at',
                       'timestamp with time zone'
                     ) IS NOT TRUE
                  OR NOT EXISTS (
                    SELECT 1
                      FROM users claimed_prescriber
                     WHERE claimed_prescriber.tenant_id = current_case.tenant_id
                       AND claimed_prescriber.uid = current_case.assigned_prescriber_uid
                       AND claimed_prescriber.role = ANY(prescriber_roles)
                       AND claimed_prescriber.role =
                             task_record.metadata->>'role_claimed_actor_role'
                       AND claimed_prescriber.role =
                             task_record.metadata->>'role_claimed_actor_raw_role'
                       AND claimed_prescriber.is_active = TRUE
                       AND COALESCE(claimed_prescriber.is_deleted, FALSE) = FALSE
                       AND claimed_prescriber.deleted_at IS NULL
                       AND LOWER(COALESCE(claimed_prescriber.status, 'active')) = 'active'
                  )
                  OR NOT EXISTS (
                    SELECT 1
                      FROM task_comments claim_comment
                     WHERE claim_comment.tenant_id = current_case.tenant_id
                       AND claim_comment.task_id = task_record.id
                       AND claim_comment.author_uid = current_case.assigned_prescriber_uid
                       AND claim_comment.body_kind = 'state_change'
                       AND claim_comment.metadata->>'from_assigned_to_role' = 'DOCTOR'
                       AND LOWER(claim_comment.metadata->>'to_assigned_to_uid') =
                             LOWER(current_case.assigned_prescriber_uid::text)
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
            )
          )
          OR (
            task_record.metadata ? 'assignment_handoff_event_id'
            AND (
              cardinality(COALESCE(sla_record.assigned_role_codes, ARRAY[]::text[])) <> 0
              OR COALESCE(task_record.metadata->>'assignment_handoff_event_id', '')
                   !~ '^[1-9][0-9]*$'
              OR COALESCE(task_record.metadata->>'assignment_handoff_receipt', '')
                   !~ '^mar-exception-handoff-v1:[0-9a-f]{64}$'
              OR COALESCE(
                   task_record.metadata->>'assignment_handoff_command_fingerprint',
                   ''
                 ) !~ '^[0-9a-f]{64}$'
              OR task_record.metadata->>'assignment_handoff_to_uid' IS DISTINCT FROM
                   current_case.assigned_prescriber_uid::text
              OR task_record.metadata->>'assignment_handoff_task_id' IS DISTINCT FROM
                   current_case.task_id::text
              OR task_record.metadata->>'assignment_handoff_sla_id' IS DISTINCT FROM
                   current_case.workflow_sla_instance_id::text
              OR task_record.metadata->>'assignment_handoff_actor_role'
                   NOT IN ('ADMIN', 'SUPER_ADMIN')
              OR pg_input_is_valid(
                   task_record.metadata->>'assignment_handoff_at',
                   'timestamp with time zone'
                 ) IS NOT TRUE
              OR sla_record.metadata->>'assignment_handoff_event_id' IS DISTINCT FROM
                   task_record.metadata->>'assignment_handoff_event_id'
              OR sla_record.metadata->>'assignment_handoff_receipt' IS DISTINCT FROM
                   task_record.metadata->>'assignment_handoff_receipt'
              OR sla_record.metadata->>'assignment_handoff_from_uid' IS DISTINCT FROM
                   task_record.metadata->>'assignment_handoff_from_uid'
              OR sla_record.metadata->>'assignment_handoff_to_uid' IS DISTINCT FROM
                   current_case.assigned_prescriber_uid::text
              OR sla_record.metadata->>'assignment_handoff_at' IS DISTINCT FROM
                   task_record.metadata->>'assignment_handoff_at'
              OR NOT EXISTS (
                SELECT 1
                  FROM mar_medication_exception_events handoff_event
                  JOIN notification_outbox outbox
                    ON outbox.tenant_id = handoff_event.tenant_id
                   AND outbox.id::text =
                         handoff_event.payload->>'notification_outbox_id'
                  JOIN users handoff_actor
                    ON handoff_actor.tenant_id = handoff_event.tenant_id
                   AND handoff_actor.uid = handoff_event.actor_uid
                   AND handoff_actor.role = handoff_event.actor_role
                   AND handoff_actor.role IN ('ADMIN', 'SUPER_ADMIN')
                 WHERE handoff_event.tenant_id = current_case.tenant_id
                   AND handoff_event.id::text =
                         task_record.metadata->>'assignment_handoff_event_id'
                   AND handoff_event.exception_case_id = current_case.id
                   AND handoff_event.medication_administration_id =
                         current_case.medication_administration_id
                   AND handoff_event.event_type = 'assignment_handoff'
                   AND handoff_event.disposition IS NULL
                   AND handoff_event.actor_uid::text =
                         task_record.metadata->>'assignment_handoff_actor_uid'
                   AND handoff_event.actor_role =
                         task_record.metadata->>'assignment_handoff_actor_role'
                   AND handoff_event.reason =
                         task_record.metadata->>'assignment_handoff_reason'
                   AND handoff_event.request_fingerprint::text =
                         task_record.metadata->>'assignment_handoff_command_fingerprint'
                   AND handoff_event.payload->>'handoff_receipt' =
                         task_record.metadata->>'assignment_handoff_receipt'
                   AND handoff_event.payload->>'from_prescriber_uid' =
                         task_record.metadata->>'assignment_handoff_from_uid'
                   AND handoff_event.payload->>'to_prescriber_uid' =
                         current_case.assigned_prescriber_uid::text
                   AND handoff_event.payload->>'task_id' = current_case.task_id::text
                   AND handoff_event.payload->>'workflow_sla_instance_id' =
                         current_case.workflow_sla_instance_id::text
                   AND handoff_event.payload->>'notification_outbox_id' =
                         task_record.metadata->>'assignment_handoff_outbox_id'
                   AND date_trunc('milliseconds', handoff_event.occurred_at) =
                         date_trunc(
                           'milliseconds',
                           (task_record.metadata->>'assignment_handoff_at')::timestamptz
                         )
                   AND date_trunc('milliseconds', current_case.notified_at) =
                         date_trunc('milliseconds', handoff_event.occurred_at)
                   AND outbox.recipient_id = (
                         SELECT target.id::text
                           FROM users target
                          WHERE target.tenant_id = current_case.tenant_id
                            AND target.uid = current_case.assigned_prescriber_uid
                            AND target.role = ANY(prescriber_roles)
                            AND target.is_active = TRUE
                            AND COALESCE(target.is_deleted, FALSE) = FALSE
                            AND target.deleted_at IS NULL
                            AND LOWER(COALESCE(target.status, 'active')) = 'active'
                         LIMIT 1
                       )
                   AND outbox.source_event_key =
                         'mar-exception:' || current_case.id::text
                           || ':handoff:' || handoff_event.id::text
                   AND outbox.type = 'mar_medication_exception_assignment_handoff'
                   AND outbox.channel = 'inapp'
                   AND outbox.template_version =
                         'mar-medication-exception-assignment-handoff.v1'
                   AND outbox.payload->>'to_prescriber_uid' =
                         current_case.assigned_prescriber_uid::text
                   AND outbox.payload->>'recipient_role' = (
                         SELECT target.role
                           FROM users target
                          WHERE target.tenant_id = current_case.tenant_id
                            AND target.uid = current_case.assigned_prescriber_uid
                          LIMIT 1
                        )
                   AND outbox.payload->>'action_label_key' =
                         'orders.mar_recovery.action'
              )
            )
          )
        )
      )
     OR (
       (
         sla_record.status = 'escalated'
         OR sla_record.escalated_at IS NOT NULL
         OR COALESCE(sla_record.metadata, '{}'::jsonb)
              ? 'mar_exception_escalation_version'
         OR COALESCE(task_record.metadata, '{}'::jsonb)
              ? 'mar_exception_escalation_version'
       )
       AND (
         sla_record.status IS DISTINCT FROM 'escalated'
         OR sla_record.escalated_at IS NULL
         OR sla_record.breached_at IS NULL
         OR task_record.sla_breached_at IS NULL
         OR date_trunc('milliseconds', task_record.sla_breached_at)
              IS DISTINCT FROM date_trunc('milliseconds', sla_record.breached_at)
         OR task_record.status NOT IN ('in_progress', 'overdue', 'completed')
         OR sla_record.metadata->>'mar_exception_escalation_version'
              IS DISTINCT FROM 'mar_medication_exception_escalation_v1'
         OR task_record.metadata->>'mar_exception_escalation_version'
              IS DISTINCT FROM 'mar_medication_exception_escalation_v1'
         OR COALESCE(
              sla_record.metadata->>'mar_exception_escalation_recipient_count',
              ''
            ) !~ '^[1-9][0-9]*$'
         OR jsonb_typeof(
              sla_record.metadata->'mar_exception_escalation_outbox_ids'
            ) IS DISTINCT FROM 'array'
         OR task_record.metadata->'mar_exception_escalation_outbox_ids'
              IS DISTINCT FROM
                sla_record.metadata->'mar_exception_escalation_outbox_ids'
         OR task_record.metadata->>'mar_exception_escalation_recipient_count'
              IS DISTINCT FROM
                sla_record.metadata->>'mar_exception_escalation_recipient_count'
         OR task_record.metadata->'mar_exception_escalated_at'
              IS DISTINCT FROM sla_record.metadata->'mar_exception_escalated_at'
         OR CASE
              WHEN pg_input_is_valid(
                sla_record.metadata->>'mar_exception_escalated_at',
                'timestamp with time zone'
              )
                THEN date_trunc(
                       'milliseconds',
                       (sla_record.metadata->>'mar_exception_escalated_at')::timestamptz
                     ) IS DISTINCT FROM
                       date_trunc('milliseconds', sla_record.escalated_at)
              ELSE TRUE
            END
         OR CASE
              WHEN jsonb_typeof(
                sla_record.metadata->'mar_exception_escalation_outbox_ids'
              ) = 'array'
                THEN EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(
                           sla_record.metadata->'mar_exception_escalation_outbox_ids'
                         ) outbox_id(value)
                   WHERE outbox_id.value !~ '^[1-9][0-9]*$'
                )
              ELSE TRUE
            END
         OR CASE
              WHEN jsonb_typeof(
                sla_record.metadata->'mar_exception_escalation_outbox_ids'
              ) = 'array'
                THEN jsonb_array_length(
                       sla_record.metadata->'mar_exception_escalation_outbox_ids'
                     ) IS DISTINCT FROM
                       CASE
                         WHEN sla_record.metadata
                                ->>'mar_exception_escalation_recipient_count'
                                ~ '^[1-9][0-9]*$'
                           THEN (
                             sla_record.metadata
                               ->>'mar_exception_escalation_recipient_count'
                           )::integer
                         ELSE 0
                       END
              ELSE TRUE
            END
          OR (
            SELECT COUNT(DISTINCT outbox.id)::integer
              FROM notification_outbox outbox
             WHERE outbox.tenant_id = current_case.tenant_id
              AND outbox.id::text IN (
                SELECT outbox_id.value
                  FROM jsonb_array_elements_text(
                         CASE
                           WHEN jsonb_typeof(
                             sla_record.metadata
                               ->'mar_exception_escalation_outbox_ids'
                           ) = 'array'
                             THEN sla_record.metadata
                               ->'mar_exception_escalation_outbox_ids'
                           ELSE '[]'::jsonb
                         END
                       ) outbox_id(value)
              )
              AND outbox.recipient_id IS NOT NULL
              AND outbox.source_event_key =
                    'mar-exception:' || current_case.id::text
                    || ':overdue:' || outbox.recipient_id
              AND outbox.type = 'mar_medication_exception_escalation'
              AND outbox.channel = 'inapp'
              AND outbox.template_version =
                    'mar-medication-exception-escalation.v1'
              AND outbox.payload->>'kind' =
                    'mar_medication_exception_escalation'
              AND outbox.payload->>'exception_case_id' = current_case.id::text
              AND outbox.payload->>'task_id' = current_case.task_id::text
              AND outbox.payload->>'medication_administration_id' =
                    current_case.medication_administration_id::text
              AND outbox.payload->>'patient_uid' = current_case.patient_uid::text
              AND outbox.payload->>'deep_link' =
                    '/mar/due?exception_id=' || current_case.id::text
              AND outbox.payload->>'recipient_role' IN (
                'MEDICAL_SUPERINTENDENT', 'ADMIN', 'SUPER_ADMIN'
              )
              AND outbox.payload->>'action_label_key' =
                    'orders.mar_recovery.action'
         ) IS DISTINCT FROM
              CASE
                WHEN sla_record.metadata->>'mar_exception_escalation_recipient_count'
                       ~ '^[1-9][0-9]*$'
                  THEN (
                    sla_record.metadata->>'mar_exception_escalation_recipient_count'
                  )::integer
                ELSE 0
              END
       )
     )
  THEN
    RAISE EXCEPTION 'MAR medication exception lacks its exact typed task and SLA binding'
      USING ERRCODE = '23514';
  END IF;

  IF current_case.notification_coverage_status = 'pending'
     OR (
       current_case.notification_coverage_status = 'notified'
       AND (
         current_case.assigned_prescriber_uid IS NULL
         OR current_case.notified_at IS NULL
           OR (
             NOT (task_record.metadata ? 'assignment_handoff_event_id')
             AND (
               task_record.metadata->>'assignment_origin' =
                 'prescriber_coverage_queue'
               AND COALESCE(task_record.metadata->>'role_claim_receipt', '')
                     ~ '^task-claim-v1:[0-9a-f]{64}$'
               AND LOWER(task_record.metadata->>'role_claimed_by') =
                     LOWER(current_case.assigned_prescriber_uid::text)
               AND pg_input_is_valid(
                     task_record.metadata->>'role_claimed_at',
                     'timestamp with time zone'
                   )
               AND date_trunc('milliseconds', current_case.notified_at) =
                     date_trunc(
                       'milliseconds',
                       (task_record.metadata->>'role_claimed_at')::timestamptz
                     )
             ) IS NOT TRUE
             AND NOT EXISTS (
              SELECT 1
                FROM mar_medication_exception_events raised_event
                JOIN users recipient
                  ON recipient.tenant_id = current_case.tenant_id
                 AND recipient.uid = current_case.assigned_prescriber_uid
                JOIN notification_outbox outbox
                  ON outbox.tenant_id = current_case.tenant_id
                 AND outbox.recipient_id = recipient.id::text
                 AND outbox.source_event_key =
                       'mar-exception:' || current_case.id::text
                       || ':raised:' || raised_event.id::text
               WHERE raised_event.tenant_id = current_case.tenant_id
                 AND raised_event.exception_case_id = current_case.id
                 AND raised_event.medication_administration_id =
                       current_case.medication_administration_id
                 AND raised_event.event_type = 'raised'
                 AND outbox.type = 'mar_medication_exception'
                 AND outbox.channel = 'inapp'
                 AND outbox.template_version = 'mar-medication-exception.v1'
                 AND outbox.payload->>'kind' = 'mar_medication_exception'
                 AND outbox.payload->>'task_id' = current_case.task_id::text
                 AND outbox.payload->>'exception_case_id' = current_case.id::text
                 AND outbox.payload->>'medication_administration_id' =
                       current_case.medication_administration_id::text
                 AND outbox.payload->>'deep_link' =
                       '/mar/due?exception_id=' || current_case.id::text
                 AND outbox.payload->>'action_label_key' =
                       'orders.mar_recovery.action'
                 AND outbox.created_at <= current_case.notified_at
            )
          )
        )
      )
     OR (
       current_case.notification_coverage_status = 'coverage_gap'
       AND (
         current_case.assigned_prescriber_uid IS NOT NULL
         OR current_case.notified_at IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
             FROM mar_medication_exception_events gap_event
            WHERE gap_event.tenant_id = current_case.tenant_id
              AND gap_event.exception_case_id = current_case.id
              AND gap_event.medication_administration_id =
                    current_case.medication_administration_id
              AND gap_event.event_type = 'notification_coverage_gap'
              AND gap_event.disposition IS NULL
              AND gap_event.actor_uid = current_case.raised_by
              AND gap_event.actor_role = ANY(medication_administration_roles)
              AND gap_event.reason = 'No active prescriber recipient was available'
              AND gap_event.payload->'intended_roles' = to_jsonb(prescriber_roles)
              AND gap_event.occurred_at >= current_case.raised_at
         )
       )
     )
  THEN
    RAISE EXCEPTION 'MAR medication exception notification coverage is not durable'
      USING ERRCODE = '23514';
  END IF;

  IF current_case.status = 'open' THEN
    IF (
         current_case.exception_kind = 'held'
         AND (
           LOWER(administration_record.status) IS DISTINCT FROM 'held'
           OR administration_record.held_by IS DISTINCT FROM current_case.raised_by
           OR date_trunc('milliseconds', administration_record.held_at) IS DISTINCT FROM
                date_trunc('milliseconds', current_case.raised_at)
         )
       )
       OR (
         current_case.exception_kind = 'missed'
         AND (
           LOWER(administration_record.status) IS DISTINCT FROM 'missed'
           OR administration_record.missed_by IS DISTINCT FROM current_case.raised_by
           OR date_trunc('milliseconds', administration_record.missed_at) IS DISTINCT FROM
                date_trunc('milliseconds', current_case.raised_at)
         )
       )
       OR task_record.status NOT IN ('open', 'in_progress', 'overdue')
       OR task_record.completed_at IS NOT NULL
       OR sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
    THEN
      RAISE EXCEPTION 'open MAR medication exception requires an actionable task and SLA'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF task_record.status IS DISTINCT FROM 'completed'
     OR task_record.completed_at IS NULL
     OR sla_record.completed_at IS NULL
     OR date_trunc('milliseconds', task_record.completed_at) IS DISTINCT FROM
          date_trunc('milliseconds', sla_record.completed_at)
     OR date_trunc('milliseconds', current_case.resolved_at) IS DISTINCT FROM
          date_trunc('milliseconds', sla_record.completed_at)
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
     OR current_case.assigned_prescriber_uid IS NULL
     OR current_case.resolved_by IS DISTINCT FROM current_case.assigned_prescriber_uid
     OR NOT EXISTS (
       SELECT 1
         FROM mar_medication_exception_events event
         JOIN users resolution_actor
           ON resolution_actor.tenant_id = event.tenant_id
          AND resolution_actor.uid = event.actor_uid
          AND resolution_actor.role = event.actor_role
          AND resolution_actor.role = ANY(prescriber_roles)
          AND resolution_actor.is_active = TRUE
          AND COALESCE(resolution_actor.is_deleted, FALSE) = FALSE
          AND resolution_actor.deleted_at IS NULL
          AND LOWER(COALESCE(resolution_actor.status, 'active')) = 'active'
        WHERE event.tenant_id = current_case.tenant_id
          AND event.id = current_case.resolution_event_id
          AND event.exception_case_id = current_case.id
          AND event.medication_administration_id = current_case.medication_administration_id
          AND event.event_type = 'resolved'
          AND event.disposition = current_case.resolution_kind
          AND event.actor_uid = current_case.assigned_prescriber_uid
          AND date_trunc('milliseconds', event.occurred_at) =
                date_trunc('milliseconds', current_case.resolved_at)
     )
  THEN
    RAISE EXCEPTION 'resolved MAR medication exception lacks exact domain evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER mar_medication_exception_case_receipt_guard
  AFTER INSERT OR UPDATE ON mar_medication_exception_cases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_case_receipt_guard();

CREATE CONSTRAINT TRIGGER mar_medication_exception_task_receipt_guard
  AFTER INSERT OR UPDATE OF
    tenant_id,
    patient_uid,
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
    assigned_to_uid,
    assigned_to_role,
    workflow_sla_instance_id,
    metadata
  ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_case_receipt_guard();

CREATE CONSTRAINT TRIGGER mar_medication_exception_sla_receipt_guard
  AFTER INSERT OR UPDATE OF
    tenant_id,
    rule_code,
    priority,
    patient_uid,
    source_table,
    source_id,
    status,
    completed_at,
    breached_at,
    escalated_at,
    metadata,
    assigned_user_uid,
    assigned_role_codes
  ON workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_case_receipt_guard();

CREATE OR REPLACE FUNCTION mar_medication_exception_escalation_snapshot_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  exception_case mar_medication_exception_cases%ROWTYPE;
  task_record tasks%ROWTYPE;
  old_version TEXT := OLD.metadata->>'mar_exception_escalation_version';
  new_version TEXT := NEW.metadata->>'mar_exception_escalation_version';
  recipient_count INTEGER;
  eligible_count INTEGER;
  exact_outbox_count INTEGER;
  exact_recipient_count INTEGER;
  missing_recipient_count INTEGER;
  extra_recipient_count INTEGER;
BEGIN
  IF NEW.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
     AND OLD.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
  THEN
    RETURN NULL;
  END IF;

  IF old_version = 'mar_medication_exception_escalation_v1' THEN
    IF NEW.escalated_at IS DISTINCT FROM OLD.escalated_at
       OR NEW.metadata->'mar_exception_escalation_version'
            IS DISTINCT FROM OLD.metadata->'mar_exception_escalation_version'
       OR NEW.metadata->'mar_exception_escalation_recipient_count'
            IS DISTINCT FROM OLD.metadata->'mar_exception_escalation_recipient_count'
       OR NEW.metadata->'mar_exception_escalation_outbox_ids'
            IS DISTINCT FROM OLD.metadata->'mar_exception_escalation_outbox_ids'
       OR NEW.metadata->'mar_exception_escalated_at'
            IS DISTINCT FROM OLD.metadata->'mar_exception_escalated_at'
    THEN
      RAISE EXCEPTION 'MAR medication exception escalation snapshot is immutable'
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

  SELECT current_case.*
    INTO exception_case
    FROM mar_medication_exception_cases current_case
   WHERE current_case.tenant_id = NEW.tenant_id
     AND current_case.workflow_sla_instance_id = NEW.id;

  IF exception_case.id IS NULL THEN
    RAISE EXCEPTION 'MAR medication exception escalation has no exact case binding'
      USING ERRCODE = '23514';
  END IF;

  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = exception_case.tenant_id
     AND task.id = exception_case.task_id;

  IF new_version IS DISTINCT FROM 'mar_medication_exception_escalation_v1'
     OR OLD.escalated_at IS NOT NULL
     OR NEW.escalated_at IS NULL
     OR NEW.status IS DISTINCT FROM 'escalated'
     OR NEW.breached_at IS NULL
     OR COALESCE(
          NEW.metadata->>'mar_exception_escalation_recipient_count',
          ''
        ) !~ '^[1-9][0-9]*$'
     OR jsonb_typeof(NEW.metadata->'mar_exception_escalation_outbox_ids')
          IS DISTINCT FROM 'array'
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'mar_medication_exception_v1'
     OR task_record.workflow_sla_instance_id IS DISTINCT FROM NEW.id
     OR task_record.metadata->'mar_exception_escalation_version'
          IS DISTINCT FROM NEW.metadata->'mar_exception_escalation_version'
     OR task_record.metadata->'mar_exception_escalation_recipient_count'
          IS DISTINCT FROM NEW.metadata->'mar_exception_escalation_recipient_count'
     OR task_record.metadata->'mar_exception_escalation_outbox_ids'
          IS DISTINCT FROM NEW.metadata->'mar_exception_escalation_outbox_ids'
     OR task_record.metadata->'mar_exception_escalated_at'
          IS DISTINCT FROM NEW.metadata->'mar_exception_escalated_at'
     OR CASE
          WHEN pg_input_is_valid(
            NEW.metadata->>'mar_exception_escalated_at',
            'timestamp with time zone'
          )
            THEN date_trunc(
                   'milliseconds',
                   (NEW.metadata->>'mar_exception_escalated_at')::timestamptz
                 ) IS DISTINCT FROM date_trunc('milliseconds', NEW.escalated_at)
          ELSE TRUE
        END
  THEN
    RAISE EXCEPTION 'MAR medication exception escalation snapshot is incomplete'
      USING ERRCODE = '23514';
  END IF;

  recipient_count := (
    NEW.metadata->>'mar_exception_escalation_recipient_count'
  )::integer;
  IF jsonb_array_length(NEW.metadata->'mar_exception_escalation_outbox_ids')
       IS DISTINCT FROM recipient_count
  THEN
    RAISE EXCEPTION 'MAR medication exception escalation outbox set is incomplete'
      USING ERRCODE = '23514';
  END IF;

  WITH eligible AS MATERIALIZED (
    SELECT recipient.id::text AS recipient_id,
           recipient.role
      FROM users recipient
     WHERE recipient.tenant_id = exception_case.tenant_id
       AND recipient.role IN ('MEDICAL_SUPERINTENDENT', 'ADMIN', 'SUPER_ADMIN')
       AND recipient.is_active = TRUE
       AND COALESCE(recipient.is_deleted, FALSE) = FALSE
       AND recipient.deleted_at IS NULL
       AND LOWER(COALESCE(recipient.status, 'active')) = 'active'
     ORDER BY recipient.last_sign_in_at DESC NULLS LAST, recipient.id ASC
     LIMIT 25
  ), outbox_ids AS MATERIALIZED (
    SELECT outbox_id.value
      FROM jsonb_array_elements_text(
             NEW.metadata->'mar_exception_escalation_outbox_ids'
           ) outbox_id(value)
  ), actual AS MATERIALIZED (
    SELECT outbox.id::text AS outbox_id,
           outbox.recipient_id,
           outbox.payload->>'recipient_role' AS recipient_role
      FROM notification_outbox outbox
      JOIN outbox_ids selected ON selected.value = outbox.id::text
     WHERE outbox.tenant_id = exception_case.tenant_id
       AND outbox.recipient_id IS NOT NULL
       AND outbox.source_event_key =
             'mar-exception:' || exception_case.id::text
             || ':overdue:' || outbox.recipient_id
       AND outbox.type = 'mar_medication_exception_escalation'
       AND outbox.channel = 'inapp'
       AND outbox.template_version = 'mar-medication-exception-escalation.v1'
       AND outbox.payload->>'kind' = 'mar_medication_exception_escalation'
       AND outbox.payload->>'exception_case_id' = exception_case.id::text
       AND outbox.payload->>'task_id' = exception_case.task_id::text
       AND outbox.payload->>'medication_administration_id' =
             exception_case.medication_administration_id::text
       AND outbox.payload->>'patient_uid' = exception_case.patient_uid::text
       AND outbox.payload->>'deep_link' =
             '/mar/due?exception_id=' || exception_case.id::text
       AND outbox.payload->>'recipient_role' IN (
             'MEDICAL_SUPERINTENDENT', 'ADMIN', 'SUPER_ADMIN'
           )
       AND outbox.payload->>'action_label_key' = 'orders.mar_recovery.action'
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
    RAISE EXCEPTION 'MAR medication exception escalation must notify the exact active recipient set'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER mar_medication_exception_escalation_snapshot_guard
  AFTER UPDATE OF status, breached_at, escalated_at, metadata
  ON workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_escalation_snapshot_guard();

CREATE CONSTRAINT TRIGGER mar_medication_exception_administration_receipt_guard
  AFTER UPDATE OF
    tenant_id,
    patient_uid,
    clinical_order_id,
    status,
    held_by,
    held_at,
    missed_by,
    missed_at
  ON medication_administrations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_case_receipt_guard();

CREATE OR REPLACE FUNCTION mar_medication_exception_claim_comment_guard()
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
       AND task.task_kind = 'review'
       AND task.related_resource_type = 'mar_medication_exception_cases'
       AND task.metadata->>'task_contract' = 'mar_medication_exception_v1'
       AND OLD.body_kind = 'state_change'
       AND OLD.metadata ? 'claim_receipt'
  ) THEN
    RAISE EXCEPTION 'MAR medication exception claim receipts are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
     AND EXISTS (
       SELECT 1
         FROM tasks task
        WHERE task.tenant_id = NEW.tenant_id
          AND task.id = NEW.task_id
          AND task.task_kind = 'review'
          AND task.related_resource_type = 'mar_medication_exception_cases'
          AND task.metadata->>'task_contract' = 'mar_medication_exception_v1'
          AND NEW.body_kind = 'state_change'
          AND NEW.metadata ? 'claim_receipt'
     )
  THEN
    RAISE EXCEPTION 'MAR medication exception claim receipts are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_medication_exception_claim_comment_guard
  BEFORE UPDATE OR DELETE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_claim_comment_guard();

CREATE OR REPLACE FUNCTION mar_medication_exception_assignee_viability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM mar_medication_exception_cases exception_case
      JOIN tasks task
        ON task.tenant_id = exception_case.tenant_id
       AND task.id = exception_case.task_id
     WHERE exception_case.tenant_id = OLD.tenant_id
       AND exception_case.assigned_prescriber_uid = OLD.uid
       AND exception_case.status = 'open'
       AND task.metadata->>'task_contract' = 'mar_medication_exception_v1'
       AND (
         NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.uid IS DISTINCT FROM OLD.uid
         OR NEW.role IS NULL
         OR NEW.role NOT IN (
           'DOCTOR',
           'DUTY_DOCTOR',
           'CONSULTANT',
           'JUNIOR_DOCTOR',
           'RESIDENT'
         )
         OR NEW.is_active IS DISTINCT FROM TRUE
         OR COALESCE(NEW.is_deleted, FALSE) IS DISTINCT FROM FALSE
         OR NEW.deleted_at IS NOT NULL
         OR LOWER(COALESCE(NEW.status, 'active')) IS DISTINCT FROM 'active'
       )
  ) THEN
    RAISE EXCEPTION 'open MAR medication exception assignee must remain an active exact prescriber'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER mar_medication_exception_assignee_viability_guard
  AFTER UPDATE OF tenant_id, uid, role, is_active, status, is_deleted, deleted_at
  ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mar_medication_exception_assignee_viability_guard();

-- ---------------------------------------------------------------------------
-- Substitution acknowledgement and reusable tenant-composite parent keys
-- ---------------------------------------------------------------------------

ALTER TABLE ward_indent_items
  ADD COLUMN substitution_acknowledged_by UUID,
  ADD COLUMN substitution_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN substitution_acknowledged_event_version INTEGER;

ALTER TABLE ward_indent_items
  ADD CONSTRAINT ward_indent_items_substitution_ack_evidence_check CHECK (
    (
      substitution_acknowledged_by IS NULL
      AND substitution_acknowledged_at IS NULL
      AND substitution_acknowledged_event_version IS NULL
    )
    OR
    (
      substitution_status = 'approved'
      AND substitution_acknowledged_by IS NOT NULL
      AND substitution_acknowledged_at IS NOT NULL
      AND substitution_acknowledged_event_version > 0
    )
  ),
  ADD CONSTRAINT fk_ward_indent_items_substitution_ack_actor_med03
    FOREIGN KEY (tenant_id, substitution_acknowledged_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX ux_ward_indent_items_tenant_indent_id_med03
  ON ward_indent_items (tenant_id, id, ward_indent_id);
CREATE UNIQUE INDEX ux_ward_indent_items_tenant_id_med03
  ON ward_indent_items (tenant_id, id);
CREATE UNIQUE INDEX ux_pharmacy_inventory_batches_tenant_item_id_med03
  ON pharmacy_inventory_batches (tenant_id, id, inventory_item_id);
CREATE UNIQUE INDEX ux_billing_invoices_tenant_id_med03
  ON billing_invoices (tenant_id, id);
CREATE UNIQUE INDEX ux_billing_invoice_items_tenant_id_med03
  ON billing_invoice_items (tenant_id, id);
CREATE UNIQUE INDEX ux_billing_refunds_tenant_id_med03
  ON billing_refunds (tenant_id, id);
CREATE UNIQUE INDEX ux_ward_indent_events_tenant_identity_med03
  ON ward_indent_events (tenant_id, id, ward_indent_id, state_version);
CREATE UNIQUE INDEX ux_pg_orders_tenant_id_med03
  ON payment_gateway_orders (tenant_id, id);

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM payment_gateway_refunds refund
     WHERE NOT EXISTS (
       SELECT 1
         FROM payment_gateway_orders gateway_order
        WHERE gateway_order.tenant_id = refund.tenant_id
          AND gateway_order.id = refund.gateway_order_id
     )
  ) THEN
    RAISE EXCEPTION
      'payment_gateway_refunds contains a gateway order from another tenant'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM payment_gateway_refunds refund
     WHERE refund.billing_refund_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM billing_refunds billing_refund
          WHERE billing_refund.tenant_id = refund.tenant_id
            AND billing_refund.id = refund.billing_refund_id
       )
  ) THEN
    RAISE EXCEPTION
      'payment_gateway_refunds contains a billing refund from another tenant'
      USING ERRCODE = '23503';
  END IF;
END
$preflight$;

ALTER TABLE payment_gateway_refunds
  ADD CONSTRAINT fk_pg_refund_gateway_order_tenant_med03
    FOREIGN KEY (tenant_id, gateway_order_id)
    REFERENCES payment_gateway_orders (tenant_id, id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pg_refund_billing_refund_tenant_med03
    FOREIGN KEY (tenant_id, billing_refund_id)
    REFERENCES billing_refunds (tenant_id, id)
    ON DELETE SET NULL (billing_refund_id)
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID;

CREATE INDEX idx_pg_refund_gateway_order_tenant_med03
  ON payment_gateway_refunds (tenant_id, gateway_order_id);
CREATE INDEX idx_pg_refund_billing_refund_tenant_med03
  ON payment_gateway_refunds (tenant_id, billing_refund_id)
  WHERE billing_refund_id IS NOT NULL;

-- These two ledgers pre-date tenant-composite constraints. NOT VALID avoids
-- claiming that historical data has already been reconciled while enforcing
-- tenant lineage on every new row immediately.
ALTER TABLE pharmacy_stock_movements
  ADD CONSTRAINT fk_pharmacy_stock_movements_item_tenant_med03
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_stock_movements_batch_item_tenant_med03
    FOREIGN KEY (tenant_id, inventory_batch_id, inventory_item_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, id, inventory_item_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_stock_movements_actor_tenant_med03
    FOREIGN KEY (tenant_id, performed_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID;

CREATE INDEX idx_pharmacy_stock_movements_item_tenant_med03
  ON pharmacy_stock_movements (tenant_id, inventory_item_id);
CREATE INDEX idx_pharmacy_stock_movements_batch_item_tenant_med03
  ON pharmacy_stock_movements (tenant_id, inventory_batch_id, inventory_item_id)
  WHERE inventory_batch_id IS NOT NULL;
CREATE INDEX idx_pharmacy_stock_movements_actor_tenant_med03
  ON pharmacy_stock_movements (tenant_id, performed_by)
  WHERE performed_by IS NOT NULL;

ALTER TABLE pharmacy_schedule_register
  ADD CONSTRAINT fk_pharmacy_schedule_register_facility_tenant_med03
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_schedule_register_item_tenant_med03
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_schedule_register_batch_item_tenant_med03
    FOREIGN KEY (tenant_id, inventory_batch_id, inventory_item_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, id, inventory_item_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_schedule_register_patient_tenant_med03
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_schedule_register_prescriber_tenant_med03
    FOREIGN KEY (tenant_id, prescriber_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_schedule_register_performer_tenant_med03
    FOREIGN KEY (tenant_id, performed_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_schedule_register_witness_tenant_med03
    FOREIGN KEY (tenant_id, witness_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID,
  ADD CONSTRAINT fk_pharmacy_schedule_register_movement_tenant_med03
    FOREIGN KEY (tenant_id, reference_movement_id)
    REFERENCES pharmacy_stock_movements (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID;

CREATE INDEX idx_pharmacy_schedule_register_facility_tenant_med03
  ON pharmacy_schedule_register (tenant_id, facility_id)
  WHERE facility_id IS NOT NULL;
CREATE INDEX idx_pharmacy_schedule_register_item_tenant_med03
  ON pharmacy_schedule_register (tenant_id, inventory_item_id);
CREATE INDEX idx_pharmacy_schedule_register_batch_item_tenant_med03
  ON pharmacy_schedule_register (tenant_id, inventory_batch_id, inventory_item_id)
  WHERE inventory_batch_id IS NOT NULL;
CREATE INDEX idx_pharmacy_schedule_register_patient_tenant_med03
  ON pharmacy_schedule_register (tenant_id, patient_uid)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX idx_pharmacy_schedule_register_prescriber_tenant_med03
  ON pharmacy_schedule_register (tenant_id, prescriber_uid)
  WHERE prescriber_uid IS NOT NULL;
CREATE INDEX idx_pharmacy_schedule_register_performer_tenant_med03
  ON pharmacy_schedule_register (tenant_id, performed_by);
CREATE INDEX idx_pharmacy_schedule_register_witness_tenant_med03
  ON pharmacy_schedule_register (tenant_id, witness_uid)
  WHERE witness_uid IS NOT NULL;
CREATE INDEX idx_pharmacy_schedule_register_movement_tenant_med03
  ON pharmacy_schedule_register (tenant_id, reference_movement_id)
  WHERE reference_movement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION controlled_ward_dispense_require_patient()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.movement_kind = 'dispense'
     AND NEW.patient_uid IS NULL
     AND EXISTS (
       SELECT 1
         FROM pharmacy_stock_movements movement
        WHERE movement.tenant_id = NEW.tenant_id
          AND movement.id = NEW.reference_movement_id
          AND movement.reference_type = 'controlled_dispense'
          AND movement.reference_id ~ '^ward-indent:[1-9][0-9]*:item:[1-9][0-9]*$'
     )
  THEN
    RAISE EXCEPTION
      'controlled ward dispense requires a patient-linked statutory register entry'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_controlled_ward_dispense_patient_required';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER controlled_ward_dispense_patient_required
  BEFORE INSERT ON pharmacy_schedule_register
  FOR EACH ROW EXECUTE FUNCTION controlled_ward_dispense_require_patient();

CREATE TRIGGER pharmacy_stock_movements_medication_evidence_append_only
  BEFORE UPDATE OR DELETE ON pharmacy_stock_movements
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE TRIGGER pharmacy_schedule_register_medication_evidence_append_only
  BEFORE UPDATE OR DELETE ON pharmacy_schedule_register
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

DROP TRIGGER IF EXISTS ward_indent_events_append_only ON ward_indent_events;
CREATE TRIGGER ward_indent_events_medication_evidence_append_only
  BEFORE UPDATE OR DELETE ON ward_indent_events
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

-- ---------------------------------------------------------------------------
-- Exact ward reservation and movement lineage
-- ---------------------------------------------------------------------------

CREATE TABLE ward_indent_inventory_allocations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  ward_indent_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  inventory_item_id INTEGER NOT NULL,
  inventory_batch_id INTEGER NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'reserved',
  reserved_quantity NUMERIC(14, 4) NOT NULL,
  issued_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  received_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  consumed_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  returned_quantity NUMERIC(14, 4) NOT NULL DEFAULT 0,
  reservation_key VARCHAR(200) NOT NULL,
  reserved_by UUID NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by UUID,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_inventory_allocations_status_check CHECK (
    status IN ('reserved', 'partially_issued', 'issued', 'released', 'reconciled')
  ),
  CONSTRAINT ward_indent_inventory_allocations_quantity_check CHECK (
    reserved_quantity > 0
    AND issued_quantity >= 0
    AND received_quantity >= 0
    AND consumed_quantity >= 0
    AND returned_quantity >= 0
    AND issued_quantity <= reserved_quantity
    AND received_quantity <= issued_quantity
    AND consumed_quantity + returned_quantity <= received_quantity
  ),
  CONSTRAINT ward_indent_inventory_allocations_release_check CHECK (
    (
      status = 'released'
      AND issued_quantity = 0
      AND released_by IS NOT NULL
      AND released_at IS NOT NULL
      AND release_reason IS NOT NULL
      AND BTRIM(release_reason) <> ''
    )
    OR
    (
      status <> 'released'
      AND released_by IS NULL
      AND released_at IS NULL
      AND release_reason IS NULL
    )
  ),
  CONSTRAINT ward_indent_inventory_allocations_reservation_key_check
    CHECK (BTRIM(reservation_key) <> ''),
  CONSTRAINT fk_ward_indent_inventory_allocations_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_ward_indent_inventory_allocations_indent_item
    FOREIGN KEY (tenant_id, ward_indent_item_id, ward_indent_id)
    REFERENCES ward_indent_items (tenant_id, id, ward_indent_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_inventory_item
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_batch_item
    FOREIGN KEY (tenant_id, inventory_batch_id, inventory_item_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, id, inventory_item_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_reserved_by
    FOREIGN KEY (tenant_id, reserved_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_allocations_released_by
    FOREIGN KEY (tenant_id, released_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_inventory_allocations_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_indent_inventory_allocations_reservation_key
    UNIQUE (tenant_id, reservation_key),
  CONSTRAINT ux_ward_indent_inventory_allocations_lineage
    UNIQUE (tenant_id, id, ward_indent_item_id, inventory_batch_id)
);

CREATE UNIQUE INDEX ux_ward_indent_inventory_allocations_active_batch
  ON ward_indent_inventory_allocations
    (tenant_id, ward_indent_item_id, inventory_batch_id)
  WHERE status IN ('reserved', 'partially_issued', 'issued');
CREATE INDEX idx_ward_indent_inventory_allocations_indent
  ON ward_indent_inventory_allocations
    (tenant_id, ward_indent_id, ward_indent_item_id, id);
CREATE INDEX idx_ward_indent_inventory_allocations_batch_reservations
  ON ward_indent_inventory_allocations
    (tenant_id, inventory_batch_id, status)
  WHERE status IN ('reserved', 'partially_issued', 'issued');
CREATE INDEX idx_wi_alloc_batch_item_fk_med03
  ON ward_indent_inventory_allocations
    (tenant_id, inventory_batch_id, inventory_item_id);
CREATE INDEX idx_wi_alloc_inventory_item_fk_med03
  ON ward_indent_inventory_allocations (tenant_id, inventory_item_id);
CREATE INDEX idx_wi_alloc_reserved_by_fk_med03
  ON ward_indent_inventory_allocations (tenant_id, reserved_by);
CREATE INDEX idx_wi_alloc_released_by_fk_med03
  ON ward_indent_inventory_allocations (tenant_id, released_by)
  WHERE released_by IS NOT NULL;

CREATE OR REPLACE FUNCTION ward_indent_inventory_allocation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ward-indent inventory allocations cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_inventory_allocation_guard';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.ward_indent_id IS DISTINCT FROM OLD.ward_indent_id
     OR NEW.ward_indent_item_id IS DISTINCT FROM OLD.ward_indent_item_id
     OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
     OR NEW.inventory_batch_id IS DISTINCT FROM OLD.inventory_batch_id
     OR NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity
     OR NEW.reservation_key IS DISTINCT FROM OLD.reservation_key
     OR NEW.reserved_by IS DISTINCT FROM OLD.reserved_by
     OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'ward-indent inventory allocation identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_inventory_allocation_guard';
  END IF;

  IF NEW.issued_quantity < OLD.issued_quantity
     OR NEW.received_quantity < OLD.received_quantity
     OR NEW.consumed_quantity < OLD.consumed_quantity
     OR NEW.returned_quantity < OLD.returned_quantity
  THEN
    RAISE EXCEPTION 'ward-indent inventory allocation projections cannot decrease'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_inventory_allocation_guard';
  END IF;

  IF OLD.status = 'released' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'released ward-indent inventory allocations are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_inventory_allocation_guard';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER ward_indent_inventory_allocation_mutation_guard
  BEFORE UPDATE OR DELETE ON ward_indent_inventory_allocations
  FOR EACH ROW EXECUTE FUNCTION ward_indent_inventory_allocation_guard();

CREATE OR REPLACE FUNCTION ward_indent_controlled_patient_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.patient_uid IS NOT NULL
     OR NEW.status NOT IN ('controlled_handoff_required', 'approved')
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ward_indent_items ward_item
      LEFT JOIN ward_indent_inventory_allocations allocation
        ON allocation.tenant_id = ward_item.tenant_id
       AND allocation.ward_indent_item_id = ward_item.id
       AND allocation.status <> 'released'
      LEFT JOIN pharmacy_inventory_items inventory
        ON inventory.tenant_id = allocation.tenant_id
       AND inventory.id = allocation.inventory_item_id
     WHERE ward_item.tenant_id = NEW.tenant_id
       AND ward_item.ward_indent_id = NEW.id
       AND (
         ward_item.controlled_reference_id IS NOT NULL
         OR inventory.is_narcotic IS TRUE
         OR UPPER(COALESCE(inventory.schedule_class, '')) IN ('H', 'H1', 'X')
       )
  ) THEN
    RAISE EXCEPTION
      'controlled medication cannot use a patientless ward-stock indent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_controlled_patient_required';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER ward_indent_controlled_patient_required
  BEFORE INSERT OR UPDATE ON ward_indents
  FOR EACH ROW EXECUTE FUNCTION ward_indent_controlled_patient_guard();

CREATE TABLE ward_indent_inventory_movement_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  allocation_id BIGINT NOT NULL,
  ward_indent_id INTEGER NOT NULL,
  stock_movement_id INTEGER NOT NULL,
  controlled_register_id INTEGER,
  movement_purpose VARCHAR(20) NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  ward_indent_state_version INTEGER NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  linked_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_inventory_movement_links_purpose_check CHECK (
    movement_purpose IN ('issue', 'return')
  ),
  CONSTRAINT ward_indent_inventory_movement_links_quantity_check
    CHECK (quantity > 0),
  CONSTRAINT ward_indent_inventory_movement_links_version_check
    CHECK (ward_indent_state_version > 0),
  CONSTRAINT ward_indent_inventory_movement_links_command_check
    CHECK (BTRIM(command_key) <> ''),
  CONSTRAINT fk_ward_indent_inventory_movement_links_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_ward_indent_inventory_movement_links_allocation
    FOREIGN KEY (tenant_id, allocation_id)
    REFERENCES ward_indent_inventory_allocations (tenant_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_movement_links_ward_event
    FOREIGN KEY (tenant_id, ward_indent_id, ward_indent_state_version)
    REFERENCES ward_indent_events (tenant_id, ward_indent_id, state_version)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_ward_indent_inventory_movement_links_movement
    FOREIGN KEY (tenant_id, stock_movement_id)
    REFERENCES pharmacy_stock_movements (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_movement_links_register
    FOREIGN KEY (tenant_id, controlled_register_id)
    REFERENCES pharmacy_schedule_register (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_movement_links_actor
    FOREIGN KEY (tenant_id, linked_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_inventory_movement_links_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_indent_inventory_movement_links_movement
    UNIQUE (tenant_id, stock_movement_id),
  CONSTRAINT ux_ward_indent_inventory_movement_links_command
    UNIQUE (tenant_id, command_key)
);

CREATE INDEX idx_ward_indent_inventory_movement_links_allocation
  ON ward_indent_inventory_movement_links
    (tenant_id, allocation_id, ward_indent_id, created_at, id);
CREATE INDEX idx_wi_movement_links_actor_fk_med03
  ON ward_indent_inventory_movement_links (tenant_id, linked_by);
CREATE INDEX idx_wi_movement_links_ward_event_med03
  ON ward_indent_inventory_movement_links
    (tenant_id, ward_indent_id, ward_indent_state_version);
CREATE UNIQUE INDEX ux_wi_movement_links_register_med03
  ON ward_indent_inventory_movement_links (tenant_id, controlled_register_id)
  WHERE controlled_register_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ward_indent_apply_inventory_movement_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  allocation ward_indent_inventory_allocations%ROWTYPE;
  movement pharmacy_stock_movements%ROWTYPE;
  register_entry pharmacy_schedule_register%ROWTYPE;
  medication RECORD;
  next_issued NUMERIC(14, 4);
  next_returned NUMERIC(14, 4);
  controlled BOOLEAN;
  expected_reference_type TEXT;
  expected_reference_id TEXT;
  expected_register_kind TEXT;
  current_indent_version INTEGER;
BEGIN
  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.allocation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent inventory allocation not found'
      USING ERRCODE = '23503';
  END IF;
  NEW.ward_indent_id := allocation.ward_indent_id;

  SELECT state_version INTO current_indent_version
    FROM ward_indents
   WHERE tenant_id = NEW.tenant_id
     AND id = allocation.ward_indent_id
   FOR KEY SHARE;
  IF NOT FOUND OR NEW.ward_indent_state_version <> current_indent_version + 1 THEN
    RAISE EXCEPTION 'ward-indent movement state version is stale or not the next transition'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO movement
    FROM pharmacy_stock_movements
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.stock_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent stock movement not found'
      USING ERRCODE = '23503';
  END IF;
  IF movement.inventory_item_id <> allocation.inventory_item_id
     OR movement.inventory_batch_id IS DISTINCT FROM allocation.inventory_batch_id
     OR ABS(movement.quantity_delta) <> NEW.quantity THEN
    RAISE EXCEPTION 'ward-indent movement lineage does not match its allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT inventory.schedule_class,
         inventory.is_narcotic,
         ward_item.controlled_reference_id,
         ward_item.id AS ward_indent_item_id,
         indent.patient_uid
    INTO medication
    FROM pharmacy_inventory_items inventory
    JOIN ward_indent_items ward_item
      ON ward_item.tenant_id = allocation.tenant_id
     AND ward_item.id = allocation.ward_indent_item_id
    JOIN ward_indents indent
      ON indent.tenant_id = ward_item.tenant_id
     AND indent.id = ward_item.ward_indent_id
   WHERE inventory.tenant_id = allocation.tenant_id
     AND inventory.id = allocation.inventory_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent movement medication context not found'
      USING ERRCODE = '23503';
  END IF;

  controlled := medication.is_narcotic IS TRUE
    OR UPPER(COALESCE(medication.schedule_class, '')) IN ('H', 'H1', 'X');

  IF NEW.movement_purpose = 'issue' AND movement.movement_kind <> 'issue' THEN
    RAISE EXCEPTION 'ward-indent issue link requires an issue stock movement'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.movement_purpose = 'return' AND movement.movement_kind <> 'return' THEN
    RAISE EXCEPTION 'ward-indent return link requires a return stock movement'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.movement_purpose = 'issue' AND movement.quantity_delta >= 0 THEN
    RAISE EXCEPTION 'ward-indent issue movement must decrease exact-batch stock'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.movement_purpose = 'return' AND movement.quantity_delta <= 0 THEN
    RAISE EXCEPTION 'ward-indent return movement must increase exact-batch stock'
      USING ERRCODE = '23514';
  END IF;

  IF controlled THEN
    IF NEW.movement_purpose = 'issue' AND medication.patient_uid IS NULL THEN
      RAISE EXCEPTION
        'controlled ward-indent dispense requires a patient-linked indent'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_ward_indent_controlled_patient_required';
    END IF;

    IF NEW.controlled_register_id IS NULL THEN
      RAISE EXCEPTION 'controlled ward-indent movement requires statutory register evidence'
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO register_entry
      FROM pharmacy_schedule_register
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.controlled_register_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'controlled ward-indent register evidence not found'
        USING ERRCODE = '23503';
    END IF;

    IF NEW.movement_purpose = 'issue' THEN
      expected_reference_type := 'controlled_dispense';
      expected_reference_id := medication.controlled_reference_id;
      expected_register_kind := 'dispense';
    ELSE
      expected_reference_type := 'ward_indent_return';
      expected_reference_id := pg_catalog.format(
        'ward-indent-return:%s:item:%s',
        allocation.ward_indent_id,
        allocation.ward_indent_item_id
      );
      expected_register_kind := 'return';
    END IF;

    IF NULLIF(BTRIM(expected_reference_id), '') IS NULL
       OR movement.reference_type IS DISTINCT FROM expected_reference_type
       OR movement.reference_id IS DISTINCT FROM expected_reference_id
       OR movement.performed_by IS NULL
       OR register_entry.inventory_item_id IS DISTINCT FROM allocation.inventory_item_id
       OR register_entry.inventory_batch_id IS DISTINCT FROM allocation.inventory_batch_id
       OR register_entry.movement_kind IS DISTINCT FROM expected_register_kind
       OR register_entry.quantity IS DISTINCT FROM NEW.quantity
       OR register_entry.patient_uid IS DISTINCT FROM medication.patient_uid
       OR register_entry.performed_by IS DISTINCT FROM movement.performed_by
       OR register_entry.reference_movement_id IS DISTINCT FROM movement.id
    THEN
      RAISE EXCEPTION 'controlled ward-indent register does not match movement lineage'
        USING ERRCODE = '23514';
    END IF;

    IF register_entry.witness_uid IS NOT NULL
       AND register_entry.witness_uid = register_entry.performed_by THEN
      RAISE EXCEPTION 'controlled ward-indent witness must be independent of performer'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.movement_purpose = 'issue'
       AND (
         UPPER(COALESCE(medication.schedule_class, '')) = 'X'
         OR medication.is_narcotic IS TRUE
       )
       AND register_entry.witness_uid IS NULL
    THEN
      RAISE EXCEPTION 'Schedule X or narcotic ward issue requires witness evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.controlled_register_id IS NOT NULL THEN
      RAISE EXCEPTION 'non-controlled ward-indent movement cannot claim statutory register evidence'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.movement_purpose = 'issue' THEN
      expected_reference_type := 'ward_indent_allocation';
    ELSE
      expected_reference_type := 'ward_indent_return_allocation';
    END IF;
    IF movement.reference_type IS DISTINCT FROM expected_reference_type
       OR movement.reference_id IS DISTINCT FROM allocation.id::text
    THEN
      RAISE EXCEPTION 'ward-indent movement reference does not match its allocation'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF movement.quantity_delta < 0 THEN
    next_issued := allocation.issued_quantity + NEW.quantity;
    IF next_issued > allocation.reserved_quantity THEN
      RAISE EXCEPTION 'ward-indent issue exceeds its exact reservation'
        USING ERRCODE = '23514';
    END IF;
    UPDATE ward_indent_inventory_allocations
       SET issued_quantity = next_issued,
           status = CASE
             WHEN next_issued = reserved_quantity THEN 'issued'
             ELSE 'partially_issued'
           END,
           updated_at = NOW()
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.allocation_id;
  ELSE
    next_returned := allocation.returned_quantity + NEW.quantity;
    IF next_returned + allocation.consumed_quantity > allocation.received_quantity THEN
      RAISE EXCEPTION 'ward-indent return exceeds received unconsumed custody'
        USING ERRCODE = '23514';
    END IF;
    UPDATE ward_indent_inventory_allocations
       SET returned_quantity = next_returned,
           status = CASE
             WHEN next_returned + consumed_quantity = received_quantity
               THEN 'reconciled'
             ELSE status
           END,
           updated_at = NOW()
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.allocation_id;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ward_indent_inventory_movement_link_projection
  BEFORE INSERT ON ward_indent_inventory_movement_links
  FOR EACH ROW EXECUTE FUNCTION ward_indent_apply_inventory_movement_link();

CREATE TRIGGER ward_indent_inventory_movement_links_append_only
  BEFORE UPDATE OR DELETE ON ward_indent_inventory_movement_links
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE UNIQUE INDEX ux_ward_indent_inventory_allocations_receipt_lineage_med03
  ON ward_indent_inventory_allocations (
    tenant_id,
    id,
    ward_indent_id,
    ward_indent_item_id,
    inventory_batch_id
  );

CREATE TABLE ward_indent_inventory_receipt_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  inventory_allocation_id BIGINT NOT NULL,
  ward_indent_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  inventory_batch_id INTEGER NOT NULL,
  ward_indent_state_version INTEGER NOT NULL,
  quantity_delta NUMERIC(14, 4) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  received_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_inventory_receipt_events_quantity_check
    CHECK (quantity_delta > 0),
  CONSTRAINT ward_indent_inventory_receipt_events_version_check
    CHECK (ward_indent_state_version > 0),
  CONSTRAINT ward_indent_inventory_receipt_events_command_check
    CHECK (command_key = BTRIM(command_key) AND command_key <> ''),
  CONSTRAINT fk_ward_indent_inventory_receipt_events_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_ward_indent_inventory_receipt_events_allocation_lineage
    FOREIGN KEY (
      tenant_id,
      inventory_allocation_id,
      ward_indent_id,
      ward_indent_item_id,
      inventory_batch_id
    )
    REFERENCES ward_indent_inventory_allocations (
      tenant_id,
      id,
      ward_indent_id,
      ward_indent_item_id,
      inventory_batch_id
    )
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_inventory_receipt_events_ward_event
    FOREIGN KEY (tenant_id, ward_indent_id, ward_indent_state_version)
    REFERENCES ward_indent_events (tenant_id, ward_indent_id, state_version)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_ward_indent_inventory_receipt_events_actor
    FOREIGN KEY (tenant_id, received_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_inventory_receipt_events_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_indent_inventory_receipt_events_command
    UNIQUE (tenant_id, command_key),
  CONSTRAINT ux_ward_indent_inventory_receipt_events_allocation_version
    UNIQUE (tenant_id, inventory_allocation_id, ward_indent_state_version)
);

CREATE INDEX idx_ward_indent_inventory_receipt_events_lineage
  ON ward_indent_inventory_receipt_events (
    tenant_id,
    inventory_allocation_id,
    ward_indent_id,
    ward_indent_item_id,
    inventory_batch_id
  );
CREATE INDEX idx_ward_indent_inventory_receipt_events_actor
  ON ward_indent_inventory_receipt_events (tenant_id, received_by);
CREATE INDEX idx_wi_receipt_events_ward_event_med03
  ON ward_indent_inventory_receipt_events
    (tenant_id, ward_indent_id, ward_indent_state_version);

CREATE OR REPLACE FUNCTION ward_indent_apply_inventory_receipt_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  allocation ward_indent_inventory_allocations%ROWTYPE;
  current_indent_version INTEGER;
BEGIN
  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id
     AND ward_indent_id = NEW.ward_indent_id
     AND ward_indent_item_id = NEW.ward_indent_item_id
     AND inventory_batch_id = NEW.inventory_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent receipt allocation lineage not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT state_version INTO current_indent_version
    FROM ward_indents
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.ward_indent_id
   FOR KEY SHARE;
  IF NOT FOUND OR NEW.ward_indent_state_version <> current_indent_version + 1 THEN
    RAISE EXCEPTION 'ward-indent receipt state version is stale or not the next transition'
      USING ERRCODE = '23514';
  END IF;

  IF allocation.status = 'released'
     OR allocation.received_quantity + NEW.quantity_delta > allocation.issued_quantity
  THEN
    RAISE EXCEPTION 'ward-indent receipt exceeds issued exact-batch custody'
      USING ERRCODE = '23514';
  END IF;

  UPDATE ward_indent_inventory_allocations
     SET received_quantity = received_quantity + NEW.quantity_delta,
         updated_at = NOW()
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ward_indent_inventory_receipt_event_projection
  BEFORE INSERT ON ward_indent_inventory_receipt_events
  FOR EACH ROW EXECUTE FUNCTION ward_indent_apply_inventory_receipt_event();

CREATE TRIGGER ward_indent_inventory_receipt_events_append_only
  BEFORE UPDATE OR DELETE ON ward_indent_inventory_receipt_events
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE OR REPLACE FUNCTION ward_indent_inventory_workflow_event_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  event_action TEXT;
  event_from_status TEXT;
  event_to_status TEXT;
  event_actor UUID;
  event_owner_role_codes TEXT[];
  projected_state_version INTEGER;
  projected_status TEXT;
  projected_owner_role_codes TEXT[];
BEGIN
  SELECT action, from_status, to_status, actor_uid, owner_role_codes
    INTO event_action, event_from_status, event_to_status, event_actor,
         event_owner_role_codes
    FROM ward_indent_events
   WHERE tenant_id = NEW.tenant_id
     AND ward_indent_id = NEW.ward_indent_id
     AND state_version = NEW.ward_indent_state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent inventory evidence has no exact workflow event'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_inventory_workflow_event';
  END IF;

  SELECT state_version, status, owner_role_codes
    INTO projected_state_version, projected_status, projected_owner_role_codes
    FROM ward_indents
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.ward_indent_id;
  IF NOT FOUND
     OR projected_state_version IS DISTINCT FROM NEW.ward_indent_state_version
     OR projected_status IS DISTINCT FROM event_to_status
     OR projected_owner_role_codes IS DISTINCT FROM event_owner_role_codes
  THEN
    RAISE EXCEPTION 'ward-indent inventory evidence does not match the projected ward state'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_inventory_projected_state';
  END IF;

  IF TG_TABLE_NAME = 'ward_indent_inventory_receipt_events' THEN
    IF event_action IS DISTINCT FROM 'receipt_recorded'
       OR event_from_status NOT IN ('issued', 'partially_received')
       OR event_to_status NOT IN ('partially_received', 'received')
       OR event_actor IS DISTINCT FROM NEW.received_by
    THEN
      RAISE EXCEPTION 'ward-indent receipt evidence does not match its receipt transition'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_ward_indent_receipt_workflow_event';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.movement_purpose = 'issue' AND NEW.controlled_register_id IS NULL THEN
    IF event_action IS DISTINCT FROM 'issued'
       OR event_from_status IS DISTINCT FROM 'approved'
       OR event_to_status IS DISTINCT FROM 'issued'
       OR event_actor IS DISTINCT FROM NEW.linked_by
    THEN
      RAISE EXCEPTION 'non-controlled ward-indent issue does not match its issue transition'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_ward_indent_issue_workflow_event';
    END IF;
  ELSIF NEW.movement_purpose = 'issue' THEN
    IF event_action IS DISTINCT FROM 'controlled_handoff_recorded'
       OR event_from_status IS DISTINCT FROM 'controlled_handoff_required'
       OR event_to_status IS DISTINCT FROM 'approved'
       OR event_actor IS DISTINCT FROM NEW.linked_by
    THEN
      RAISE EXCEPTION 'controlled ward-indent issue does not match its handoff transition'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_ward_indent_controlled_issue_workflow_event';
    END IF;
  ELSIF event_action IS DISTINCT FROM 'reconciled'
     OR event_from_status NOT IN ('return_pending', 'reconciliation_required')
     OR event_to_status IS DISTINCT FROM 'reconciled'
     OR event_actor IS DISTINCT FROM NEW.linked_by
  THEN
    RAISE EXCEPTION 'ward-indent return evidence does not match its reconciliation transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_return_workflow_event';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER ward_indent_inventory_movement_workflow_event
  AFTER INSERT ON ward_indent_inventory_movement_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ward_indent_inventory_workflow_event_validate();

CREATE CONSTRAINT TRIGGER ward_indent_inventory_receipt_workflow_event
  AFTER INSERT ON ward_indent_inventory_receipt_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ward_indent_inventory_workflow_event_validate();

-- ---------------------------------------------------------------------------
-- Ward custody consumption by MAR
-- ---------------------------------------------------------------------------

CREATE TABLE mar_supply_consumptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  clinical_order_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  inventory_allocation_id BIGINT,
  inventory_batch_id INTEGER,
  quantity NUMERIC(14, 4) NOT NULL,
  evidence_status VARCHAR(30) NOT NULL DEFAULT 'matched',
  administration_mode VARCHAR(50) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  recorded_by UUID NOT NULL,
  override_reason TEXT,
  override_recorded_at TIMESTAMPTZ,
  reconciliation_task_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_supply_consumptions_quantity_check CHECK (quantity > 0),
  CONSTRAINT mar_supply_consumptions_evidence_status_check CHECK (
    evidence_status IN ('matched', 'unmatched_override')
  ),
  CONSTRAINT mar_supply_consumptions_mode_check
    CHECK (BTRIM(administration_mode) <> ''),
  CONSTRAINT mar_supply_consumptions_command_check
    CHECK (BTRIM(command_key) <> ''),
  CONSTRAINT mar_supply_consumptions_evidence_check CHECK (
    (
      evidence_status = 'matched'
      AND inventory_allocation_id IS NOT NULL
      AND inventory_batch_id IS NOT NULL
      AND override_reason IS NULL
      AND override_recorded_at IS NULL
      AND reconciliation_task_id IS NULL
    )
    OR
    (
      evidence_status = 'unmatched_override'
      AND inventory_allocation_id IS NULL
      AND inventory_batch_id IS NULL
      AND override_reason IS NOT NULL
      AND BTRIM(override_reason) <> ''
      AND override_recorded_at IS NOT NULL
      AND reconciliation_task_id IS NOT NULL
    )
  ),
  CONSTRAINT fk_mar_supply_consumptions_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_supply_consumptions_administration_order
    FOREIGN KEY (tenant_id, medication_administration_id, clinical_order_id)
    REFERENCES medication_administrations (tenant_id, id, clinical_order_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_clinical_order
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_ward_item
    FOREIGN KEY (tenant_id, ward_indent_item_id)
    REFERENCES ward_indent_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_allocation_lineage
    FOREIGN KEY (
      tenant_id,
      inventory_allocation_id,
      ward_indent_item_id,
      inventory_batch_id
    )
    REFERENCES ward_indent_inventory_allocations (
      tenant_id,
      id,
      ward_indent_item_id,
      inventory_batch_id
    )
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_actor
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_consumptions_reconciliation_task
    FOREIGN KEY (tenant_id, reconciliation_task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_supply_consumptions_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_mar_supply_consumptions_command
    UNIQUE (tenant_id, command_key),
  CONSTRAINT ux_mar_supply_consumptions_admin_allocation
    UNIQUE (tenant_id, medication_administration_id, inventory_allocation_id)
);

CREATE INDEX idx_mar_supply_consumptions_administration
  ON mar_supply_consumptions
    (tenant_id, medication_administration_id, clinical_order_id, id);
CREATE INDEX idx_mar_supply_consumptions_clinical_order
  ON mar_supply_consumptions
    (tenant_id, clinical_order_id, created_at);
CREATE INDEX idx_mar_supply_consumptions_open_reconciliation
  ON mar_supply_consumptions
    (tenant_id, reconciliation_task_id, created_at)
  WHERE evidence_status = 'unmatched_override';
CREATE INDEX idx_mar_supply_allocation_lineage_fk_med03
  ON mar_supply_consumptions
    (tenant_id, inventory_allocation_id, ward_indent_item_id, inventory_batch_id)
  WHERE inventory_allocation_id IS NOT NULL;
CREATE INDEX idx_mar_supply_ward_item_fk_med03
  ON mar_supply_consumptions (tenant_id, ward_indent_item_id);
CREATE INDEX idx_mar_supply_actor_fk_med03
  ON mar_supply_consumptions (tenant_id, recorded_by);
CREATE UNIQUE INDEX ux_mar_supply_consumptions_command_receipt_lineage_med03
  ON mar_supply_consumptions (tenant_id, id, medication_administration_id);

CREATE OR REPLACE FUNCTION mar_supply_apply_custody_consumption()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  allocation ward_indent_inventory_allocations%ROWTYPE;
  item_order_id INTEGER;
BEGIN
  SELECT clinical_order_id
    INTO item_order_id
    FROM ward_indent_items
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.ward_indent_item_id
   FOR KEY SHARE;
  IF NOT FOUND OR item_order_id IS DISTINCT FROM NEW.clinical_order_id THEN
    RAISE EXCEPTION 'MAR supply must match the ward-indent clinical order'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.evidence_status = 'unmatched_override' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR supply allocation not found'
      USING ERRCODE = '23503';
  END IF;
  IF allocation.status = 'released'
     OR allocation.consumed_quantity + allocation.returned_quantity + NEW.quantity
          > allocation.received_quantity THEN
    RAISE EXCEPTION 'MAR supply exceeds received unconsumed ward custody'
      USING ERRCODE = '23514';
  END IF;

  UPDATE ward_indent_inventory_allocations
     SET consumed_quantity = consumed_quantity + NEW.quantity,
         status = CASE
           WHEN consumed_quantity + returned_quantity + NEW.quantity = received_quantity
             THEN 'reconciled'
           ELSE status
         END,
         updated_at = NOW()
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_supply_consumption_projection
  BEFORE INSERT ON mar_supply_consumptions
  FOR EACH ROW EXECUTE FUNCTION mar_supply_apply_custody_consumption();

CREATE TRIGGER mar_supply_consumptions_append_only
  BEFORE UPDATE OR DELETE ON mar_supply_consumptions
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE TABLE mar_administration_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  actor_uid UUID NOT NULL,
  command_scope VARCHAR(50) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  administration_mode VARCHAR(50) NOT NULL,
  response_data JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_administration_command_receipts_identity_check CHECK (
    command_key = BTRIM(command_key)
    AND command_key ~ '^[A-Za-z0-9_:.\-]+$'
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      (command_scope = 'mar_administer' AND administration_mode = 'online_no_scan')
      OR
      (command_scope = 'mar_administer_scan' AND administration_mode = 'online_barcode_scan')
    )
  ),
  CONSTRAINT mar_administration_command_receipts_response_check CHECK (
    jsonb_typeof(response_data) = 'object'
    AND response_data->>'id' ~ '^[1-9][0-9]*$'
    AND (response_data->>'id')::INTEGER = medication_administration_id
    AND LOWER(response_data->>'status') = 'administered'
  ),
  CONSTRAINT fk_mar_administration_command_receipts_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_administration_command_receipts_administration
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES medication_administrations (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_administration_command_receipts_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_administration_command_receipts_identity
    UNIQUE (tenant_id, actor_uid, command_scope, command_key),
  CONSTRAINT ux_mar_administration_command_receipts_target
    UNIQUE (tenant_id, medication_administration_id),
  CONSTRAINT ux_mar_administration_command_receipts_tenant_id
    UNIQUE (tenant_id, id)
);

CREATE INDEX idx_mar_administration_command_receipts_completed
  ON mar_administration_command_receipts
    (tenant_id, completed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION mar_administration_command_receipt_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  administration RECORD;
BEGIN
  SELECT status, administered_by, scanned_patient_uid, scanned_barcode,
         patient_scanned_at, medication_scanned_at
    INTO administration
    FROM medication_administrations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.medication_administration_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR administration command target not found'
      USING ERRCODE = '23503';
  END IF;
  IF LOWER(administration.status) <> 'administered'
     OR administration.administered_by IS DISTINCT FROM NEW.actor_uid THEN
    RAISE EXCEPTION 'MAR administration command receipt must match the committed actor and state'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.command_scope = 'mar_administer_scan'
     AND (
       administration.scanned_patient_uid IS NULL
       OR NULLIF(BTRIM(administration.scanned_barcode), '') IS NULL
       OR administration.patient_scanned_at IS NULL
       OR administration.medication_scanned_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Scanned MAR command receipt requires committed two-scan evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_administration_command_receipt_validation
  BEFORE INSERT ON mar_administration_command_receipts
  FOR EACH ROW EXECUTE FUNCTION mar_administration_command_receipt_validate();

CREATE TRIGGER mar_administration_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON mar_administration_command_receipts
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE TABLE mar_transition_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  actor_uid UUID NOT NULL,
  command_scope VARCHAR(50) NOT NULL,
  transition_action VARCHAR(20) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  response_data JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_transition_command_receipts_identity_check CHECK (
    command_key = BTRIM(command_key)
    AND command_key ~ '^[A-Za-z0-9_:.\-]+$'
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      (command_scope = 'mar_miss' AND transition_action = 'missed')
      OR
      (command_scope = 'mar_hold' AND transition_action = 'held')
    )
  ),
  CONSTRAINT mar_transition_command_receipts_response_check CHECK (
    jsonb_typeof(response_data) = 'object'
    AND response_data->>'id' ~ '^[1-9][0-9]*$'
    AND (response_data->>'id')::INTEGER = medication_administration_id
    AND LOWER(response_data->>'status') = transition_action
  ),
  CONSTRAINT fk_mar_transition_command_receipts_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_transition_command_receipts_administration
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES medication_administrations (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_transition_command_receipts_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_transition_command_receipts_identity
    UNIQUE (tenant_id, actor_uid, command_scope, command_key),
  CONSTRAINT ux_mar_transition_command_receipts_target_action
    UNIQUE (tenant_id, medication_administration_id, transition_action),
  CONSTRAINT ux_mar_transition_command_receipts_tenant_id
    UNIQUE (tenant_id, id)
);

CREATE INDEX idx_mar_transition_command_receipts_completed
  ON mar_transition_command_receipts
    (tenant_id, completed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION mar_transition_command_receipt_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  administration RECORD;
BEGIN
  SELECT status, held_by, held_at, missed_by, missed_at
    INTO administration
    FROM medication_administrations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.medication_administration_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR transition command target not found'
      USING ERRCODE = '23503';
  END IF;
  IF LOWER(administration.status) <> NEW.transition_action THEN
    RAISE EXCEPTION 'MAR transition receipt must match the committed state'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.transition_action = 'held'
     AND (
       administration.held_by IS DISTINCT FROM NEW.actor_uid
       OR administration.held_at IS NULL
     ) THEN
    RAISE EXCEPTION 'MAR hold receipt must match the committed actor and time'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.transition_action = 'missed'
     AND (
       administration.missed_by IS DISTINCT FROM NEW.actor_uid
       OR administration.missed_at IS NULL
     ) THEN
    RAISE EXCEPTION 'MAR miss receipt must match the committed actor and time'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_transition_command_receipt_validation
  BEFORE INSERT ON mar_transition_command_receipts
  FOR EACH ROW EXECUTE FUNCTION mar_transition_command_receipt_validate();

CREATE TRIGGER mar_transition_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON mar_transition_command_receipts
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE TABLE mar_supply_reconciliation_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  unmatched_consumption_id BIGINT NOT NULL,
  clinical_order_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  inventory_allocation_id BIGINT NOT NULL,
  inventory_batch_id INTEGER NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  reconciled_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_supply_reconciliation_links_quantity_check CHECK (quantity > 0),
  CONSTRAINT mar_supply_reconciliation_links_command_check
    CHECK (BTRIM(command_key) <> ''),
  CONSTRAINT fk_mar_supply_reconciliation_links_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_supply_reconciliation_links_consumption
    FOREIGN KEY (tenant_id, unmatched_consumption_id)
    REFERENCES mar_supply_consumptions (tenant_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_clinical_order
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_ward_item
    FOREIGN KEY (tenant_id, ward_indent_item_id)
    REFERENCES ward_indent_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_allocation_lineage
    FOREIGN KEY (
      tenant_id,
      inventory_allocation_id,
      ward_indent_item_id,
      inventory_batch_id
    )
    REFERENCES ward_indent_inventory_allocations (
      tenant_id,
      id,
      ward_indent_item_id,
      inventory_batch_id
    )
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_links_actor
    FOREIGN KEY (tenant_id, reconciled_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_supply_reconciliation_links_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_mar_supply_reconciliation_links_command
    UNIQUE (tenant_id, command_key)
);

CREATE INDEX idx_mar_supply_reconciliation_links_consumption
  ON mar_supply_reconciliation_links
    (tenant_id, unmatched_consumption_id, created_at, id);
CREATE INDEX idx_mar_supply_reconciliation_links_allocation_fk_med03
  ON mar_supply_reconciliation_links
    (tenant_id, inventory_allocation_id, ward_indent_item_id, inventory_batch_id);
CREATE INDEX idx_mar_supply_reconciliation_links_clinical_order_fk_med03
  ON mar_supply_reconciliation_links (tenant_id, clinical_order_id);
CREATE INDEX idx_mar_supply_reconciliation_links_ward_item_fk_med03
  ON mar_supply_reconciliation_links (tenant_id, ward_indent_item_id);
CREATE INDEX idx_mar_supply_reconciliation_links_actor_fk_med03
  ON mar_supply_reconciliation_links (tenant_id, reconciled_by);

CREATE TABLE mar_supply_reconciliation_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  unmatched_consumption_id BIGINT NOT NULL,
  medication_administration_id INTEGER NOT NULL,
  actor_uid UUID NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  response_data JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mar_supply_reconciliation_command_receipts_identity_check CHECK (
    command_key = BTRIM(command_key)
    AND command_key ~ '^[A-Za-z0-9_:.\-]+$'
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT mar_supply_reconciliation_command_receipts_response_check CHECK (
    jsonb_typeof(response_data) = 'object'
  ),
  CONSTRAINT fk_mar_supply_reconciliation_command_receipts_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_mar_supply_reconciliation_command_receipts_consumption
    FOREIGN KEY (
      tenant_id,
      unmatched_consumption_id,
      medication_administration_id
    )
    REFERENCES mar_supply_consumptions (
      tenant_id,
      id,
      medication_administration_id
    )
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_command_receipts_administration
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES medication_administrations (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_mar_supply_reconciliation_command_receipts_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_mar_supply_reconciliation_command_receipts_command
    UNIQUE (tenant_id, command_key),
  CONSTRAINT ux_mar_supply_reconciliation_command_receipts_tenant_id
    UNIQUE (tenant_id, id)
);

CREATE INDEX idx_mar_supply_reconciliation_command_receipts_consumption
  ON mar_supply_reconciliation_command_receipts (
    tenant_id,
    unmatched_consumption_id,
    medication_administration_id
  );
CREATE INDEX idx_mar_supply_reconciliation_command_receipts_administration
  ON mar_supply_reconciliation_command_receipts (
    tenant_id,
    medication_administration_id
  );
CREATE INDEX idx_mar_supply_reconciliation_command_receipts_actor
  ON mar_supply_reconciliation_command_receipts (tenant_id, actor_uid);

CREATE TRIGGER mar_supply_reconciliation_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON mar_supply_reconciliation_command_receipts
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE OR REPLACE FUNCTION mar_supply_batch_unavailable_reason(
  inventory_item_status TEXT,
  inventory_batch_status TEXT,
  inventory_batch_expiry_date DATE,
  available_quantity NUMERIC,
  reference_instant TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT CASE
    WHEN LOWER(COALESCE(NULLIF(BTRIM(inventory_item_status), ''), '')) <> 'active'
      THEN 'inventory_item_inactive'
    WHEN LOWER(COALESCE(NULLIF(BTRIM(inventory_batch_status), ''), ''))
           NOT IN ('in_stock', 'depleted')
      THEN 'batch_' || COALESCE(
        NULLIF(LOWER(BTRIM(inventory_batch_status)), ''),
        'status_missing'
      )
    WHEN LOWER(BTRIM(inventory_batch_status)) = 'depleted'
         AND COALESCE(available_quantity, 0) <= 0
      THEN 'batch_depleted'
    WHEN COALESCE(available_quantity, 0) <= 0
      THEN 'ward_custody_unavailable'
    WHEN inventory_batch_expiry_date IS NULL
      THEN 'batch_expiry_missing'
    WHEN inventory_batch_expiry_date < (reference_instant AT TIME ZONE 'Asia/Kolkata')::date
      THEN 'batch_expired'
    ELSE NULL
  END
$fn$;

CREATE OR REPLACE FUNCTION mar_supply_apply_reconciliation_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  unmatched mar_supply_consumptions%ROWTYPE;
  allocation ward_indent_inventory_allocations%ROWTYPE;
  inventory_item_status TEXT;
  inventory_batch_status TEXT;
  inventory_batch_expiry_date DATE;
  batch_unavailable_reason TEXT;
  already_reconciled NUMERIC(14, 4);
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format(
        'med03-mar-reconciliation:%s:%s',
        NEW.tenant_id,
        NEW.unmatched_consumption_id
      ),
      0
    )
  );
  SELECT * INTO unmatched
    FROM mar_supply_consumptions
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.unmatched_consumption_id;
  IF NOT FOUND OR unmatched.evidence_status <> 'unmatched_override' THEN
    RAISE EXCEPTION 'MAR reconciliation requires an unmatched override consumption'
      USING ERRCODE = '23514';
  END IF;
  IF unmatched.clinical_order_id IS DISTINCT FROM NEW.clinical_order_id
     OR unmatched.ward_indent_item_id IS DISTINCT FROM NEW.ward_indent_item_id THEN
    RAISE EXCEPTION 'MAR reconciliation must preserve the original order and ward item'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id
   FOR UPDATE;
  IF NOT FOUND OR allocation.status = 'released' THEN
    RAISE EXCEPTION 'MAR reconciliation allocation is unavailable'
      USING ERRCODE = '23514';
  END IF;

  SELECT item.status, batch.status, batch.expiry_date
    INTO inventory_item_status, inventory_batch_status, inventory_batch_expiry_date
    FROM pharmacy_inventory_batches batch
    JOIN pharmacy_inventory_items item
      ON item.tenant_id = batch.tenant_id
     AND item.id = batch.inventory_item_id
   WHERE batch.tenant_id = allocation.tenant_id
     AND batch.id = allocation.inventory_batch_id
     AND batch.inventory_item_id = allocation.inventory_item_id
   FOR UPDATE OF batch FOR SHARE OF item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAR reconciliation batch lineage is unavailable'
      USING ERRCODE = '23503';
  END IF;

  batch_unavailable_reason := mar_supply_batch_unavailable_reason(
    inventory_item_status,
    inventory_batch_status,
    inventory_batch_expiry_date,
    allocation.received_quantity
      - allocation.consumed_quantity
      - allocation.returned_quantity
  );
  IF batch_unavailable_reason IS NOT NULL THEN
    RAISE EXCEPTION
      'MAR reconciliation requires currently eligible ward batch custody'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_mar_supply_reconciliation_batch_eligible',
            DETAIL = pg_catalog.format('reason=%s', batch_unavailable_reason);
  END IF;

  SELECT COALESCE(SUM(link.quantity), 0)::numeric
    INTO already_reconciled
    FROM mar_supply_reconciliation_links link
   WHERE link.tenant_id = NEW.tenant_id
     AND link.unmatched_consumption_id = NEW.unmatched_consumption_id;
  IF already_reconciled + NEW.quantity > unmatched.quantity THEN
    RAISE EXCEPTION 'MAR reconciliation exceeds the unmatched administration quantity'
      USING ERRCODE = '23514';
  END IF;
  IF allocation.consumed_quantity + allocation.returned_quantity + NEW.quantity
       > allocation.received_quantity THEN
    RAISE EXCEPTION 'MAR reconciliation exceeds received unconsumed ward custody'
      USING ERRCODE = '23514';
  END IF;

  UPDATE ward_indent_inventory_allocations
     SET consumed_quantity = consumed_quantity + NEW.quantity,
         status = CASE
           WHEN consumed_quantity + returned_quantity + NEW.quantity = received_quantity
             THEN 'reconciled'
           ELSE status
         END,
         updated_at = NOW()
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.inventory_allocation_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mar_supply_reconciliation_link_projection
  BEFORE INSERT ON mar_supply_reconciliation_links
  FOR EACH ROW EXECUTE FUNCTION mar_supply_apply_reconciliation_link();

CREATE TRIGGER mar_supply_reconciliation_links_append_only
  BEFORE UPDATE OR DELETE ON mar_supply_reconciliation_links
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE OR REPLACE FUNCTION ward_indent_inventory_allocation_evidence_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  allocation ward_indent_inventory_allocations%ROWTYPE;
  issued_evidence NUMERIC(14, 4);
  received_evidence NUMERIC(14, 4);
  returned_evidence NUMERIC(14, 4);
  consumed_evidence NUMERIC(14, 4);
BEGIN
  SELECT * INTO allocation
    FROM ward_indent_inventory_allocations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(quantity), 0)::numeric
    INTO issued_evidence
    FROM ward_indent_inventory_movement_links
   WHERE tenant_id = allocation.tenant_id
     AND allocation_id = allocation.id
     AND movement_purpose = 'issue';

  SELECT COALESCE(SUM(quantity_delta), 0)::numeric
    INTO received_evidence
    FROM ward_indent_inventory_receipt_events
   WHERE tenant_id = allocation.tenant_id
     AND inventory_allocation_id = allocation.id;

  SELECT COALESCE(SUM(quantity), 0)::numeric
    INTO returned_evidence
    FROM ward_indent_inventory_movement_links
   WHERE tenant_id = allocation.tenant_id
     AND allocation_id = allocation.id
     AND movement_purpose = 'return';

  SELECT (
    COALESCE((
      SELECT SUM(consumption.quantity)
        FROM mar_supply_consumptions consumption
       WHERE consumption.tenant_id = allocation.tenant_id
         AND consumption.inventory_allocation_id = allocation.id
         AND consumption.evidence_status = 'matched'
    ), 0)
    +
    COALESCE((
      SELECT SUM(link.quantity)
        FROM mar_supply_reconciliation_links link
       WHERE link.tenant_id = allocation.tenant_id
         AND link.inventory_allocation_id = allocation.id
    ), 0)
  )::numeric
    INTO consumed_evidence;

  IF allocation.issued_quantity IS DISTINCT FROM issued_evidence
     OR allocation.received_quantity IS DISTINCT FROM received_evidence
     OR allocation.returned_quantity IS DISTINCT FROM returned_evidence
     OR allocation.consumed_quantity IS DISTINCT FROM consumed_evidence
  THEN
    RAISE EXCEPTION 'ward-indent inventory allocation projections must equal append-only evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_ward_indent_inventory_allocation_evidence_equality';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER ward_indent_inventory_allocation_evidence_equality
  AFTER INSERT OR UPDATE ON ward_indent_inventory_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ward_indent_inventory_allocation_evidence_validate();

-- ---------------------------------------------------------------------------
-- Append-only medication financial evidence and governed credit obligations
-- ---------------------------------------------------------------------------

ALTER TABLE billing_invoices
  ADD COLUMN credit_note_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE billing_invoices
  ADD CONSTRAINT billing_invoices_credit_note_amount_check CHECK (
    credit_note_amount >= 0
    AND credit_note_amount <= total_amount + 0.005
  );

CREATE UNIQUE INDEX ux_billing_invoice_items_ward_indent_item_med03
  ON billing_invoice_items (tenant_id, source_ref_type, source_ref_id)
  WHERE source_ref_type = 'ward_indent_item'
    AND source_ref_id IS NOT NULL
    AND source_ref_active;

CREATE TABLE ward_indent_financial_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  ward_indent_id INTEGER NOT NULL,
  ward_indent_item_id INTEGER NOT NULL,
  clinical_order_id INTEGER,
  ward_indent_event_id BIGINT NOT NULL,
  ward_indent_state_version INTEGER NOT NULL,
  event_kind VARCHAR(30) NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  unit_price_minor BIGINT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  pricing_snapshot JSONB NOT NULL,
  original_event_id BIGINT,
  invoice_id INTEGER,
  invoice_item_id INTEGER,
  event_key VARCHAR(200) NOT NULL,
  actor_uid UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ward_indent_financial_events_kind_check CHECK (
    event_kind IN ('charge', 'credit', 'charge_reversal', 'credit_reversal')
  ),
  CONSTRAINT ward_indent_financial_events_quantity_check CHECK (quantity > 0),
  CONSTRAINT ward_indent_financial_events_price_check CHECK (unit_price_minor >= 0),
  CONSTRAINT ward_indent_financial_events_amount_check CHECK (
    amount_minor = CASE
      WHEN event_kind IN ('charge', 'credit_reversal')
        THEN ROUND(quantity * unit_price_minor)::BIGINT
      ELSE -ROUND(quantity * unit_price_minor)::BIGINT
    END
  ),
  CONSTRAINT ward_indent_financial_events_currency_check CHECK (
    currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT ward_indent_financial_events_version_check
    CHECK (ward_indent_state_version > 0),
  CONSTRAINT ward_indent_financial_events_key_check CHECK (BTRIM(event_key) <> ''),
  CONSTRAINT ward_indent_financial_events_original_check CHECK (
    (event_kind = 'charge' AND original_event_id IS NULL)
    OR (event_kind <> 'charge' AND original_event_id IS NOT NULL)
  ),
  CONSTRAINT ward_indent_financial_events_invoice_projection_check CHECK (
    (invoice_id IS NULL AND invoice_item_id IS NULL)
    OR (invoice_id IS NOT NULL AND invoice_item_id IS NOT NULL)
  ),
  CONSTRAINT fk_ward_indent_financial_events_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_ward_indent_financial_events_indent_item
    FOREIGN KEY (tenant_id, ward_indent_item_id, ward_indent_id)
    REFERENCES ward_indent_items (tenant_id, id, ward_indent_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_clinical_order
    FOREIGN KEY (tenant_id, clinical_order_id)
    REFERENCES clinical_orders (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_ward_event
    FOREIGN KEY (
      tenant_id,
      ward_indent_event_id,
      ward_indent_id,
      ward_indent_state_version
    )
    REFERENCES ward_indent_events (tenant_id, id, ward_indent_id, state_version)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_ward_indent_financial_events_original
    FOREIGN KEY (tenant_id, original_event_id)
    REFERENCES ward_indent_financial_events (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_invoice
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing_invoices (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_invoice_item
    FOREIGN KEY (tenant_id, invoice_item_id)
    REFERENCES billing_invoice_items (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_ward_indent_financial_events_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_ward_indent_financial_events_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ward_indent_financial_events_event_key
    UNIQUE (tenant_id, event_key)
);

CREATE INDEX idx_ward_indent_financial_events_indent
  ON ward_indent_financial_events
    (tenant_id, ward_indent_id, ward_indent_item_id, occurred_at, id);
CREATE INDEX idx_ward_indent_financial_events_invoice
  ON ward_indent_financial_events
    (tenant_id, invoice_id, occurred_at, id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_wi_financial_original_fk_med03
  ON ward_indent_financial_events
    (tenant_id, original_event_id)
  WHERE original_event_id IS NOT NULL;
CREATE INDEX idx_wi_financial_clinical_order_fk_med03
  ON ward_indent_financial_events
    (tenant_id, clinical_order_id)
  WHERE clinical_order_id IS NOT NULL;
CREATE INDEX idx_wi_financial_invoice_item_fk_med03
  ON ward_indent_financial_events
    (tenant_id, invoice_item_id)
  WHERE invoice_item_id IS NOT NULL;
CREATE INDEX idx_wi_financial_ward_event_fk_med03
  ON ward_indent_financial_events
    (tenant_id, ward_indent_event_id, ward_indent_id, ward_indent_state_version);
CREATE INDEX idx_wi_financial_actor_fk_med03
  ON ward_indent_financial_events (tenant_id, actor_uid);

CREATE OR REPLACE FUNCTION ward_indent_validate_financial_event_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  original ward_indent_financial_events%ROWTYPE;
  root_charge ward_indent_financial_events%ROWTYPE;
  root_charge_id BIGINT;
  effective_reduction NUMERIC(14, 4);
  prior_reversal_quantity NUMERIC(14, 4);
  ward_item_order_id INTEGER;
  indent_patient_uid UUID;
  projected_invoice_patient_uid UUID;
  projected_line_invoice_id INTEGER;
  projected_line_source_type VARCHAR(80);
  projected_line_source_id BIGINT;
  projected_line_active BOOLEAN;
BEGIN
  SELECT item.clinical_order_id, indent.patient_uid
    INTO ward_item_order_id, indent_patient_uid
    FROM ward_indent_items item
    JOIN ward_indents indent
      ON indent.tenant_id = item.tenant_id
     AND indent.id = item.ward_indent_id
   WHERE item.tenant_id = NEW.tenant_id
     AND item.id = NEW.ward_indent_item_id
     AND indent.id = NEW.ward_indent_id
   FOR KEY SHARE OF item, indent;
  IF NOT FOUND OR ward_item_order_id IS DISTINCT FROM NEW.clinical_order_id THEN
    RAISE EXCEPTION 'ward-indent financial event does not match its clinical-order item'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    SELECT invoice.patient_uid,
           line.invoice_id,
           line.source_ref_type,
           line.source_ref_id,
           line.source_ref_active
      INTO projected_invoice_patient_uid,
           projected_line_invoice_id,
           projected_line_source_type,
           projected_line_source_id,
           projected_line_active
      FROM billing_invoices invoice
      JOIN billing_invoice_items line
        ON line.tenant_id = invoice.tenant_id
       AND line.id = NEW.invoice_item_id
     WHERE invoice.tenant_id = NEW.tenant_id
       AND invoice.id = NEW.invoice_id
     FOR KEY SHARE OF invoice, line;
    IF NOT FOUND
       OR projected_invoice_patient_uid IS DISTINCT FROM indent_patient_uid
       OR projected_line_invoice_id IS DISTINCT FROM NEW.invoice_id
       OR projected_line_source_type IS DISTINCT FROM 'ward_indent_item'
       OR projected_line_source_id IS DISTINCT FROM NEW.ward_indent_item_id::BIGINT
       OR projected_line_active IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ward-indent financial event invoice projection has mismatched lineage'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.original_event_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original
    FROM ward_indent_financial_events
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.original_event_id;
  IF NOT FOUND
     OR original.ward_indent_id <> NEW.ward_indent_id
     OR original.ward_indent_item_id <> NEW.ward_indent_item_id
     OR original.clinical_order_id IS DISTINCT FROM NEW.clinical_order_id
     OR original.invoice_id IS DISTINCT FROM NEW.invoice_id
     OR original.invoice_item_id IS DISTINCT FROM NEW.invoice_item_id
     OR original.currency <> NEW.currency
     OR original.unit_price_minor <> NEW.unit_price_minor THEN
    RAISE EXCEPTION 'ward-indent financial event lineage does not match its original charge'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'credit' AND original.event_kind <> 'charge' THEN
    RAISE EXCEPTION 'ward-indent credit must reference an original charge'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'charge_reversal' AND original.event_kind <> 'charge' THEN
    RAISE EXCEPTION 'ward-indent charge reversal must reference a charge'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'credit_reversal' AND original.event_kind <> 'credit' THEN
    RAISE EXCEPTION 'ward-indent credit reversal must reference a credit'
      USING ERRCODE = '23514';
  END IF;

  root_charge_id := CASE
    WHEN original.event_kind = 'charge' THEN original.id
    WHEN original.event_kind = 'credit' THEN original.original_event_id
    ELSE NULL
  END;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.format(
        'med03-financial-root:%s:%s',
        NEW.tenant_id,
        root_charge_id
      ),
      0
    )
  );
  SELECT * INTO root_charge
    FROM ward_indent_financial_events
   WHERE tenant_id = NEW.tenant_id
     AND id = root_charge_id
     AND event_kind = 'charge';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ward-indent financial event has no root charge'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.quantity > original.quantity THEN
    RAISE EXCEPTION 'ward-indent financial event exceeds original quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_kind = 'credit_reversal' THEN
    SELECT COALESCE(SUM(event.quantity), 0)
      INTO prior_reversal_quantity
      FROM ward_indent_financial_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.event_kind = 'credit_reversal'
       AND event.original_event_id = original.id;
    IF prior_reversal_quantity + NEW.quantity > original.quantity THEN
      RAISE EXCEPTION 'ward-indent credit reversals cumulatively exceed the credit'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT
      COALESCE((
        SELECT SUM(event.quantity)
          FROM ward_indent_financial_events event
         WHERE event.tenant_id = NEW.tenant_id
           AND event.original_event_id = root_charge.id
           AND event.event_kind IN ('credit', 'charge_reversal')
      ), 0)
      - COALESCE((
        SELECT SUM(reversal.quantity)
          FROM ward_indent_financial_events reversal
          JOIN ward_indent_financial_events credit
            ON credit.tenant_id = reversal.tenant_id
           AND credit.id = reversal.original_event_id
           AND credit.event_kind = 'credit'
         WHERE reversal.tenant_id = NEW.tenant_id
           AND reversal.event_kind = 'credit_reversal'
           AND credit.original_event_id = root_charge.id
      ), 0)
      INTO effective_reduction;
    IF effective_reduction + NEW.quantity > root_charge.quantity THEN
      RAISE EXCEPTION 'ward-indent credits and reversals cumulatively exceed the root charge'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ward_indent_financial_event_lineage
  BEFORE INSERT ON ward_indent_financial_events
  FOR EACH ROW EXECUTE FUNCTION ward_indent_validate_financial_event_lineage();

CREATE TRIGGER ward_indent_financial_events_append_only
  BEFORE UPDATE OR DELETE ON ward_indent_financial_events
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE TABLE billing_credit_notes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  credit_note_number VARCHAR(80) NOT NULL,
  invoice_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  source_financial_event_id BIGINT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  task_id INTEGER,
  raised_by UUID NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_by UUID,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  applied_by UUID,
  applied_at TIMESTAMPTZ,
  application_key VARCHAR(200),
  receivable_credit_minor BIGINT NOT NULL DEFAULT 0,
  refund_obligation_minor BIGINT NOT NULL DEFAULT 0,
  refund_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_credit_notes_amount_check CHECK (amount_minor > 0),
  CONSTRAINT billing_credit_notes_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT billing_credit_notes_reason_check CHECK (BTRIM(reason) <> ''),
  CONSTRAINT billing_credit_notes_status_check CHECK (
    status IN ('pending', 'approved', 'rejected', 'applied')
  ),
  CONSTRAINT billing_credit_notes_projection_check CHECK (
    receivable_credit_minor >= 0
    AND refund_obligation_minor >= 0
    AND receivable_credit_minor + refund_obligation_minor <= amount_minor
  ),
  CONSTRAINT billing_credit_notes_refund_projection_check CHECK (
    (refund_obligation_minor = 0 AND refund_id IS NULL)
    OR
    (status = 'applied' AND refund_obligation_minor > 0 AND refund_id IS NOT NULL)
  ),
  CONSTRAINT billing_credit_notes_lifecycle_check CHECK (
    (
      status = 'pending'
      AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
      AND applied_by IS NULL AND applied_at IS NULL AND application_key IS NULL
    )
    OR
    (
      status = 'approved'
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
      AND applied_by IS NULL AND applied_at IS NULL AND application_key IS NULL
    )
    OR
    (
      status = 'rejected'
      AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL AND BTRIM(rejection_reason) <> ''
      AND applied_by IS NULL AND applied_at IS NULL AND application_key IS NULL
    )
    OR
    (
      status = 'applied'
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
      AND applied_by IS NOT NULL AND applied_at IS NOT NULL
      AND application_key IS NOT NULL AND BTRIM(application_key) <> ''
      AND receivable_credit_minor + refund_obligation_minor = amount_minor
    )
  ),
  CONSTRAINT fk_billing_credit_notes_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_billing_credit_notes_invoice
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing_invoices (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_financial_event
    FOREIGN KEY (tenant_id, source_financial_event_id)
    REFERENCES ward_indent_financial_events (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_raised_by
    FOREIGN KEY (tenant_id, raised_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_approved_by
    FOREIGN KEY (tenant_id, approved_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_rejected_by
    FOREIGN KEY (tenant_id, rejected_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_applied_by
    FOREIGN KEY (tenant_id, applied_by)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_notes_refund
    FOREIGN KEY (tenant_id, refund_id)
    REFERENCES billing_refunds (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_billing_credit_notes_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_billing_credit_notes_number UNIQUE (tenant_id, credit_note_number),
  CONSTRAINT ux_billing_credit_notes_source_event
    UNIQUE (tenant_id, source_financial_event_id),
  CONSTRAINT ux_billing_credit_notes_application_key
    UNIQUE (tenant_id, application_key)
);

CREATE INDEX idx_billing_credit_notes_worklist
  ON billing_credit_notes (tenant_id, status, raised_at, id);
CREATE INDEX idx_billing_credit_notes_invoice
  ON billing_credit_notes (tenant_id, invoice_id, raised_at, id);
CREATE INDEX idx_billing_credit_notes_patient_fk_med03
  ON billing_credit_notes (tenant_id, patient_uid);
CREATE INDEX idx_billing_credit_notes_task_fk_med03
  ON billing_credit_notes (tenant_id, task_id)
  WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX ux_billing_credit_notes_refund_med03
  ON billing_credit_notes (tenant_id, refund_id)
  WHERE refund_id IS NOT NULL;
CREATE INDEX idx_billing_credit_notes_raised_by_fk_med03
  ON billing_credit_notes (tenant_id, raised_by);
CREATE INDEX idx_billing_credit_notes_approved_by_fk_med03
  ON billing_credit_notes (tenant_id, approved_by)
  WHERE approved_by IS NOT NULL;
CREATE INDEX idx_billing_credit_notes_rejected_by_fk_med03
  ON billing_credit_notes (tenant_id, rejected_by)
  WHERE rejected_by IS NOT NULL;
CREATE INDEX idx_billing_credit_notes_applied_by_fk_med03
  ON billing_credit_notes (tenant_id, applied_by)
  WHERE applied_by IS NOT NULL;

CREATE TABLE billing_credit_note_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  credit_note_id BIGINT NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  actor_uid UUID NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_credit_note_events_type_check CHECK (
    event_type IN ('raised', 'approved', 'rejected', 'applied')
  ),
  CONSTRAINT billing_credit_note_events_command_check CHECK (
    BTRIM(command_key) <> ''
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fk_billing_credit_note_events_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_billing_credit_note_events_note
    FOREIGN KEY (tenant_id, credit_note_id)
    REFERENCES billing_credit_notes (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_billing_credit_note_events_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT ux_billing_credit_note_events_command UNIQUE (tenant_id, command_key),
  CONSTRAINT ux_billing_credit_note_events_state
    UNIQUE (tenant_id, credit_note_id, event_type)
);

CREATE INDEX idx_billing_credit_note_events_note
  ON billing_credit_note_events (tenant_id, credit_note_id, occurred_at, id);
CREATE INDEX idx_billing_credit_note_events_actor_fk_med03
  ON billing_credit_note_events (tenant_id, actor_uid);

CREATE TRIGGER billing_credit_note_events_append_only
  BEFORE UPDATE OR DELETE ON billing_credit_note_events
  FOR EACH ROW EXECUTE FUNCTION medication_evidence_append_only_guard();

CREATE OR REPLACE FUNCTION billing_credit_note_event_state_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  note billing_credit_notes%ROWTYPE;
BEGIN
  SELECT * INTO note
    FROM billing_credit_notes
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.credit_note_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing credit-note event requires its same-tenant note'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.event_type = 'raised' THEN
    IF note.status NOT IN ('pending', 'applied')
       OR NEW.actor_uid IS DISTINCT FROM note.raised_by
    THEN
      RAISE EXCEPTION 'billing credit-note raised event actor does not match its note'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'approved' THEN
    IF note.status NOT IN ('approved', 'applied')
       OR NEW.actor_uid IS DISTINCT FROM note.approved_by
    THEN
      RAISE EXCEPTION 'billing credit-note approval event precedes its note state'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'rejected' THEN
    IF note.status IS DISTINCT FROM 'rejected'
       OR NEW.actor_uid IS DISTINCT FROM note.rejected_by
    THEN
      RAISE EXCEPTION 'billing credit-note rejection event precedes its note state'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'applied' THEN
    IF note.status IS DISTINCT FROM 'applied'
       OR NEW.actor_uid IS DISTINCT FROM note.applied_by
       OR NEW.command_key IS DISTINCT FROM note.application_key
    THEN
      RAISE EXCEPTION 'billing credit-note application event precedes its note state'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'billing credit-note event type is unsupported'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER billing_credit_note_event_state
  BEFORE INSERT ON billing_credit_note_events
  FOR EACH ROW EXECUTE FUNCTION billing_credit_note_event_state_validate();

CREATE OR REPLACE FUNCTION billing_credit_note_require_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  invoice_patient UUID;
  invoice_status VARCHAR(30);
  source_event ward_indent_financial_events%ROWTYPE;
  refund_row billing_refunds%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.credit_note_number IS DISTINCT FROM OLD.credit_note_number
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.source_financial_event_id IS DISTINCT FROM OLD.source_financial_event_id
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.raised_by IS DISTINCT FROM OLD.raised_by
    OR NEW.raised_at IS DISTINCT FROM OLD.raised_at
  ) THEN
    RAISE EXCEPTION 'billing credit-note source identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'applied')
  ) THEN
    RAISE EXCEPTION 'billing credit-note state transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    (OLD.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id)
    OR (
      OLD.approved_by IS NOT NULL
      AND (
        NEW.approved_by IS DISTINCT FROM OLD.approved_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      )
    )
    OR (
      OLD.rejected_by IS NOT NULL
      AND (
        NEW.rejected_by IS DISTINCT FROM OLD.rejected_by
        OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
        OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
      )
    )
    OR (
      OLD.applied_by IS NOT NULL
      AND (
        NEW.applied_by IS DISTINCT FROM OLD.applied_by
        OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
        OR NEW.application_key IS DISTINCT FROM OLD.application_key
        OR NEW.receivable_credit_minor IS DISTINCT FROM OLD.receivable_credit_minor
        OR NEW.refund_obligation_minor IS DISTINCT FROM OLD.refund_obligation_minor
        OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
      )
    )
  ) THEN
    RAISE EXCEPTION 'billing credit-note recorded authority is immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT patient_uid, status INTO invoice_patient, invoice_status
    FROM billing_invoices
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.invoice_id
   FOR KEY SHARE;
  IF NOT FOUND OR invoice_patient IS DISTINCT FROM NEW.patient_uid THEN
    RAISE EXCEPTION 'billing credit note must match its invoice patient'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'applied' AND invoice_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only a draft invoice credit may be inserted already applied'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO source_event
    FROM ward_indent_financial_events
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.source_financial_event_id;
  IF NOT FOUND
     OR source_event.event_kind <> 'credit'
     OR source_event.invoice_id IS DISTINCT FROM NEW.invoice_id
     OR ABS(source_event.amount_minor) <> NEW.amount_minor
     OR source_event.currency <> NEW.currency THEN
    RAISE EXCEPTION 'billing credit note must match its source credit event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.refund_id IS NOT NULL THEN
    SELECT * INTO refund_row
      FROM billing_refunds
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.refund_id
     FOR KEY SHARE;
    IF NOT FOUND
       OR refund_row.invoice_id IS DISTINCT FROM NEW.invoice_id
       OR refund_row.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR ROUND(refund_row.amount * 100)::BIGINT IS DISTINCT FROM NEW.refund_obligation_minor THEN
      RAISE EXCEPTION 'billing credit-note refund does not match its patient obligation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER billing_credit_note_context
  BEFORE INSERT OR UPDATE ON billing_credit_notes
  FOR EACH ROW EXECUTE FUNCTION billing_credit_note_require_context();

CREATE OR REPLACE FUNCTION billing_credit_note_require_lifecycle_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  required_event VARCHAR(30);
  required_actor UUID;
BEGIN
  required_event := 'raised';
  required_actor := NEW.raised_by;
  IF NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = required_event
       AND event.actor_uid = required_actor
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching raised event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('approved', 'applied') AND NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = 'approved'
       AND event.actor_uid = NEW.approved_by
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching approval event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'rejected' AND NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = 'rejected'
       AND event.actor_uid = NEW.rejected_by
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching rejection event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'applied' AND NOT EXISTS (
    SELECT 1
      FROM billing_credit_note_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.credit_note_id = NEW.id
       AND event.event_type = 'applied'
       AND event.actor_uid = NEW.applied_by
  ) THEN
    RAISE EXCEPTION 'billing credit-note state has no matching application event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER billing_credit_note_lifecycle_event
  AFTER INSERT OR UPDATE OF status ON billing_credit_notes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_credit_note_require_lifecycle_event();

-- ---------------------------------------------------------------------------
-- Tenant isolation and append-only safety
-- ---------------------------------------------------------------------------

ALTER TABLE mar_medication_exception_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_medication_exception_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_medication_exception_cases
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
CREATE POLICY explicit_tenant_context ON mar_medication_exception_cases
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

ALTER TABLE mar_medication_exception_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_medication_exception_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_medication_exception_events
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
CREATE POLICY explicit_tenant_context ON mar_medication_exception_events
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

ALTER TABLE ward_indent_inventory_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_inventory_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_inventory_allocations
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
CREATE POLICY explicit_tenant_context ON ward_indent_inventory_allocations
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

ALTER TABLE ward_indent_inventory_movement_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_inventory_movement_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_inventory_movement_links
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
CREATE POLICY explicit_tenant_context ON ward_indent_inventory_movement_links
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

ALTER TABLE ward_indent_inventory_receipt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_inventory_receipt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_inventory_receipt_events
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
CREATE POLICY explicit_tenant_context ON ward_indent_inventory_receipt_events
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

ALTER TABLE mar_supply_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_supply_consumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_supply_consumptions
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
CREATE POLICY explicit_tenant_context ON mar_supply_consumptions
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

ALTER TABLE mar_administration_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_administration_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_administration_command_receipts
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
CREATE POLICY explicit_tenant_context ON mar_administration_command_receipts
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

ALTER TABLE mar_transition_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_transition_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_transition_command_receipts
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
CREATE POLICY explicit_tenant_context ON mar_transition_command_receipts
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

ALTER TABLE mar_supply_reconciliation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_supply_reconciliation_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_supply_reconciliation_links
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
CREATE POLICY explicit_tenant_context ON mar_supply_reconciliation_links
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

ALTER TABLE mar_supply_reconciliation_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mar_supply_reconciliation_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mar_supply_reconciliation_command_receipts
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
CREATE POLICY explicit_tenant_context ON mar_supply_reconciliation_command_receipts
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

ALTER TABLE ward_indent_financial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ward_indent_financial_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ward_indent_financial_events
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
CREATE POLICY explicit_tenant_context ON ward_indent_financial_events
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

ALTER TABLE billing_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_credit_notes
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
CREATE POLICY explicit_tenant_context ON billing_credit_notes
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

ALTER TABLE billing_credit_note_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_note_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_credit_note_events
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
CREATE POLICY explicit_tenant_context ON billing_credit_note_events
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

-- Ward-medication tasks are typed, domain-evidence obligations. Migration 580's
-- rolling compatibility trigger intentionally rejects unknown SLA contracts,
-- so MED-03 adds a narrow contract handler instead of weakening that guard.
CREATE OR REPLACE FUNCTION ward_medication_tasks_sync_workflow_sla_compat()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  sla_record workflow_sla_instances%ROWTYPE;
  metadata_value JSONB := COALESCE(NEW.metadata, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(metadata_value) IS DISTINCT FROM 'object'
     OR metadata_value->>'task_contract' IS DISTINCT FROM 'ward_medication_obligation_v1'
  THEN
    RAISE EXCEPTION
      'ward medication task metadata contract is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.workflow_sla_instance_id IS NULL
     OR NEW.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR NULLIF(BTRIM(NEW.related_resource_type), '') IS NULL
     OR NULLIF(BTRIM(NEW.related_resource_id), '') IS NULL
  THEN
    RAISE EXCEPTION
      'ward medication task requires a typed domain-evidence SLA source'
      USING ERRCODE = 'check_violation';
  END IF;

  IF metadata_value ? 'requested_sla_key'
     OR metadata_value ? 'sla_policy_status'
  THEN
    RAISE EXCEPTION
      'ward medication task cannot use a degraded SLA policy marker'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = NEW.workflow_sla_instance_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR sla_record.rule_code NOT IN (
       'ward_indent_pharmacy_response',
       'ward_indent_substitution_authorization',
       'ward_indent_controlled_handoff',
       'ward_indent_pharmacy_issue',
       'ward_indent_ward_receipt',
       'ward_indent_reconciliation',
       'ward_indent_mar_supply_reconciliation',
       'ward_indent_credit_note_review',
       'ward_indent_notification_coverage'
     )
     OR sla_record.source_table IS DISTINCT FROM NEW.related_resource_type
     OR sla_record.source_id IS DISTINCT FROM NEW.related_resource_id
     OR sla_record.due_at IS NULL
  THEN
    RAISE EXCEPTION
      'ward medication task and linked SLA do not describe the same obligation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.encounter_id IS NOT NULL
     OR NULLIF(
          LOWER(BTRIM(metadata_value->>'canonical_encounter_id')),
          ''
        ) IS DISTINCT FROM sla_record.encounter_id::text
  THEN
    RAISE EXCEPTION
      'ward medication task canonical encounter must equal its linked SLA encounter'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND (
       sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION
      'actionable ward medication task requires an incomplete SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_sla_instance_id IS NOT NULL
     AND NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
  THEN
    RAISE EXCEPTION
      'ward medication task SLA links are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND NEW.status = 'cancelled'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION
      'ward medication task cannot be cancelled while its SLA is incomplete'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.due_at := sla_record.due_at;
  NEW.metadata := metadata_value
    || jsonb_build_object(
         'sla_instance_id', sla_record.id::text,
         'sla_key', sla_record.rule_code
       );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_insert ON tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') NOT IN (
    'ward_medication_obligation_v1',
    'mar_medication_exception_v1'
  ))
  EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_update ON tasks;
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
  ON tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') NOT IN (
    'ward_medication_obligation_v1',
    'mar_medication_exception_v1'
  ))
  EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_med03_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'ward_medication_obligation_v1')
  EXECUTE FUNCTION ward_medication_tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_med03_update
  BEFORE UPDATE OF
    tenant_id,
    status,
    workflow_step_id,
    encounter_id,
    related_resource_type,
    related_resource_id,
    workflow_sla_instance_id,
    sla_completion_semantics,
    due_at,
    metadata
  ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'ward_medication_obligation_v1')
  EXECUTE FUNCTION ward_medication_tasks_sync_workflow_sla_compat();

CREATE OR REPLACE FUNCTION mar_medication_exception_tasks_sync_workflow_sla_compat()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  sla_record workflow_sla_instances%ROWTYPE;
  metadata_value JSONB := COALESCE(NEW.metadata, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(metadata_value) IS DISTINCT FROM 'object'
     OR NEW.task_kind IS DISTINCT FROM 'review'
     OR NEW.priority IS DISTINCT FROM 'critical'
     OR NEW.workflow_run_id IS NOT NULL
     OR NEW.workflow_step_id IS NOT NULL
     OR NEW.cancelled_at IS NOT NULL
     OR NEW.cancellation_reason IS NOT NULL
     OR metadata_value->>'task_contract' IS DISTINCT FROM 'mar_medication_exception_v1'
     OR COALESCE(metadata_value->>'exception_case_id', '') !~ '^[1-9][0-9]*$'
     OR COALESCE(metadata_value->>'medication_administration_id', '')
          !~ '^[1-9][0-9]*$'
     OR COALESCE(metadata_value->>'exception_kind', '') NOT IN ('held', 'missed')
     OR metadata_value->>'assignment_origin' IS NULL
     OR metadata_value->>'assignment_origin' NOT IN (
       'source_prescriber',
       'prescriber_coverage_queue'
     )
     OR metadata_value ?| ARRAY[
       'acknowledged_at',
       'acknowledged_by',
       'acknowledged_via',
       'acknowledgement_receipt_repaired',
       'previous_acknowledged_at',
       'acknowledgement_receipt_repaired_from'
     ]
  THEN
    RAISE EXCEPTION 'MAR medication exception task metadata contract is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.workflow_sla_instance_id IS NULL
     OR NEW.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR NEW.related_resource_type IS DISTINCT FROM 'mar_medication_exception_cases'
     OR NEW.related_resource_id IS DISTINCT FROM metadata_value->>'exception_case_id'
  THEN
    RAISE EXCEPTION 'MAR medication exception task requires its exact domain-evidence SLA source'
      USING ERRCODE = 'check_violation';
  END IF;

  IF metadata_value ? 'requested_sla_key'
     OR metadata_value ? 'sla_policy_status'
  THEN
    RAISE EXCEPTION 'MAR medication exception task cannot use a degraded SLA policy marker'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances sla
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = NEW.workflow_sla_instance_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR sla_record.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
     OR sla_record.priority IS DISTINCT FROM 'critical'
     OR sla_record.source_table IS DISTINCT FROM NEW.related_resource_type
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
  THEN
    RAISE EXCEPTION 'MAR medication exception task and linked SLA do not describe the same obligation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.encounter_id IS NOT NULL
     OR NULLIF(LOWER(BTRIM(metadata_value->>'canonical_encounter_id')), '')
          IS DISTINCT FROM sla_record.encounter_id::text
  THEN
    RAISE EXCEPTION 'MAR medication exception canonical encounter must equal its linked SLA encounter'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'blocked' THEN
    RAISE EXCEPTION 'MAR medication exception tasks cannot enter an unroutable blocked state'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('open', 'in_progress', 'overdue')
     AND (
       NEW.completed_at IS NOT NULL
       OR sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION 'actionable MAR medication exception task requires an incomplete SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_sla_instance_id IS NOT NULL
     AND NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
  THEN
    RAISE EXCEPTION 'MAR medication exception task SLA links are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.metadata->>'assignment_origin'
          IS DISTINCT FROM metadata_value->>'assignment_origin'
  THEN
    RAISE EXCEPTION 'MAR medication exception assignment origin is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND NEW.status = 'cancelled'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION 'MAR medication exception task cannot be cancelled while its SLA is incomplete'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.due_at := sla_record.due_at;
  NEW.metadata := metadata_value || jsonb_build_object(
    'sla_instance_id', sla_record.id::text,
    'sla_key', sla_record.rule_code
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tasks_workflow_sla_compat_mar_exception_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'mar_medication_exception_v1')
  EXECUTE FUNCTION mar_medication_exception_tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_mar_exception_update
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
    metadata
  ON tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'mar_medication_exception_v1')
  EXECUTE FUNCTION mar_medication_exception_tasks_sync_workflow_sla_compat();

CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_source_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  valid_binding BOOLEAN := FALSE;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND OR task_record.workflow_sla_instance_id IS NULL THEN
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances AS sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;

  IF FOUND AND (
    task_record.metadata->>'sla_instance_id'
      IS DISTINCT FROM task_record.workflow_sla_instance_id::text
    OR NULLIF(BTRIM(task_record.metadata->>'sla_key'), '')
      IS DISTINCT FROM sla_record.rule_code
  ) THEN
    RAISE EXCEPTION
      'typed task SLA legacy aliases must equal the linked instance and rule'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND AND task_record.due_at IS NULL THEN
    RAISE EXCEPTION
      'linked task deadline must be present'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND (
       sla_record.due_at IS NULL
       OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     )
  THEN
    RAISE EXCEPTION
      'task and linked SLA deadlines must both be present and exactly equal'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status = 'in_progress'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION
      'acknowledged task must have a completed linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status IN ('open', 'blocked', 'overdue')
     AND (
       sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION
      'actionable acknowledgement task must have an incomplete linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND AND task_record.workflow_step_id IS NOT NULL THEN
    valid_binding := task_record.sla_completion_semantics
        IN ('acknowledgement', 'domain_evidence')
      AND sla_record.source_table IS NOT DISTINCT FROM 'workflow_steps'
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.workflow_step_id::text;
  ELSIF FOUND
        AND sla_record.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
  THEN
    valid_binding := task_record.sla_completion_semantics = 'acknowledgement'
      AND NULLIF(BTRIM(task_record.related_resource_type), '') IS NOT NULL
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM task_record.related_resource_type
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id;
  ELSIF FOUND AND sla_record.rule_code = 'mortuary_unclaimed_body' THEN
    valid_binding := task_record.sla_completion_semantics = 'domain_evidence'
      AND task_record.related_resource_type IS NOT DISTINCT FROM 'death_record'
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM 'death_records'
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id
      AND EXISTS (
        SELECT 1
          FROM death_records AS death_record
         WHERE death_record.tenant_id = task_record.tenant_id
           AND death_record.id::text = task_record.related_resource_id
      );
  ELSIF FOUND
        AND sla_record.rule_code IN (
          'ward_indent_pharmacy_response',
          'ward_indent_substitution_authorization',
          'ward_indent_controlled_handoff',
          'ward_indent_pharmacy_issue',
          'ward_indent_ward_receipt',
          'ward_indent_reconciliation',
          'ward_indent_mar_supply_reconciliation',
          'ward_indent_credit_note_review',
          'ward_indent_notification_coverage'
        )
  THEN
    valid_binding := task_record.sla_completion_semantics = 'domain_evidence'
      AND task_record.metadata->>'task_contract'
        IS NOT DISTINCT FROM 'ward_medication_obligation_v1'
      AND NULLIF(BTRIM(task_record.related_resource_type), '') IS NOT NULL
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM task_record.related_resource_type
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id;
  ELSIF FOUND AND sla_record.rule_code = 'mar_medication_exception_review' THEN
    valid_binding := task_record.sla_completion_semantics = 'domain_evidence'
      AND task_record.metadata->>'task_contract'
        IS NOT DISTINCT FROM 'mar_medication_exception_v1'
      AND task_record.related_resource_type
        IS NOT DISTINCT FROM 'mar_medication_exception_cases'
      AND task_record.related_resource_id
        IS NOT DISTINCT FROM task_record.metadata->>'exception_case_id'
      AND sla_record.source_table IS NOT DISTINCT FROM task_record.related_resource_type
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id;
  END IF;

  IF NOT valid_binding THEN
    RAISE EXCEPTION
      'task and linked SLA source do not describe the same obligation'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER FUNCTION care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_med03;

CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  evidence JSONB;
  completed_by_text TEXT;
  evidence_timestamp TIMESTAMPTZ;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
       IS DISTINCT FROM 'ward_medication_obligation_v1'
  THEN
    PERFORM care_pathway_assert_task_sla_completion_receipt_pre_med03(
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

  IF NOT FOUND
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
  THEN
    RAISE EXCEPTION
      'ward medication task has no exact typed SLA receipt contract'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.status IN ('open', 'in_progress', 'blocked', 'overdue') THEN
    IF sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
       OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
            'completed_via',
            'completed_by_task',
            'completed_by',
            'completion_evidence'
          ]
    THEN
      RAISE EXCEPTION
        'actionable ward medication task must have a clean incomplete SLA clock'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  evidence := sla_record.metadata->'completion_evidence';
  completed_by_text := NULLIF(BTRIM(sla_record.metadata->>'completed_by'), '');
  IF task_record.status IS DISTINCT FROM 'completed'
     OR sla_record.completed_at IS NULL
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
     OR sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR completed_by_text IS NULL
     OR completed_by_text !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR pg_input_is_valid(completed_by_text, 'uuid') IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1
         FROM users actor
        WHERE actor.tenant_id = task_record.tenant_id
          AND actor.uid::text = LOWER(completed_by_text)
     )
     OR evidence->>'resource_id' !~ '^[1-9][0-9]*$'
     OR pg_input_is_valid(evidence->>'resource_id', 'bigint') IS NOT TRUE
     OR evidence->>'occurred_at' !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR pg_input_is_valid(evidence->>'occurred_at', 'timestamp with time zone')
          IS NOT TRUE
     OR evidence->>'recorded_at' !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR pg_input_is_valid(evidence->>'recorded_at', 'timestamp with time zone')
          IS NOT TRUE
  THEN
    RAISE EXCEPTION
      'terminal ward medication task requires an authenticated domain receipt'
      USING ERRCODE = 'check_violation';
  END IF;

  evidence_timestamp := (evidence->>'recorded_at')::timestamptz;
  IF date_trunc('milliseconds', sla_record.completed_at)
       IS DISTINCT FROM date_trunc('milliseconds', evidence_timestamp)
  THEN
    RAISE EXCEPTION
      'ward medication SLA completion time must equal its recorded evidence time'
      USING ERRCODE = 'check_violation';
  END IF;

  IF evidence->>'kind' = 'ward_indent_transition' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'ward_indent_event'
       OR task_record.metadata->>'ward_indent_id' !~ '^[1-9][0-9]*$'
       OR task_record.metadata->>'state_version' !~ '^[1-9][0-9]*$'
       OR NULLIF(BTRIM(task_record.metadata->>'current_state'), '') IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM ward_indent_events event
          WHERE event.tenant_id = task_record.tenant_id
            AND event.id = (evidence->>'resource_id')::bigint
            AND event.ward_indent_id::text = task_record.metadata->>'ward_indent_id'
            AND event.state_version > (task_record.metadata->>'state_version')::integer
            AND event.from_status = task_record.metadata->>'current_state'
            AND event.action = evidence->>'action'
            AND event.to_status = evidence->>'to_status'
            AND event.actor_uid::text = LOWER(completed_by_text)
            AND date_trunc('milliseconds', event.occurred_at) =
                  date_trunc('milliseconds', (evidence->>'occurred_at')::timestamptz)
            AND date_trunc('milliseconds', event.occurred_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'ward indent task receipt does not match its transition event'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'billing_credit_note_decision' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'billing_credit_note_event'
       OR task_record.metadata->>'obligation_kind' IS DISTINCT FROM 'credit_note_review'
       OR task_record.metadata->>'credit_note_id' !~ '^[1-9][0-9]*$'
       OR evidence->>'decision' NOT IN ('approved', 'rejected')
       OR NOT EXISTS (
         SELECT 1
           FROM billing_credit_note_events event
          WHERE event.tenant_id = task_record.tenant_id
            AND event.id = (evidence->>'resource_id')::bigint
            AND event.credit_note_id::text = task_record.metadata->>'credit_note_id'
            AND event.event_type = evidence->>'decision'
            AND event.actor_uid::text = LOWER(completed_by_text)
            AND date_trunc('milliseconds', event.occurred_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'credit-note task receipt does not match its decision event'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'billing_credit_note_application' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'billing_credit_note_event'
       OR task_record.metadata->>'obligation_kind' IS DISTINCT FROM 'credit_note_review'
       OR task_record.metadata->>'credit_note_id' !~ '^[1-9][0-9]*$'
       OR evidence->>'event_type' IS DISTINCT FROM 'applied'
       OR NOT EXISTS (
         SELECT 1
           FROM billing_credit_note_events event
          WHERE event.tenant_id = task_record.tenant_id
            AND event.id = (evidence->>'resource_id')::bigint
            AND event.credit_note_id::text = task_record.metadata->>'credit_note_id'
            AND event.event_type = 'applied'
            AND event.actor_uid::text = LOWER(completed_by_text)
            AND date_trunc('milliseconds', event.occurred_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'credit-note task receipt does not match its application event'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'billing_credit_note_refund_paid' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'billing_refund'
       OR task_record.metadata->>'obligation_kind' IS DISTINCT FROM 'credit_note_review'
       OR task_record.metadata->>'credit_note_id' !~ '^[1-9][0-9]*$'
       OR task_record.metadata->>'refund_id' !~ '^[1-9][0-9]*$'
       OR evidence->>'resource_id' IS DISTINCT FROM task_record.metadata->>'refund_id'
       OR evidence->>'completion_actor' IS DISTINCT FROM LOWER(completed_by_text)
       OR NOT EXISTS (
         SELECT 1
           FROM billing_refunds refund
           JOIN billing_credit_notes note
             ON note.tenant_id = refund.tenant_id
            AND note.refund_id = refund.id
            AND note.id::text = task_record.metadata->>'credit_note_id'
           LEFT JOIN payment_gateway_refunds execution
             ON execution.tenant_id = refund.tenant_id
            AND execution.id = refund.gateway_refund_id
            AND execution.billing_refund_id = refund.id
          WHERE refund.tenant_id = task_record.tenant_id
            AND refund.id = (evidence->>'resource_id')::integer
            AND refund.approval_status = 'PAID'
            AND refund.payout_rail = evidence->>'payout_rail'
            AND COALESCE(refund.paid_by, execution.initiated_by)::text =
                  LOWER(completed_by_text)
            AND date_trunc('milliseconds', refund.paid_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'credit-note refund task receipt does not match its payout evidence'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'mar_supply_reconciled' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'mar_supply_reconciliation_link'
       OR task_record.metadata->>'obligation_kind'
            IS DISTINCT FROM 'mar_supply_reconciliation'
       OR task_record.metadata->>'medication_administration_id' !~ '^[1-9][0-9]*$'
       OR NOT EXISTS (
         SELECT 1
           FROM mar_supply_reconciliation_links link
           JOIN mar_supply_consumptions consumption
             ON consumption.tenant_id = link.tenant_id
            AND consumption.id = link.unmatched_consumption_id
          WHERE link.tenant_id = task_record.tenant_id
            AND link.id = (evidence->>'resource_id')::bigint
            AND link.reconciled_by::text = LOWER(completed_by_text)
            AND consumption.evidence_status = 'unmatched_override'
            AND consumption.reconciliation_task_id = task_record.id
            AND consumption.medication_administration_id::text =
                  task_record.metadata->>'medication_administration_id'
            AND (
              SELECT COALESCE(SUM(all_links.quantity), 0)
                FROM mar_supply_reconciliation_links all_links
               WHERE all_links.tenant_id = consumption.tenant_id
                 AND all_links.unmatched_consumption_id = consumption.id
            ) = consumption.quantity
            AND date_trunc('milliseconds', link.created_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'MAR supply task receipt does not match complete reconciliation evidence'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF evidence->>'kind' = 'notification_coverage_restored' THEN
    IF evidence->>'resource_type' IS DISTINCT FROM 'notification_outbox'
       OR task_record.metadata->>'obligation_kind'
            IS DISTINCT FROM 'notification_coverage'
       OR NOT EXISTS (
         SELECT 1
           FROM notification_outbox outbox
          WHERE outbox.tenant_id = task_record.tenant_id
            AND outbox.id = (evidence->>'resource_id')::bigint
            AND outbox.recipient_id IS NOT NULL
            AND outbox.payload->>'coverage_task_id' = task_record.id::text
            AND date_trunc('milliseconds', outbox.created_at) =
                  date_trunc('milliseconds', evidence_timestamp)
       )
    THEN
      RAISE EXCEPTION
        'notification coverage task receipt does not match its durable intent'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION
    'ward medication task source is not a registered completion contract'
    USING ERRCODE = 'check_violation';
END;
$$;

ALTER FUNCTION care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_mar_exception;

CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  evidence JSONB;
  completed_by_text TEXT;
  evidence_timestamp TIMESTAMPTZ;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'mar_medication_exception_v1'
  THEN
    PERFORM care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(
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

  IF NOT FOUND
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     OR sla_record.rule_code IS DISTINCT FROM 'mar_medication_exception_review'
  THEN
    RAISE EXCEPTION 'MAR medication exception task has no exact typed SLA receipt contract'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.status IN ('open', 'in_progress', 'overdue') THEN
    IF task_record.completed_at IS NOT NULL
       OR sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
       OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
            'completed_via',
            'completed_by_task',
            'completed_by',
            'completion_evidence'
          ]
    THEN
      RAISE EXCEPTION 'actionable MAR medication exception task must have a clean incomplete SLA clock'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  evidence := sla_record.metadata->'completion_evidence';
  completed_by_text := NULLIF(BTRIM(sla_record.metadata->>'completed_by'), '');
  IF task_record.status IS DISTINCT FROM 'completed'
     OR task_record.completed_at IS NULL
     OR sla_record.completed_at IS NULL
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
     OR sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR evidence->>'kind' IS DISTINCT FROM 'mar_medication_exception_resolution'
     OR evidence->>'resource_type' IS DISTINCT FROM 'mar_medication_exception_event'
     OR COALESCE(evidence->>'resource_id', '') !~ '^[1-9][0-9]*$'
     OR completed_by_text IS NULL
     OR completed_by_text !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR pg_input_is_valid(completed_by_text, 'uuid') IS NOT TRUE
     OR COALESCE(evidence->>'occurred_at', '') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR pg_input_is_valid(evidence->>'occurred_at', 'timestamp with time zone')
          IS NOT TRUE
     OR COALESCE(evidence->>'recorded_at', '') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR pg_input_is_valid(evidence->>'recorded_at', 'timestamp with time zone')
          IS NOT TRUE
  THEN
    RAISE EXCEPTION 'terminal MAR medication exception task requires an authenticated domain receipt'
      USING ERRCODE = 'check_violation';
  END IF;

  evidence_timestamp := (evidence->>'recorded_at')::timestamptz;
  IF date_trunc('milliseconds', task_record.completed_at)
       IS DISTINCT FROM date_trunc('milliseconds', sla_record.completed_at)
     OR date_trunc('milliseconds', sla_record.completed_at)
       IS DISTINCT FROM date_trunc('milliseconds', evidence_timestamp)
     OR NOT EXISTS (
       SELECT 1
         FROM mar_medication_exception_events event
         JOIN mar_medication_exception_cases exception_case
           ON exception_case.tenant_id = event.tenant_id
          AND exception_case.id = event.exception_case_id
         JOIN medication_administrations administration
           ON administration.tenant_id = exception_case.tenant_id
          AND administration.id = exception_case.medication_administration_id
        WHERE event.tenant_id = task_record.tenant_id
          AND event.id = (evidence->>'resource_id')::bigint
          AND event.event_type = 'resolved'
          AND event.actor_uid::text = LOWER(completed_by_text)
          AND event.exception_case_id::text = task_record.metadata->>'exception_case_id'
          AND event.medication_administration_id::text =
                task_record.metadata->>'medication_administration_id'
          AND exception_case.task_id = task_record.id
          AND exception_case.workflow_sla_instance_id = sla_record.id
          AND exception_case.exception_kind = task_record.metadata->>'exception_kind'
          AND event.disposition = evidence->>'disposition'
           AND (
             (exception_case.exception_kind = 'held' AND event.disposition = 'hold_released')
            OR (
              exception_case.exception_kind = 'missed'
              AND event.disposition IN (
                'reviewed_no_replacement',
                'replacement_ordered',
                'order_stopped'
             )
           )
            OR (
              exception_case.exception_kind = 'held'
              AND event.disposition = 'order_stopped'
            )
          )
          AND (
            event.disposition <> 'hold_released'
            OR LOWER(administration.status) = 'scheduled'
          )
          AND (
            event.disposition <> 'replacement_ordered'
            OR EXISTS (
              SELECT 1
                FROM clinical_orders replacement_order
               WHERE replacement_order.tenant_id = event.tenant_id
                 AND replacement_order.id = event.replacement_clinical_order_id
                 AND replacement_order.id IS DISTINCT FROM exception_case.clinical_order_id
                 AND replacement_order.patient_uid = exception_case.patient_uid
                 AND replacement_order.order_type = 'medication'
                 AND LOWER(replacement_order.status) IN ('ordered', 'verified', 'in_progress')
                 AND replacement_order.created_at >= exception_case.raised_at
            )
          )
          AND (
            event.disposition <> 'order_stopped'
            OR EXISTS (
              SELECT 1
                FROM clinical_orders stopped_order
               WHERE stopped_order.tenant_id = exception_case.tenant_id
                 AND stopped_order.id = exception_case.clinical_order_id
                 AND LOWER(stopped_order.status) NOT IN ('ordered', 'verified', 'in_progress')
            )
          )
          AND date_trunc('milliseconds', event.occurred_at) =
                date_trunc('milliseconds', (evidence->>'occurred_at')::timestamptz)
          AND date_trunc('milliseconds', event.occurred_at) =
                date_trunc('milliseconds', evidence_timestamp)
     )
  THEN
    RAISE EXCEPTION 'MAR medication exception receipt does not match its exact resolution event'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Runtime role privileges
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_med03(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ)
  FROM PUBLIC;

DO $med03_runtime_privileges$
DECLARE
  runtime_role TEXT;
  relation_name TEXT;
  sequence_name TEXT;
  trigger_function_name TEXT;
  mutable_relations CONSTANT TEXT[] := ARRAY[
    'ward_indent_inventory_allocations',
    'billing_credit_notes',
    'mar_medication_exception_cases'
  ];
  append_only_relations CONSTANT TEXT[] := ARRAY[
    'pharmacy_stock_movements',
    'pharmacy_schedule_register',
    'ward_indent_events',
    'ward_indent_inventory_movement_links',
    'ward_indent_inventory_receipt_events',
    'mar_supply_consumptions',
    'mar_administration_command_receipts',
    'mar_transition_command_receipts',
    'mar_supply_reconciliation_links',
    'mar_supply_reconciliation_command_receipts',
    'ward_indent_financial_events',
    'billing_credit_note_events',
    'mar_medication_exception_events'
  ];
  trigger_functions CONSTANT TEXT[] := ARRAY[
    'medication_evidence_append_only_guard',
    'medication_administration_require_order_context',
    'controlled_ward_dispense_require_patient',
    'ward_indent_controlled_patient_guard',
    'ward_indent_inventory_allocation_guard',
    'ward_indent_apply_inventory_movement_link',
    'ward_indent_apply_inventory_receipt_event',
    'ward_indent_inventory_workflow_event_validate',
    'ward_indent_inventory_allocation_evidence_validate',
    'mar_supply_apply_custody_consumption',
    'mar_administration_command_receipt_validate',
    'mar_transition_command_receipt_validate',
    'mar_supply_apply_reconciliation_link',
    'ward_indent_validate_financial_event_lineage',
    'billing_credit_note_event_state_validate',
    'billing_credit_note_require_context',
    'billing_credit_note_require_lifecycle_event',
    'ward_medication_tasks_sync_workflow_sla_compat',
    'mar_medication_exception_event_actor_guard',
    'mar_medication_exception_case_guard',
    'mar_medication_exception_case_receipt_guard',
    'mar_medication_exception_escalation_snapshot_guard',
    'mar_medication_exception_claim_comment_guard',
    'mar_medication_exception_assignee_viability_guard',
    'mar_medication_exception_tasks_sync_workflow_sla_compat'
  ];
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    FOREACH relation_name IN ARRAY mutable_relations
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
        relation_name,
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO %I',
        relation_name,
        runtime_role
      );
    END LOOP;

    FOREACH relation_name IN ARRAY append_only_relations
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
        relation_name,
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO %I',
        relation_name,
        runtime_role
      );
    END LOOP;

    FOREACH relation_name IN ARRAY (mutable_relations || append_only_relations)
    LOOP
      sequence_name := relation_name || '_id_seq';
      IF pg_catalog.to_regclass(pg_catalog.format('public.%I', sequence_name)) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',
          sequence_name,
          runtime_role
        );
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I',
          sequence_name,
          runtime_role
        );
      END IF;
    END LOOP;

    FOREACH trigger_function_name IN ARRAY trigger_functions
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',
        trigger_function_name,
        runtime_role
      );
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) TO %I',
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
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) TO %I',
      runtime_role
    );
  END LOOP;

  FOREACH trigger_function_name IN ARRAY trigger_functions
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM PUBLIC',
      trigger_function_name
    );
  END LOOP;
END
$med03_runtime_privileges$;

-- ---------------------------------------------------------------------------
-- SLA defaults for newly owned medication-closure work
-- ---------------------------------------------------------------------------

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, metadata)
VALUES
  (NULL, 'mar_medication_exception_review',
   'Held or missed medication prescriber review', 'mar.medication_exception', 15, 'critical',
   ARRAY['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']::TEXT[],
   ARRAY['MEDICAL_SUPERINTENDENT', 'ADMIN', 'SUPER_ADMIN']::TEXT[],
   '{"med_03":true,"surface":"mar_exception_queue"}'::jsonb),
  (NULL, 'ward_indent_mar_supply_reconciliation',
   'MAR supply evidence reconciliation', 'mar.supply_override', 30, 'critical',
   ARRAY['NURSING_INCHARGE', 'IP_INCHARGE', 'PHARMACY_INCHARGE']::TEXT[],
   ARRAY['MEDICAL_SUPERINTENDENT', 'ADMIN']::TEXT[],
   '{"med_03":true,"surface":"mar_supply"}'::jsonb),
  (NULL, 'ward_indent_credit_note_review',
   'Ward medication credit-note review', 'ward_indent.credit_created', 1440, 'high',
   ARRAY['BILLING_INCHARGE', 'FINANCE_INCHARGE']::TEXT[],
   ARRAY['FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN']::TEXT[],
   '{"med_03":true,"surface":"billing_credit_note"}'::jsonb),
  (NULL, 'ward_indent_notification_coverage',
   'Ward medication notification recipient coverage',
   'ward_indent.notification_coverage_gap', 15, 'critical',
   ARRAY['ADMIN', 'SUPER_ADMIN']::TEXT[],
   ARRAY['SUPER_ADMIN', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"med_03":true,"surface":"notification_coverage"}'::jsonb)
ON CONFLICT (
  (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)),
  rule_code
)
DO UPDATE SET
  title = EXCLUDED.title,
  trigger_event_type = EXCLUDED.trigger_event_type,
  target_minutes = EXCLUDED.target_minutes,
  severity = EXCLUDED.severity,
  owner_role_codes = EXCLUDED.owner_role_codes,
  escalation_role_codes = EXCLUDED.escalation_role_codes,
  metadata = EXCLUDED.metadata,
  enabled = TRUE,
  updated_at = NOW();

COMMIT;
