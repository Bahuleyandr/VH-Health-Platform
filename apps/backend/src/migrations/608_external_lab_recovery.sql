-- C6.1-C: provenance-bound I01/I02 recovery on the existing migration-582/583
-- laboratory receipts. Late recovery may create clinical result evidence and
-- one actionable review task, but never a retrospective critical-alert/SLA,
-- pathway-transition, or notification effect.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TABLE public.lab_oru_ingest_messages
  ADD COLUMN IF NOT EXISTS recovery_inbox_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_interface_family VARCHAR(8),
  ADD COLUMN IF NOT EXISTS recovery_pending_task_id INTEGER;

ALTER TABLE public.lab_oru_ingest_messages
  DROP CONSTRAINT IF EXISTS chk_lab_oru_ingest_messages_recovery_pair,
  DROP CONSTRAINT IF EXISTS chk_lab_oru_ingest_messages_recovery_shape,
  DROP CONSTRAINT IF EXISTS fk_lab_oru_ingest_messages_recovery_inbox,
  DROP CONSTRAINT IF EXISTS fk_lab_oru_ingest_messages_recovery_task,
  ADD CONSTRAINT chk_lab_oru_ingest_messages_recovery_pair
    CHECK ((recovery_inbox_id IS NULL) = (recovery_interface_family IS NULL)),
  ADD CONSTRAINT chk_lab_oru_ingest_messages_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_pending_task_id IS NULL
      )
      OR (
        recovery_interface_family = 'I01'
        AND legacy_adoption = FALSE
        AND cardinality(active_critical_result_ids) = 0
        AND cardinality(closed_critical_result_ids) = 0
        AND cardinality(alert_ids) = 0
        AND cardinality(task_ids) = 0
        AND cardinality(sla_instance_ids) = 0
        AND cardinality(closed_alert_ids) = 0
        AND cardinality(closed_task_ids) = 0
        AND cardinality(closed_sla_instance_ids) = 0
        AND (
          (status = 'processing' AND recovery_pending_task_id IS NULL)
          OR (status = 'completed' AND recovery_pending_task_id IS NOT NULL)
        )
      )
    ),
  ADD CONSTRAINT fk_lab_oru_ingest_messages_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox(tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_lab_oru_ingest_messages_recovery_task
    FOREIGN KEY (tenant_id, recovery_pending_task_id)
    REFERENCES public.tasks(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE public.lab_oru_ingest_messages
  DROP CONSTRAINT IF EXISTS ck_lab_oru_ingest_messages_artifact_cardinality,
  ADD CONSTRAINT ck_lab_oru_ingest_messages_artifact_cardinality
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND cardinality(active_critical_result_ids) = cardinality(alert_ids)
        AND cardinality(alert_ids) = cardinality(task_ids)
        AND cardinality(alert_ids) = cardinality(sla_instance_ids)
        AND cardinality(closed_critical_result_ids) = cardinality(closed_alert_ids)
        AND cardinality(closed_alert_ids) = cardinality(closed_task_ids)
        AND cardinality(closed_alert_ids) = cardinality(closed_sla_instance_ids)
        AND cardinality(critical_result_ids) =
              cardinality(active_critical_result_ids)
              + cardinality(closed_critical_result_ids)
        AND (legacy_adoption OR cardinality(closed_critical_result_ids) = 0)
      )
      OR (
        recovery_interface_family = 'I01'
        AND cardinality(active_critical_result_ids) = 0
        AND cardinality(closed_critical_result_ids) = 0
        AND cardinality(alert_ids) = 0
        AND cardinality(task_ids) = 0
        AND cardinality(sla_instance_ids) = 0
        AND cardinality(closed_alert_ids) = 0
        AND cardinality(closed_task_ids) = 0
        AND cardinality(closed_sla_instance_ids) = 0
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_oru_ingest_messages_recovery_inbox
  ON public.lab_oru_ingest_messages (tenant_id, recovery_inbox_id)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lab_oru_ingest_messages_recovery_contract
  ON public.lab_oru_ingest_messages
    (tenant_id, recovery_inbox_id, recovery_interface_family);

CREATE UNIQUE INDEX IF NOT EXISTS ux_lab_oru_ingest_messages_recovery_task
  ON public.lab_oru_ingest_messages (tenant_id, recovery_pending_task_id)
  WHERE recovery_pending_task_id IS NOT NULL;

ALTER TABLE public.lab_interface_messages
  ADD COLUMN IF NOT EXISTS recovery_critical_result_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  ADD COLUMN IF NOT EXISTS recovery_pending_task_id INTEGER;

ALTER TABLE public.lab_interface_messages
  DROP CONSTRAINT IF EXISTS chk_lab_interface_messages_i09_recovery_shape,
  DROP CONSTRAINT IF EXISTS chk_lab_interface_messages_recovery_shape,
  DROP CONSTRAINT IF EXISTS fk_lab_interface_messages_recovery_task,
  ADD CONSTRAINT chk_lab_interface_messages_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND cardinality(recovery_critical_result_ids) = 0
        AND recovery_pending_task_id IS NULL
      )
      OR (
        recovery_interface_family = 'I09'
        AND direction = 'inbound'
        AND protocol = 'hl7v2'
        AND message_type = 'ORU^VITALS'
        AND cardinality(recovery_critical_result_ids) = 0
        AND recovery_pending_task_id IS NULL
      )
      OR (
        recovery_interface_family = 'I02'
        AND direction = 'inbound'
        AND protocol = 'astm_e1394'
        AND (
          (
            status = 'received'
            AND cardinality(recovery_critical_result_ids) = 0
            AND recovery_pending_task_id IS NULL
          )
          OR (
            status = 'ingested'
            AND recovery_pending_task_id IS NOT NULL
          )
        )
      )
    ),
  ADD CONSTRAINT fk_lab_interface_messages_recovery_task
    FOREIGN KEY (tenant_id, recovery_pending_task_id)
    REFERENCES public.tasks(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lab_interface_messages_recovery_task
  ON public.lab_interface_messages (tenant_id, recovery_pending_task_id)
  WHERE recovery_pending_task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assert_lab_external_recovery_task(
  target_tenant_id UUID,
  target_task_id INTEGER,
  target_resource_type TEXT,
  target_resource_id TEXT,
  target_patient_uid UUID,
  target_recovery_inbox_id UUID,
  target_interface_family TEXT,
  target_critical_result_ids INTEGER[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  matched_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer
    INTO matched_count
    FROM public.tasks AS task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id
     AND task.task_kind = 'review'
     AND task.patient_uid = target_patient_uid
     AND task.related_resource_type = target_resource_type
     AND task.related_resource_id = target_resource_id
     AND task.priority = CASE
           WHEN cardinality(target_critical_result_ids) > 0 THEN 'critical'
           ELSE 'high'
         END
     AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND task.workflow_sla_instance_id IS NULL
     AND task.sla_completion_semantics = 'none'
     AND task.due_at IS NULL
     AND task.metadata->>'contract' = 'late_pending_only'
     AND task.metadata->>'interface_family' = target_interface_family
     AND task.metadata->>'recovery_inbox_id' = target_recovery_inbox_id::text
     AND task.metadata->>'owner_reconciliation_required' = 'true'
     AND task.metadata->'critical_result_ids' = to_jsonb(target_critical_result_ids);

  IF matched_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Late laboratory recovery lacks one exact actionable no-SLA review task';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.lab_oru_validate_recovery_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  recovery_row public.pathway_projector_inbox%ROWTYPE;
  linked_result_ids INTEGER[];
  linked_critical_result_ids INTEGER[];
  declared_result_ids INTEGER[];
  declared_critical_result_ids INTEGER[];
  result_patient_uid UUID;
  result_patient_count INTEGER;
  forbidden_effect_count INTEGER;
BEGIN
  IF NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT inbox.*
    INTO recovery_row
    FROM public.pathway_projector_inbox AS inbox
   WHERE inbox.tenant_id = NEW.tenant_id
     AND inbox.inbox_id = NEW.recovery_inbox_id
     AND inbox.interface_family = 'I01'
     AND inbox.scope_kind = 'external_interface'
     AND inbox.arrival_class = 'recovery_backlog'
     AND inbox.effect_disposition = 'late_pending_only'
     AND inbox.status = 'handled';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed I01 recovery claim lacks its handled canonical recovery inbox row';
  END IF;

  SELECT COALESCE(array_agg(result.id ORDER BY result.id), '{}'::integer[]),
         COALESCE(array_agg(result.id ORDER BY result.id)
           FILTER (WHERE result.is_critical), '{}'::integer[]),
         (array_agg(result.patient_uid ORDER BY result.id))[1],
         COUNT(DISTINCT result.patient_uid)::integer
    INTO linked_result_ids, linked_critical_result_ids,
         result_patient_uid, result_patient_count
    FROM public.lab_results AS result
   WHERE result.tenant_id = NEW.tenant_id
     AND result.oru_ingest_message_id = NEW.id;

  SELECT COALESCE(array_agg(result_id ORDER BY result_id), '{}'::integer[])
    INTO declared_result_ids
    FROM unnest(NEW.result_ids) AS result_id;
  SELECT COALESCE(array_agg(result_id ORDER BY result_id), '{}'::integer[])
    INTO declared_critical_result_ids
    FROM unnest(NEW.critical_result_ids) AS result_id;

  IF linked_result_ids IS DISTINCT FROM declared_result_ids
     OR linked_critical_result_ids IS DISTINCT FROM declared_critical_result_ids
     OR result_patient_count <> 1
     OR EXISTS (
       SELECT 1
         FROM public.lab_results AS result
        WHERE result.tenant_id = NEW.tenant_id
          AND result.oru_ingest_message_id = NEW.id
          AND result.performed_at IS DISTINCT FROM recovery_row.occurred_at
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed I01 recovery claim result/critical/source-time evidence is not exact';
  END IF;

  PERFORM public.assert_lab_external_recovery_task(
    NEW.tenant_id,
    NEW.recovery_pending_task_id,
    'lab_oru_ingest_message',
    NEW.id::text,
    result_patient_uid,
    NEW.recovery_inbox_id,
    'I01',
    declared_critical_result_ids
  );

  SELECT (
      SELECT COUNT(*)
        FROM public.lab_critical_alerts AS alert
       WHERE alert.tenant_id = NEW.tenant_id
         AND alert.result_id = ANY(NEW.result_ids)
    ) + (
      SELECT COUNT(*)
        FROM public.workflow_sla_instances AS sla
       WHERE sla.tenant_id = NEW.tenant_id
         AND sla.source_table = 'lab_result'
         AND sla.source_id IN (
           SELECT result_id::text FROM unnest(NEW.result_ids) AS result_id
         )
    )
    INTO forbidden_effect_count;
  IF forbidden_effect_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Late I01 recovery created a forbidden critical-alert or SLA effect';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_oru_assert_completed_message
  ON public.lab_oru_ingest_messages;
CREATE CONSTRAINT TRIGGER trg_lab_oru_assert_completed_message
AFTER INSERT OR UPDATE ON public.lab_oru_ingest_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.recovery_inbox_id IS NULL)
EXECUTE FUNCTION public.lab_oru_assert_completed_message();

DROP TRIGGER IF EXISTS trg_lab_oru_validate_recovery_complete
  ON public.lab_oru_ingest_messages;
CREATE CONSTRAINT TRIGGER trg_lab_oru_validate_recovery_complete
AFTER INSERT OR UPDATE ON public.lab_oru_ingest_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.recovery_inbox_id IS NOT NULL)
EXECUTE FUNCTION public.lab_oru_validate_recovery_complete();

CREATE OR REPLACE FUNCTION public.lab_interface_validate_astm_recovery_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  recovery_row public.pathway_projector_inbox%ROWTYPE;
  linked_result_ids INTEGER[];
  linked_critical_result_ids INTEGER[];
  result_patient_uid UUID;
  result_patient_count INTEGER;
  linked_result_count INTEGER;
  first_position INTEGER;
  last_position INTEGER;
  distinct_position_count INTEGER;
  forbidden_effect_count INTEGER;
BEGIN
  IF NEW.status <> 'ingested' THEN
    RETURN NEW;
  END IF;

  SELECT inbox.*
    INTO recovery_row
    FROM public.pathway_projector_inbox AS inbox
   WHERE inbox.tenant_id = NEW.tenant_id
     AND inbox.inbox_id = NEW.recovery_inbox_id
     AND inbox.interface_family = 'I02'
     AND inbox.scope_kind = 'external_interface'
     AND inbox.arrival_class = 'recovery_backlog'
     AND inbox.effect_disposition = 'late_pending_only'
     AND inbox.status = 'handled';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed I02 recovery receipt lacks its handled canonical recovery inbox row';
  END IF;

  IF NEW.ingest_contract_version IS DISTINCT FROM 1
     OR NEW.analyzer_id IS NULL
     OR NEW.authenticated_actor_uid IS NULL
     OR cardinality(NEW.authenticated_actor_roles) <> 1
     OR NEW.analyzer_binding_mode NOT IN ('api_client', 'manual_import_actor')
     OR NEW.specimen_id IS NULL
     OR NEW.result_count IS NULL
     OR NEW.result_count <= 0
     OR jsonb_typeof(NEW.verdicts) IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.verdicts) <> NEW.result_count
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed I02 recovery receipt lacks its exact migration-583 source contract';
  END IF;

  SELECT COALESCE(array_agg(result.id ORDER BY result.id), '{}'::integer[]),
         COALESCE(array_agg(result.id ORDER BY result.id)
           FILTER (WHERE result.is_critical), '{}'::integer[]),
         (array_agg(result.patient_uid ORDER BY result.id))[1],
         COUNT(DISTINCT result.patient_uid)::integer,
         COUNT(*)::integer,
         MIN(result.interface_result_index),
         MAX(result.interface_result_index),
         COUNT(DISTINCT result.interface_result_index)::integer
    INTO linked_result_ids, linked_critical_result_ids,
         result_patient_uid, result_patient_count, linked_result_count,
         first_position, last_position, distinct_position_count
    FROM public.lab_results AS result
   WHERE result.tenant_id = NEW.tenant_id
     AND result.interface_message_id = NEW.id;

  IF linked_critical_result_ids IS DISTINCT FROM (
       SELECT COALESCE(array_agg(result_id ORDER BY result_id), '{}'::integer[])
         FROM unnest(NEW.recovery_critical_result_ids) AS result_id
     )
     OR linked_result_count <> NEW.result_count
     OR result_patient_count <> 1
     OR first_position <> 1
     OR last_position <> NEW.result_count
     OR distinct_position_count <> NEW.result_count
     OR EXISTS (
       SELECT 1
         FROM public.lab_results AS result
        WHERE result.tenant_id = NEW.tenant_id
          AND result.interface_message_id = NEW.id
          AND (
            result.specimen_id IS DISTINCT FROM NEW.specimen_id
            OR result.analyzer_id IS DISTINCT FROM NEW.analyzer_id
            OR result.performed_at IS DISTINCT FROM recovery_row.occurred_at
            OR (NEW.verdicts -> (result.interface_result_index - 1)
                  ->> 'interface_result_index')::integer
                 IS DISTINCT FROM result.interface_result_index
            OR (NEW.verdicts -> (result.interface_result_index - 1)
                  -> 'threshold_assessment' ->> 'breached')::boolean
                 IS DISTINCT FROM result.is_critical
          )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed I02 recovery receipt result/critical/source-time evidence is not exact';
  END IF;

  PERFORM public.assert_lab_external_recovery_task(
    NEW.tenant_id,
    NEW.recovery_pending_task_id,
    'lab_interface_message',
    NEW.id::text,
    result_patient_uid,
    NEW.recovery_inbox_id,
    'I02',
    NEW.recovery_critical_result_ids
  );

  SELECT (
      SELECT COUNT(*)
        FROM public.lab_critical_alerts AS alert
       WHERE alert.tenant_id = NEW.tenant_id
         AND alert.result_id = ANY(linked_result_ids)
    ) + (
      SELECT COUNT(*)
        FROM public.workflow_sla_instances AS sla
       WHERE sla.tenant_id = NEW.tenant_id
         AND sla.source_table = 'lab_result'
         AND sla.source_id IN (
           SELECT result_id::text FROM unnest(linked_result_ids) AS result_id
         )
    )
    INTO forbidden_effect_count;
  IF forbidden_effect_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Late I02 recovery created a forbidden critical-alert or SLA effect';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_interface_validate_astm_ingested_complete
  ON public.lab_interface_messages;
CREATE CONSTRAINT TRIGGER trg_lab_interface_validate_astm_ingested_complete
AFTER INSERT OR UPDATE OF status, result_count, specimen_id, verdicts,
  processed_at, error, analyzer_id, ingest_contract_version
ON public.lab_interface_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  NEW.direction = 'inbound'
  AND NEW.protocol = 'astm_e1394'
  AND NEW.recovery_inbox_id IS NULL
)
EXECUTE FUNCTION public.lab_interface_validate_astm_ingested_complete();

DROP TRIGGER IF EXISTS trg_lab_interface_validate_astm_recovery_complete
  ON public.lab_interface_messages;
CREATE CONSTRAINT TRIGGER trg_lab_interface_validate_astm_recovery_complete
AFTER INSERT OR UPDATE ON public.lab_interface_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.recovery_interface_family = 'I02')
EXECUTE FUNCTION public.lab_interface_validate_astm_recovery_complete();

