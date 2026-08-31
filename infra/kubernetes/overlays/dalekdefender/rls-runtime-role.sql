-- DalekDefender runtime RLS role.
--
-- The in-cluster bootstrap role `vhhealth` owns the database and is a
-- superuser in this single-node dev/test rig, so it bypasses Postgres row
-- level security. The backend keeps that connection for migrations, then
-- request-scoped tenant transactions SET LOCAL ROLE to `vhhealth_app`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vhhealth_app') THEN
    CREATE ROLE vhhealth_app NOLOGIN;
  END IF;
END $$;

ALTER ROLE vhhealth_app NOSUPERUSER NOBYPASSRLS;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE vhhealth TO vhhealth_app;
GRANT USAGE ON SCHEMA public TO vhhealth_app;
REVOKE CREATE ON SCHEMA public FROM vhhealth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vhhealth_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO vhhealth_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vhhealth_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vhhealth_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vhhealth_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO vhhealth_app;

-- ── Audit finding M17 (2026-06-10): non-superuser CONNECTION role ──────────
-- The backend previously CONNECTED as the superuser `vhhealth` full-time,
-- which bypasses RLS everywhere outside tenant transactions. Create a
-- non-superuser LOGIN role for the app's normal connection; keep the
-- superuser strictly for migrations.
--
-- OPERATOR steps on the rig (after running this file):
--   1. Set a strong password:
--        ALTER ROLE vhhealth_runtime PASSWORD '<openssl rand -base64 24>';
--   2. Point the vhhealth-backend Secret's DATABASE_URL at
--        postgresql://vhhealth_runtime:<pw>@vhhealth-postgres:5432/vhhealth
--   3. Run migrations via a one-off job/psql using the superuser DSN only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vhhealth_runtime') THEN
    CREATE ROLE vhhealth_runtime LOGIN;
  END IF;
END $$;

ALTER ROLE vhhealth_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT vhhealth_app TO vhhealth_runtime;
GRANT CONNECT ON DATABASE vhhealth TO vhhealth_runtime;
GRANT USAGE ON SCHEMA public TO vhhealth_runtime;
REVOKE CREATE ON SCHEMA public FROM vhhealth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vhhealth_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO vhhealth_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vhhealth_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vhhealth_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vhhealth_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO vhhealth_runtime;

