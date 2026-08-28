import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';
import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reserveWardIndent,
} from '../services/ipd/ipdSupportService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

async function expectSqlState(operation, expected) {
  try {
    await operation();
  } catch (error) {
    const sqlState = error?.meta?.code
      || error?.meta?.driverAdapterError?.cause?.code
      || error?.meta?.driverAdapterError?.cause?.originalCode
      || error?.code;
    if (sqlState) {
      expect(sqlState).toBe(expected);
    } else {
      const detail = [
        error?.message,
        error?.meta?.driverAdapterError?.cause?.message,
        error?.meta?.driverAdapterError?.cause?.originalMessage,
      ].filter(Boolean).join(' ');
      expect(detail).toContain(expected);
    }
    return;
  }
  throw new Error(`Expected SQLSTATE ${expected}`);
}

async function expectPgSqlState(operation, expected) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await operation(client);
  } catch (error) {
    const expectedCodes = Array.isArray(expected) ? expected : [expected];
    if (!expectedCodes.includes(error?.code)) {
      throw new Error(
        `Expected SQLSTATE ${expectedCodes.join(' or ')}, got ${error?.code}: `
          + `${error?.message}; context=${error?.where || 'none'}`,
      );
    }
    return;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
  throw new Error(`Expected SQLSTATE ${expected}`);
}

