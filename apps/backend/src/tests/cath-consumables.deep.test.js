import prisma from '../lib/prisma.js';
import {
  listUnbilledConsumableUsage,
  maybeEmitCathBillingLines,
  recordConsumableUsage,
  transitionCaseStatus,
  upsertCathConsumablesBillingSettings,
  upsertConsumableCatalogItem,
} from '../services/clinical/cathLabService.js';
import { voidInvoice } from '../services/billing/billingV2Service.js';

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-00000000d1b2';
const PATIENT_A = 'cd000000-0000-4000-8000-00000000a001';
const CLINICIAN_A = 'cd000000-0000-4000-8000-00000000a002';
const PATIENT_B = 'cd000000-0000-4000-8000-00000000b001';
const RLS_ROLE = 'rls_test_app';
const PROCEDURE_CODE = 'CATH-PROC-NL13-P1D-TEST';
const IMPLANT_CODE = 'CATH-IMPLANT-NL13-P1D-TEST';

const actor = {
  actorUid: CLINICIAN_A,
  actorRole: 'DOCTOR',
  requestId: 'cath-consumables-deep',
};

let caseAId;
let procedureAId;
let caseBId;
let implantItemId;
let wasteItemId;
let lowStockItemId;
let tenantBItemId;
let implantBatchId;
let wasteBatchId;
let lowStockBatchId;
let mappedCatalog;
let wasteCatalog;
let unmappedCatalog;

