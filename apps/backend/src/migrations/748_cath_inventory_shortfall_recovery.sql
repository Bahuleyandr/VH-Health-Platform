-- Migration 748: Cath-lab consumable inventory shortfall recovery.
--
-- A clinically documented Cath consumable may outlive immediately available
-- inventory. This migration binds that visible shortfall to one pharmacist
-- task, one workflow SLA, one durable notification intent, and append-only
-- movement evidence. It does not reinterpret the clinical documentation or
-- authorize controlled-drug movement.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Existing shortfalls pre-date the task/SLA/notification contract and cannot
-- be attributed safely inside DDL. Stop with a counted readiness failure so an
-- operator can reconcile them before this contract becomes mandatory.
DO $cath_inventory_shortfall_preflight$
DECLARE
  stranded_shortfalls BIGINT;
  invalid_movement_totals BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO stranded_shortfalls
    FROM public.cath_case_consumable_usage usage
   WHERE usage.inventory_decrement_status = 'insufficient_stock';

  IF stranded_shortfalls > 0 THEN
    RAISE EXCEPTION
      'migration 748 blocked: % existing Cath consumable shortfall row(s) require operator reconciliation before task/SLA activation',
      stranded_shortfalls
      USING ERRCODE = '23514';
  END IF;

  WITH movement_totals AS (
    SELECT usage.tenant_id,
           usage.id,
           usage.quantity,
           usage.inventory_decrement_status,
           COALESCE(SUM(-movement.quantity_delta) FILTER (
             WHERE movement.id IS NOT NULL
           ), 0::numeric) AS decremented_quantity,
           COUNT(movement.id) FILTER (
             WHERE movement.quantity_delta >= 0
                OR movement.inventory_item_id IS DISTINCT FROM catalog.inventory_item_id
                OR movement.movement_kind IS DISTINCT FROM
                     CASE WHEN usage.wasted THEN 'dispose' ELSE 'issue' END
           ) AS invalid_count
      FROM public.cath_case_consumable_usage usage
      JOIN public.cath_consumable_catalog catalog
        ON catalog.tenant_id = usage.tenant_id
       AND catalog.id = usage.catalog_item_id
      LEFT JOIN public.pharmacy_stock_movements movement
        ON movement.tenant_id = usage.tenant_id
       AND (
         (
           movement.reference_type = 'cath_consumable_usage'
           AND movement.reference_id = usage.id::text
         )
         OR (
           movement.reference_type = 'cath_consumable_reconciliation'
           AND movement.metadata->>'cath_consumable_usage_id' = usage.id::text
         )
       )
     GROUP BY usage.tenant_id,
              usage.id,
              usage.quantity,
              usage.inventory_decrement_status,
              catalog.inventory_item_id
  )
  SELECT COUNT(*)
    INTO invalid_movement_totals
    FROM movement_totals totals
   WHERE totals.invalid_count > 0
      OR totals.decremented_quantity > totals.quantity
      OR (
        totals.inventory_decrement_status = 'decremented'
        AND totals.decremented_quantity IS DISTINCT FROM totals.quantity
      )
      OR (
        totals.decremented_quantity > 0
        AND totals.decremented_quantity < totals.quantity
        AND totals.inventory_decrement_status IS DISTINCT FROM 'insufficient_stock'
      );

  IF invalid_movement_totals > 0 THEN
    RAISE EXCEPTION
      'migration 748 blocked: % Cath consumable usage row(s) have movement totals inconsistent with documented quantity/status',
      invalid_movement_totals
      USING ERRCODE = '23514';
  END IF;
END
$cath_inventory_shortfall_preflight$;

CREATE UNIQUE INDEX ux_pharmacy_stock_movements_cath_reconcile_command_batch
  ON public.pharmacy_stock_movements (
    tenant_id,
    reference_type,
    reference_id,
    COALESCE(inventory_batch_id, 0)
  )
  WHERE reference_type = 'cath_consumable_reconciliation'
    AND reference_id IS NOT NULL;

CREATE UNIQUE INDEX ux_notification_outbox_cath_shortfall_usage
  ON public.notification_outbox (tenant_id, source_event_key)
  WHERE type = 'cath_inventory_shortfall';

UPDATE public.workflow_sla_rules
   SET target_minutes = 30,
       metadata = COALESCE(metadata, '{}'::jsonb)
         || '{"task_contract":"cath_inventory_shortfall_v1","surface":"cath_inventory_shortfall"}'::jsonb,
       updated_at = NOW()
 WHERE rule_code = 'cath_consumable_inventory_reconciliation'
   AND target_minutes IS DISTINCT FROM 30;

INSERT INTO public.workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, enabled, metadata)
VALUES
  (NULL, 'cath_consumable_inventory_reconciliation',
   'Cath consumable inventory reconciliation',
   'cath_lab.consumable_inventory_shortfall', 30, 'high',
   ARRAY['PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE']::TEXT[],
   ARRAY['PHARMACY_INCHARGE', 'ADMIN']::TEXT[], TRUE,
   '{"task_contract":"cath_inventory_shortfall_v1","surface":"cath_inventory_shortfall"}'::jsonb)
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
  enabled = TRUE,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

