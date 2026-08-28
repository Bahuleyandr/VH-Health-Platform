import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  consumeMarSupplyTx,
  reconcileMarSupplyOverride,
} from '../services/clinical/marSupplyService.js';
import { seedReceivedMedicationSupply } from './helpers/medicationEvidenceFixture.js';

const databaseConfigured = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = databaseConfigured ? describe : describe.skip;

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const NURSE_UID = randomUUID();
const PHARMACIST_UID = randomUUID();
const RUN = `${process.pid}-${Date.now()}`;

let product;
let wardIndentItemId;
let allocationId;
let consumptionId;
let medicationAdministrationId;

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of [
      'idempotency_keys',
      'mar_supply_reconciliation_command_receipts',
      'mar_supply_reconciliation_links',
      'mar_supply_consumptions',
      'mar_administration_command_receipts',
      'mar_transition_command_receipts',
      'task_comments',
      'tasks',
      'notification_outbox',
      'workflow_sla_instances',
      'billing_credit_note_events',
      'billing_credit_notes',
      'ward_indent_financial_events',
      'medication_safety_reviews',
      'medication_administrations',
      'ward_indent_inventory_receipt_events',
      'ward_indent_inventory_movement_links',
      'ward_indent_inventory_allocations',
      'ward_indent_events',
      'clinical_timeline_events',
      'clinical_audit_events',
      'billing_invoice_items',
      'billing_invoices',
      'pharmacy_schedule_register',
      'pharmacy_stock_movements',
      'pharmacy_inventory_batches',
      'pharmacy_inventory_items',
      'ward_indent_items',
      'ward_indents',
      'clinical_orders',
      'pharmacy_catalog',
      'wards',
      'staff',
      'audit_logs',
      'users',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, TENANT_ID);
    }
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID);
  });
}

async function setBatchState({
  batchStatus = 'depleted',
  expired = false,
  itemStatus = 'active',
}) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_inventory_items
          SET status = $3::text, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      product.inventoryItemId,
      itemStatus,
    );
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET status = $3::text,
              expiry_date = CASE
                WHEN $4::boolean THEN CURRENT_DATE - 1
                ELSE CURRENT_DATE + 365
              END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      product.inventoryBatchId,
      batchStatus,
      expired,
    );
  });
}

async function attemptReconciliation(commandKey) {
  return reconcileMarSupplyOverride(
    consumptionId,
    [{ inventory_allocation_id: allocationId, quantity: 1 }],
    {
      tenantId: TENANT_ID,
      reconciledBy: PHARMACIST_UID,
      commandKey,
      expectedMedicationAdministrationId: medicationAdministrationId,
    },
  );
}

