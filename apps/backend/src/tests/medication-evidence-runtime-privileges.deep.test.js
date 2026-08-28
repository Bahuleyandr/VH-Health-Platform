import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const runtimeRoles = ['vhhealth_app', 'vhhealth_runtime'];
const primaryRuntimeRole = runtimeRoles[0];
const mutableTables = [
  'ward_indent_inventory_allocations',
  'billing_credit_notes',
  'mar_medication_exception_cases',
];
const appendOnlyTables = [
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
  'mar_medication_exception_events',
];
const counterSaleVoidInsertColumns = [
  'tenant_id',
  'counter_sale_id',
  'invoice_id',
  'patient_uid',
  'amount',
  'refund_mode',
  'disposition',
  'reason',
  'requested_by',
  'requested_by_name',
  'requested_by_role',
  'command_key',
  'request_fingerprint',
  'status',
  'task_stage',
];
const counterSaleVoidUpdateColumns = [
  'refund_id',
  'status',
  'task_stage',
  'task_id',
  'workflow_sla_instance_id',
  'last_checked_at',
  'reconciled_at',
  'reconciled_by',
  'reconciliation_source',
  'rejection_resolved_at',
  'rejection_resolved_by',
  'rejection_resolution',
  'rejection_resolution_reason',
  'updated_at',
];
const offlineRefundEvidenceInsertColumns = [
  'tenant_id',
  'refund_id',
  'original_payment_id',
  'original_advance_id',
  'mode',
  'amount',
  'provider_name',
  'original_payment_reference',
  'provider_refund_reference',
  'provider_refunded_at',
  'recorded_by',
];
const billingRefundInsertColumns = [
  'patient_uid',
  'invoice_id',
  'advance_id',
  'amount',
  'reason',
  'mode',
  'approval_status',
  'raised_by',
  'tenant_id',
  'counter_sale_void_request_id',
];
const billingRefundUpdateColumns = [
  'reference',
  'approval_status',
  'approved_by',
  'approved_at',
  'rejected_by',
  'rejected_at',
  'rejection_reason',
  'paid_at',
  'paid_by',
  'updated_at',
  'payout_rail',
  'payout_rail_claimed_at',
  'gateway_refund_id',
  'cash_drawer_session_id',
  'offline_electronic_evidence_id',
];
const cashDrawerInsertColumns = [
  'tenant_id',
  'cashier_uid',
  'shift',
  'opening_float',
];
const cashDrawerUpdateColumns = [
  'closed_at',
  'counted_total',
  'counted_denominations',
  'system_total',
  'variance',
  'short_count',
  'over_count',
  'requires_review',
  'variance_reason',
  'status',
  'reviewed_by',
  'reviewed_at',
  'review_notes',
  'updated_at',
  'cash_inflow_total',
  'cash_refund_total',
];
const med03RestrictedTriggerFunctions = [
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
  'mar_medication_exception_case_guard',
  'mar_medication_exception_case_receipt_guard',
  'mar_medication_exception_claim_comment_guard',
  'mar_medication_exception_assignee_viability_guard',
  'mar_medication_exception_tasks_sync_workflow_sla_compat',
  'clinical_alert_delivery_obligation_guard',
  'clinical_alert_delivery_recovery_case_guard',
  'clinical_alert_delivery_recovery_action_guard',
  'clinical_alert_delivery_recovery_task_sync',
  'clinical_alert_delivery_recovery_task_case_constraint',
  'clinical_alert_delivery_recovery_obligation_constraint',
  'clinical_alert_delivery_recovery_claim_comment_guard',
  'clinical_alert_delivery_recovery_assignee_viability_guard',
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
  'cath_inventory_shortfall_contract_constraint',
];
const med03RestrictedFunctionSignatures = [
  ...med03RestrictedTriggerFunctions.map((name) => `public.${name}()`),
];
const med03RuntimeWrapperFunctionSignatures = [
  'public.care_pathway_assert_task_sla_source_binding(uuid,integer)',
  'public.care_pathway_assert_task_sla_source_binding_pre_748(uuid,integer)',
  'public.care_pathway_assert_task_sla_source_binding_pre_746(uuid,integer)',
  'public.care_pathway_assert_task_sla_source_binding_pre_745(uuid,integer)',
  'public.care_pathway_assert_task_sla_completion_receipt(uuid,integer)',
  'public.care_pathway_assert_task_sla_completion_receipt_pre_748(uuid,integer)',
  'public.care_pathway_assert_task_sla_completion_receipt_pre_746(uuid,integer)',
  'public.care_pathway_assert_task_sla_completion_receipt_pre_745(uuid,integer)',
  'public.care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(uuid,integer)',
  'public.care_pathway_assert_task_sla_completion_receipt_pre_med03(uuid,integer)',
];
const med03RuntimeAssertionFunctionSignatures = [
  ...med03RuntimeWrapperFunctionSignatures,
  'public.mar_supply_batch_unavailable_reason(text,text,date,numeric,timestamp with time zone)',
  'public.cath_inventory_shortfall_assert_contract(uuid,bigint)',
];