CREATE OR REPLACE FUNCTION public.cath_inventory_shortfall_task_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_inventory_shortfall_task_sync$
DECLARE
  sla_record public.workflow_sla_instances%ROWTYPE;
  usage_record public.cath_case_consumable_usage%ROWTYPE;
  case_record public.cath_lab_cases%ROWTYPE;
  catalog_record public.cath_consumable_catalog%ROWTYPE;
  rule_record public.workflow_sla_rules%ROWTYPE;
  metadata_value JSONB := COALESCE(NEW.metadata, '{}'::jsonb);
  expected_movement_kind TEXT;
  movement_total NUMERIC(18,4);
  invalid_movement_count BIGINT;
  ownership_recovery BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(metadata_value) IS DISTINCT FROM 'object'
     OR metadata_value->>'task_contract'
          IS DISTINCT FROM 'cath_inventory_shortfall_v1'
     OR metadata_value->>'cath_consumable_usage_id' !~ '^[1-9][0-9]*$'
     OR metadata_value->>'cath_case_id' !~ '^[1-9][0-9]*$'
     OR metadata_value->>'inventory_item_id' !~ '^[1-9][0-9]*$'
     OR metadata_value->>'movement_kind' NOT IN ('issue', 'dispose')
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall task metadata contract is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT usage.*
    INTO usage_record
    FROM public.cath_case_consumable_usage usage
   WHERE usage.tenant_id = NEW.tenant_id
     AND usage.id::text = metadata_value->>'cath_consumable_usage_id'
   FOR KEY SHARE;

  SELECT cath_case.*
    INTO case_record
    FROM public.cath_lab_cases cath_case
   WHERE cath_case.tenant_id = NEW.tenant_id
     AND cath_case.id::text = metadata_value->>'cath_case_id'
     AND cath_case.id = usage_record.case_id;

  SELECT catalog.*
    INTO catalog_record
    FROM public.cath_consumable_catalog catalog
   WHERE catalog.tenant_id = NEW.tenant_id
     AND catalog.id = usage_record.catalog_item_id;

  SELECT sla.*
    INTO sla_record
    FROM public.workflow_sla_instances sla
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = NEW.workflow_sla_instance_id
   FOR KEY SHARE;

  SELECT rule.*
    INTO rule_record
    FROM public.workflow_sla_rules rule
   WHERE rule.enabled = TRUE
     AND rule.rule_code = 'cath_consumable_inventory_reconciliation'
     AND (rule.tenant_id = NEW.tenant_id OR rule.tenant_id IS NULL)
   ORDER BY CASE WHEN rule.tenant_id = NEW.tenant_id THEN 0 ELSE 1 END
   LIMIT 1;

  expected_movement_kind := CASE WHEN usage_record.wasted THEN 'dispose' ELSE 'issue' END;

  IF usage_record.id IS NULL
     OR case_record.id IS NULL
     OR catalog_record.id IS NULL
     OR sla_record.id IS NULL
     OR catalog_record.inventory_item_id IS NULL
     OR metadata_value->>'inventory_item_id'
          IS DISTINCT FROM catalog_record.inventory_item_id::text
     OR metadata_value->>'movement_kind' IS DISTINCT FROM expected_movement_kind
     OR NEW.task_kind IS DISTINCT FROM 'review'
     OR NEW.priority IS DISTINCT FROM 'high'
     OR NEW.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR NEW.encounter_id IS NOT NULL
     OR NEW.related_resource_type
          IS DISTINCT FROM 'cath_case_consumable_usage'
     OR NEW.related_resource_id IS DISTINCT FROM usage_record.id::text
     OR NEW.related_resource_id
          IS DISTINCT FROM metadata_value->>'cath_consumable_usage_id'
     OR NEW.workflow_sla_instance_id IS NULL
     OR NEW.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
      OR NEW.stage_occurrence_key
          IS DISTINCT FROM 'cath-inventory-shortfall:usage:' || usage_record.id::text
      OR metadata_value->>'deep_link'
           IS DISTINCT FROM '/pharmacy/cath-inventory-reconciliation?case_id='
             || usage_record.case_id::text
             || '&consumable_usage_id=' || usage_record.id::text
     OR metadata_value->>'retry_path'
          IS DISTINCT FROM '/api/v1/cath-lab/cases/' || usage_record.case_id::text
            || '/consumables/' || usage_record.id::text || '/inventory-reconcile'
     OR sla_record.rule_code
          IS DISTINCT FROM 'cath_consumable_inventory_reconciliation'
     OR rule_record.id IS NULL
     OR rule_record.target_minutes IS DISTINCT FROM 30
     OR sla_record.rule_id IS DISTINCT FROM rule_record.id
     OR sla_record.source_table
          IS DISTINCT FROM 'cath_case_consumable_usage'
     OR sla_record.source_id IS DISTINCT FROM usage_record.id::text
     OR sla_record.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR sla_record.encounter_id IS DISTINCT FROM case_record.encounter_id
     OR sla_record.priority IS DISTINCT FROM 'high'
     OR sla_record.due_at
          IS DISTINCT FROM sla_record.started_at + INTERVAL '30 minutes'
     OR NULLIF(LOWER(BTRIM(metadata_value->>'canonical_encounter_id')), '')
          IS DISTINCT FROM case_record.encounter_id::text
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall task and linked SLA do not describe the same obligation'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    ownership_recovery := OLD.assigned_to_uid IS NOT NULL
      AND OLD.assigned_to_role IS NULL
      AND NEW.assigned_to_uid IS NOT NULL
      AND NEW.assigned_to_uid IS DISTINCT FROM OLD.assigned_to_uid
      AND NEW.assigned_to_role IS NULL
      AND metadata_value->>'role_claimed_actor_role' IN (
        'PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE'
      )
      AND metadata_value->>'assignment_recovery_receipt'
            ~ '^cath-assignment-recovery-v1:[0-9a-f]{64}$'
      AND metadata_value->>'assignment_recovery_command_fingerprint'
            ~ '^[0-9a-f]{64}$'
      AND metadata_value->>'assignment_recovered_from_uid'
            = OLD.assigned_to_uid::text
      AND metadata_value->>'assignment_recovered_at' IS NOT NULL
      AND sla_record.assigned_user_uid = OLD.assigned_to_uid
      AND sla_record.assigned_role_codes = ARRAY[]::text[]
      AND NOT EXISTS (
        SELECT 1
          FROM public.users prior_claimant
         WHERE prior_claimant.tenant_id = NEW.tenant_id
           AND prior_claimant.uid = OLD.assigned_to_uid
           AND prior_claimant.is_active = TRUE
           AND prior_claimant.status = 'active'
           AND COALESCE(prior_claimant.is_deleted, FALSE) = FALSE
           AND prior_claimant.role IN (
             'PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE'
           )
      );
  END IF;

  IF NEW.assigned_to_uid IS NULL THEN
    IF NEW.assigned_to_role IS DISTINCT FROM 'PHARMACIST'
       OR sla_record.assigned_user_uid IS NOT NULL
       OR sla_record.assigned_role_codes IS DISTINCT FROM
            ARRAY['PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE']::text[]
    THEN
      RAISE EXCEPTION 'Cath inventory shortfall queue ownership is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.assigned_to_role IS NOT NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.users claimant
        WHERE claimant.tenant_id = NEW.tenant_id
          AND claimant.uid = NEW.assigned_to_uid
          AND claimant.is_active = TRUE
          AND claimant.status = 'active'
          AND COALESCE(claimant.is_deleted, FALSE) = FALSE
          AND claimant.role IN ('PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE')
     )
     OR metadata_value->>'role_claim_receipt' !~ '^task-claim-v1:[0-9a-f]{64}$'
     OR metadata_value->>'role_claim_command_fingerprint' !~ '^[0-9a-f]{64}$'
     OR metadata_value->>'role_claimed_by' IS DISTINCT FROM NEW.assigned_to_uid::text
     OR metadata_value->>'role_claimed_from_role' IS DISTINCT FROM 'PHARMACIST'
     OR metadata_value->>'role_claimed_actor_role'
          NOT IN ('PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE')
     OR NOT (
       (
         sla_record.assigned_user_uid IS NOT DISTINCT FROM NEW.assigned_to_uid
         AND sla_record.assigned_role_codes = ARRAY[]::text[]
       )
        OR (
          TG_OP = 'UPDATE'
         AND OLD.assigned_to_uid IS NULL
         AND OLD.assigned_to_role = 'PHARMACIST'
         AND sla_record.assigned_user_uid IS NULL
         AND sla_record.assigned_role_codes =
               ARRAY['PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE']::text[]
        )
        OR ownership_recovery
      )
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall claimed ownership is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.task_kind IS DISTINCT FROM OLD.task_kind
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.related_resource_type IS DISTINCT FROM OLD.related_resource_type
    OR NEW.related_resource_id IS DISTINCT FROM OLD.related_resource_id
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
    OR NEW.sla_completion_semantics IS DISTINCT FROM OLD.sla_completion_semantics
    OR NEW.stage_occurrence_key IS DISTINCT FROM OLD.stage_occurrence_key
    OR NEW.metadata->>'task_contract' IS DISTINCT FROM OLD.metadata->>'task_contract'
    OR NEW.metadata->>'cath_consumable_usage_id'
         IS DISTINCT FROM OLD.metadata->>'cath_consumable_usage_id'
    OR NEW.metadata->>'cath_case_id' IS DISTINCT FROM OLD.metadata->>'cath_case_id'
    OR NEW.metadata->>'inventory_item_id'
         IS DISTINCT FROM OLD.metadata->>'inventory_item_id'
    OR NEW.metadata->>'movement_kind' IS DISTINCT FROM OLD.metadata->>'movement_kind'
    OR NEW.metadata->>'deep_link' IS DISTINCT FROM OLD.metadata->>'deep_link'
    OR NEW.metadata->>'retry_path' IS DISTINCT FROM OLD.metadata->>'retry_path'
  ) THEN
    RAISE EXCEPTION 'Cath inventory shortfall task identity and ownership are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.assigned_to_uid IS DISTINCT FROM OLD.assigned_to_uid
       OR NEW.assigned_to_role IS DISTINCT FROM OLD.assigned_to_role
     )
     AND NOT (
       OLD.assigned_to_uid IS NULL
       AND OLD.assigned_to_role = 'PHARMACIST'
       AND NEW.assigned_to_uid IS NOT NULL
       AND NEW.assigned_to_role IS NULL
     )
     AND ownership_recovery IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall task ownership may only be claimed once'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cath inventory shortfall task cannot be cancelled'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'completed' THEN
    SELECT COALESCE(SUM(-movement.quantity_delta), 0::numeric),
           COUNT(*) FILTER (
             WHERE movement.inventory_item_id IS DISTINCT FROM catalog_record.inventory_item_id
                OR movement.quantity_delta >= 0
                OR movement.movement_kind IS DISTINCT FROM expected_movement_kind
                OR (
                  usage_record.inventory_batch_id IS NOT NULL
                  AND movement.inventory_batch_id
                        IS DISTINCT FROM usage_record.inventory_batch_id
                )
           )
      INTO movement_total, invalid_movement_count
      FROM public.pharmacy_stock_movements movement
     WHERE movement.tenant_id = usage_record.tenant_id
       AND (
         (
           movement.reference_type = 'cath_consumable_usage'
           AND movement.reference_id = usage_record.id::text
         )
         OR (
           movement.reference_type = 'cath_consumable_reconciliation'
           AND movement.metadata->>'cath_consumable_usage_id' = usage_record.id::text
         )
       );

    IF usage_record.inventory_decrement_status IS DISTINCT FROM 'decremented'
       OR movement_total IS DISTINCT FROM usage_record.quantity
       OR invalid_movement_count > 0
       OR usage_record.inventory_movement_id IS NULL
    THEN
      RAISE EXCEPTION 'Cath inventory shortfall task completion requires exact durable inventory evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.due_at := sla_record.due_at;
  NEW.metadata := metadata_value || jsonb_build_object(
    'sla_instance_id', sla_record.id::text,
    'sla_key', sla_record.rule_code
  );
  RETURN NEW;
