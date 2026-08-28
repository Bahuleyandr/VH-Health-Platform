import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import {
  approveInventoryMovementWitnessApproval,
  listScheduleRegister,
  recordMovement,
  requestControlledMovementWitnessApproval,
} from '../services/pharmacy/inventoryV2Service.js';
import {
  addInventoryBatch,
  appendStockMovement,
  bridgeForecastToBatches,
  listStockMovements,
  recallBatch,
  reserveStock,
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
  let reservationItemId;
  let reservationBatchId;
  let emptyReservationItemId;

  async function cleanup() {
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
    });
  }

  async function seedItem({ sku, scheduleClass, reorderLevel = null }) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, unit_label, schedule_class,
          is_narcotic, reorder_level, status)
       VALUES ($1::uuid, $2, $3, 'unit', $4, false, $5::numeric, 'active')
       RETURNING id`,
      TENANT,
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
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3,
               (NOW() + INTERVAL '365 days')::date,
               $4::numeric, $4::numeric, 'in_stock')
       RETURNING id`,
      TENANT,
      itemId,
      batchNumber,
      quantity,
    );
    return Number(rows[0].id);
  }

  async function seedReservationClaim({ commandKey, requestFingerprint }) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO idempotency_keys
         (tenant_id, user_uid, request_key, request_method, request_path,
          request_body_hash, status)
       VALUES ($1::uuid, $2::uuid, $3, 'POST',
               '/api/v1/admin/pharmacy-supply/reserve-stock', $4::char(64), 'in_flight')
       RETURNING id`,
      TENANT,
      ACTOR,
      commandKey,
      requestFingerprint,
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
    reservationItemId = await seedItem({
      sku: 'MED03-RESERVATION-OTC',
      scheduleClass: 'OTC',
    });
    reservationBatchId = await seedBatch(
      reservationItemId,
      'MED03-RESERVATION-BATCH',
      50,
    );
    emptyReservationItemId = await seedItem({
      sku: 'MED03-RESERVATION-ZERO-OTC',
      scheduleClass: 'OTC',
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
    });
    expect(recallReplay).toEqual(recalled);
    await expect(recallBatch({
      tenantId: TENANT,
      id: recallBatchId,
      recallReference: 'MED03-CDSCO-RECALL-CHANGED',
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

  test('serializes a durable reservation command and rejects a changed replay', async () => {
    const commandKey = 'med03-reservation-concurrent-001';
    const requestFingerprint = 'a'.repeat(64);
    const httpIdempotencyClaimId = await seedReservationClaim({
      commandKey,
      requestFingerprint,
    });
    const command = {
      tenantId: TENANT,
      inventoryItemId: reservationItemId,
      quantity: 15,
      movementKind: 'issue',
      referenceType: 'ward_stock_request',
      referenceId: 'MED03-RESERVE-001',
      performedBy: ACTOR,
      notes: 'Concurrent reservation replay proof',
      commandKey,
      requestFingerprint,
      httpIdempotencyClaimId,
    };

    const results = await Promise.all([
      reserveStock(command),
      reserveStock(command),
    ]);
    expect(results.map((result) => result.idempotent_replay === true).sort())
      .toEqual([false, true]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ requested: 15, fulfilled: 15, short_by: 0 }),
      expect.objectContaining({
        requested: 15,
        fulfilled: 15,
        short_by: 0,
        idempotent_replay: true,
      }),
    ]));

    const afterExactReplay = (await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      reservationBatchId,
    ))[0];
    expect(Number(afterExactReplay.remaining_quantity)).toBe(35);
    const movementCount = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM pharmacy_stock_movements
        WHERE tenant_id = $1::uuid
          AND inventory_item_id = $2::int
          AND reference_type = 'pharmacy_supply_reservation'`,
      TENANT,
      reservationItemId,
    ))[0];
    expect(movementCount.count).toBe(1);

    await expect(reserveStock({
      ...command,
      quantity: 16,
      requestFingerprint: 'b'.repeat(64),
      httpIdempotencyClaimId: 744002,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'PHARMACY_SUPPLY_RESERVATION_COMMAND_MISMATCH',
    });
    const afterMismatch = (await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      reservationBatchId,
    ))[0];
    expect(Number(afterMismatch.remaining_quantity)).toBe(35);
  });

  test('permanently replays zero fulfilment after later stock replenishment', async () => {
    const commandKey = 'med03-reservation-zero-001';
    const requestFingerprint = 'e'.repeat(64);
    const httpIdempotencyClaimId = await seedReservationClaim({
      commandKey,
      requestFingerprint,
    });
    const command = {
      tenantId: TENANT,
      inventoryItemId: emptyReservationItemId,
      quantity: 8,
      movementKind: 'issue',
      referenceType: 'ward_stock_request',
      referenceId: 'MED03-RESERVE-ZERO-001',
      performedBy: ACTOR,
      notes: 'Zero-stock reservation replay proof',
      commandKey,
      requestFingerprint,
      httpIdempotencyClaimId,
      requestId: 'med03-zero-request-001',
    };

    const first = await reserveStock(command);
    expect(first).toEqual({ requested: 8, fulfilled: 0, short_by: 8, consumed: [] });

    const receipt = (await prisma.$queryRawUnsafe(
      `SELECT status, response_status, response_body,
              (expires_at = 'infinity'::timestamptz) AS is_immutable
         FROM idempotency_keys
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      httpIdempotencyClaimId,
      TENANT,
    ))[0];
    expect(receipt).toMatchObject({
      status: 'complete',
      response_status: 200,
      is_immutable: true,
    });
    expect(receipt.response_body).toEqual({
      success: true,
      message: 'Stock reserved (FEFO)',
      data: first,
      requestId: 'med03-zero-request-001',
    });

    const replenishedBatchId = await seedBatch(
      emptyReservationItemId,
      'MED03-RESERVATION-ZERO-REPLENISHED',
      25,
    );
    const replay = await reserveStock(command);
    expect(replay).toEqual(first);

    const batchAfterReplay = (await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      replenishedBatchId,
    ))[0];
    expect(Number(batchAfterReplay.remaining_quantity)).toBe(25);
    const movementCount = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM pharmacy_stock_movements
        WHERE tenant_id = $1::uuid
          AND inventory_item_id = $2::int`,
      TENANT,
      emptyReservationItemId,
    ))[0];
    expect(movementCount.count).toBe(0);
  });

  test('rejects increasing labels before touching controlled inventory', async () => {
    const before = await prisma.$queryRawUnsafe(
      `SELECT id, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid
          AND inventory_item_id = $2::int
        ORDER BY id`,
      TENANT,
      controlledItemId,
    );
    for (const movementKind of ['receive', 'return']) {
      await expect(reserveStock({
        tenantId: TENANT,
        inventoryItemId: controlledItemId,
        quantity: 1,
        movementKind,
        performedBy: ACTOR,
        commandKey: `med03-controlled-${movementKind}`,
        requestFingerprint: movementKind === 'receive' ? 'c'.repeat(64) : 'd'.repeat(64),
      })).rejects.toMatchObject({
        statusCode: 400,
        code: 'PHARMACY_SUPPLY_RESERVATION_MOVEMENT_KIND_INVALID',
      });
    }
    const after = await prisma.$queryRawUnsafe(
      `SELECT id, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid
          AND inventory_item_id = $2::int
        ORDER BY id`,
      TENANT,
      controlledItemId,
    );
    expect(after.map((row) => [Number(row.id), Number(row.remaining_quantity)]))
      .toEqual(before.map((row) => [Number(row.id), Number(row.remaining_quantity)]));
  });

  test('keeps normal tenant-scoped inventory writes, reads, and forecast consumption working', async () => {
    const batch = await addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: otcItemId,
      batchNumber: 'MED03-TENANT-BATCH',
      expiryDate: '2028-12-31',
      receivedQuantity: 100,
      performedBy: ACTOR,
    });
    await appendStockMovement({
      tenantId: TENANT,
      inventoryItemId: otcItemId,
      inventoryBatchId: batch.id,
      movementKind: 'issue',
      quantityDelta: -30,
      performedBy: ACTOR,
      notes: 'tenant-scoped forecast usage',
    });

    const movements = await listStockMovements({
      tenantId: TENANT,
      inventoryItemId: otcItemId,
    });
    expect(movements.movements).toHaveLength(2);
    expect(movements.movements.map((row) => row.movement_kind).sort())
      .toEqual(['issue', 'receive']);

    const forecast = await bridgeForecastToBatches({
      tenantId: TENANT,
      lookbackDays: 30,
    });
    const otcForecast = forecast.items.find(
      (row) => Number(row.inventory_item_id) === otcItemId,
    );
    expect(otcForecast).toMatchObject({
      inventory_item_id: otcItemId,
      on_hand: 100,
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