async function asRuntimeRole(role, sql, params = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(sql, params);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

describe('MED-03 DalekDefender runtime privilege bootstrap', () => {
  const runtimeBootstrapSource = ensureTenantRlsRuntimeRoleGrants.toString();
  const source = readFileSync(
    new URL('../../../../infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql', import.meta.url),
    'utf8',
  );
  const med03Block = source.match(
    /-- MED-03 medication evidence[\s\S]+?\$med03_runtime_privileges\$;/,
  )?.[0];

  test('re-narrows both runtime roles after broad grants', () => {
    expect(med03Block).toContain(
      "ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]",
    );
    expect(med03Block).toContain(
      "'GRANT SELECT, INSERT ON TABLE public.%I TO %I'",
    );
    expect(med03Block).toContain(
      "'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I'",
    );
    expect(med03Block).toContain(
      "'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I'",
    );
  });

  test.each(appendOnlyTables)('%s is included in the overlay fence', (table) => {
    expect(med03Block).toContain(`'${table}'`);
  });

  test.each(mutableTables)('%s is included in the overlay fence', (table) => {
    expect(med03Block).toContain(`'${table}'`);
  });

  test.each([
    'pharmacy_counter_sale_void_requests',
    'billing_refund_offline_electronic_evidence',
    'billing_refunds',
    'cash_drawer_sessions',
  ])('%s has a column-scoped overlay fence', (table) => {
    expect(med03Block).toContain(
      `REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM %I`,
    );
    expect(med03Block).toContain(`GRANT SELECT ON TABLE public.${table} TO %I`);
  });

  test.each(med03RestrictedTriggerFunctions)(
    '%s is included in the overlay function fence',
    (functionName) => {
      expect(med03Block).toContain(`'${functionName}'`);
      expect(runtimeBootstrapSource).toContain(`'${functionName}'`);
    },
  );

  test('keeps only required assertion helpers executable by runtime roles', () => {
    expect(med03Block).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) FROM %I',
    );
    expect(med03Block).toContain(
      'GRANT EXECUTE ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) TO %I',
    );
    expect(med03Block).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) FROM %I',
    );
    expect(med03Block).toContain(
      'GRANT EXECUTE ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) TO %I',
    );
    expect(runtimeBootstrapSource).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) FROM %I',
    );
    expect(runtimeBootstrapSource).toContain(
      'GRANT EXECUTE ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) TO %I',
    );
    expect(med03Block).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) FROM %I',
    );
    expect(med03Block).toContain(
      'GRANT EXECUTE ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) TO %I',
    );
    expect(med03Block).toContain(
      "'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM %I'",
    );
    expect(med03Block).toContain(
      "'GRANT EXECUTE ON FUNCTION public.%s TO %I'",
    );
    for (const signature of med03RuntimeWrapperFunctionSignatures) {
      const functionName = signature.slice('public.'.length, signature.indexOf('('));
      expect(med03Block).toContain(`'${functionName}(UUID, INTEGER)'`);
    }
  });
});