END
$cath_inventory_shortfall_task_sync$;

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_insert ON public.tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_insert
  BEFORE INSERT ON public.tasks
  FOR EACH ROW
  WHEN (COALESCE(NEW.metadata->>'task_contract', '') NOT IN (
    'ward_medication_obligation_v1',
    'mar_medication_exception_v1',
    'clinical_alert_delivery_recovery_v1',
    'counter_sale_void_refund_v1',
    'cath_inventory_shortfall_v1'
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
    'clinical_alert_delivery_recovery_v1',
    'counter_sale_void_refund_v1',
    'cath_inventory_shortfall_v1'
  ))
  EXECUTE FUNCTION public.tasks_sync_workflow_sla_compat();

CREATE TRIGGER trg_tasks_workflow_sla_compat_cath_shortfall_insert
  BEFORE INSERT ON public.tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'cath_inventory_shortfall_v1')
  EXECUTE FUNCTION public.cath_inventory_shortfall_task_sync();

CREATE TRIGGER trg_tasks_workflow_sla_compat_cath_shortfall_update
  BEFORE UPDATE OF
    tenant_id,
    status,
    task_kind,
    patient_uid,
    encounter_id,
    related_resource_type,
    related_resource_id,
    priority,
    assigned_to_uid,
    assigned_to_role,
    workflow_sla_instance_id,
    sla_completion_semantics,
    stage_occurrence_key,
    due_at,
    metadata
  ON public.tasks
  FOR EACH ROW
  WHEN (NEW.metadata->>'task_contract' = 'cath_inventory_shortfall_v1')
  EXECUTE FUNCTION public.cath_inventory_shortfall_task_sync();