async function asRlsRole(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    await tx.$executeRawUnsafe(
      `DELETE FROM billing_invoice_items
        WHERE source_ref_type IN ('cath_procedure_log', 'cath_consumable_usage')
          AND invoice_id IN (
            SELECT id FROM billing_invoices WHERE patient_uid IN ($1::uuid, $2::uuid)
          )`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM billing_invoices WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM surgical_implants WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_stock_movements
        WHERE reference_type = 'cath_consumable_usage'
          AND reference_id IN (
            SELECT id::text
              FROM cath_case_consumable_usage
             WHERE patient_uid IN ($1::uuid, $2::uuid)
          )`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_case_consumable_usage WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_procedure_logs WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_lab_cases WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_consumable_catalog
        WHERE metadata->>'test_scope' = 'nl13_p1d_deep'`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_batches
        WHERE batch_number LIKE 'NL13-P1D-%'`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_items
        WHERE sku_code LIKE 'NL13-P1D-%'`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_consumables_billing_settings
        WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A,
      TENANT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A,
      CLINICIAN_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM billing_service_master WHERE code IN ($1, $2)`,
      PROCEDURE_CODE,
      IMPLANT_CODE,
    );
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B);
  });
}

describeIfDb('NL-13 P1d cath consumables deep integration', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'nl13-p1d-tenant-b', 'NL13 P1d Tenant B')`,
      TENANT_B,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, '9011776101', 'Cath Consumable Patient A', 'PATIENT', TRUE, 'active', NOW()),
         ($1::uuid, $3::uuid, '9011776102', 'Dr Cath Consumable A', 'DOCTOR', TRUE, 'active', NOW()),
         ($4::uuid, $5::uuid, '9011776103', 'Cath Consumable Patient B', 'PATIENT', TRUE, 'active', NOW())`,
      TENANT_A,
      PATIENT_A,
      CLINICIAN_A,
      TENANT_B,
      PATIENT_B,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO billing_service_master
         (code, description, category, default_price, gst_rate, hsn_sac, tenant_id)
       VALUES
         ($1, 'Cath procedure deep test', 'procedure', 7500, 0, '9993', $3::uuid),
         ($2, 'Cath implant deep test', 'implants', 47000, 0, '9021', $3::uuid)`,
      PROCEDURE_CODE,
      IMPLANT_CODE,
      TENANT_A,
    );
    const inventoryItems = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, unit_label, status)
       VALUES
         ($1::uuid, 'NL13-P1D-STENT', 'Deep test coronary stent', 'each', 'active'),
         ($1::uuid, 'NL13-P1D-BALLOON', 'Deep test balloon', 'each', 'active'),
         ($1::uuid, 'NL13-P1D-WIRE', 'Deep test guidewire', 'each', 'active'),
         ($2::uuid, 'NL13-P1D-TENANT-B', 'Tenant B inventory item', 'each', 'active')
       RETURNING id, sku_code`,
      TENANT_A,
      TENANT_B,
    );
    implantItemId = inventoryItems.find((row) => row.sku_code === 'NL13-P1D-STENT').id;
    wasteItemId = inventoryItems.find((row) => row.sku_code === 'NL13-P1D-BALLOON').id;
    lowStockItemId = inventoryItems.find((row) => row.sku_code === 'NL13-P1D-WIRE').id;
    tenantBItemId = inventoryItems.find((row) => row.sku_code === 'NL13-P1D-TENANT-B').id;
    const batches = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES
         ($1::uuid, $2::int, 'NL13-P1D-STENT-B1', 'LOT-STENT-B1', '2028-12-31', 5, 5, 'in_stock'),
         ($1::uuid, $3::int, 'NL13-P1D-BALLOON-B1', 'LOT-BALLOON-B1', '2028-12-31', 2, 2, 'in_stock'),
         ($1::uuid, $4::int, 'NL13-P1D-WIRE-B1', 'LOT-WIRE-B1', '2028-12-31', 0.5, 0.5, 'in_stock')
       RETURNING id, batch_number`,
      TENANT_A,
      implantItemId,
      wasteItemId,
      lowStockItemId,
    );
    implantBatchId = batches.find((row) => row.batch_number === 'NL13-P1D-STENT-B1').id;
    wasteBatchId = batches.find((row) => row.batch_number === 'NL13-P1D-BALLOON-B1').id;
    lowStockBatchId = batches.find((row) => row.batch_number === 'NL13-P1D-WIRE-B1').id;
    const cases = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, requested_procedure, status, actual_start_at, created_by, updated_by)
       VALUES
         ($1::uuid, $2::uuid, 'PTCA with stent', 'in_progress', NOW() - INTERVAL '30 minutes', $3::uuid, $3::uuid),
         ($4::uuid, $5::uuid, 'Tenant B diagnostic cath', 'in_progress', NOW() - INTERVAL '20 minutes', NULL, NULL)
       RETURNING id, tenant_id`,
      TENANT_A,
      PATIENT_A,
      CLINICIAN_A,
      TENANT_B,
      PATIENT_B,
    );
    caseAId = cases.find((row) => row.tenant_id === TENANT_A).id;
    caseBId = cases.find((row) => row.tenant_id === TENANT_B).id;
    const procedures = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, procedure_type, operators,
          status, started_at, ended_at, logged_by)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'PTCA', '[]'::jsonb,
               'finalized', NOW() - INTERVAL '30 minutes', NOW(), $4::uuid)
       RETURNING id`,
      TENANT_A,
      caseAId,
      PATIENT_A,
      CLINICIAN_A,
    );
    procedureAId = procedures[0].id;
    mappedCatalog = await upsertConsumableCatalogItem({
      tenantId: TENANT_A,
      item_name: 'Deep test drug-eluting stent',
      category: 'stent',
      manufacturer: 'Synthetic Devices',
      model: 'DES-TEST',
      is_implant: true,
      batch_tracked: true,
      inventory_item_id: implantItemId,
      billing_item_code: IMPLANT_CODE,
      default_unit_cost_reference: 32000,
      metadata: { test_scope: 'nl13_p1d_deep' },
    }, actor);
    wasteCatalog = await upsertConsumableCatalogItem({
      tenantId: TENANT_A,
      item_name: 'Deep test angioplasty balloon',
      category: 'balloon',
      batch_tracked: true,
      inventory_item_id: wasteItemId,
      metadata: { test_scope: 'nl13_p1d_deep' },
    }, actor);
    unmappedCatalog = await upsertConsumableCatalogItem({
      tenantId: TENANT_A,
      item_name: 'Deep test unmapped guidewire',
      category: 'guidewire',
      inventory_item_id: lowStockItemId,
      metadata: { test_scope: 'nl13_p1d_deep' },
    }, actor);
    const tenantBCatalog = await upsertConsumableCatalogItem({
      tenantId: TENANT_B,
      item_name: 'Tenant B catheter',
      category: 'catheter',
      metadata: { test_scope: 'nl13_p1d_deep' },
    });
    await recordConsumableUsage(caseBId, {
      tenantId: TENANT_B,
      catalog_item_id: tenantBCatalog.id,
      quantity: 1,
    });
    await upsertCathConsumablesBillingSettings({
      tenantId: TENANT_A,
      charge_enabled: true,
      procedure_billing_code: PROCEDURE_CODE,
      procedure_unit_price: 7500,
      gst_rate: 0,
    }, actor);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('rejects missing batch/expiry at the database constraint', async () => {
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO cath_case_consumable_usage
         (tenant_id, case_id, procedure_log_id, catalog_item_id, patient_uid,
          quantity, batch_tracked, is_implant, serial_number,
          inventory_decrement_status)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::uuid,
               1, TRUE, TRUE, 'SERIAL-MISSING-BATCH', 'pending')`,
      TENANT_A,
      caseAId,
      procedureAId,
      mappedCatalog.id,
      PATIENT_A,
    )).rejects.toThrow(/cath_consumable_usage_batch_expiry_check/i);
  });

  test('database constraints reject cross-tenant and downgraded implant links', async () => {
    await expect(asRlsRole(
      TENANT_A,
      `INSERT INTO cath_case_consumable_usage
         (tenant_id, case_id, catalog_item_id, patient_uid, quantity,
          batch_tracked, is_implant, batch_number, expiry_date, serial_number)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, 1,
               TRUE, TRUE, 'CROSS-TENANT', '2028-12-31', 'CROSS-TENANT-SERIAL')
       RETURNING id`,
      TENANT_A,
      caseBId,
      mappedCatalog.id,
      PATIENT_B,
    )).rejects.toThrow(/fk_cath_consumable_usage_case_tenant_patient|foreign key/i);

    await expect(asRlsRole(
      TENANT_A,
      `INSERT INTO cath_consumable_catalog
         (tenant_id, inventory_item_id, item_name, category, is_implant, batch_tracked)
       VALUES ($1::uuid, $2::int, 'Cross-tenant inventory', 'other', FALSE, FALSE)
       RETURNING id`,
      TENANT_A,
      tenantBItemId,
    )).rejects.toThrow(/fk_cath_consumable_catalog_inventory_tenant|foreign key/i);

    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO cath_consumable_catalog
         (tenant_id, item_name, category, is_implant, batch_tracked)
       VALUES ($1::uuid, 'Invalid non-implant stent', 'stent', FALSE, TRUE)`,
      TENANT_A,
    )).rejects.toThrow(/cath_consumable_catalog_category_implant_check/i);

    const [foreignTimeline] = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        ORDER BY occurred_at DESC LIMIT 1`,
      TENANT_B,
      PATIENT_B,
    );
    const [foreignAudit] = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_audit_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        ORDER BY occurred_at DESC LIMIT 1`,
      TENANT_B,
      PATIENT_B,
    );
    expect(foreignTimeline).toBeTruthy();
    expect(foreignAudit).toBeTruthy();

    for (const [column, id, constraint] of [
      ['timeline_event_id', foreignTimeline.id, 'fk_cath_consumable_usage_timeline_tenant'],
      ['audit_event_id', foreignAudit.id, 'fk_cath_consumable_usage_audit_tenant'],
    ]) {
      await expect(asRlsRole(
        TENANT_A,
        `INSERT INTO cath_case_consumable_usage
           (tenant_id, case_id, catalog_item_id, patient_uid, quantity,
            batch_tracked, is_implant, ${column})
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, 1, FALSE, FALSE, $5::uuid)
         RETURNING id`,
        TENANT_A,
        caseAId,
        unmappedCatalog.id,
        PATIENT_A,
        id,
      )).rejects.toThrow(new RegExp(`${constraint}|foreign key`, 'i'));
    }
  });

  test('records mapped implant usage, decrements inventory, and feeds patient implant registry', async () => {
    const input = {
      tenantId: TENANT_A,
      procedure_log_id: procedureAId,
      catalog_item_id: mappedCatalog.id,
      inventory_batch_id: implantBatchId,
      quantity: 1,
      serial_number: 'NL13-P1D-STENT-SERIAL-1',
    };
    const idempotentActor = { ...actor, idempotencyKey: 'nl13-p1d-implant-deep-1' };
    const usage = await recordConsumableUsage(caseAId, input, idempotentActor);
    const replay = await recordConsumableUsage(caseAId, input, idempotentActor);
    expect(replay.id).toBe(usage.id);
    expect(replay.idempotent_replay).toBe(true);
    expect(usage.inventory_decrement_status).toBe('decremented');
    expect(usage.inventory_warning).toBeNull();
    expect(usage.used_by_name).toBe('Dr Cath Consumable A');
    expect(usage.implant_record_id).toBeTruthy();

    const batch = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id = $1::int`,
      implantBatchId,
    );
    expect(Number(batch[0].remaining_quantity)).toBe(4);
    const movement = await prisma.$queryRawUnsafe(
      `SELECT movement_kind, quantity_delta, reference_type, reference_id
         FROM pharmacy_stock_movements
        WHERE reference_type = 'cath_consumable_usage' AND reference_id = $1`,
      String(usage.id),
    );
    expect(movement).toHaveLength(1);
    expect(movement[0].movement_kind).toBe('issue');
    expect(Number(movement[0].quantity_delta)).toBe(-1);

    const implant = await prisma.$queryRawUnsafe(
      `SELECT cath_case_id, cath_usage_id, patient_uid, serial_number, status
         FROM surgical_implants WHERE cath_usage_id = $1::bigint`,
      usage.id,
    );
    expect(implant).toHaveLength(1);
    expect(Number(implant[0].cath_case_id)).toBe(Number(caseAId));
    expect(implant[0].serial_number).toBe('NL13-P1D-STENT-SERIAL-1');
    expect(implant[0].status).toBe('in_situ');
  });

  test('global SET NULL and CASCADE references coexist with tenant-aware cath FKs', async () => {
    const [tempCase] = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, requested_procedure, status)
       VALUES ($1::uuid, $2::uuid, 'Temporary FK deletion probe', 'in_progress')
       RETURNING id`,
      TENANT_A,
      PATIENT_A,
    );
    const [tempProcedure] = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, procedure_type, status)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'Deletion probe', 'finalized')
       RETURNING id`,
      TENANT_A,
      tempCase.id,
      PATIENT_A,
    );
    const [tempUsage] = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_case_consumable_usage
         (tenant_id, case_id, procedure_log_id, catalog_item_id, patient_uid,
          quantity, batch_tracked, is_implant, idempotency_key)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::uuid,
               1, FALSE, FALSE, 'nl13-p1d-delete-probe')
       RETURNING id`,
      TENANT_A,
      tempCase.id,
      tempProcedure.id,
      unmappedCatalog.id,
      PATIENT_A,
    );

    await prisma.$executeRawUnsafe(
      'DELETE FROM cath_procedure_logs WHERE id = $1::bigint',
      tempProcedure.id,
    );
    const [afterProcedureDelete] = await prisma.$queryRawUnsafe(
      'SELECT procedure_log_id FROM cath_case_consumable_usage WHERE id = $1::bigint',
      tempUsage.id,
    );
    expect(afterProcedureDelete.procedure_log_id).toBeNull();

    await prisma.$executeRawUnsafe('DELETE FROM cath_lab_cases WHERE id = $1::bigint', tempCase.id);
    const [{ count }] = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM cath_case_consumable_usage WHERE id = $1::bigint',
      tempUsage.id,
    );
    expect(count).toBe(0);
  });

  test('wastage decrements stock with dispose semantics and remains auditable', async () => {
    const usage = await recordConsumableUsage(caseAId, {
      tenantId: TENANT_A,
      procedure_log_id: procedureAId,
      catalog_item_id: wasteCatalog.id,
      inventory_batch_id: wasteBatchId,
      quantity: 1,
      wasted: true,
      waste_reason: 'Opened during setup but not used',
    }, actor);
    expect(usage.wasted).toBe(true);
    expect(usage.inventory_decrement_status).toBe('decremented');
    const batch = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id = $1::int`,
      wasteBatchId,
    );
    expect(Number(batch[0].remaining_quantity)).toBe(1);
    const movement = await prisma.$queryRawUnsafe(
      `SELECT movement_kind FROM pharmacy_stock_movements
        WHERE reference_type = 'cath_consumable_usage' AND reference_id = $1`,
      String(usage.id),
    );
    expect(movement[0].movement_kind).toBe('dispose');
  });

  test('insufficient stock warns without blocking the clinical record', async () => {
    const usage = await recordConsumableUsage(caseAId, {
      tenantId: TENANT_A,
      procedure_log_id: procedureAId,
      catalog_item_id: unmappedCatalog.id,
      inventory_batch_id: lowStockBatchId,
      quantity: 2,
    }, actor);
    expect(usage.id).toBeTruthy();
    expect(usage.inventory_decrement_status).toBe('insufficient_stock');
    expect(usage.inventory_warning).toMatch(/clinical usage was saved/i);
    const batch = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id = $1::int`,
      lowStockBatchId,
    );
    expect(Number(batch[0].remaining_quantity)).toBe(0.5);
    const events = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE source_table = 'cath_case_consumable_usage' AND source_id = $1`,
      String(usage.id),
    );
    expect(events).toHaveLength(1);
  });

  test('completion emits mapped billing lines and keeps unmapped usage fail-visible', async () => {
    const completed = await transitionCaseStatus(caseAId, {
      tenantId: TENANT_A,
      status: 'completed',
    }, actor);
    expect(completed.status).toBe('completed');
    expect(completed.billing_hook).toMatchObject({ status: 'emitted', emitted: 2 });

    const lines = await prisma.$queryRawUnsafe(
      `SELECT source_ref_type, source_ref_id, quantity, unit_price
         FROM billing_invoice_items item
         JOIN billing_invoices invoice ON invoice.id = item.invoice_id
        WHERE item.source_ref_type IN ('cath_procedure_log', 'cath_consumable_usage')
          AND invoice.patient_uid = $1::uuid
        ORDER BY source_ref_type`,
      PATIENT_A,
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((row) => row.source_ref_type)).toEqual([
      'cath_consumable_usage',
      'cath_procedure_log',
    ]);
    const consumableLine = lines.find(
      (row) => row.source_ref_type === 'cath_consumable_usage',
    );
    expect(Number(consumableLine.unit_price)).toBe(47000);
    expect(Number(consumableLine.unit_price)).not.toBe(32000);

    const unbilled = await listUnbilledConsumableUsage({ tenantId: TENANT_A });
    expect(unbilled.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        item_name: 'Deep test unmapped guidewire',
        billing_gap_reason: 'billing_code_not_mapped',
      }),
      expect.objectContaining({
        item_name: 'Deep test angioplasty balloon',
        billing_gap_reason: 'wastage_review_required',
      }),
    ]));
    const canonical = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid
          AND source_table = 'cath_case_consumable_usage'`,
      PATIENT_A,
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM clinical_audit_events
        WHERE patient_uid = $1::uuid
          AND resource_table = 'cath_case_consumable_usage'`,
      PATIENT_A,
    );
    expect(canonical[0].n).toBe(3);
    expect(audit[0].n).toBe(3);
  });

  test('voided cath lines become fail-visible and can be emitted once on a new draft', async () => {
    const [activeInvoice] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT invoice.id
         FROM billing_invoices invoice
         JOIN billing_invoice_items item
           ON item.invoice_id = invoice.id
          AND item.tenant_id = invoice.tenant_id
        WHERE invoice.tenant_id = $1::uuid
          AND invoice.patient_uid = $2::uuid
          AND invoice.status = 'DRAFT'
          AND item.source_ref_type = 'cath_procedure_log'
          AND item.source_ref_active = TRUE`,
      TENANT_A,
      PATIENT_A,
    );
    expect(activeInvoice).toBeTruthy();

    await voidInvoice(activeInvoice.id, {
      tenantId: TENANT_A,
      reason: 'Deep test cath re-billing after void',
      voided_by: CLINICIAN_A,
    });
    const voidedLines = await prisma.$queryRawUnsafe(
      `SELECT source_ref_active
         FROM billing_invoice_items
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int
          AND source_ref_type IN ('cath_procedure_log', 'cath_consumable_usage')`,
      TENANT_A,
      activeInvoice.id,
    );
    expect(voidedLines).toHaveLength(2);
    expect(voidedLines.every((row) => row.source_ref_active === false)).toBe(true);

    const visibleAfterVoid = await listUnbilledConsumableUsage({ tenantId: TENANT_A });
    expect(visibleAfterVoid.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        item_name: 'Deep test drug-eluting stent',
        billing_gap_reason: 'billing_pending_or_failed',
      }),
    ]));

    const reemitted = await maybeEmitCathBillingLines({
      tenantId: TENANT_A,
      caseId: caseAId,
      actorUid: CLINICIAN_A,
    });
    expect(reemitted).toMatchObject({ status: 'emitted', emitted: 2, failed: 0 });
    const activeLines = await prisma.$queryRawUnsafe(
      `SELECT invoice_id, source_ref_type
         FROM billing_invoice_items
        WHERE tenant_id = $1::uuid
          AND source_ref_active = TRUE
          AND source_ref_type IN ('cath_procedure_log', 'cath_consumable_usage')
        ORDER BY source_ref_type`,
      TENANT_A,
    );
    expect(activeLines).toHaveLength(2);
    expect(new Set(activeLines.map((row) => row.invoice_id))).toEqual(
      new Set([activeLines[0].invoice_id]),
    );
    expect(activeLines[0].invoice_id).not.toBe(activeInvoice.id);
  });

  test('voiding an issued invoice keeps its posted cath source reference active', async () => {
    const [issuedInvoice] = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (tenant_id, patient_uid, invoice_type, department, status, issued_at)
       VALUES ($1::uuid, $2::uuid, 'OP', 'Cath Lab', 'ISSUED', NOW())
       RETURNING id`,
      TENANT_A,
      PATIENT_A,
    );
    const sourceRefId = '566000000000';
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_invoice_items
         (tenant_id, invoice_id, description, quantity, unit_price,
          line_subtotal, line_total, source_ref_type, source_ref_id,
          source_ref_active)
       VALUES ($1::uuid, $2::int, 'Posted cath source', 1, 1, 1, 1,
               'cath_consumable_usage', $3::bigint, TRUE)`,
      TENANT_A,
      issuedInvoice.id,
      sourceRefId,
    );

    await voidInvoice(issuedInvoice.id, {
      tenantId: TENANT_A,
      reason: 'Deep test issued source remains claimed',
      voided_by: CLINICIAN_A,
    });

    const [postedLine] = await prisma.$queryRawUnsafe(
      `SELECT item.source_ref_active, invoice.status
         FROM billing_invoice_items item
         JOIN billing_invoices invoice ON invoice.id = item.invoice_id
        WHERE item.tenant_id = $1::uuid
          AND item.source_ref_type = 'cath_consumable_usage'
          AND item.source_ref_id = $2::bigint`,
      TENANT_A,
      sourceRefId,
    );
    expect(postedLine).toEqual({ source_ref_active: true, status: 'VOID' });
  });

  test('concurrent cath hooks share one draft and keep every active line together', async () => {
    const [currentDraft] = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND department = 'Cath Lab'
          AND status = 'DRAFT'
        ORDER BY id DESC
        LIMIT 1`,
      TENANT_A,
      PATIENT_A,
    );
    await voidInvoice(currentDraft.id, {
      tenantId: TENANT_A,
      reason: 'Deep test concurrent cath hook',
      voided_by: CLINICIAN_A,
    });

    await Promise.all([
      maybeEmitCathBillingLines({
        tenantId: TENANT_A,
        caseId: caseAId,
        actorUid: CLINICIAN_A,
      }),
      maybeEmitCathBillingLines({
        tenantId: TENANT_A,
        caseId: caseAId,
        actorUid: CLINICIAN_A,
      }),
    ]);

    const drafts = await prisma.$queryRawUnsafe(
      `SELECT invoice.id, COUNT(item.id)::int AS active_line_count
         FROM billing_invoices invoice
         LEFT JOIN billing_invoice_items item
           ON item.invoice_id = invoice.id
          AND item.tenant_id = invoice.tenant_id
          AND item.source_ref_active = TRUE
          AND item.source_ref_type IN ('cath_procedure_log', 'cath_consumable_usage')
        WHERE invoice.tenant_id = $1::uuid
          AND invoice.patient_uid = $2::uuid
          AND invoice.department = 'Cath Lab'
          AND invoice.status = 'DRAFT'
        GROUP BY invoice.id`,
      TENANT_A,
      PATIENT_A,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].active_line_count).toBe(2);
  });

  test('concurrent cases for one patient share the same cath draft', async () => {
    const [currentDraft] = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND department = 'Cath Lab'
          AND status = 'DRAFT'
        ORDER BY id DESC
        LIMIT 1`,
      TENANT_A,
      PATIENT_A,
    );
    await voidInvoice(currentDraft.id, {
      tenantId: TENANT_A,
      reason: 'Deep test cross-case cath hook',
      voided_by: CLINICIAN_A,
    });
    const [secondCase] = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, requested_procedure, status)
       VALUES ($1::uuid, $2::uuid, 'Staged PCI', 'completed')
       RETURNING id`,
      TENANT_A,
      PATIENT_A,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, procedure_type, operators,
          status, started_at, ended_at, logged_by)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'Staged PCI', '[]'::jsonb,
               'finalized', NOW() - INTERVAL '20 minutes', NOW(), $4::uuid)
       RETURNING id`,
      TENANT_A,
      secondCase.id,
      PATIENT_A,
      CLINICIAN_A,
    );

    await Promise.all([
      maybeEmitCathBillingLines({
        tenantId: TENANT_A,
        caseId: caseAId,
        actorUid: CLINICIAN_A,
      }),
      maybeEmitCathBillingLines({
        tenantId: TENANT_A,
        caseId: secondCase.id,
        actorUid: CLINICIAN_A,
      }),
    ]);

    const drafts = await prisma.$queryRawUnsafe(
      `SELECT invoice.id, COUNT(item.id)::int AS active_line_count
         FROM billing_invoices invoice
         LEFT JOIN billing_invoice_items item
           ON item.invoice_id = invoice.id
          AND item.tenant_id = invoice.tenant_id
          AND item.source_ref_active = TRUE
          AND item.source_ref_type IN ('cath_procedure_log', 'cath_consumable_usage')
        WHERE invoice.tenant_id = $1::uuid
          AND invoice.patient_uid = $2::uuid
          AND invoice.department = 'Cath Lab'
          AND invoice.status = 'DRAFT'
        GROUP BY invoice.id`,
      TENANT_A,
      PATIENT_A,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].active_line_count).toBe(3);
  });

  test('RLS hides each tenant from the other in both directions', async () => {
    const tenantAUsage = await asRlsRole(
      TENANT_A,
      'SELECT tenant_id FROM cath_case_consumable_usage WHERE patient_uid = $1::uuid ORDER BY id',
      PATIENT_A,
    );
    expect(tenantAUsage.length).toBe(3);
    expect(tenantAUsage.every((row) => row.tenant_id === TENANT_A)).toBe(true);

    const tenantBUsage = await asRlsRole(
      TENANT_B,
      'SELECT tenant_id FROM cath_case_consumable_usage WHERE patient_uid = $1::uuid ORDER BY id',
      PATIENT_B,
    );
    expect(tenantBUsage).toHaveLength(1);
    expect(tenantBUsage[0].tenant_id).toBe(TENANT_B);

    const tenantACatalog = await asRlsRole(
      TENANT_A,
      "SELECT tenant_id FROM cath_consumable_catalog WHERE metadata->>'test_scope' = 'nl13_p1d_deep' ORDER BY id",
    );
    expect(tenantACatalog).toHaveLength(3);
    expect(tenantACatalog.every((row) => row.tenant_id === TENANT_A)).toBe(true);
    const tenantBCatalog = await asRlsRole(
      TENANT_B,
      "SELECT tenant_id FROM cath_consumable_catalog WHERE metadata->>'test_scope' = 'nl13_p1d_deep' ORDER BY id",
    );
    expect(tenantBCatalog).toHaveLength(1);
    expect(tenantBCatalog[0].tenant_id).toBe(TENANT_B);
  });

  test('decrements only exact documented lineage and warns without debiting unusable batches', async () => {
    const batches = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES
         ($1::uuid, $2::int, 'NL13-P1D-EXACT-DECOY', 'LOT-EXACT-DECOY', '2028-06-01', 3, 3, 'in_stock'),
         ($1::uuid, $2::int, 'NL13-P1D-EXACT-TARGET', 'LOT-EXACT-TARGET', '2029-12-31', 3, 3, 'in_stock'),
         ($1::uuid, $2::int, 'NL13-P1D-EXPIRED', 'LOT-EXPIRED', '2025-01-01', 2, 2, 'in_stock'),
         ($1::uuid, $2::int, 'NL13-P1D-RECALLED', 'LOT-RECALLED', '2029-01-01', 2, 2, 'recalled'),
         ($1::uuid, $3::int, 'NL13-P1D-OPTIONAL-DECOY', 'LOT-OPTIONAL-DECOY', '2028-07-01', 3, 3, 'in_stock'),
         ($1::uuid, $3::int, 'NL13-P1D-OPTIONAL-TARGET', 'LOT-OPTIONAL-TARGET', '2029-11-30', 3, 3, 'in_stock')
       RETURNING id, batch_number`,
      TENANT_A,
      wasteItemId,
      lowStockItemId,
    );
    const idOf = (batchNumber) => batches.find(
      (row) => row.batch_number === batchNumber,
    ).id;

    const exact = await recordConsumableUsage(caseAId, {
      tenantId: TENANT_A,
      catalog_item_id: wasteCatalog.id,
      quantity: 1,
      batch_number: 'NL13-P1D-EXACT-TARGET',
      lot_number: 'LOT-EXACT-TARGET',
      expiry_date: '2029-12-31',
    }, actor);
    expect(exact).toMatchObject({
      inventory_batch_id: idOf('NL13-P1D-EXACT-TARGET'),
      batch_number: 'NL13-P1D-EXACT-TARGET',
      lot_number: 'LOT-EXACT-TARGET',
      inventory_decrement_status: 'decremented',
      inventory_warning: null,
    });

    const optionalTracking = await recordConsumableUsage(caseAId, {
      tenantId: TENANT_A,
      catalog_item_id: unmappedCatalog.id,
      quantity: 1,
      batch_number: 'NL13-P1D-OPTIONAL-TARGET',
      lot_number: 'LOT-OPTIONAL-TARGET',
      expiry_date: '2029-11-30',
    }, actor);
    expect(optionalTracking).toMatchObject({
      batch_tracked: false,
      inventory_batch_id: idOf('NL13-P1D-OPTIONAL-TARGET'),
      inventory_decrement_status: 'decremented',
    });

    const expired = await recordConsumableUsage(caseAId, {
      tenantId: TENANT_A,
      catalog_item_id: wasteCatalog.id,
      quantity: 1,
      batch_number: 'NL13-P1D-EXPIRED',
      lot_number: 'LOT-EXPIRED',
      expiry_date: '2025-01-01',
    }, actor);
    expect(expired).toMatchObject({
      inventory_batch_id: idOf('NL13-P1D-EXPIRED'),
      inventory_decrement_status: 'error',
      inventory_warning: expect.stringMatching(/expired.*without a stock decrement/i),
    });

    const recalled = await recordConsumableUsage(caseAId, {
      tenantId: TENANT_A,
      catalog_item_id: wasteCatalog.id,
      inventory_batch_id: idOf('NL13-P1D-RECALLED'),
      quantity: 1,
    }, actor);
    expect(recalled).toMatchObject({
      inventory_batch_id: idOf('NL13-P1D-RECALLED'),
      inventory_decrement_status: 'error',
      inventory_warning: expect.stringMatching(/recalled.*without a stock decrement/i),
    });

    const invalid = await recordConsumableUsage(caseAId, {
      tenantId: TENANT_A,
      catalog_item_id: wasteCatalog.id,
      inventory_batch_id: idOf('NL13-P1D-OPTIONAL-TARGET'),
      quantity: 1,
      batch_number: 'NL13-P1D-OPTIONAL-TARGET',
      lot_number: 'LOT-OPTIONAL-TARGET',
      expiry_date: '2029-11-30',
    }, actor);
    expect(invalid).toMatchObject({
      inventory_batch_id: null,
      inventory_decrement_status: 'error',
      inventory_warning: expect.stringMatching(/outside this tenant or catalog item/i),
    });

    const stock = await prisma.$queryRawUnsafe(
      `SELECT batch_number, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE id IN ($1::int, $2::int, $3::int, $4::int, $5::int, $6::int)
        ORDER BY batch_number`,
      idOf('NL13-P1D-EXACT-DECOY'),
      idOf('NL13-P1D-EXACT-TARGET'),
      idOf('NL13-P1D-EXPIRED'),
      idOf('NL13-P1D-RECALLED'),
      idOf('NL13-P1D-OPTIONAL-DECOY'),
      idOf('NL13-P1D-OPTIONAL-TARGET'),
    );
    const remaining = Object.fromEntries(stock.map((row) => [
      row.batch_number,
      Number(row.remaining_quantity),
    ]));
    expect(remaining).toMatchObject({
      'NL13-P1D-EXACT-DECOY': 3,
      'NL13-P1D-EXACT-TARGET': 2,
      'NL13-P1D-EXPIRED': 2,
      'NL13-P1D-RECALLED': 2,
      'NL13-P1D-OPTIONAL-DECOY': 3,
      'NL13-P1D-OPTIONAL-TARGET': 2,
    });

    const unusableMovements = await prisma.$queryRawUnsafe(
      `SELECT reference_id
         FROM pharmacy_stock_movements
        WHERE reference_type = 'cath_consumable_usage'
          AND reference_id IN ($1, $2, $3)`,
      String(expired.id),
      String(recalled.id),
      String(invalid.id),
    );
    expect(unusableMovements).toEqual([]);
  });

  test('idempotent replay resumes both exact-batch crash windows without double decrement', async () => {
    const batches = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES
         ($1::uuid, $2::int, 'NL13-P1D-REPLAY-EXACT-BEFORE', 'LOT-REPLAY-BEFORE', '2029-10-31', 3, 3, 'in_stock'),
         ($1::uuid, $2::int, 'NL13-P1D-REPLAY-EXACT-AFTER', 'LOT-REPLAY-AFTER', '2029-11-30', 3, 3, 'in_stock')
       RETURNING id, batch_number`,
      TENANT_A,
      wasteItemId,
    );
    const beforeBatchId = batches.find(
      (row) => row.batch_number === 'NL13-P1D-REPLAY-EXACT-BEFORE',
    ).id;
    const afterBatchId = batches.find(
      (row) => row.batch_number === 'NL13-P1D-REPLAY-EXACT-AFTER',
    ).id;

    const beforeInput = {
      tenantId: TENANT_A,
      catalog_item_id: wasteCatalog.id,
      inventory_batch_id: beforeBatchId,
      quantity: 1,
    };
    const beforeActor = {
      ...actor,
      idempotencyKey: 'nl13-p1d-replay-exact-before-movement',
    };
    const beforeUsage = await recordConsumableUsage(caseAId, beforeInput, beforeActor);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE cath_case_consumable_usage
            SET inventory_decrement_status = 'pending',
                inventory_movement_id = NULL,
                inventory_warning = NULL
          WHERE id = $1::bigint`,
        beforeUsage.id,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements
          WHERE reference_type = 'cath_consumable_usage'
            AND reference_id = $1`,
        String(beforeUsage.id),
      );
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_batches
            SET remaining_quantity = 3, status = 'in_stock'
          WHERE id = $1::int`,
        beforeBatchId,
      );
    });

    const resumedBefore = await recordConsumableUsage(caseAId, beforeInput, beforeActor);
    expect(resumedBefore).toMatchObject({
      id: beforeUsage.id,
      idempotent_replay: true,
      inventory_decrement_status: 'decremented',
    });
    const [beforeStock] = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id = $1::int`,
      beforeBatchId,
    );
    expect(Number(beforeStock.remaining_quantity)).toBe(2);

    const afterInput = {
      tenantId: TENANT_A,
      catalog_item_id: wasteCatalog.id,
      inventory_batch_id: afterBatchId,
      quantity: 1,
    };
    const afterActor = {
      ...actor,
      idempotencyKey: 'nl13-p1d-replay-exact-after-movement',
    };
    const afterUsage = await recordConsumableUsage(caseAId, afterInput, afterActor);
    await prisma.$executeRawUnsafe(
      `UPDATE cath_case_consumable_usage
          SET inventory_decrement_status = 'pending',
              inventory_movement_id = NULL,
              inventory_warning = NULL
        WHERE id = $1::bigint`,
      afterUsage.id,
    );
    const resumedAfter = await recordConsumableUsage(caseAId, afterInput, afterActor);
    expect(resumedAfter).toMatchObject({
      id: afterUsage.id,
      idempotent_replay: true,
      inventory_decrement_status: 'decremented',
    });
    const [afterStock] = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id = $1::int`,
      afterBatchId,
    );
    expect(Number(afterStock.remaining_quantity)).toBe(2);

    const movementCounts = await prisma.$queryRawUnsafe(
      `SELECT reference_id, COUNT(*)::int AS count
         FROM pharmacy_stock_movements
        WHERE reference_type = 'cath_consumable_usage'
          AND reference_id IN ($1, $2)
        GROUP BY reference_id`,
      String(beforeUsage.id),
      String(afterUsage.id),
    );
    expect(Object.fromEntries(movementCounts.map((row) => [
      row.reference_id,
      row.count,
    ]))).toEqual({
      [String(beforeUsage.id)]: 1,
      [String(afterUsage.id)]: 1,
    });
  });

  test('completed-case replay restores a billing hook missed after the clinical commit', async () => {
    const [batch] = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, 'NL13-P1D-REPLAY-BILLING', 'LOT-REPLAY-BILLING',
               '2030-01-31', 2, 2, 'in_stock')
       RETURNING id`,
      TENANT_A,
      implantItemId,
    );
    const input = {
      tenantId: TENANT_A,
      procedure_log_id: procedureAId,
      catalog_item_id: mappedCatalog.id,
      inventory_batch_id: batch.id,
      quantity: 1,
      serial_number: 'NL13-P1D-REPLAY-BILLING-SERIAL',
    };
    const replayActor = {
      ...actor,
      idempotencyKey: 'nl13-p1d-replay-completed-billing',
    };
    const usage = await recordConsumableUsage(caseAId, input, replayActor);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE cath_case_consumable_usage
            SET inventory_decrement_status = 'pending',
                inventory_movement_id = NULL,
                inventory_warning = NULL
          WHERE id = $1::bigint`,
        usage.id,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements
          WHERE tenant_id = $1::uuid
            AND reference_type = 'cath_consumable_usage'
            AND reference_id = $2`,
        TENANT_A,
        String(usage.id),
      );
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_batches
            SET remaining_quantity = 2, status = 'in_stock'
          WHERE id = $1::int
            AND tenant_id = $2::uuid`,
        batch.id,
        TENANT_A,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_invoice_items
          WHERE tenant_id = $1::uuid
            AND source_ref_type = 'cath_consumable_usage'
            AND source_ref_id = $2::bigint`,
        TENANT_A,
        usage.id,
      );
    });

    const replay = await recordConsumableUsage(caseAId, input, replayActor);
    expect(replay).toMatchObject({
      id: usage.id,
      idempotent_replay: true,
      inventory_decrement_status: 'decremented',
      billing_hook: { status: 'emitted', emitted: 1 },
    });
    const [stock] = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      batch.id,
      TENANT_A,
    );
    expect(Number(stock.remaining_quantity)).toBe(1);
    const [{ movement_count: movementCount, billing_count: billingCount }]
      = await prisma.$queryRawUnsafe(
        `SELECT
           (SELECT COUNT(*)::int
              FROM pharmacy_stock_movements
             WHERE tenant_id = $1::uuid
               AND reference_type = 'cath_consumable_usage'
               AND reference_id = $2) AS movement_count,
           (SELECT COUNT(*)::int
              FROM billing_invoice_items
             WHERE tenant_id = $1::uuid
               AND source_ref_type = 'cath_consumable_usage'
               AND source_ref_id = $3::bigint) AS billing_count`,
        TENANT_A,
        String(usage.id),
        usage.id,
      );
    expect(movementCount).toBe(1);
    expect(billingCount).toBe(1);
  });

  test('idempotent replay resumes both FEFO crash windows without double decrement', async () => {
    const [item] = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, unit_label, status)
       VALUES ($1::uuid, 'NL13-P1D-REPLAY-FEFO', 'Replay FEFO guidewire', 'each', 'active')
       RETURNING id`,
      TENANT_A,
    );
    const [batch] = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, 'NL13-P1D-REPLAY-FEFO-B1', 'LOT-REPLAY-FEFO', '2029-12-31', 4, 4, 'in_stock')
       RETURNING id`,
      TENANT_A,
      item.id,
    );
    const catalog = await upsertConsumableCatalogItem({
      tenantId: TENANT_A,
      item_name: 'Replay FEFO guidewire',
      category: 'guidewire',
      inventory_item_id: item.id,
      metadata: { test_scope: 'nl13_p1d_deep' },
    }, actor);

    const beforeInput = {
      tenantId: TENANT_A,
      catalog_item_id: catalog.id,
      quantity: 1,
    };
    const beforeActor = {
      ...actor,
      idempotencyKey: 'nl13-p1d-replay-fefo-before-movement',
    };
    const beforeUsage = await recordConsumableUsage(caseAId, beforeInput, beforeActor);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE cath_case_consumable_usage
            SET inventory_decrement_status = 'pending', inventory_warning = NULL
          WHERE id = $1::bigint`,
        beforeUsage.id,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements
          WHERE reference_type = 'cath_consumable_usage'
            AND reference_id = $1`,
        String(beforeUsage.id),
      );
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_batches
            SET remaining_quantity = 4, status = 'in_stock'
          WHERE id = $1::int`,
        batch.id,
      );
    });

    const resumedBefore = await recordConsumableUsage(caseAId, beforeInput, beforeActor);
    expect(resumedBefore).toMatchObject({
      id: beforeUsage.id,
      idempotent_replay: true,
      inventory_decrement_status: 'decremented',
    });
    const [stockAfterBeforeWindow] = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id = $1::int`,
      batch.id,
    );
    expect(Number(stockAfterBeforeWindow.remaining_quantity)).toBe(3);

    const afterInput = {
      tenantId: TENANT_A,
      catalog_item_id: catalog.id,
      quantity: 1,
    };
    const afterActor = {
      ...actor,
      idempotencyKey: 'nl13-p1d-replay-fefo-after-movement',
    };
    const afterUsage = await recordConsumableUsage(caseAId, afterInput, afterActor);
    await prisma.$executeRawUnsafe(
      `UPDATE cath_case_consumable_usage
          SET inventory_decrement_status = 'pending', inventory_warning = NULL
        WHERE id = $1::bigint`,
      afterUsage.id,
    );
    const resumedAfter = await recordConsumableUsage(caseAId, afterInput, afterActor);
    expect(resumedAfter).toMatchObject({
      id: afterUsage.id,
      idempotent_replay: true,
      inventory_decrement_status: 'decremented',
    });
    const [stockAfterAfterWindow] = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id = $1::int`,
      batch.id,
    );
    expect(Number(stockAfterAfterWindow.remaining_quantity)).toBe(2);

    const movementCounts = await prisma.$queryRawUnsafe(
      `SELECT reference_id, COUNT(*)::int AS count
         FROM pharmacy_stock_movements
        WHERE reference_type = 'cath_consumable_usage'
          AND reference_id IN ($1, $2)
        GROUP BY reference_id`,
      String(beforeUsage.id),
      String(afterUsage.id),
    );
    expect(Object.fromEntries(movementCounts.map((row) => [
      row.reference_id,
      row.count,
    ]))).toEqual({
      [String(beforeUsage.id)]: 1,
      [String(afterUsage.id)]: 1,
    });
  });

  test.each([
    ['relink', () => lowStockItemId],
    ['removal', () => null],
  ])('prevents tenant-scoped catalog inventory link %s after usage exists', async (
    _label,
    inventoryItem,
  ) => {
    await expect(upsertConsumableCatalogItem({
      tenantId: TENANT_A,
      id: wasteCatalog.id,
      inventory_item_id: inventoryItem(),
    }, actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATH_CONSUMABLE_INVENTORY_LINK_IMMUTABLE',
    });
  });
});