describeIfDb('MAR supply reconciliation batch eligibility — database boundary', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MAR reconciliation eligibility', 'IN',
               'active', NOW(), NOW())`,
      TENANT_ID,
      `mar-reconcile-eligibility-${RUN}`.slice(0, 100),
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5::text, 'MAR Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $4::uuid, $6::text, 'MAR Nurse', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($3::uuid, $4::uuid, $7::text, 'MAR Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW())`,
      PATIENT_UID,
      NURSE_UID,
      PHARMACIST_UID,
      TENANT_ID,
      `+91961${String(Date.now() % 10_000_000).padStart(7, '0')}`,
      `+91962${String(Date.now() % 10_000_000).padStart(7, '0')}`,
      `+91963${String(Date.now() % 10_000_000).padStart(7, '0')}`,
    );

    const supply = await seedReceivedMedicationSupply({
      prisma,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      requesterUid: NURSE_UID,
      pharmacistUid: PHARMACIST_UID,
      receiverUid: NURSE_UID,
      run: `eligibility-${RUN}`,
      medications: [{
        key: 'eligibility',
        name: `MAR eligibility medicine ${RUN}`,
        dose: '10 mg',
        route: 'oral',
        strength: '10 mg',
        form: 'tablet',
        quantity: 2,
      }],
    });
    product = supply.products.eligibility;

    const [wardItem] = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM ward_indent_items
        WHERE tenant_id = $1::uuid AND clinical_order_id = $2::int`,
      TENANT_ID,
      product.clinicalOrderId,
    );
    const [allocation] = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid AND ward_indent_item_id = $2::int`,
      TENANT_ID,
      Number(wardItem.id),
    );
    wardIndentItemId = Number(wardItem.id);
    allocationId = BigInt(allocation.id);

    const [administration] = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route, scheduled_time,
          status, clinical_order_id, supply_quantity_per_dose)
       VALUES ($1::uuid, $2::uuid, $3::text, '10 mg', 'oral', NOW(),
               'scheduled', $4::int, 3)
       RETURNING *`,
      TENANT_ID,
      PATIENT_UID,
      product.name,
      product.clinicalOrderId,
    );
    medicationAdministrationId = Number(administration.id);
    const unmatched = await setTenantTx(TENANT_ID, (tx) => consumeMarSupplyTx(tx, {
      tenantId: TENANT_ID,
      administration,
      recordedBy: NURSE_UID,
      administrationMode: 'online_no_scan',
      commandKey: `mar-eligibility-unmatched-${RUN}`,
      supplyQuantity: 3,
      supplyOverrideReason: 'Documented downtime dose exceeds received custody and requires reconciliation',
    }));
    consumptionId = BigInt(unmatched.consumptions[0].id);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30_000);

  test('the shared SQL rule classifies all unsafe current custody states', async () => {
    const [classification] = await prisma.$queryRawUnsafe(
      `SELECT
         mar_supply_batch_unavailable_reason('active', 'recalled', CURRENT_DATE + 1, 1)
           AS recalled,
         mar_supply_batch_unavailable_reason('active', 'quarantined', CURRENT_DATE + 1, 1)
           AS quarantined,
         mar_supply_batch_unavailable_reason('active', 'reserved', CURRENT_DATE + 1, 1)
           AS reserved,
         mar_supply_batch_unavailable_reason('active', 'in_stock', CURRENT_DATE - 1, 1)
           AS expired,
         mar_supply_batch_unavailable_reason('inactive', 'in_stock', CURRENT_DATE + 1, 1)
            AS inactive,
         mar_supply_batch_unavailable_reason('active', 'depleted', CURRENT_DATE + 1, 1)
            AS depleted_with_ward_custody,
         mar_supply_batch_unavailable_reason(
           'active', 'in_stock', DATE '2026-08-28', 1,
           TIMESTAMPTZ '2026-08-28 18:29:00+00'
         ) AS before_kolkata_midnight,
         mar_supply_batch_unavailable_reason(
           'active', 'in_stock', DATE '2026-08-28', 1,
           TIMESTAMPTZ '2026-08-28 18:31:00+00'
         ) AS after_kolkata_midnight`,
    );
    expect(classification).toEqual({
      recalled: 'batch_recalled',
      quarantined: 'batch_quarantined',
      reserved: 'batch_reserved',
      expired: 'batch_expired',
      inactive: 'inventory_item_inactive',
      depleted_with_ward_custody: null,
      before_kolkata_midnight: null,
      after_kolkata_midnight: 'batch_expired',
    });
  });

  test.each([
    ['recalled', { batchStatus: 'recalled' }, 'batch_recalled'],
    ['quarantined', { batchStatus: 'quarantined' }, 'batch_quarantined'],
    ['reserved', { batchStatus: 'reserved' }, 'batch_reserved'],
    ['expired', { expired: true }, 'batch_expired'],
    ['inactive product', { itemStatus: 'inactive' }, 'inventory_item_inactive'],
  ])('the service rejects %s custody without a partial write', async (_label, state, reason) => {
    await setBatchState(state);
    await expect(attemptReconciliation(
      `mar-eligibility-${reason}-${RUN}`,
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_SUPPLY_RECONCILIATION_BATCH_UNAVAILABLE',
      details: { reason },
    });
    const [counts] = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM mar_supply_reconciliation_links
           WHERE tenant_id = $1::uuid
             AND unmatched_consumption_id = $2::bigint) AS link_count,
         (SELECT consumed_quantity
            FROM ward_indent_inventory_allocations
           WHERE tenant_id = $1::uuid AND id = $3::bigint) AS consumed_quantity`,
      TENANT_ID,
      consumptionId,
      allocationId,
    );
    expect(counts.link_count).toBe(0);
    expect(Number(counts.consumed_quantity)).toBe(0);
  });

  test('the database trigger rejects a direct bypass against recalled custody', async () => {
    await setBatchState({ batchStatus: 'recalled' });
    let failure;
    try {
      await setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
        `INSERT INTO mar_supply_reconciliation_links
           (tenant_id, unmatched_consumption_id, clinical_order_id,
            ward_indent_item_id, inventory_allocation_id, inventory_batch_id,
            quantity, command_key, reconciled_by)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::bigint, $6::int,
                 1, $7::text, $8::uuid)`,
        TENANT_ID,
        consumptionId,
        product.clinicalOrderId,
        wardIndentItemId,
        allocationId,
        product.inventoryBatchId,
        `mar-eligibility-direct-bypass-${RUN}`,
        PHARMACIST_UID,
      ));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const evidence = [
      failure?.message,
      failure?.meta?.driverAdapterError?.cause?.message,
      failure?.meta?.driverAdapterError?.cause?.originalMessage,
      failure?.meta?.code,
      failure?.meta?.driverAdapterError?.cause?.code,
      failure?.meta?.driverAdapterError?.cause?.originalCode,
    ].filter(Boolean).join(' ');
    expect(evidence).toContain('currently eligible ward batch custody');
    expect(evidence).toContain('23514');
  });

  test('concurrent exact commands commit once, and replay remains historical after recall', async () => {
    await setBatchState({});
    const commandKey = `mar-eligibility-concurrent-${RUN}`;
    const [first, concurrentReplay] = await Promise.all([
      attemptReconciliation(commandKey),
      attemptReconciliation(commandKey),
    ]);
    expect(concurrentReplay).toEqual(first);

    const [counts] = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM mar_supply_reconciliation_links
           WHERE tenant_id = $1::uuid
             AND unmatched_consumption_id = $2::bigint) AS link_count,
         (SELECT COUNT(*)::int
            FROM mar_supply_reconciliation_command_receipts
           WHERE tenant_id = $1::uuid AND command_key = $3::text) AS receipt_count,
         (SELECT consumed_quantity
            FROM ward_indent_inventory_allocations
           WHERE tenant_id = $1::uuid AND id = $4::bigint) AS consumed_quantity`,
      TENANT_ID,
      consumptionId,
      commandKey,
      allocationId,
    );
    expect(counts.link_count).toBe(1);
    expect(counts.receipt_count).toBe(1);
    expect(Number(counts.consumed_quantity)).toBe(1);

    await setBatchState({ batchStatus: 'recalled' });
    await expect(attemptReconciliation(commandKey)).resolves.toEqual(first);
  });
});