CREATE OR REPLACE FUNCTION public.cath_inventory_shortfall_assert_contract(
  target_tenant_id UUID,
  target_usage_id BIGINT
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_inventory_shortfall_assert_contract$
DECLARE
  usage_record public.cath_case_consumable_usage%ROWTYPE;
  case_record public.cath_lab_cases%ROWTYPE;
  catalog_record public.cath_consumable_catalog%ROWTYPE;
  rule_record public.workflow_sla_rules%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  sla_record public.workflow_sla_instances%ROWTYPE;
  notification_record public.notification_outbox%ROWTYPE;
  final_movement_record public.pharmacy_stock_movements%ROWTYPE;
  expected_movement_kind TEXT;
  task_count BIGINT;
  spoofed_task_count BIGINT;
  sla_count BIGINT;
  spoofed_sla_count BIGINT;
  notification_count BIGINT;
  spoofed_notification_count BIGINT;
  movement_count BIGINT;
  invalid_movement_count BIGINT;
  movement_total NUMERIC(18,4);
  final_movement_time TIMESTAMPTZ;
  evidence JSONB;
  contract_expected BOOLEAN;
  owner_binding_valid BOOLEAN;
  notification_recipient_valid BOOLEAN;
BEGIN
  SELECT usage.*
    INTO usage_record
    FROM public.cath_case_consumable_usage usage
   WHERE usage.tenant_id = target_tenant_id
     AND usage.id = target_usage_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cath inventory shortfall evidence references a missing usage row'
      USING ERRCODE = '23514';
  END IF;

  SELECT cath_case.*
    INTO case_record
    FROM public.cath_lab_cases cath_case
   WHERE cath_case.tenant_id = usage_record.tenant_id
     AND cath_case.id = usage_record.case_id
     AND cath_case.patient_uid = usage_record.patient_uid;

  SELECT catalog.*
    INTO catalog_record
    FROM public.cath_consumable_catalog catalog
   WHERE catalog.tenant_id = usage_record.tenant_id
     AND catalog.id = usage_record.catalog_item_id;

  SELECT rule.*
    INTO rule_record
    FROM public.workflow_sla_rules rule
   WHERE rule.enabled = TRUE
     AND rule.rule_code = 'cath_consumable_inventory_reconciliation'
     AND (rule.tenant_id = usage_record.tenant_id OR rule.tenant_id IS NULL)
   ORDER BY CASE WHEN rule.tenant_id = usage_record.tenant_id THEN 0 ELSE 1 END
   LIMIT 1;

  IF case_record.id IS NULL
     OR catalog_record.id IS NULL
     OR catalog_record.inventory_item_id IS NULL
     OR rule_record.id IS NULL
     OR rule_record.target_minutes IS DISTINCT FROM 30
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall usage lacks tenant/patient/item lineage'
      USING ERRCODE = '23514';
  END IF;

  expected_movement_kind := CASE WHEN usage_record.wasted THEN 'dispose' ELSE 'issue' END;

  SELECT COUNT(*),
         COALESCE(SUM(-movement.quantity_delta), 0::numeric),
         COUNT(*) FILTER (
           WHERE movement.inventory_item_id IS DISTINCT FROM catalog_record.inventory_item_id
              OR movement.quantity_delta >= 0
              OR movement.movement_kind IS DISTINCT FROM expected_movement_kind
              OR (
                usage_record.inventory_batch_id IS NOT NULL
                AND movement.inventory_batch_id
                      IS DISTINCT FROM usage_record.inventory_batch_id
              )
              OR (
                movement.reference_type = 'cath_consumable_reconciliation'
                AND (
                  movement.reference_id !~ '^[0-9a-f]{64}$'
                  OR movement.metadata->>'command_contract'
                       IS DISTINCT FROM 'cath_inventory_reconciliation_v1'
                  OR movement.metadata->>'command_key_sha256'
                       IS DISTINCT FROM movement.reference_id
                  OR movement.metadata->>'request_fingerprint' !~ '^[0-9a-f]{64}$'
                  OR movement.metadata->>'http_idempotency_claim_id' !~ '^[1-9][0-9]*$'
                  OR movement.metadata->>'cath_consumable_usage_id'
                       IS DISTINCT FROM usage_record.id::text
                  OR movement.metadata->>'source_reference_type'
                       IS DISTINCT FROM 'cath_case_consumable_usage'
                  OR movement.metadata->>'source_reference_id'
                       IS DISTINCT FROM usage_record.id::text
                  OR movement.metadata->>'inventory_batch_id'
                       IS DISTINCT FROM movement.inventory_batch_id::text
                  OR movement.metadata->>'actor_role' NOT IN (
                       'PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE'
                     )
                  OR NOT pg_input_is_valid(
                       movement.metadata->>'requested_quantity',
                       'numeric'
                     )
                  OR NOT pg_input_is_valid(
                       movement.metadata->>'quantity_taken',
                       'numeric'
                     )
                  OR CASE
                       WHEN pg_input_is_valid(
                         movement.metadata->>'requested_quantity',
                         'numeric'
                       ) AND pg_input_is_valid(
                         movement.metadata->>'quantity_taken',
                         'numeric'
                       )
                       THEN (movement.metadata->>'requested_quantity')::numeric <= 0
                         OR (movement.metadata->>'quantity_taken')::numeric
                              IS DISTINCT FROM -movement.quantity_delta
                         OR (movement.metadata->>'requested_quantity')::numeric
                              < (movement.metadata->>'quantity_taken')::numeric
                       ELSE TRUE
                     END
                  OR movement.metadata->>'request_fingerprint'
                       IS DISTINCT FROM encode(
                         public.digest(
                           convert_to(
                             '{"case_id":"' || usage_record.case_id::text
                               || '","usage_id":"' || usage_record.id::text || '"}',
                             'UTF8'
                           ),
                           'sha256'
                         ),
                         'hex'
                       )
                  OR NOT EXISTS (
                    SELECT 1
                      FROM public.idempotency_keys claim
                     WHERE claim.id::text =
                             movement.metadata->>'http_idempotency_claim_id'
                       AND claim.tenant_id = movement.tenant_id
                       AND claim.user_uid = movement.performed_by
                       AND claim.request_method = 'POST'
                       AND claim.request_path =
                            '/api/v1/cath-lab/cases/' || usage_record.case_id::text
                              || '/consumables/' || usage_record.id::text
                              || '/inventory-reconcile'
                       AND claim.request_body_hash =
                            movement.metadata->>'request_fingerprint'
                       AND claim.status = 'complete'
                       AND claim.response_status = 200
                       AND claim.expires_at = 'infinity'::timestamptz
                       AND claim.response_body->>'success' = 'true'
                       AND claim.response_body->>'message' =
                            'Cath consumable inventory reconciliation'
                       AND claim.response_body->'data'->>'outcome' IN (
                            'completed', 'still_insufficient'
                          )
                       AND claim.response_body->'data'->'reconciliation'->>'case_id'
                            = usage_record.case_id::text
                       AND claim.response_body->'data'->'reconciliation'->>'usage_id'
                            = usage_record.id::text
                       AND movement.reference_id = encode(
                         public.digest(
                           convert_to(
                             movement.tenant_id::text || ':'
                               || movement.performed_by::text
                               || ':cath-inventory-shortfall:'
                               || usage_record.id::text || ':' || claim.request_key,
                             'UTF8'
                           ),
                           'sha256'
                         ),
                         'hex'
                       )
                  )
                )
              )
         ),
         MAX(movement.created_at) FILTER (
           WHERE movement.id = usage_record.inventory_movement_id
         )
    INTO movement_count,
         movement_total,
         invalid_movement_count,
         final_movement_time
    FROM public.pharmacy_stock_movements movement
   WHERE movement.tenant_id = usage_record.tenant_id
     AND (
       (
         movement.reference_type = 'cath_consumable_usage'
         AND movement.reference_id = usage_record.id::text
       )
       OR (
         movement.reference_type = 'cath_consumable_reconciliation'
         AND movement.metadata->>'cath_consumable_usage_id' = usage_record.id::text
       )
     );

  SELECT movement.*
    INTO final_movement_record
    FROM public.pharmacy_stock_movements movement
   WHERE movement.tenant_id = usage_record.tenant_id
     AND (
       (
         movement.reference_type = 'cath_consumable_usage'
         AND movement.reference_id = usage_record.id::text
       )
       OR (
         movement.reference_type = 'cath_consumable_reconciliation'
         AND movement.metadata->>'cath_consumable_usage_id' = usage_record.id::text
       )
     )
   ORDER BY movement.created_at DESC, movement.id DESC
   LIMIT 1;

  IF invalid_movement_count > 0
     OR movement_total > usage_record.quantity
     OR (
       movement_count > 0
       AND usage_record.inventory_movement_id IS DISTINCT FROM final_movement_record.id
     )
     OR (
       movement_total > 0
       AND usage_record.inventory_decrement_status NOT IN (
         'insufficient_stock',
         'decremented'
       )
     )
     OR (
       usage_record.inventory_decrement_status = 'decremented'
       AND movement_total IS DISTINCT FROM usage_record.quantity
     )
  THEN
    RAISE EXCEPTION 'Cath consumable movement evidence does not equal its documented quantity/item/lineage'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)
    INTO task_count
    FROM public.tasks task
   WHERE task.tenant_id = usage_record.tenant_id
     AND task.related_resource_type = 'cath_case_consumable_usage'
     AND task.related_resource_id = usage_record.id::text
     AND task.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
     AND task.metadata->>'cath_consumable_usage_id' = usage_record.id::text;

  SELECT COUNT(*)
    INTO spoofed_task_count
    FROM public.tasks task
   WHERE task.tenant_id = usage_record.tenant_id
     AND (
       task.stage_occurrence_key =
            'cath-inventory-shortfall:usage:' || usage_record.id::text
       OR task.metadata->>'cath_consumable_usage_id' = usage_record.id::text
       OR (
         task.related_resource_type = 'cath_case_consumable_usage'
         AND task.related_resource_id = usage_record.id::text
         AND task.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
       )
     )
     AND (
       task.related_resource_type = 'cath_case_consumable_usage'
       AND task.related_resource_id = usage_record.id::text
       AND task.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
       AND task.metadata->>'cath_consumable_usage_id' = usage_record.id::text
     ) IS NOT TRUE;

  SELECT task.*
    INTO task_record
    FROM public.tasks task
   WHERE task.tenant_id = usage_record.tenant_id
     AND task.related_resource_type = 'cath_case_consumable_usage'
     AND task.related_resource_id = usage_record.id::text
     AND task.metadata->>'task_contract' = 'cath_inventory_shortfall_v1';

  SELECT COUNT(*)
    INTO sla_count
    FROM public.workflow_sla_instances sla
   WHERE sla.tenant_id = usage_record.tenant_id
     AND sla.rule_code = 'cath_consumable_inventory_reconciliation'
     AND sla.source_table = 'cath_case_consumable_usage'
     AND sla.source_id = usage_record.id::text;

  SELECT COUNT(*)
    INTO spoofed_sla_count
    FROM public.workflow_sla_instances sla
   WHERE sla.tenant_id = usage_record.tenant_id
     AND (
       sla.rule_code = 'cath_consumable_inventory_reconciliation'
       OR sla.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
     )
     AND (
       sla.rule_code = 'cath_consumable_inventory_reconciliation'
       AND sla.source_table = 'cath_case_consumable_usage'
       AND sla.source_id = usage_record.id::text
     ) IS NOT TRUE
     AND (
       sla.source_id = usage_record.id::text
       OR sla.metadata->>'cath_consumable_usage_id' = usage_record.id::text
     );

  SELECT sla.*
    INTO sla_record
    FROM public.workflow_sla_instances sla
   WHERE sla.tenant_id = usage_record.tenant_id
     AND sla.rule_code = 'cath_consumable_inventory_reconciliation'
     AND sla.source_table = 'cath_case_consumable_usage'
     AND sla.source_id = usage_record.id::text;

  SELECT COUNT(*)
    INTO notification_count
    FROM public.notification_outbox outbox
   WHERE outbox.tenant_id = usage_record.tenant_id
     AND outbox.type = 'cath_inventory_shortfall'
     AND outbox.source_event_key = 'cath-inventory-shortfall:' || usage_record.id::text;

  SELECT COUNT(*)
    INTO spoofed_notification_count
    FROM public.notification_outbox outbox
   WHERE outbox.tenant_id = usage_record.tenant_id
     AND (
       outbox.source_event_key = 'cath-inventory-shortfall:' || usage_record.id::text
       OR outbox.payload->>'cath_consumable_usage_id' = usage_record.id::text
     )
     AND (
       outbox.type = 'cath_inventory_shortfall'
       AND outbox.source_event_key = 'cath-inventory-shortfall:' || usage_record.id::text
       AND outbox.payload->>'cath_consumable_usage_id' = usage_record.id::text
     ) IS NOT TRUE;

  SELECT outbox.*
    INTO notification_record
    FROM public.notification_outbox outbox
   WHERE outbox.tenant_id = usage_record.tenant_id
     AND outbox.type = 'cath_inventory_shortfall'
     AND outbox.source_event_key = 'cath-inventory-shortfall:' || usage_record.id::text;

  contract_expected := usage_record.inventory_decrement_status = 'insufficient_stock'
    OR usage_record.metadata->>'inventory_shortfall_contract'
         = 'cath_inventory_shortfall_v1'
    OR task_count > 0
    OR spoofed_task_count > 0
    OR sla_count > 0
    OR spoofed_sla_count > 0
    OR notification_count > 0
    OR spoofed_notification_count > 0;

  owner_binding_valid := (
    task_record.assigned_to_uid IS NULL
    AND task_record.assigned_to_role = 'PHARMACIST'
    AND sla_record.assigned_user_uid IS NULL
    AND sla_record.assigned_role_codes =
         ARRAY['PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE']::text[]
  ) OR (
    task_record.assigned_to_uid IS NOT NULL
    AND task_record.assigned_to_role IS NULL
    AND sla_record.assigned_user_uid = task_record.assigned_to_uid
    AND sla_record.assigned_role_codes = ARRAY[]::text[]
    AND EXISTS (
      SELECT 1
        FROM public.users claimant
       WHERE claimant.tenant_id = usage_record.tenant_id
         AND claimant.uid = task_record.assigned_to_uid
         AND claimant.is_active = TRUE
         AND claimant.status = 'active'
         AND COALESCE(claimant.is_deleted, FALSE) = FALSE
         AND claimant.role IN ('PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE')
    )
  );

  notification_recipient_valid := (
    notification_record.recipient_id IS NULL
    AND notification_record.payload->>'recipient_uid' IS NULL
    AND notification_record.payload->>'recipient_role' IS NULL
    AND notification_record.payload->>'recipient_status_snapshot' IS NULL
    AND notification_record.payload->>'recipient_not_deleted_snapshot' IS NULL
    AND notification_record.payload->>'coverage_gap' = 'true'
    AND notification_record.payload->>'delivery_coverage' = 'unassigned'
    AND notification_record.payload->'intended_role_codes' =
        '["PHARMACIST","PHARMACY_STAFF","PHARMACY_INCHARGE"]'::jsonb
  ) OR (
    notification_record.recipient_id ~ '^[1-9][0-9]*$'
    AND pg_input_is_valid(notification_record.payload->>'recipient_uid', 'uuid')
    AND notification_record.payload->>'recipient_status_snapshot' = 'active'
    AND notification_record.payload->>'recipient_not_deleted_snapshot' = 'true'
    AND notification_record.payload->'intended_role_codes' =
        '["PHARMACIST","PHARMACY_STAFF","PHARMACY_INCHARGE"]'::jsonb
    AND EXISTS (
      SELECT 1
        FROM public.users recipient_identity
       WHERE recipient_identity.tenant_id = usage_record.tenant_id
         AND recipient_identity.id::text = notification_record.recipient_id
         AND recipient_identity.uid::text =
             lower(notification_record.payload->>'recipient_uid')
    )
    AND (
      (
        notification_record.payload->>'recipient_role' IN (
          'PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE'
        )
        AND COALESCE(notification_record.payload->>'coverage_gap', 'false') = 'false'
        AND notification_record.payload->>'delivery_coverage' = 'direct'
      )
      OR (
        notification_record.payload->>'recipient_role' IN ('ADMIN', 'SUPER_ADMIN')
        AND notification_record.payload->>'coverage_gap' = 'true'
        AND notification_record.payload->>'delivery_coverage' = 'operator_recovery'
      )
    )
  );

  IF contract_expected IS NOT TRUE THEN
    RETURN;
  END IF;

  IF usage_record.metadata->>'inventory_shortfall_contract'
       IS DISTINCT FROM 'cath_inventory_shortfall_v1'
     OR task_count IS DISTINCT FROM 1::bigint
     OR spoofed_task_count IS DISTINCT FROM 0::bigint
     OR sla_count IS DISTINCT FROM 1::bigint
     OR spoofed_sla_count IS DISTINCT FROM 0::bigint
     OR notification_count IS DISTINCT FROM 1::bigint
     OR spoofed_notification_count IS DISTINCT FROM 0::bigint
     OR task_record.id IS NULL
     OR sla_record.id IS NULL
     OR notification_record.id IS NULL
     OR usage_record.metadata->>'inventory_shortfall_task_id'
          IS DISTINCT FROM task_record.id::text
     OR usage_record.metadata->>'inventory_shortfall_sla_instance_id'
          IS DISTINCT FROM sla_record.id::text
     OR usage_record.metadata->>'inventory_shortfall_notification_outbox_id'
          IS DISTINCT FROM notification_record.id::text
     OR task_record.workflow_sla_instance_id IS DISTINCT FROM sla_record.id
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR task_record.task_kind IS DISTINCT FROM 'review'
     OR task_record.priority IS DISTINCT FROM 'high'
     OR task_record.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR task_record.encounter_id IS NOT NULL
     OR owner_binding_valid IS NOT TRUE
     OR task_record.stage_occurrence_key
          IS DISTINCT FROM 'cath-inventory-shortfall:usage:' || usage_record.id::text
     OR task_record.metadata->>'cath_case_id' IS DISTINCT FROM usage_record.case_id::text
     OR task_record.metadata->>'inventory_item_id'
          IS DISTINCT FROM catalog_record.inventory_item_id::text
     OR task_record.metadata->>'movement_kind' IS DISTINCT FROM expected_movement_kind
      OR task_record.metadata->>'deep_link'
           IS DISTINCT FROM '/pharmacy/cath-inventory-reconciliation?case_id='
             || usage_record.case_id::text
             || '&consumable_usage_id=' || usage_record.id::text
     OR task_record.metadata->>'retry_path'
          IS DISTINCT FROM '/api/v1/cath-lab/cases/' || usage_record.case_id::text
            || '/consumables/' || usage_record.id::text || '/inventory-reconcile'
     OR sla_record.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR sla_record.encounter_id IS DISTINCT FROM case_record.encounter_id
     OR sla_record.priority IS DISTINCT FROM 'high'
     OR sla_record.rule_id IS DISTINCT FROM rule_record.id
     OR sla_record.metadata->>'task_contract'
          IS DISTINCT FROM 'cath_inventory_shortfall_v1'
     OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     OR sla_record.due_at
          IS DISTINCT FROM sla_record.started_at + INTERVAL '30 minutes'
     OR notification_record.channel IS DISTINCT FROM 'inapp'
     OR notification_record.template_version
          IS DISTINCT FROM 'cath-inventory-shortfall.v1'
      OR notification_record.payload->>'kind'
          IS DISTINCT FROM 'cath_inventory_shortfall'
     OR notification_record.payload->>'presentation_key'
          IS DISTINCT FROM 'cath_inventory_shortfall'
     OR notification_record.payload->>'task_id' IS DISTINCT FROM task_record.id::text
     OR notification_record.payload->>'cath_case_id'
          IS DISTINCT FROM usage_record.case_id::text
     OR notification_record.payload->>'cath_consumable_usage_id'
          IS DISTINCT FROM usage_record.id::text
     OR notification_record.payload->>'deep_link'
          IS DISTINCT FROM task_record.metadata->>'deep_link'
     OR notification_record.payload->>'retry_path'
          IS DISTINCT FROM task_record.metadata->>'retry_path'
     OR notification_record.payload->>'action_label_key'
          IS DISTINCT FROM 'clinical_inbox.open_workflow'
     OR notification_record.payload->>'presentation_locale' NOT IN (
          'en', 'hi', 'ta', 'te', 'ml'
        )
     OR notification_record.payload->>'presentation_copy_version'
          IS DISTINCT FROM 'cath-inventory-shortfall.v1'
     OR jsonb_typeof(notification_record.payload->'presentations')
          IS DISTINCT FROM 'object'
     OR notification_record.payload->'presentations' IS DISTINCT FROM
          $cath_inventory_shortfall_presentations$
          {
            "en": {
              "title": "Reconcile Cath consumable stock",
              "body": "Documented Cath consumable stock is incomplete. Replenish and retry the exact remaining quantity."
            },
            "hi": {
              "title": "कैथ उपभोग्य स्टॉक का मिलान करें",
              "body": "दर्ज कैथ उपभोग्य स्टॉक अधूरा है। स्टॉक भरें और केवल शेष मात्रा का पुनः प्रयास करें।"
            },
            "ta": {
              "title": "கேத் நுகர்பொருள் இருப்பை சரிசெய்யவும்",
              "body": "பதிவுசெய்த கேத் நுகர்பொருள் இருப்பு முழுமையில்லை. இருப்பை நிரப்பி மீதமுள்ள அளவை மட்டும் மீண்டும் முயலவும்."
            },
            "te": {
              "title": "క్యాథ్ వినియోగ వస్తు నిల్వను సరిపోల్చండి",
              "body": "నమోదైన క్యాథ్ వినియోగ వస్తు నిల్వ అసంపూర్ణంగా ఉంది. నిల్వను నింపి మిగిలిన పరిమాణాన్ని మాత్రమే మళ్లీ ప్రయత్నించండి."
            },
            "ml": {
              "title": "കാത്ത് ഉപഭോഗവസ്തു സ്റ്റോക്ക് പൊരുത്തപ്പെടുത്തുക",
              "body": "രേഖപ്പെടുത്തിയ കാത്ത് ഉപഭോഗവസ്തു സ്റ്റോക്ക് അപൂർണ്ണമാണ്. സ്റ്റോക്ക് നിറച്ച് ശേഷിക്കുന്ന അളവ് മാത്രം വീണ്ടും ശ്രമിക്കുക."
            }
          }
          $cath_inventory_shortfall_presentations$::jsonb
     OR NOT (
       notification_record.payload->'presentations'
         ?& ARRAY['en', 'hi', 'ta', 'te', 'ml']::text[]
     )
     OR notification_record.title IS DISTINCT FROM
          notification_record.payload->'presentations'
            ->(notification_record.payload->>'presentation_locale')->>'title'
     OR notification_record.body IS DISTINCT FROM
          notification_record.payload->'presentations'
            ->(notification_record.payload->>'presentation_locale')->>'body'
     OR notification_recipient_valid IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall lacks its exact pharmacist task/SLA/notification binding'
      USING ERRCODE = '23514';
  END IF;

  IF usage_record.inventory_decrement_status = 'insufficient_stock' THEN
    IF movement_total >= usage_record.quantity
       OR task_record.status NOT IN ('open', 'in_progress', 'blocked', 'overdue')
       OR task_record.completed_at IS NOT NULL
       OR sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
    THEN
      RAISE EXCEPTION 'Open Cath inventory shortfall requires incomplete stock and an actionable task/SLA'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  IF usage_record.inventory_decrement_status IS DISTINCT FROM 'decremented'
     OR movement_count < 1
     OR movement_total IS DISTINCT FROM usage_record.quantity
     OR usage_record.inventory_movement_id IS NULL
     OR final_movement_record.id IS NULL
     OR usage_record.inventory_movement_id IS DISTINCT FROM final_movement_record.id
     OR final_movement_record.reference_type
          IS DISTINCT FROM 'cath_consumable_reconciliation'
     OR final_movement_record.metadata->>'command_contract'
          IS DISTINCT FROM 'cath_inventory_reconciliation_v1'
     OR task_record.assigned_to_uid IS NULL
     OR final_movement_record.performed_by
          IS DISTINCT FROM task_record.assigned_to_uid
     OR final_movement_record.metadata->>'actor_role'
          IS DISTINCT FROM task_record.metadata->>'role_claimed_actor_role'
     OR final_movement_time IS NULL
     OR task_record.status IS DISTINCT FROM 'completed'
     OR task_record.completed_at IS NULL
     OR sla_record.completed_at IS NULL
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
  THEN
    RAISE EXCEPTION 'Terminal Cath inventory shortfall requires exact movement, task, and SLA closure'
      USING ERRCODE = '23514';
  END IF;

  evidence := sla_record.metadata->'completion_evidence';
  IF sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
     OR sla_record.metadata->>'completed_by'
          IS DISTINCT FROM final_movement_record.performed_by::text
     OR task_record.completed_at IS DISTINCT FROM sla_record.completed_at
     OR task_record.completed_at IS DISTINCT FROM final_movement_record.created_at
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR evidence->>'kind'
          IS DISTINCT FROM 'cath_consumable_inventory_reconciled'
     OR evidence->>'resource_type' IS DISTINCT FROM 'pharmacy_stock_movement'
     OR evidence->>'resource_id' IS DISTINCT FROM usage_record.inventory_movement_id::text
     OR evidence->>'cath_consumable_usage_id' IS DISTINCT FROM usage_record.id::text
     OR evidence->>'documented_quantity' IS DISTINCT FROM usage_record.quantity::text
     OR evidence->>'decremented_quantity' IS DISTINCT FROM usage_record.quantity::text
     OR evidence->>'actor_uid'
          IS DISTINCT FROM final_movement_record.performed_by::text
     OR evidence->>'recorded_at' !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR NOT pg_input_is_valid(evidence->>'recorded_at', 'timestamp with time zone')
     OR date_trunc('milliseconds', sla_record.completed_at)
          IS DISTINCT FROM date_trunc(
            'milliseconds',
            (evidence->>'recorded_at')::timestamptz
          )
     OR date_trunc('milliseconds', final_movement_time)
          IS DISTINCT FROM date_trunc(
            'milliseconds',
            (evidence->>'recorded_at')::timestamptz
          )
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall SLA receipt does not match its exact movement evidence'
      USING ERRCODE = '23514';
  END IF;
