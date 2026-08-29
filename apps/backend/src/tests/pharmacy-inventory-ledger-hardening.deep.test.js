import { Client } from 'pg';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  approveInventoryMovementWitnessApproval,
  listScheduleRegister,
  recordMovement,
  requestControlledMovementWitnessApproval,
} from '../services/pharmacy/inventoryV2Service.js';
import {
  addInventoryBatch,
  bridgeForecastToBatches,
  listStockMovements,
  recallBatch,
} from '../services/pharmacySupply/pharmacySupplyService.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000c0744a11';
const ACTOR = 'c0744a11-0000-4000-8000-000000000001';
const WITNESS = 'c0744a11-0000-4000-8000-000000000002';

async function waitForAdvisoryWaiter(client, blockerPid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const waiting = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity activity
        WHERE $1::int = ANY(pg_blocking_pids(activity.pid))`,
      [blockerPid],
    );
    if (waiting.rows[0]?.count >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the controlled-register item lock');
}

describeIfDb('pharmacy inventory ledger tenant and serialization hardening', () => {
  let controlledItemId;
  let controlledBatchA;
  let controlledBatchB;
  let recallItemId;
  let recallBatchId;
  let otcItemId;
  let facilityId;
  let storageLocationId;
  let supplierId;

  async function cleanup() {
    await setTenantTx(TENANT, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grant_events WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grants WHERE tenant_id=$1::uuid`,
        TENANT,
      );
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM idempotency_keys WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_ai_inventory_alerts WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_schedule_register WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_batches WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_items WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_suppliers WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM facility_locations WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM approvals
          WHERE tenant_id = $1::uuid
            AND subject_resource_type = 'inventory_controlled_movement'`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM staff
          WHERE tenant_id = $1::uuid AND user_id IN ($2::uuid, $3::uuid)`,
        TENANT,
        ACTOR,
        WITNESS,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users
          WHERE tenant_id = $1::uuid AND uid IN ($2::uuid, $3::uuid)`,
        TENANT,
        ACTOR,
        WITNESS,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM facilities WHERE tenant_id=$1::uuid`,
        TENANT,
      );
    });
  }

  async function seedItem({ sku, scheduleClass, reorderLevel = null }) {
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, is_available, in_stock)
       VALUES ($1::uuid, $2, TRUE, TRUE, TRUE)
       RETURNING id`,
      TENANT,
      `${sku} test catalog`,
    );
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, catalog_id, default_supplier_id,
          sku_code, display_name, unit_label, schedule_class,
          is_narcotic, reorder_level, status)
       VALUES ($1::uuid, $2::int, $3::int, $4::int, $5, $6,
               'unit', $7, false, $8::numeric, 'active')
       RETURNING id`,
      TENANT,
      facilityId,
      Number(catalogRows[0].id),
      supplierId,
      sku,
      `${sku} test item`,
      scheduleClass,
      reorderLevel,
    );
    return Number(rows[0].id);
  }

  async function seedBatch(itemId, batchNumber, quantity) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, supplier_id,
          storage_location_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::int, $6,
               (NOW() + INTERVAL '365 days')::date,
               $7::numeric, $7::numeric, 'in_stock')
       RETURNING id`,
      TENANT,
      itemId,
      facilityId,
      supplierId,
      storageLocationId,
      batchNumber,
      quantity,
    );
    return Number(rows[0].id);
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, 'med03-ledger-hardening', 'MED03 Ledger Hardening',
               'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    const facilityRows = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, 'MED03-PHARMACY', 'MED03 Pharmacy', 'active', TRUE)
       RETURNING id`,
      TENANT,
    );
    facilityId = Number(facilityRows[0].id);
    const storageLocationRows = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, status)
       VALUES ($1::uuid, $2::int, 'MED03-PHARMACY-STORE',
               'MED03 Pharmacy Store', 'active')
       RETURNING id`,
      TENANT,
      facilityId,
    );
    storageLocationId = Number(storageLocationRows[0].id);
    const supplierRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_suppliers
         (tenant_id, facility_id, supplier_code, display_name, status)
       VALUES ($1::uuid, $2::int, 'MED03-SUPPLIER', 'MED03 Supplier', 'active')
       RETURNING id`,
      TENANT,
      facilityId,
    );
    supplierId = Number(supplierRows[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, name, role, tenant_id, is_active, status, updated_at)
        VALUES ($1::uuid, 'MED03 Pharmacist', 'PHARMACY_INCHARGE',
                $3::uuid, true, 'active', NOW()),
               ($2::uuid, 'MED03 Disposal Witness', 'PHARMACY_STAFF',
                $3::uuid, true, 'active', NOW())
        ON CONFLICT (uid) DO NOTHING`,
      ACTOR,
      WITNESS,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'MED03-ACTOR', 'MED03 Pharmacist', 'Pharmacist',
          '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW()),
         ($1::uuid, $3::uuid, 'MED03-WITNESS', 'MED03 Disposal Witness',
          'Pharmacist', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
      TENANT,
      ACTOR,
      WITNESS,
    );
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO pharmacy_staff_facility_grants
         (tenant_id, facility_id, staff_uid, status, grant_source,
          grant_reason, granted_by)
       VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'test_fixture',
               'MED03 pharmacy ledger authority fixture', $3::uuid)`,
      TENANT,
      facilityId,
      ACTOR,
    ));

    controlledItemId = await seedItem({
      sku: 'MED03-LOCK-H1',
      scheduleClass: 'H1',
    });
    controlledBatchA = await seedBatch(controlledItemId, 'MED03-LOCK-A', 10);
    controlledBatchB = await seedBatch(controlledItemId, 'MED03-LOCK-B', 10);

    recallItemId = await seedItem({
      sku: 'MED03-RECALL-X',
      scheduleClass: 'X',
    });
    recallBatchId = await seedBatch(recallItemId, 'MED03-RECALL-A', 12);

    otcItemId = await seedItem({
      sku: 'MED03-TENANT-OTC',
      scheduleClass: 'OTC',
      reorderLevel: 10,
    });
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('serializes different-batch controlled movements into item-wide running balances', async () => {
    const blocker = new Client({ connectionString: DATABASE_URL });
    await blocker.connect();
    let blockerCommitted = false;
    let movementPromises = [];
    try {
      await blocker.query('BEGIN');
      const pidRows = await blocker.query('SELECT pg_backend_pid() AS pid');
      const blockerPid = pidRows.rows[0].pid;
      await blocker.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`pharmacy-controlled-register:${TENANT}:${controlledItemId}`],
      );

      const receive = (batchId, referenceId) => recordMovement({
        tenantId: TENANT,
        inventory_item_id: controlledItemId,
        inventory_batch_id: batchId,
        movement_kind: 'receive',
        quantity: 5,
        reference_type: 'med03_controlled_lock_test',
        reference_id: referenceId,
        performed_by: ACTOR,
        expected_facility_id: facilityId,
      });
      movementPromises = [
        receive(controlledBatchA, 'batch-a'),
        receive(controlledBatchB, 'batch-b'),
      ];
      const movements = Promise.all(movementPromises);
      movements.catch(() => {});

      await waitForAdvisoryWaiter(blocker, blockerPid);
      await blocker.query('COMMIT');
      blockerCommitted = true;
      await movements;
    } finally {
      if (!blockerCommitted) await blocker.query('ROLLBACK').catch(() => {});
      if (!blockerCommitted) await Promise.allSettled(movementPromises);
      await blocker.end();
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT running_balance
         FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid
          AND inventory_item_id = $2::int
        ORDER BY running_balance::numeric`,
      TENANT,
      controlledItemId,
    );
    expect(rows.map((row) => Number(row.running_balance))).toEqual([25, 30]);

    const batches = await prisma.$queryRawUnsafe(
      `SELECT id, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid
          AND id IN ($2::int, $3::int)
        ORDER BY id`,
      TENANT,
      controlledBatchA,
      controlledBatchB,
    );
    expect(batches.map((row) => Number(row.remaining_quantity))).toEqual([15, 15]);
  }, 30_000);

  test('recall is status-only and witnessed disposal decrements exactly once', async () => {
    const recallReference = 'MED03-CDSCO-RECALL-001';
    const recalled = await recallBatch({
      tenantId: TENANT,
      id: recallBatchId,
      recallReference,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(recalled).toMatchObject({
      id: recallBatchId,
      status: 'recalled',
      recall_reference: recallReference,
    });
    expect(Number(recalled.remaining_quantity)).toBe(12);

    const recallReplay = await recallBatch({
      tenantId: TENANT,
      id: recallBatchId,
      recallReference,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(recallReplay).toEqual(recalled);
    await expect(recallBatch({
      tenantId: TENANT,
      id: recallBatchId,
      recallReference: 'MED03-CDSCO-RECALL-CHANGED',
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    })).rejects.toMatchObject({ code: 'BATCH_RECALL_REPLAY_MISMATCH' });

    const afterRecall = (await prisma.$queryRawUnsafe(
      `SELECT status, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      recallBatchId,
    ))[0];
    expect(afterRecall.status).toBe('recalled');
    expect(Number(afterRecall.remaining_quantity)).toBe(12);
    const recallEvidence = (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM pharmacy_stock_movements
           WHERE tenant_id = $1::uuid AND inventory_batch_id = $2::int) AS movement_count,
         (SELECT COUNT(*)::int FROM pharmacy_schedule_register
           WHERE tenant_id = $1::uuid AND inventory_batch_id = $2::int) AS register_count`,
      TENANT,
      recallBatchId,
    ))[0];
    expect(recallEvidence).toMatchObject({ movement_count: 0, register_count: 0 });

    const disposal = {
      tenantId: TENANT,
      inventory_item_id: recallItemId,
      inventory_batch_id: recallBatchId,
      movement_kind: 'dispose',
      quantity: 12,
      reference_type: 'batch_recall_disposal',
      reference_id: recallReference,
      notes: 'Witnessed destruction of recalled stock',
      expected_batch_number: 'MED03-RECALL-A',
      performed_by: ACTOR,
      expected_facility_id: facilityId,
    };
    await expect(recordMovement(disposal)).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
    });

    const afterMissingApproval = (await prisma.$queryRawUnsafe(
      `SELECT status, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      recallBatchId,
    ))[0];
    expect(afterMissingApproval.status).toBe('recalled');
    expect(Number(afterMissingApproval.remaining_quantity)).toBe(12);

    const approval = await requestControlledMovementWitnessApproval({
      ...disposal,
      requested_by: ACTOR,
    });
    await approveInventoryMovementWitnessApproval({
      tenantId: TENANT,
      approvalId: approval.id,
      actorUid: WITNESS,
      requesterUid: ACTOR,
      movement: disposal,
    });
    const disposed = await recordMovement({
      ...disposal,
      witness_approval_id: approval.id,
    });
    expect(disposed.register_entry).toMatchObject({
      movement_kind: 'dispose',
      witness_uid: WITNESS,
    });

    await expect(recordMovement({
      ...disposal,
      witness_approval_id: approval.id,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONSUMED' });

    const finalBatch = (await prisma.$queryRawUnsafe(
      `SELECT status, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      recallBatchId,
    ))[0];
    expect(finalBatch.status).toBe('depleted');
    expect(Number(finalBatch.remaining_quantity)).toBe(0);
    const movementRows = await prisma.$queryRawUnsafe(
      `SELECT movement_kind, quantity_delta
         FROM pharmacy_stock_movements
        WHERE tenant_id = $1::uuid AND inventory_batch_id = $2::int
        ORDER BY id`,
      TENANT,
      recallBatchId,
    );
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0].movement_kind).toBe('dispose');
    expect(Number(movementRows[0].quantity_delta)).toBe(-12);
    const registerRows = await prisma.$queryRawUnsafe(
      `SELECT movement_kind, quantity, witness_uid::text
         FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid AND inventory_batch_id = $2::int
        ORDER BY id`,
      TENANT,
      recallBatchId,
    );
    expect(registerRows).toHaveLength(1);
    expect(registerRows[0]).toMatchObject({
      movement_kind: 'dispose',
      witness_uid: WITNESS,
    });
    expect(Number(registerRows[0].quantity)).toBe(12);
  });

  test('keeps normal tenant-scoped inventory writes, reads, and forecast consumption working', async () => {
    const batch = await addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: otcItemId,
      facilityId,
      supplierId,
      storageLocationId,
      batchNumber: 'MED03-TENANT-BATCH',
      expiryDate: '2099-12-31',
      receivedQuantity: 100,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      commandKey: 'med03-direct-receive',
      requestFingerprint: 'd'.repeat(64),
    });
    await recordMovement({
      tenantId: TENANT,
      inventory_item_id: otcItemId,
      inventory_batch_id: batch.id,
      movement_kind: 'issue',
      quantity: 30,
      performed_by: ACTOR,
      expected_facility_id: facilityId,
      notes: 'tenant-scoped forecast usage',
    });

    const movements = await listStockMovements({
      tenantId: TENANT,
      facilityId,
      inventoryItemId: otcItemId,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(movements.movements).toHaveLength(2);
    expect(movements.movements.map((row) => row.movement_kind).sort())
      .toEqual(['issue', 'receive']);

    const forecast = await bridgeForecastToBatches({
      tenantId: TENANT,
      facilityId,
      lookbackDays: 30,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    const otcForecast = forecast.items.find(
      (row) => Number(row.inventory_item_id) === otcItemId,
    );
    expect(otcForecast).toMatchObject({
      inventory_item_id: otcItemId,
      on_hand: 70,
      consumption_per_day: 1,
      alert_written: false,
    });

    const registerRows = await listScheduleRegister({
      tenantId: TENANT,
      schedule_class: 'H1',
      limit: 20,
    });
    expect(registerRows).toHaveLength(2);
    expect(registerRows.map((row) => Number(row.running_balance)).sort((a, b) => a - b))
      .toEqual([25, 30]);
  });
});