CREATE OR REPLACE FUNCTION public.assert_lab_recovery_provenance_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.recovery_inbox_id IS DISTINCT FROM NEW.recovery_inbox_id
     OR OLD.recovery_interface_family IS DISTINCT FROM NEW.recovery_interface_family
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Laboratory recovery provenance is immutable once claimed';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS lab_oru_recovery_provenance_immutable
  ON public.lab_oru_ingest_messages;
CREATE TRIGGER lab_oru_recovery_provenance_immutable
BEFORE UPDATE OF recovery_inbox_id, recovery_interface_family
ON public.lab_oru_ingest_messages
FOR EACH ROW EXECUTE FUNCTION public.assert_lab_recovery_provenance_immutable();

DROP TRIGGER IF EXISTS lab_interface_recovery_provenance_immutable
  ON public.lab_interface_messages;
CREATE TRIGGER lab_interface_recovery_provenance_immutable
BEFORE UPDATE OF recovery_inbox_id, recovery_interface_family
ON public.lab_interface_messages
FOR EACH ROW EXECUTE FUNCTION public.assert_lab_recovery_provenance_immutable();

CREATE OR REPLACE FUNCTION public.assert_lab_interface_recovery_evidence_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.recovery_interface_family = 'I02'
     AND OLD.status = 'ingested'
     AND (
       OLD.recovery_critical_result_ids IS DISTINCT FROM NEW.recovery_critical_result_ids
       OR OLD.recovery_pending_task_id IS DISTINCT FROM NEW.recovery_pending_task_id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed I02 recovery evidence is immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS lab_interface_recovery_evidence_immutable
  ON public.lab_interface_messages;
CREATE TRIGGER lab_interface_recovery_evidence_immutable
BEFORE UPDATE OF recovery_critical_result_ids, recovery_pending_task_id
ON public.lab_interface_messages
FOR EACH ROW
EXECUTE FUNCTION public.assert_lab_interface_recovery_evidence_immutable();

REVOKE ALL PRIVILEGES
  ON FUNCTION public.assert_lab_external_recovery_task(
    UUID, INTEGER, TEXT, TEXT, UUID, UUID, TEXT, INTEGER[]
  ) FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.lab_oru_validate_recovery_complete() FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.lab_interface_validate_astm_recovery_complete() FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.assert_lab_recovery_provenance_immutable() FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.assert_lab_interface_recovery_evidence_immutable() FROM PUBLIC;

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
      'GRANT EXECUTE ON FUNCTION public.assert_lab_external_recovery_task(
        UUID, INTEGER, TEXT, TEXT, UUID, UUID, TEXT, INTEGER[]) TO %I',
      runtime_role
    );

    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, trusted_sender_identity, message_control_id,
        raw_message, obx_count, authenticated_actor_uid,
        authenticated_actor_roles, sender_binding_mode,
        sender_binding_identity, recovery_inbox_id,
        recovery_interface_family) ON public.lab_oru_ingest_messages TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT UPDATE (status, result_ids, critical_result_ids,
        recovery_pending_task_id, completed_at, updated_at)
        ON public.lab_oru_ingest_messages TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, analyzer_id, analyzer_code, direction,
        protocol, message_type, raw_message, status, result_count, specimen_id,
        verdicts, processed_at, ingest_contract_version,
        authenticated_actor_uid, authenticated_actor_roles,
        analyzer_binding_mode, analyzer_binding_identity,
        analyzer_sender_identity, recovery_inbox_id,
        recovery_interface_family, recovery_critical_result_ids,
        recovery_pending_task_id) ON public.lab_interface_messages TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT UPDATE (status, result_count, specimen_id, verdicts, processed_at,
        recovery_critical_result_ids, recovery_pending_task_id)
        ON public.lab_interface_messages TO %I',
      runtime_role
    );
  END LOOP;
END;
$runtime_privileges$;

COMMIT;