describeIfDb('MED-03 medication evidence runtime privileges', () => {
  const runtimeRole = primaryRuntimeRole;
  let previousRuntimeRole;
  let hasPayoutClosureSchema = false;

  beforeAll(async () => {
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    for (const role of runtimeRoles) {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
      await ensureTenantRlsRuntimeRoleGrants();
    }
    const closureSchema = await prisma.$queryRawUnsafe(
      `SELECT pg_catalog.to_regclass('public.pharmacy_counter_sale_void_requests') IS NOT NULL
                AS has_void_requests,
              pg_catalog.to_regclass('public.billing_refund_offline_electronic_evidence') IS NOT NULL
                AS has_offline_evidence`,
    );
    hasPayoutClosureSchema = Boolean(
      closureSchema[0]?.has_void_requests && closureSchema[0]?.has_offline_evidence,
    );
  });

  afterAll(async () => {
    if (previousRuntimeRole === undefined) {
      delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    } else {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }
    await prisma.$disconnect().catch(() => {});
  });

  test.each(appendOnlyTables)(
    '%s remains SELECT+INSERT only after the broad boot grant',
    async (table) => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1::name, $2::text, 'SELECT') AS can_select,
                has_table_privilege($1::name, $2::text, 'INSERT') AS can_insert,
                has_table_privilege($1::name, $2::text, 'UPDATE') AS can_update,
                has_table_privilege($1::name, $2::text, 'DELETE') AS can_delete,
                has_table_privilege($1::name, $2::text, 'TRUNCATE') AS can_truncate`,
        runtimeRole,
        `public.${table}`,
      );
      expect(rows[0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        can_truncate: false,
      });
    },
  );

  test.each(mutableTables)(
    '%s remains SELECT+INSERT+UPDATE only after the broad boot grant',
    async (table) => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1::name, $2::text, 'SELECT') AS can_select,
                has_table_privilege($1::name, $2::text, 'INSERT') AS can_insert,
                has_table_privilege($1::name, $2::text, 'UPDATE') AS can_update,
                has_table_privilege($1::name, $2::text, 'DELETE') AS can_delete,
                has_table_privilege($1::name, $2::text, 'TRUNCATE') AS can_truncate`,
        runtimeRole,
        `public.${table}`,
      );
      expect(rows[0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: false,
        can_truncate: false,
      });
    },
  );

  test.each([...mutableTables, ...appendOnlyTables])(
    '%s identity sequence cannot be advanced by the runtime role',
    async (table) => {
      const sequence = `public.${table}_id_seq`;
      const existence = await prisma.$queryRawUnsafe(
        `SELECT to_regclass($1::text)::text AS sequence_name`,
        sequence,
      );
      if (!existence[0]?.sequence_name) return;
      const rows = await prisma.$queryRawUnsafe(
        `SELECT has_sequence_privilege($1::name, $2::text, 'USAGE') AS can_use,
                has_sequence_privilege($1::name, $2::text, 'SELECT') AS can_select,
                has_sequence_privilege($1::name, $2::text, 'UPDATE') AS can_update`,
        runtimeRole,
        sequence,
      );
      expect(rows[0]).toEqual({
        can_use: true,
        can_select: true,
        can_update: false,
      });
    },
  );

  test('trigger helpers cannot be invoked directly by the runtime role', async () => {
    const functions = [
      'medication_evidence_append_only_guard',
      'ward_indent_inventory_allocation_guard',
      'ward_indent_apply_inventory_movement_link',
      'ward_indent_apply_inventory_receipt_event',
      'ward_indent_inventory_workflow_event_validate',
      'ward_indent_inventory_allocation_evidence_validate',
      'billing_credit_note_event_state_validate',
      'mar_medication_exception_case_guard',
      'mar_medication_exception_case_receipt_guard',
      'mar_medication_exception_tasks_sync_workflow_sla_compat',
    ];
    const rows = await prisma.$queryRawUnsafe(
      `SELECT function_name,
              has_function_privilege(
                $1::name,
                pg_catalog.format('public.%I()', function_name),
                'EXECUTE'
              ) AS can_execute
         FROM unnest($2::text[]) AS function_name
        ORDER BY function_name`,
      runtimeRole,
      functions,
    );
    expect(rows).toHaveLength(functions.length);
    expect(rows.every((row) => row.can_execute === false)).toBe(true);
  });

  test('runtime grant reconciliation is idempotent for both production roles', async () => {
    for (const role of runtimeRoles) {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
      await ensureTenantRlsRuntimeRoleGrants();
      await ensureTenantRlsRuntimeRoleGrants();
    }
  });

  test.each(runtimeRoles)(
    '%s keeps counter-sale void requests column-scoped after startup reconciliation',
    async (role) => {
      if (!hasPayoutClosureSchema) return;
      const tablePrivileges = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1::name, 'public.pharmacy_counter_sale_void_requests', 'SELECT') AS can_select,
                has_table_privilege($1::name, 'public.pharmacy_counter_sale_void_requests', 'INSERT') AS table_insert,
                has_table_privilege($1::name, 'public.pharmacy_counter_sale_void_requests', 'UPDATE') AS table_update,
                has_table_privilege($1::name, 'public.pharmacy_counter_sale_void_requests', 'DELETE') AS can_delete,
                has_table_privilege($1::name, 'public.pharmacy_counter_sale_void_requests', 'TRUNCATE') AS can_truncate`,
        role,
      );
      expect(tablePrivileges[0]).toEqual({
        can_select: true,
        table_insert: false,
        table_update: false,
        can_delete: false,
        can_truncate: false,
      });

      const columns = await prisma.$queryRawUnsafe(
        `SELECT attr.attname AS column_name,
                has_column_privilege($1::name, 'public.pharmacy_counter_sale_void_requests', attr.attname, 'INSERT') AS can_insert,
                has_column_privilege($1::name, 'public.pharmacy_counter_sale_void_requests', attr.attname, 'UPDATE') AS can_update
           FROM pg_catalog.pg_attribute attr
          WHERE attr.attrelid = 'public.pharmacy_counter_sale_void_requests'::regclass
            AND attr.attnum > 0
            AND NOT attr.attisdropped
          ORDER BY attr.attnum`,
        role,
      );
      expect(columns.filter((row) => row.can_insert).map((row) => row.column_name)).toEqual(
        counterSaleVoidInsertColumns,
      );
      expect(columns.filter((row) => row.can_update).map((row) => row.column_name)).toEqual(
        counterSaleVoidUpdateColumns,
      );
    },
  );

  test.each(runtimeRoles)(
    '%s keeps offline electronic refund evidence append-only and column-scoped',
    async (role) => {
      if (!hasPayoutClosureSchema) return;
      const tablePrivileges = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1::name, 'public.billing_refund_offline_electronic_evidence', 'SELECT') AS can_select,
                has_table_privilege($1::name, 'public.billing_refund_offline_electronic_evidence', 'INSERT') AS table_insert,
                has_table_privilege($1::name, 'public.billing_refund_offline_electronic_evidence', 'UPDATE') AS table_update,
                has_table_privilege($1::name, 'public.billing_refund_offline_electronic_evidence', 'DELETE') AS can_delete,
                has_table_privilege($1::name, 'public.billing_refund_offline_electronic_evidence', 'TRUNCATE') AS can_truncate`,
        role,
      );
      expect(tablePrivileges[0]).toEqual({
        can_select: true,
        table_insert: false,
        table_update: false,
        can_delete: false,
        can_truncate: false,
      });

      const columns = await prisma.$queryRawUnsafe(
        `SELECT attr.attname AS column_name,
                has_column_privilege($1::name, 'public.billing_refund_offline_electronic_evidence', attr.attname, 'INSERT') AS can_insert,
                has_column_privilege($1::name, 'public.billing_refund_offline_electronic_evidence', attr.attname, 'UPDATE') AS can_update
           FROM pg_catalog.pg_attribute attr
          WHERE attr.attrelid = 'public.billing_refund_offline_electronic_evidence'::regclass
            AND attr.attnum > 0
            AND NOT attr.attisdropped
          ORDER BY attr.attnum`,
        role,
      );
      expect(columns.filter((row) => row.can_insert).map((row) => row.column_name)).toEqual(
        offlineRefundEvidenceInsertColumns,
      );
      expect(columns.some((row) => row.can_update)).toBe(false);
    },
  );

  test.each([
    ['billing_refunds', billingRefundInsertColumns, billingRefundUpdateColumns],
    ['cash_drawer_sessions', cashDrawerInsertColumns, cashDrawerUpdateColumns],
  ])('%s keeps finance lifecycle writes column-scoped for both runtime roles', async (
    table,
    expectedInsertColumns,
    expectedUpdateColumns,
  ) => {
    if (!hasPayoutClosureSchema) return;
    for (const role of runtimeRoles) {
      const tablePrivileges = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1::name, $2::text, 'SELECT') AS can_select,
                has_table_privilege($1::name, $2::text, 'INSERT') AS table_insert,
                has_table_privilege($1::name, $2::text, 'UPDATE') AS table_update,
                has_table_privilege($1::name, $2::text, 'DELETE') AS can_delete,
                has_table_privilege($1::name, $2::text, 'TRUNCATE') AS can_truncate,
                has_table_privilege($1::name, $2::text, 'REFERENCES') AS can_reference,
                has_table_privilege($1::name, $2::text, 'TRIGGER') AS can_trigger`,
        role,
        `public.${table}`,
      );
      expect(tablePrivileges[0]).toEqual({
        can_select: true,
        table_insert: false,
        table_update: false,
        can_delete: false,
        can_truncate: false,
        can_reference: false,
        can_trigger: false,
      });

      const columns = await prisma.$queryRawUnsafe(
        `SELECT attr.attname AS column_name,
                has_column_privilege($1::name, $2::text, attr.attname, 'INSERT') AS can_insert,
                has_column_privilege($1::name, $2::text, attr.attname, 'UPDATE') AS can_update
           FROM pg_catalog.pg_attribute attr
          WHERE attr.attrelid = $2::regclass
            AND attr.attnum > 0
            AND NOT attr.attisdropped
          ORDER BY attr.attnum`,
        role,
        `public.${table}`,
      );
      expect(columns.filter((row) => row.can_insert).map((row) => row.column_name)).toEqual(
        expectedInsertColumns,
      );
      expect(columns.filter((row) => row.can_update).map((row) => row.column_name)).toEqual(
        expectedUpdateColumns,
      );
      await expect(asRuntimeRole(
        role,
        `INSERT INTO ${table} (${expectedInsertColumns.join(', ')})
         SELECT ${expectedInsertColumns.map(() => 'NULL').join(', ')} WHERE FALSE`,
      )).resolves.toBeDefined();
      await expect(asRuntimeRole(
        role,
        `UPDATE ${table} SET ${expectedUpdateColumns.map((column) => `${column} = ${column}`).join(', ')} WHERE FALSE`,
      )).resolves.toBeDefined();
    }
  });

  test.each(runtimeRoles)(
    '%s cannot advance MED-03 workflow evidence sequences',
    async (role) => {
      if (!hasPayoutClosureSchema) return;
      for (const sequence of [
        'public.pharmacy_counter_sale_void_requests_id_seq',
        'public.billing_refund_offline_electronic_evidence_id_seq',
        'public.billing_refunds_id_seq',
        'public.cash_drawer_sessions_id_seq',
      ]) {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT has_sequence_privilege($1::name, $2::text, 'USAGE') AS can_use,
                  has_sequence_privilege($1::name, $2::text, 'SELECT') AS can_select,
                  has_sequence_privilege($1::name, $2::text, 'UPDATE') AS can_update`,
          role,
          sequence,
        );
        expect(rows[0]).toEqual({ can_use: true, can_select: true, can_update: false });
      }
    },
  );

  test.each(runtimeRoles)(
    '%s cannot invoke MED-03 trigger helpers directly',
    async (role) => {
      if (!hasPayoutClosureSchema) return;
      const signatures = med03RestrictedFunctionSignatures;
      const rows = await prisma.$queryRawUnsafe(
        `SELECT signature,
                has_function_privilege($1::name, signature, 'EXECUTE') AS can_execute
           FROM unnest($2::text[]) AS signature
          ORDER BY signature`,
        role,
        signatures,
      );
      expect(rows).toHaveLength(signatures.length);
      expect(rows.every((row) => row.can_execute === false)).toBe(true);

      const paidEvidence = await prisma.$queryRawUnsafe(
        `SELECT has_function_privilege(
                  $1::name,
                  'public.counter_sale_void_has_paid_evidence(bigint)',
                  'EXECUTE'
                ) AS can_execute`,
        role,
      );
      expect(paidEvidence[0]?.can_execute).toBe(true);
      for (const signature of med03RuntimeAssertionFunctionSignatures) {
        const assertionHelper = await prisma.$queryRawUnsafe(
          `SELECT has_function_privilege($1::name, $2::text, 'EXECUTE') AS can_execute`,
          role,
          signature,
        );
        expect(assertionHelper[0]?.can_execute).toBe(true);
      }
    },
  );

  test('PUBLIC cannot invoke any MED-03 helper', async () => {
    if (!hasPayoutClosureSchema) return;
    const signatures = [
      ...med03RestrictedFunctionSignatures,
      ...med03RuntimeAssertionFunctionSignatures,
      'public.counter_sale_void_has_paid_evidence(bigint)',
    ];
    const rows = await prisma.$queryRawUnsafe(
      `SELECT signature,
              EXISTS (
                SELECT 1
                  FROM pg_catalog.pg_proc proc
                  CROSS JOIN LATERAL pg_catalog.aclexplode(
                    COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
                  ) privilege
                 WHERE proc.oid = pg_catalog.to_regprocedure(signature)
                   AND privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
              ) AS public_execute
         FROM unnest($1::text[]) AS signature
        ORDER BY signature`,
      signatures,
    );
    expect(rows).toHaveLength(signatures.length);
    expect(rows.every((row) => row.public_execute === false)).toBe(true);
  });

  test.each(runtimeRoles)(
    '%s traverses the complete source/completion predecessor chain for an unrelated task',
    async (role) => {
      const tenantId = '00000000-0000-4000-8000-000000000001';
      const [task] = await prisma.$queryRawUnsafe(
        `INSERT INTO tasks (tenant_id, task_kind, title, metadata)
         VALUES ($1::uuid, 'general', 'MED-03 runtime predecessor probe', '{}'::jsonb)
         RETURNING id`,
        tenantId,
      );
      try {
        await expect(asRuntimeRole(
          role,
          `SELECT set_config('app.current_tenant_id', '${tenantId}', true);
           SELECT public.care_pathway_assert_task_sla_source_binding(
                    '${tenantId}'::uuid,
                    ${Number(task.id)}::integer
                  );
           SELECT public.care_pathway_assert_task_sla_completion_receipt(
                    '${tenantId}'::uuid,
                    ${Number(task.id)}::integer
                  );`,
        )).resolves.toBeDefined();
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM tasks WHERE tenant_id = $1::uuid AND id = $2::int`,
          tenantId,
          task.id,
        );
      }
    },
  );

  test.each(runtimeRoles)(
    '%s receives 42501 for forbidden workflow-evidence DML and setval',
    async (role) => {
      if (!hasPayoutClosureSchema) return;
      const forbiddenStatements = [
        `INSERT INTO pharmacy_counter_sale_void_requests (id) VALUES (1)`,
        `INSERT INTO pharmacy_counter_sale_void_requests (requested_at) VALUES (NOW())`,
        `INSERT INTO pharmacy_counter_sale_void_requests (created_at) VALUES (NOW())`,
        `UPDATE pharmacy_counter_sale_void_requests SET id = id WHERE FALSE`,
        `UPDATE pharmacy_counter_sale_void_requests SET created_at = created_at WHERE FALSE`,
        `DELETE FROM pharmacy_counter_sale_void_requests WHERE FALSE`,
        `TRUNCATE pharmacy_counter_sale_void_requests`,
        `INSERT INTO billing_refund_offline_electronic_evidence (id) VALUES (1)`,
        `INSERT INTO billing_refund_offline_electronic_evidence (recorded_at) VALUES (NOW())`,
        `UPDATE billing_refund_offline_electronic_evidence SET id = id WHERE FALSE`,
        `DELETE FROM billing_refund_offline_electronic_evidence WHERE FALSE`,
        `TRUNCATE billing_refund_offline_electronic_evidence`,
        `INSERT INTO billing_refunds (id) VALUES (1)`,
        `INSERT INTO billing_refunds (created_at) VALUES (NOW())`,
        `UPDATE billing_refunds SET amount = amount WHERE FALSE`,
        `UPDATE billing_refunds SET patient_uid = patient_uid WHERE FALSE`,
        `DELETE FROM billing_refunds WHERE FALSE`,
        `TRUNCATE billing_refunds`,
        `INSERT INTO cash_drawer_sessions (id) VALUES (1)`,
        `INSERT INTO cash_drawer_sessions (opened_at) VALUES (NOW())`,
        `UPDATE cash_drawer_sessions SET cashier_uid = cashier_uid WHERE FALSE`,
        `UPDATE cash_drawer_sessions SET opening_float = opening_float WHERE FALSE`,
        `DELETE FROM cash_drawer_sessions WHERE FALSE`,
        `TRUNCATE cash_drawer_sessions`,
        `SELECT setval('pharmacy_counter_sale_void_requests_id_seq', 1, FALSE)`,
        `SELECT setval('billing_refund_offline_electronic_evidence_id_seq', 1, FALSE)`,
        `SELECT setval('billing_refunds_id_seq', 1, FALSE)`,
        `SELECT setval('cash_drawer_sessions_id_seq', 1, FALSE)`,
      ];
      for (const sql of forbiddenStatements) {
        await expect(asRuntimeRole(role, sql)).rejects.toMatchObject({ code: '42501' });
      }
    },
  );
});