END
$cath_inventory_shortfall_assert_contract$;

ALTER FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_source_binding_pre_748;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_source_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_inventory_shortfall_source_binding$
DECLARE
  task_record public.tasks%ROWTYPE;
BEGIN
  SELECT task.*
    INTO task_record
    FROM public.tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'cath_inventory_shortfall_v1'
  THEN
    PERFORM public.care_pathway_assert_task_sla_source_binding_pre_748(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  IF task_record.related_resource_type
       IS DISTINCT FROM 'cath_case_consumable_usage'
     OR task_record.related_resource_id !~ '^[1-9][0-9]*$'
  THEN
    RAISE EXCEPTION 'Cath inventory shortfall task has an invalid usage source'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.cath_inventory_shortfall_assert_contract(
    task_record.tenant_id,
    task_record.related_resource_id::bigint
  );
END
$cath_inventory_shortfall_source_binding$;

ALTER FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)
  RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_748;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_inventory_shortfall_completion_receipt$
DECLARE
  task_record public.tasks%ROWTYPE;
BEGIN
  SELECT task.*
    INTO task_record
    FROM public.tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'cath_inventory_shortfall_v1'
  THEN
    PERFORM public.care_pathway_assert_task_sla_completion_receipt_pre_748(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  IF task_record.related_resource_id !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Cath inventory shortfall completion receipt has an invalid usage source'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.cath_inventory_shortfall_assert_contract(
    task_record.tenant_id,
    task_record.related_resource_id::bigint
  );
