import { Client } from 'pg';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  approveInventoryDisposalWitnessApproval,
  disposeInventoryBatch,
  listScheduleRegister,
  requestInventoryDisposalWitnessApproval,
} from '../services/pharmacy/inventoryV2Service.js';
import {
  addInventoryBatch,
  appendStockMovement,
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
        `DELETE FROM audit_logs
          WHERE tenant_id = $1::uuid
            AND action = 'PHARMACY_INVENTORY_DISPOSED'`,
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
            AND subject_resource_type IN (
              'inventory_controlled_movement',
              'pharmacy_inventory_controlled_disposal'
            )`,
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

      const receive = (batchId, referenceId, fingerprintCharacter) => appendStockMovement({
        tenantId: TENANT,
        inventoryItemId: controlledItemId,
        inventoryBatchId: batchId,
        movementKind: 'receive',
        quantityDelta: 5,
        referenceType: 'med03_controlled_lock_test',
        referenceId,
        performedBy: ACTOR,
        actorRole: 'PHARMACY_INCHARGE',
        commandKey: `med03-controlled-lock-${referenceId}`,
        requestFingerprint: fingerprintCharacter.repeat(64),
      });
      movementPromises = [
        receive(controlledBatchA, 'batch-a', 'a'),
        receive(controlledBatchB, 'batch-b', 'b'),
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
    await expect(appendStockMovement({
      tenantId: TENANT,
      inventoryItemId: recallItemId,
      inventoryBatchId: recallBatchId,
      movementKind: 'recall',
      quantityDelta: -12,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    })).rejects.toMatchObject({
      code: 'INVENTORY_RECALL_REQUIRES_BATCH_RECALL_PATH',
      statusCode: 409,
    });

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

    const disposalIntent = {
      tenantId: TENANT,
      facility_id: facilityId,
      inventory_item_id: recallItemId,
      inventory_batch_id: recallBatchId,
      quantity: 12,
      reason_code: 'regulatory_recall',
      disposition_method: 'witnessed_destruction',
      authority_reference: recallReference,
      notes: 'Witnessed destruction of recalled stock',
      expected_batch_number: 'MED03-RECALL-A',
    };
    const disposal = {
      ...disposalIntent,
      performed_by: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      commandKey: 'med03-recalled-batch-disposal',
      requestFingerprint: 'c'.repeat(64),
    };
    await expect(disposeInventoryBatch(disposal)).rejects.toMatchObject({
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

    const approval = await requestInventoryDisposalWitnessApproval({
      ...disposalIntent,
      requested_by: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    const approved = await approveInventoryDisposalWitnessApproval({
      tenantId: TENANT,
      approvalId: approval.id,
      actorUid: WITNESS,
      requesterUid: ACTOR,
      disposal: disposalIntent,
    });
    expect(approved.witness).toMatchObject({
      uid: WITNESS,
      name: 'MED03 Disposal Witness',
      role: 'PHARMACY_STAFF',
    });

    const disposed = await disposeInventoryBatch({
      ...disposal,
      witness_approval_id: approval.id,
    });
    expect(disposed).toMatchObject({
      idempotent_replay: false,
      disposal: {
        contract: 'pharmacy_inventory_disposal_v1',
        facility_id: facilityId,
        inventory_item_id: recallItemId,
        inventory_batch_id: recallBatchId,
        quantity: 12,
        reason_code: 'regulatory_recall',
        disposition_method: 'witnessed_destruction',
        authority_reference: recallReference,
        source_batch_status: 'recalled',
        resulting_batch_status: 'disposed',
        witness_approval_id: String(approval.id),
        performed_by: ACTOR,
        witness_uid: WITNESS,
      },
    });
    expect(disposed.register_entry).toMatchObject({
      movement_kind: 'dispose',
      witness_uid: WITNESS,
    });

    const replay = await disposeInventoryBatch({
      ...disposal,
      witness_approval_id: approval.id,
    });
    expect(replay).toMatchObject({
      idempotent_replay: true,
      disposal: {
        movement_id: disposed.disposal.movement_id,
        schedule_register_id: disposed.disposal.schedule_register_id,
        witness_approval_id: String(approval.id),
        witness_uid: WITNESS,
      },
    });
    await expect(disposeInventoryBatch({
      ...disposal,
      witness_approval_id: approval.id,
      requestFingerprint: 'e'.repeat(64),
    })).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_IDEMPOTENCY_MISMATCH',
      statusCode: 409,
    });

    const finalBatch = (await prisma.$queryRawUnsafe(
      `SELECT status, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      recallBatchId,
    ))[0];
    expect(finalBatch.status).toBe('disposed');
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

  test('keeps governed tenant-scoped receipt, durable replay, reads, and forecast projection working', async () => {
    const receipt = {
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
    };
    const batch = await addInventoryBatch(receipt);
    const replayedBatch = await addInventoryBatch(receipt);
    expect(Number(replayedBatch.id)).toBe(Number(batch.id));
    expect(replayedBatch).toMatchObject({
      batch_number: 'MED03-TENANT-BATCH',
      facility_id: facilityId,
      inventory_item_id: otcItemId,
    });
    expect(Number(replayedBatch.remaining_quantity)).toBe(100);

    const movements = await listStockMovements({
      tenantId: TENANT,
      facilityId,
      inventoryItemId: otcItemId,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0]).toMatchObject({
      movement_kind: 'receive',
      inventory_item_id: otcItemId,
    });
    expect(Number(movements.movements[0].quantity_delta)).toBe(100);

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
      on_hand: 100,
      consumption_per_day: 0,
      days_to_reorder: null,
      alert_written: false,
    });

    const otcRegisterRows = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid AND inventory_item_id = $2::int`,
      TENANT,
      otcItemId,
    );
    expect(otcRegisterRows).toHaveLength(0);

    const otherFacilityId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, 'MED03-OTHER-PHARMACY', 'MED03 Other Pharmacy', 'active', FALSE)
       RETURNING id`,
      TENANT,
    ))[0].id);
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO pharmacy_staff_facility_grants
         (tenant_id, facility_id, staff_uid, status, grant_source,
          grant_reason, granted_by)
       VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'test_fixture',
               'Cross-facility register exclusion fixture', $3::uuid)`,
      TENANT,
      otherFacilityId,
      ACTOR,
    ));
    const otherSupplierId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_suppliers
         (tenant_id, facility_id, supplier_code, display_name, status)
       VALUES ($1::uuid, $2::int, 'MED03-OTHER-SUPPLIER', 'MED03 Other Supplier', 'active')
       RETURNING id`,
      TENANT,
      otherFacilityId,
    ))[0].id);
    const otherLocationId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, status)
       VALUES ($1::uuid, $2::int, 'MED03-OTHER-STORE', 'MED03 Other Store', 'active')
       RETURNING id`,
      TENANT,
      otherFacilityId,
    ))[0].id);
    const otherCatalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, is_available, in_stock)
       VALUES ($1::uuid, 'MED03 other H1 catalog', TRUE, TRUE, TRUE)
       RETURNING id`,
      TENANT,
    ))[0].id);
    const otherItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, catalog_id, default_supplier_id,
          sku_code, display_name, unit_label, schedule_class, is_narcotic, status)
       VALUES ($1::uuid, $2::int, $3::int, $4::int,
               'MED03-OTHER-H1', 'MED03 Other H1 Item', 'unit', 'H1', FALSE, 'active')
       RETURNING id`,
      TENANT,
      otherFacilityId,
      otherCatalogId,
      otherSupplierId,
    ))[0].id);
    const otherBatchId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, supplier_id,
          storage_location_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::int,
               'MED03-OTHER-BATCH', (NOW() + INTERVAL '365 days')::date,
               9, 9, 'in_stock')
       RETURNING id`,
      TENANT,
      otherItemId,
      otherFacilityId,
      otherSupplierId,
      otherLocationId,
    ))[0].id);
    await appendStockMovement({
      tenantId: TENANT,
      facilityId: otherFacilityId,
      inventoryItemId: otherItemId,
      inventoryBatchId: otherBatchId,
      movementKind: 'receive',
      quantityDelta: 1,
      referenceType: 'med03_cross_facility_register_test',
      referenceId: 'other-facility',
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      commandKey: 'med03-cross-facility-register-test',
      requestFingerprint: '9'.repeat(64),
    });
    const otherRegisterRows = await prisma.$queryRawUnsafe(
      `SELECT facility_id, inventory_item_id, inventory_batch_id
         FROM pharmacy_schedule_register
        WHERE tenant_id=$1::uuid
          AND facility_id=$2::int
          AND inventory_item_id=$3::int
          AND inventory_batch_id=$4::int`,
      TENANT,
      otherFacilityId,
      otherItemId,
      otherBatchId,
    );
    expect(otherRegisterRows).toHaveLength(1);

    const registerRows = await listScheduleRegister({
      tenantId: TENANT,
      facility_id: facilityId,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      schedule_class: 'H1',
      limit: 20,
    });
    expect(registerRows).toHaveLength(2);
    expect(registerRows.map((row) => Number(row.running_balance)).sort((a, b) => a - b))
      .toEqual([25, 30]);
    expect(new Set(registerRows.map((row) => Number(row.facility_id))))
      .toEqual(new Set([facilityId]));
    expect(new Set(registerRows.map((row) => Number(row.inventory_item_id))))
      .toEqual(new Set([controlledItemId]));
    expect(new Set(registerRows.map((row) => Number(row.inventory_batch_id))))
      .toEqual(new Set([controlledBatchA, controlledBatchB]));
    expect(registerRows.every((row) => row.sku_code === 'MED03-LOCK-H1')).toBe(true);
    expect(registerRows.some((row) => Number(row.facility_id) === otherFacilityId)).toBe(false);
    expect(registerRows.some((row) => Number(row.inventory_item_id) === otherItemId)).toBe(false);
    expect(registerRows.some((row) => Number(row.inventory_batch_id) === otherBatchId)).toBe(false);
  });
});