async function pgStep(client, label, sql, params = []) {
  try {
    return await client.query(sql, params);
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

describeIfDb('MED-03 medication evidence invariants', () => {
  const tenantId = randomUUID();
  const requester = randomUUID();
  const pharmacist = randomUUID();
  const receiver = randomUUID();
  const patient = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  let wardId;
  let catalogId;
  let indent;
  let issued;

  beforeAll(async () => {
    const previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
    try {
      const grants = await ensureTenantRlsRuntimeRoleGrants();
      if (grants.skipped || grants.error) {
        throw new Error(grants.error || `Runtime role grant pass skipped: ${grants.reason}`);
      }
    } finally {
      if (previousRuntimeRole === undefined) {
        delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      } else {
        process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
      }
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MED-03 Evidence Invariants', 'IN', 'active', NOW(), NOW())`,
      tenantId,
      `med03-evidence-${run}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $5::uuid, 'Request Nurse', 'IP_STAFF_NURSE', TRUE, 'active', NOW()),
         ($2::uuid, $5::uuid, 'Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($3::uuid, $5::uuid, 'Receipt Nurse', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($4::uuid, $5::uuid, 'Patient', 'PATIENT', TRUE, 'active', NOW())`,
      requester,
      pharmacist,
      receiver,
      patient,
      tenantId,
    );
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 10, NOW(), NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Evidence Ward ${run}`,
    ))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, 10, 12.50, 12.50, NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Evidence Medicine ${run}`,
    ))[0].id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, unit_label,
          schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, 'unit', 'OTC', FALSE)
       RETURNING id`,
      tenantId,
      `MED03-EVIDENCE-${run}`,
      `MED-03 Evidence Medicine ${run}`,
      catalogId,
    ))[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::text,
               (NOW() + INTERVAL '365 days')::date, 10, 10, 'in_stock')`,
      tenantId,
      inventoryItemId,
      `MED03-EVIDENCE-BATCH-${run}`,
    );

    indent = await createWardIndent({
      wardId,
      patientUid: patient,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        item_name: 'Caller text is not authoritative',
        quantity_requested: 2,
      }],
      requestedBy: requester,
      commandKey: `evidence-create-${run}`,
      tenantId,
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: pharmacist,
      expectedVersion: 1,
      commandKey: `evidence-reserve-${run}`,
      tenantId,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: pharmacist,
      expectedVersion: reserved.state_version,
      commandKey: `evidence-approve-${run}`,
      tenantId,
    });
    issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: pharmacist,
      expectedVersion: approved.state_version,
      commandKey: `evidence-issue-${run}`,
      tenantId,
    });
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const table of [
        'idempotency_keys',
        'task_comments',
        'tasks',
        'notification_outbox',
        'workflow_sla_instances',
        'billing_credit_note_events',
        'billing_credit_notes',
        'billing_refunds',
        'ward_indent_financial_events',
        'ward_indent_inventory_receipt_events',
        'ward_indent_inventory_movement_links',
        'ward_indent_inventory_allocations',
        'ward_indent_events',
        'clinical_timeline_events',
        'clinical_audit_events',
        'billing_payments',
        'billing_invoice_items',
        'billing_invoices',
        'pharmacy_schedule_register',
        'pharmacy_stock_movements',
        'pharmacy_inventory_batches',
        'pharmacy_inventory_items',
        'ward_indent_items',
        'ward_indents',
        'pharmacy_catalog',
        'wards',
        'audit_logs',
        'users',
      ]) {
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'origin'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
    }, { timeout: 30_000 });
    await prisma.$disconnect().catch(() => {});
  }, 30_000);

  test('rejects direct evidence rewrites, projection tampering, and mismatched links', async () => {
    const allocation = (await prisma.$queryRawUnsafe(
      `SELECT allocation.*, link.stock_movement_id
         FROM ward_indent_inventory_allocations allocation
         JOIN ward_indent_inventory_movement_links link
           ON link.tenant_id = allocation.tenant_id
          AND link.allocation_id = allocation.id
          AND link.movement_purpose = 'issue'
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int`,
      tenantId,
      Number(indent.id),
    ))[0];
    expect(Number(allocation.issued_quantity)).toBe(2);
    expect(Number(allocation.received_quantity)).toBe(0);

    await expectPgSqlState(
      async (client) => {
        await pgStep(client, 'begin', 'BEGIN');
        await pgStep(client, 'set runtime role', 'SET LOCAL ROLE vhhealth_app');
        await pgStep(
          client,
          'set tenant context',
          `SELECT set_config('app.current_tenant_id', $1::text, TRUE)`,
          [tenantId],
        );
        await pgStep(
          client,
          'create allocation shadow',
          `CREATE TEMP TABLE ward_indent_inventory_allocations
             (LIKE public.ward_indent_inventory_allocations INCLUDING DEFAULTS)`,
        );
        await pgStep(
          client,
          'create movement shadow',
          `CREATE TEMP TABLE pharmacy_stock_movements
             (LIKE public.pharmacy_stock_movements INCLUDING DEFAULTS)`,
        );
        await pgStep(
          client,
          'copy allocation shadow',
          `INSERT INTO pg_temp.ward_indent_inventory_allocations
           SELECT * FROM public.ward_indent_inventory_allocations
            WHERE tenant_id = $1::uuid AND id = $2::bigint`,
          [tenantId, allocation.id],
        );
        await pgStep(
          client,
          'prime allocation shadow',
          `UPDATE pg_temp.ward_indent_inventory_allocations
              SET received_quantity = issued_quantity
            WHERE tenant_id = $1::uuid AND id = $2::bigint`,
          [tenantId, allocation.id],
        );
        const shadowMovement = (await pgStep(
          client,
          'insert real movement',
          `INSERT INTO public.pharmacy_stock_movements
             (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
              quantity_delta, reference_type, reference_id, performed_by, notes)
           SELECT tenant_id, inventory_item_id, inventory_batch_id, 'issue',
                  -0.25, 'ward_indent_return_allocation', id::text,
                  $3::uuid, 'pg_temp shadow bypass regression'
             FROM public.ward_indent_inventory_allocations
            WHERE tenant_id = $1::uuid AND id = $2::bigint
           RETURNING id`,
          [tenantId, allocation.id, receiver],
        )).rows[0];
        await pgStep(
          client,
          'copy movement shadow',
          `INSERT INTO pg_temp.pharmacy_stock_movements
           SELECT * FROM public.pharmacy_stock_movements
            WHERE tenant_id = $1::uuid AND id = $2::int`,
          [tenantId, shadowMovement.id],
        );
        await pgStep(
          client,
          'prime movement shadow',
          `UPDATE pg_temp.pharmacy_stock_movements
              SET movement_kind = 'return', quantity_delta = 0.25
            WHERE tenant_id = $1::uuid AND id = $2::int`,
          [tenantId, shadowMovement.id],
        );
        await pgStep(
          client,
          'insert public movement link',
          `INSERT INTO public.ward_indent_inventory_movement_links
             (tenant_id, allocation_id, stock_movement_id, controlled_register_id,
              movement_purpose, quantity, ward_indent_state_version,
              command_key, linked_by)
           VALUES ($1::uuid, $2::bigint, $3::int, NULL,
                   'return', 0.25, $4::int, $5::text, $6::uuid)`,
          [
            tenantId,
            allocation.id,
            shadowMovement.id,
            Number(issued.state_version) + 1,
            `pg-temp-shadow-${run}`,
            receiver,
          ],
        );
      },
      '23514',
    );

    await expectSqlState(
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.audit_bypass = 'on'`);
        await tx.$executeRawUnsafe(
          `UPDATE ward_indent_inventory_movement_links
              SET quantity = quantity
            WHERE tenant_id = $1::uuid AND allocation_id = $2::bigint`,
          tenantId,
          allocation.id,
        );
      }),
      '55000',
    );
    await expectSqlState(
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.audit_bypass = 'on'`);
        await tx.$executeRawUnsafe(
          `UPDATE ward_indent_events
              SET action = action
            WHERE tenant_id = $1::uuid
              AND ward_indent_id = $2::int
              AND state_version = $3::int`,
          tenantId,
          Number(indent.id),
          Number(issued.state_version),
        );
      }),
      '55000',
    );
    await expectSqlState(
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.audit_bypass = 'on'`);
        await tx.$executeRawUnsafe(
          `DELETE FROM pharmacy_stock_movements
            WHERE tenant_id = $1::uuid AND id = $2::bigint`,
          tenantId,
          allocation.stock_movement_id,
        );
      }),
      '55000',
    );
    await expectSqlState(
      () => prisma.$executeRawUnsafe(
        `UPDATE ward_indent_inventory_allocations
            SET reservation_key = reservation_key || ':tampered'
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        tenantId,
        allocation.id,
      ),
      '23514',
    );
    await expectPgSqlState(
      async (client) => {
        await client.query('BEGIN');
        await client.query(
          `UPDATE ward_indent_inventory_allocations
              SET received_quantity = 1
            WHERE tenant_id = $1::uuid AND id = $2::bigint`,
          [tenantId, allocation.id],
        );
        await client.query('COMMIT');
      },
      '23514',
    );
    await expectSqlState(
      () => prisma.$executeRawUnsafe(
        `INSERT INTO ward_indent_inventory_movement_links
           (tenant_id, allocation_id, stock_movement_id, controlled_register_id,
            movement_purpose, quantity)
         VALUES ($1::uuid, $2::bigint, $3::bigint, NULL, 'return', 2)`,
        tenantId,
        allocation.id,
        allocation.stock_movement_id,
      ),
      '23514',
    );
    await expectSqlState(
      () => prisma.$executeRawUnsafe(
        `INSERT INTO ward_indent_inventory_movement_links
           (tenant_id, allocation_id, stock_movement_id, controlled_register_id,
            movement_purpose, quantity)
         VALUES ($1::uuid, $2::bigint, $3::bigint, 1, 'issue', 2)`,
        tenantId,
        allocation.id,
        allocation.stock_movement_id,
      ),
      '23514',
    );

    await expectPgSqlState(
      async (client) => {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ward_indent_inventory_receipt_events
             (tenant_id, inventory_allocation_id, ward_indent_id,
              ward_indent_item_id, inventory_batch_id, ward_indent_state_version,
              quantity_delta, command_key, received_by)
           VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::int, $6::int,
                   1, $7::text, $8::uuid)`,
          [
            tenantId,
            allocation.id,
            Number(indent.id),
            Number(allocation.ward_indent_item_id),
            Number(allocation.inventory_batch_id),
            Number(issued.state_version) + 1,
            `missing-receipt-transition-${run}`,
            receiver,
          ],
        );
        await client.query('COMMIT');
      },
      ['23503', '23514'],
    );
    await expectPgSqlState(
      async (client) => {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ward_indent_events
             (tenant_id, ward_indent_id, state_version, action, from_status,
              to_status, actor_uid, owner_role_codes, command_key, details)
           VALUES ($1::uuid, $2::int, $3::int, 'receipt_recorded', 'issued',
                   'partially_received', $4::uuid, ARRAY['NURSING_INCHARGE'],
                   $5::text, '{}'::jsonb)`,
          [
            tenantId,
            Number(indent.id),
            Number(issued.state_version) + 1,
            receiver,
            `forged-future-receipt-event-${run}`,
          ],
        );
        await client.query(
          `INSERT INTO ward_indent_inventory_receipt_events
             (tenant_id, inventory_allocation_id, ward_indent_id,
              ward_indent_item_id, inventory_batch_id, ward_indent_state_version,
              quantity_delta, command_key, received_by)
           VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::int, $6::int,
                   1, $7::text, $8::uuid)`,
          [
            tenantId,
            allocation.id,
            Number(indent.id),
            Number(allocation.ward_indent_item_id),
            Number(allocation.inventory_batch_id),
            Number(issued.state_version) + 1,
            `forged-future-receipt-${run}`,
            receiver,
          ],
        );
        await client.query('COMMIT');
      },
      '23514',
    );

    const received = await receiveWardIndent({
      indentId: indent.id,
      receivedBy: receiver,
      expectedVersion: issued.state_version,
      commandKey: `evidence-receive-${run}`,
      tenantId,
    });
    const projected = (await prisma.$queryRawUnsafe(
      `SELECT allocation.issued_quantity, allocation.received_quantity,
              COALESCE(SUM(receipt.quantity_delta), 0)::numeric AS receipt_quantity
         FROM ward_indent_inventory_allocations allocation
         LEFT JOIN ward_indent_inventory_receipt_events receipt
           ON receipt.tenant_id = allocation.tenant_id
          AND receipt.inventory_allocation_id = allocation.id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.id = $2::bigint
        GROUP BY allocation.id`,
      tenantId,
      allocation.id,
    ))[0];
    expect(Number(projected.issued_quantity)).toBe(2);
    expect(Number(projected.received_quantity)).toBe(2);
    expect(Number(projected.receipt_quantity)).toBe(2);

    await expectSqlState(
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.audit_bypass = 'on'`);
        await tx.$executeRawUnsafe(
          `UPDATE ward_indent_inventory_receipt_events
              SET quantity_delta = quantity_delta
            WHERE tenant_id = $1::uuid AND inventory_allocation_id = $2::bigint`,
          tenantId,
          allocation.id,
        );
      }),
      '55000',
    );
    await expectSqlState(
      () => prisma.$executeRawUnsafe(
        `INSERT INTO ward_indent_inventory_receipt_events
           (tenant_id, inventory_allocation_id, ward_indent_id,
            ward_indent_item_id, inventory_batch_id, ward_indent_state_version,
            quantity_delta, command_key, received_by)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::int, $6::int,
                 0.5, $7::text, $8::uuid)`,
        tenantId,
        allocation.id,
        Number(indent.id),
        Number(allocation.ward_indent_item_id),
        Number(allocation.inventory_batch_id),
        Number(received.state_version) + 1,
        `evidence-extra-receipt-${run}`,
        receiver,
      ),
      '23514',
    );
  });

  test('catalog keeps legacy tenant FKs unvalidated and every evidence rail immutable', async () => {
    const constraintNames = [
      'fk_pharmacy_stock_movements_item_tenant_med03',
      'fk_pharmacy_stock_movements_batch_item_tenant_med03',
      'fk_pharmacy_stock_movements_actor_tenant_med03',
      'fk_pharmacy_schedule_register_facility_tenant_med03',
      'fk_pharmacy_schedule_register_item_tenant_med03',
      'fk_pharmacy_schedule_register_batch_item_tenant_med03',
      'fk_pharmacy_schedule_register_patient_tenant_med03',
      'fk_pharmacy_schedule_register_prescriber_tenant_med03',
      'fk_pharmacy_schedule_register_performer_tenant_med03',
      'fk_pharmacy_schedule_register_witness_tenant_med03',
      'fk_pharmacy_schedule_register_movement_tenant_med03',
    ];
    const constraints = await prisma.$queryRawUnsafe(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      constraintNames,
    );
    expect(constraints).toHaveLength(11);
    expect(constraints.every(({ convalidated }) => convalidated === false)).toBe(true);

    const workflowConstraintNames = [
      'fk_ward_indent_inventory_movement_links_ward_event',
      'fk_ward_indent_inventory_receipt_events_ward_event',
    ];
    const workflowConstraints = await prisma.$queryRawUnsafe(
      `SELECT conname, condeferrable, condeferred
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      workflowConstraintNames,
    );
    expect(workflowConstraints).toEqual([
      {
        conname: 'fk_ward_indent_inventory_movement_links_ward_event',
        condeferrable: true,
        condeferred: true,
      },
      {
        conname: 'fk_ward_indent_inventory_receipt_events_ward_event',
        condeferrable: true,
        condeferred: true,
      },
    ]);

    const triggerNames = [
      'pharmacy_stock_movements_medication_evidence_append_only',
      'pharmacy_schedule_register_medication_evidence_append_only',
      'ward_indent_events_medication_evidence_append_only',
      'ward_indent_inventory_movement_links_append_only',
      'ward_indent_inventory_receipt_events_append_only',
      'mar_supply_reconciliation_command_receipts_append_only',
    ];
    const triggerRows = await prisma.$queryRawUnsafe(
      `SELECT cls.relname AS table_name,
              trg.tgname AS trigger_name,
              pg_get_triggerdef(trg.oid) AS definition
         FROM pg_trigger trg
         JOIN pg_class cls ON cls.oid = trg.tgrelid
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public'
          AND NOT trg.tgisinternal
          AND trg.tgname = ANY($1::text[])
        ORDER BY trg.tgname`,
      triggerNames,
    );
    expect(triggerRows).toHaveLength(6);
    expect(triggerRows.every(({ definition }) => (
      definition.includes('medication_evidence_append_only_guard')
    ))).toBe(true);

    const indexNames = [
      'ux_wi_movement_links_register_med03',
      'ux_billing_credit_notes_refund_med03',
    ];
    const indexes = await prisma.$queryRawUnsafe(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      indexNames,
    );
    expect(indexes).toHaveLength(2);
    expect(indexes.every(({ indexdef }) => (
      indexdef.includes('CREATE UNIQUE INDEX') && indexdef.includes('WHERE')
    ))).toBe(true);

    const guard = (await prisma.$queryRawUnsafe(
      `SELECT pg_get_functiondef(proc.oid) AS definition,
              proc.proconfig
         FROM pg_proc proc
         JOIN pg_namespace ns ON ns.oid = proc.pronamespace
        WHERE ns.nspname = 'public'
          AND proc.proname = 'medication_evidence_append_only_guard'`,
    ))[0];
    expect(guard.proconfig).toContain('search_path=pg_catalog');
    expect(guard.definition).toContain("ERRCODE = '55000'");
    expect(guard.definition).not.toContain('current_setting');

    const protectedFunctions = [
      'medication_administration_require_order_context',
      'ward_indent_inventory_allocation_guard',
      'ward_indent_apply_inventory_movement_link',
      'ward_indent_apply_inventory_receipt_event',
      'ward_indent_inventory_workflow_event_validate',
      'mar_supply_apply_custody_consumption',
      'mar_administration_command_receipt_validate',
      'mar_transition_command_receipt_validate',
      'mar_supply_apply_reconciliation_link',
      'ward_indent_inventory_allocation_evidence_validate',
      'ward_indent_validate_financial_event_lineage',
      'billing_credit_note_event_state_validate',
      'billing_credit_note_require_context',
      'billing_credit_note_require_lifecycle_event',
      'ward_medication_tasks_sync_workflow_sla_compat',
      'care_pathway_assert_task_sla_source_binding',
      'care_pathway_assert_task_sla_completion_receipt',
    ];
    const functionPaths = await prisma.$queryRawUnsafe(
      `SELECT proc.proname, proc.proconfig
         FROM pg_proc proc
         JOIN pg_namespace ns ON ns.oid = proc.pronamespace
        WHERE ns.nspname = 'public'
          AND proc.proname = ANY($1::text[])
        ORDER BY proc.proname`,
      protectedFunctions,
    );
    expect(functionPaths).toHaveLength(protectedFunctions.length);
    expect(functionPaths.every(({ proconfig }) => (
      proconfig?.includes('search_path=pg_catalog, public, pg_temp')
    ))).toBe(true);

    const forcedRlsTables = [
      'ward_indent_inventory_receipt_events',
      'mar_supply_reconciliation_command_receipts',
    ];
    const policies = await prisma.$queryRawUnsafe(
      `SELECT class.relname,
              class.relforcerowsecurity,
              COUNT(*) FILTER (WHERE policy.polpermissive = FALSE)::integer
                AS restrictive_policies
         FROM pg_class class
         JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
         LEFT JOIN pg_policy policy ON policy.polrelid = class.oid
        WHERE namespace.nspname = 'public'
          AND class.relname = ANY($1::text[])
        GROUP BY class.relname, class.relforcerowsecurity
        ORDER BY class.relname`,
      forcedRlsTables,
    );
    expect(policies).toEqual([
      {
        relname: 'mar_supply_reconciliation_command_receipts',
        relforcerowsecurity: true,
        restrictive_policies: 1,
      },
      {
        relname: 'ward_indent_inventory_receipt_events',
        relforcerowsecurity: true,
        restrictive_policies: 1,
      },
    ]);
  });
});