END
$cath_inventory_shortfall_completion_receipt$;

CREATE OR REPLACE FUNCTION public.cath_inventory_shortfall_contract_constraint()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $cath_inventory_shortfall_contract_constraint$
DECLARE
  tenant_id_value UUID;
  usage_id_text TEXT;
  relevant BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'cath_case_consumable_usage' THEN
    tenant_id_value := COALESCE(NEW.tenant_id, OLD.tenant_id);
    usage_id_text := COALESCE(NEW.id, OLD.id)::text;
    relevant := COALESCE(
      NEW.inventory_decrement_status = 'insufficient_stock',
      FALSE
    ) OR COALESCE(
      OLD.inventory_decrement_status = 'insufficient_stock',
      FALSE
    );
    IF relevant IS NOT TRUE THEN
      relevant := EXISTS (
        SELECT 1
          FROM public.tasks task
         WHERE task.tenant_id = tenant_id_value
           AND task.related_resource_type = 'cath_case_consumable_usage'
           AND task.related_resource_id = usage_id_text
           AND task.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
      ) OR EXISTS (
        SELECT 1
          FROM public.workflow_sla_instances sla
         WHERE sla.tenant_id = tenant_id_value
           AND sla.rule_code = 'cath_consumable_inventory_reconciliation'
           AND sla.source_table = 'cath_case_consumable_usage'
           AND sla.source_id = usage_id_text
      ) OR EXISTS (
        SELECT 1
          FROM public.notification_outbox outbox
         WHERE outbox.tenant_id = tenant_id_value
           AND outbox.type = 'cath_inventory_shortfall'
           AND outbox.source_event_key = 'cath-inventory-shortfall:' || usage_id_text
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    tenant_id_value := COALESCE(NEW.tenant_id, OLD.tenant_id);
    usage_id_text := COALESCE(
      NEW.metadata->>'cath_consumable_usage_id',
      OLD.metadata->>'cath_consumable_usage_id',
      CASE
        WHEN NEW.related_resource_type = 'cath_case_consumable_usage'
          THEN NEW.related_resource_id
        WHEN OLD.related_resource_type = 'cath_case_consumable_usage'
          THEN OLD.related_resource_id
        ELSE NULL
      END,
      CASE
        WHEN NEW.stage_occurrence_key LIKE 'cath-inventory-shortfall:usage:%'
          THEN SUBSTRING(
            NEW.stage_occurrence_key
            FROM LENGTH('cath-inventory-shortfall:usage:') + 1
          )
        WHEN OLD.stage_occurrence_key LIKE 'cath-inventory-shortfall:usage:%'
          THEN SUBSTRING(
            OLD.stage_occurrence_key
            FROM LENGTH('cath-inventory-shortfall:usage:') + 1
          )
        ELSE NULL
      END
    );
    relevant := NEW.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
      OR OLD.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
      OR NEW.metadata ? 'cath_consumable_usage_id'
      OR OLD.metadata ? 'cath_consumable_usage_id'
      OR NEW.related_resource_type = 'cath_case_consumable_usage'
      OR OLD.related_resource_type = 'cath_case_consumable_usage'
      OR NEW.stage_occurrence_key LIKE 'cath-inventory-shortfall:usage:%'
      OR OLD.stage_occurrence_key LIKE 'cath-inventory-shortfall:usage:%';
  ELSIF TG_TABLE_NAME = 'workflow_sla_instances' THEN
    tenant_id_value := COALESCE(NEW.tenant_id, OLD.tenant_id);
    usage_id_text := COALESCE(
      NEW.metadata->>'cath_consumable_usage_id',
      OLD.metadata->>'cath_consumable_usage_id',
      CASE
        WHEN NEW.rule_code = 'cath_consumable_inventory_reconciliation'
          OR NEW.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
          THEN NEW.source_id
        ELSE NULL
      END,
      CASE
        WHEN OLD.rule_code = 'cath_consumable_inventory_reconciliation'
          OR OLD.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
          THEN OLD.source_id
        ELSE NULL
      END
    );
    relevant := NEW.rule_code = 'cath_consumable_inventory_reconciliation'
      OR OLD.rule_code = 'cath_consumable_inventory_reconciliation'
      OR NEW.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
      OR OLD.metadata->>'task_contract' = 'cath_inventory_shortfall_v1';
  ELSIF TG_TABLE_NAME = 'pharmacy_stock_movements' THEN
    tenant_id_value := COALESCE(NEW.tenant_id, OLD.tenant_id);
    relevant := NEW.reference_type IN (
      'cath_consumable_usage',
      'cath_consumable_reconciliation'
    ) OR OLD.reference_type IN (
      'cath_consumable_usage',
      'cath_consumable_reconciliation'
    );
    usage_id_text := COALESCE(
      CASE
        WHEN NEW.reference_type = 'cath_consumable_usage' THEN NEW.reference_id
        WHEN NEW.reference_type = 'cath_consumable_reconciliation'
          THEN NEW.metadata->>'cath_consumable_usage_id'
        ELSE NULL
      END,
      CASE
        WHEN OLD.reference_type = 'cath_consumable_usage' THEN OLD.reference_id
        WHEN OLD.reference_type = 'cath_consumable_reconciliation'
          THEN OLD.metadata->>'cath_consumable_usage_id'
        ELSE NULL
      END
    );
  ELSIF TG_TABLE_NAME = 'notification_outbox' THEN
    tenant_id_value := COALESCE(NEW.tenant_id, OLD.tenant_id);
    relevant := NEW.type = 'cath_inventory_shortfall'
      OR OLD.type = 'cath_inventory_shortfall'
      OR NEW.payload ? 'cath_consumable_usage_id'
      OR OLD.payload ? 'cath_consumable_usage_id'
      OR NEW.source_event_key LIKE 'cath-inventory-shortfall:%'
      OR OLD.source_event_key LIKE 'cath-inventory-shortfall:%';
    usage_id_text := COALESCE(
      NEW.payload->>'cath_consumable_usage_id',
      OLD.payload->>'cath_consumable_usage_id',
      CASE
        WHEN NEW.source_event_key LIKE 'cath-inventory-shortfall:%'
          THEN SUBSTRING(
            NEW.source_event_key
            FROM LENGTH('cath-inventory-shortfall:') + 1
          )
        WHEN OLD.source_event_key LIKE 'cath-inventory-shortfall:%'
          THEN SUBSTRING(
            OLD.source_event_key
            FROM LENGTH('cath-inventory-shortfall:') + 1
          )
        ELSE NULL
      END
    );
  ELSE
    RAISE EXCEPTION 'Unsupported Cath inventory shortfall constraint source'
      USING ERRCODE = '23514';
  END IF;

  IF relevant IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  IF usage_id_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Cath inventory shortfall evidence has an invalid usage identity'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.cath_inventory_shortfall_assert_contract(
    tenant_id_value,
    usage_id_text::bigint
  );
  RETURN NULL;