-- MED-03 medication evidence is append-only. The broad bootstrap grants above
-- intentionally cover the whole application schema; immediately narrow these
-- ledgers so re-running this file can never restore UPDATE/DELETE/setval.
DO $med03_runtime_privileges$
DECLARE
  runtime_role TEXT;
  relation_name TEXT;
  sequence_name TEXT;
  trigger_function_name TEXT;
  runtime_wrapper_function TEXT;
  column_list TEXT;
  mutable_relations CONSTANT TEXT[] := ARRAY[
    'ward_indent_inventory_allocations',
    'billing_credit_notes',
    'clinical_alert_delivery_obligations',
    'clinical_alert_delivery_recovery_cases',
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
    'ward_indent_inventory_allocation_guard',
    'ward_indent_controlled_patient_guard',
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
    'clinical_alert_delivery_obligation_guard',
    'clinical_alert_delivery_recovery_case_guard',
    'clinical_alert_delivery_recovery_action_guard',
    'clinical_alert_delivery_recovery_task_sync',
    'clinical_alert_delivery_recovery_task_case_constraint',
    'clinical_alert_delivery_recovery_obligation_constraint',
    'clinical_alert_delivery_recovery_claim_comment_guard',
    'clinical_alert_delivery_recovery_assignee_viability_guard',
    'mar_medication_exception_case_guard',
    'mar_medication_exception_case_receipt_guard',
    'mar_medication_exception_claim_comment_guard',
    'mar_medication_exception_assignee_viability_guard',
    'mar_medication_exception_tasks_sync_workflow_sla_compat',
    'counter_sale_void_request_guard',
    'counter_sale_void_refund_guard',
    'counter_sale_void_sale_guard',
    'counter_sale_void_stock_return_guard',
    'counter_sale_void_allocation_return_guard',
    'counter_sale_void_request_terminal_evidence',
    'counter_sale_void_task_sync',
    'counter_sale_void_task_binding_evidence',
    'billing_refund_offline_electronic_evidence_guard_747',
    'billing_refund_offline_electronic_binding_guard_747',
    'billing_refund_payout_guard_747',
    'cash_drawer_reconciliation_guard_747',
    'billing_cash_payment_reversal_guard_747',
    'cath_inventory_shortfall_task_sync',
    'cath_inventory_shortfall_contract_constraint'
  ];
  runtime_wrapper_functions CONSTANT TEXT[] := ARRAY[
    'care_pathway_assert_task_sla_source_binding(UUID, INTEGER)',
    'care_pathway_assert_task_sla_source_binding_pre_748(UUID, INTEGER)',
    'care_pathway_assert_task_sla_source_binding_pre_746(UUID, INTEGER)',
    'care_pathway_assert_task_sla_source_binding_pre_745(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_748(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_746(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_745(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_med03(UUID, INTEGER)'
  ];
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    FOREACH relation_name IN ARRAY mutable_relations
    LOOP
      IF pg_catalog.to_regclass(pg_catalog.format('public.%I', relation_name)) IS NOT NULL THEN
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
      END IF;
    END LOOP;

    IF pg_catalog.to_regclass('public.clinical_alert_delivery_obligations') IS NOT NULL THEN
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
    END IF;

    IF pg_catalog.to_regclass('public.clinical_alert_delivery_recovery_cases') IS NOT NULL THEN
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
    END IF;

    IF pg_catalog.to_regclass('public.clinical_alert_delivery_recovery_actions') IS NOT NULL THEN
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
    END IF;

    IF pg_catalog.to_regclass('public.pharmacy_counter_sale_void_requests') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.pharmacy_counter_sale_void_requests FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT INSERT (
           tenant_id, counter_sale_id, invoice_id, patient_uid, amount,
           refund_mode, disposition, reason, requested_by, requested_by_name,
           requested_by_role, command_key, request_fingerprint, status, task_stage
         ) ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT UPDATE (
           refund_id, status, task_stage, task_id, workflow_sla_instance_id,
           last_checked_at, reconciled_at, reconciled_by, reconciliation_source,
           rejection_resolved_at, rejection_resolved_by, rejection_resolution,
           rejection_resolution_reason, updated_at
         ) ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regclass('public.billing_refund_offline_electronic_evidence') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.billing_refund_offline_electronic_evidence FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT ON TABLE public.billing_refund_offline_electronic_evidence TO %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT INSERT (
           tenant_id, refund_id, original_payment_id, original_advance_id, mode,
           amount, provider_name, original_payment_reference,
           provider_refund_reference, provider_refunded_at, recorded_by
         ) ON TABLE public.billing_refund_offline_electronic_evidence TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regclass('public.billing_refunds') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.billing_refunds FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT ON TABLE public.billing_refunds TO %I',
        runtime_role
      );
      SELECT pg_catalog.string_agg(
               pg_catalog.quote_ident(allowed.column_name),
               ', ' ORDER BY allowed.ordinality
             )
        INTO column_list
        FROM pg_catalog.unnest(ARRAY[
          'patient_uid', 'invoice_id', 'advance_id', 'amount', 'reason',
          'mode', 'approval_status', 'raised_by', 'tenant_id',
          'counter_sale_void_request_id'
        ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
       WHERE EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = 'public.billing_refunds'::regclass
            AND attribute.attname = allowed.column_name
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       );
      IF column_list IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'GRANT INSERT (%s) ON TABLE public.billing_refunds TO %I',
          column_list,
          runtime_role
        );
      END IF;
      SELECT pg_catalog.string_agg(
               pg_catalog.quote_ident(allowed.column_name),
               ', ' ORDER BY allowed.ordinality
             )
        INTO column_list
        FROM pg_catalog.unnest(ARRAY[
          'reference', 'approval_status', 'approved_by', 'approved_at',
          'rejected_by', 'rejected_at', 'rejection_reason', 'paid_at',
          'paid_by', 'updated_at', 'payout_rail', 'payout_rail_claimed_at',
          'gateway_refund_id', 'cash_drawer_session_id',
          'offline_electronic_evidence_id'
        ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
       WHERE EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = 'public.billing_refunds'::regclass
            AND attribute.attname = allowed.column_name
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       );
      IF column_list IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'GRANT UPDATE (%s) ON TABLE public.billing_refunds TO %I',
          column_list,
          runtime_role
        );
      END IF;
    END IF;

    IF pg_catalog.to_regclass('public.cash_drawer_sessions') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.cash_drawer_sessions FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT ON TABLE public.cash_drawer_sessions TO %I',
        runtime_role
      );
      SELECT pg_catalog.string_agg(
               pg_catalog.quote_ident(allowed.column_name),
               ', ' ORDER BY allowed.ordinality
             )
        INTO column_list
        FROM pg_catalog.unnest(ARRAY[
          'tenant_id', 'cashier_uid', 'shift', 'opening_float'
        ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
       WHERE EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = 'public.cash_drawer_sessions'::regclass
            AND attribute.attname = allowed.column_name
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       );
      IF column_list IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'GRANT INSERT (%s) ON TABLE public.cash_drawer_sessions TO %I',
          column_list,
          runtime_role
        );
      END IF;
      SELECT pg_catalog.string_agg(
               pg_catalog.quote_ident(allowed.column_name),
               ', ' ORDER BY allowed.ordinality
             )
        INTO column_list
        FROM pg_catalog.unnest(ARRAY[
          'closed_at', 'counted_total', 'counted_denominations',
          'system_total', 'variance', 'short_count', 'over_count',
          'requires_review', 'variance_reason', 'status', 'reviewed_by',
          'reviewed_at', 'review_notes', 'updated_at', 'cash_inflow_total',
          'cash_refund_total'
        ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
       WHERE EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = 'public.cash_drawer_sessions'::regclass
            AND attribute.attname = allowed.column_name
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       );
      IF column_list IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'GRANT UPDATE (%s) ON TABLE public.cash_drawer_sessions TO %I',
          column_list,
          runtime_role
        );
      END IF;
    END IF;

    FOREACH relation_name IN ARRAY append_only_relations
    LOOP
      IF pg_catalog.to_regclass(pg_catalog.format('public.%I', relation_name)) IS NOT NULL THEN
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
      END IF;
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

    IF pg_catalog.to_regclass('public.clinical_alert_delivery_recovery_actions_id_seq') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public.clinical_alert_delivery_recovery_actions_id_seq FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT USAGE, SELECT ON SEQUENCE public.clinical_alert_delivery_recovery_actions_id_seq TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regclass('public.pharmacy_counter_sale_void_requests_id_seq') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public.pharmacy_counter_sale_void_requests_id_seq FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT USAGE, SELECT ON SEQUENCE public.pharmacy_counter_sale_void_requests_id_seq TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regclass('public.billing_refund_offline_electronic_evidence_id_seq') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public.billing_refund_offline_electronic_evidence_id_seq FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT USAGE, SELECT ON SEQUENCE public.billing_refund_offline_electronic_evidence_id_seq TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regclass('public.billing_refunds_id_seq') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public.billing_refunds_id_seq FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT USAGE, SELECT ON SEQUENCE public.billing_refunds_id_seq TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regclass('public.cash_drawer_sessions_id_seq') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public.cash_drawer_sessions_id_seq FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT USAGE, SELECT ON SEQUENCE public.cash_drawer_sessions_id_seq TO %I',
        runtime_role
      );
    END IF;

    FOREACH trigger_function_name IN ARRAY trigger_functions
    LOOP
      IF pg_catalog.to_regprocedure(
        pg_catalog.format('public.%I()', trigger_function_name)
      ) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',
          trigger_function_name,
          runtime_role
        );
      END IF;
    END LOOP;

    IF pg_catalog.to_regprocedure('public.counter_sale_void_has_paid_evidence(bigint)') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regprocedure(
      'public.mar_supply_batch_unavailable_reason(text,text,date,numeric,timestamp with time zone)'
    ) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) TO %I',
        runtime_role
      );
    END IF;

    IF pg_catalog.to_regprocedure('public.cath_inventory_shortfall_assert_contract(uuid,bigint)') IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) TO %I',
        runtime_role
      );
    END IF;
    FOREACH runtime_wrapper_function IN ARRAY runtime_wrapper_functions
    LOOP
      IF pg_catalog.to_regprocedure(
        pg_catalog.format('public.%s', runtime_wrapper_function)
      ) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM %I',
          runtime_wrapper_function,
          runtime_role
        );
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION public.%s TO %I',
          runtime_wrapper_function,
          runtime_role
        );
      END IF;
    END LOOP;
  END LOOP;
END
$med03_runtime_privileges$;

-- `_migrations` is owner-written bookkeeping. Reapply this fence after the
-- broad grants above so the application roles can verify readiness but cannot
-- forge, rewrite, delete, or allocate migration tracker rows.
REVOKE ALL PRIVILEGES ON TABLE public._migrations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public._migrations FROM vhhealth_app, vhhealth_runtime;
GRANT SELECT ON TABLE public._migrations TO vhhealth_app, vhhealth_runtime;
REVOKE ALL PRIVILEGES ON SEQUENCE public._migrations_id_seq FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE public._migrations_id_seq FROM vhhealth_app, vhhealth_runtime;