END
$cath_inventory_shortfall_contract_constraint$;

CREATE CONSTRAINT TRIGGER trg_cath_inventory_shortfall_usage_contract
  AFTER INSERT OR UPDATE OR DELETE ON public.cath_case_consumable_usage
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_shortfall_contract_constraint();

CREATE CONSTRAINT TRIGGER trg_cath_inventory_shortfall_task_contract
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_shortfall_contract_constraint();

CREATE CONSTRAINT TRIGGER trg_cath_inventory_shortfall_sla_contract
  AFTER INSERT OR UPDATE OR DELETE ON public.workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_shortfall_contract_constraint();

CREATE CONSTRAINT TRIGGER trg_cath_inventory_shortfall_movement_contract
  AFTER INSERT OR UPDATE OR DELETE ON public.pharmacy_stock_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_shortfall_contract_constraint();

CREATE CONSTRAINT TRIGGER trg_cath_inventory_shortfall_notification_contract
  AFTER INSERT OR UPDATE OR DELETE ON public.notification_outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.cath_inventory_shortfall_contract_constraint();

REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_task_sync()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_contract_constraint()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding_pre_748(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding_pre_746(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding_pre_745(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_748(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_746(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_745(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_med03(UUID, INTEGER)
  FROM PUBLIC;

DO $cath_inventory_shortfall_runtime_privileges$
DECLARE
  runtime_role TEXT;
  callable_function_name TEXT;
  callable_functions CONSTANT TEXT[] := ARRAY[
    'care_pathway_assert_task_sla_source_binding',
    'care_pathway_assert_task_sla_source_binding_pre_748',
    'care_pathway_assert_task_sla_source_binding_pre_746',
    'care_pathway_assert_task_sla_source_binding_pre_745',
    'care_pathway_assert_task_sla_completion_receipt',
    'care_pathway_assert_task_sla_completion_receipt_pre_748',
    'care_pathway_assert_task_sla_completion_receipt_pre_746',
    'care_pathway_assert_task_sla_completion_receipt_pre_745',
    'care_pathway_assert_task_sla_completion_receipt_pre_mar_exception',
    'care_pathway_assert_task_sla_completion_receipt_pre_med03'
  ];
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_task_sync() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_contract_constraint() FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) TO %I',
      runtime_role
    );
    FOREACH callable_function_name IN ARRAY callable_functions
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(UUID, INTEGER) FROM %I',
        callable_function_name,
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.%I(UUID, INTEGER) TO %I',
        callable_function_name,
        runtime_role
      );
    END LOOP;
  END LOOP;
END
$cath_inventory_shortfall_runtime_privileges$;

COMMENT ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) IS
  'Deferred exact binding for Cath shortfall usage, pharmacist task/SLA/notification, and append-only stock movement evidence.';

COMMIT;
