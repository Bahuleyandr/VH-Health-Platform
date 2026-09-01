// Deep integration coverage for the typed pharmacy inventory custody paths.
// The retired generic movement endpoint is intentionally not exercised here:
// recall is status-only, direct receipt owns its receive ledger entry, and
// controlled disposal owns its independently witnessed statutory register.
import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  approveInventoryDisposalWitnessApproval,
  disposeInventoryBatch,
  requestInventoryDisposalWitnessApproval,
} from '../services/pharmacy/inventoryV2Service.js';
import { grantPharmacyFacilityAuthority } from '../services/pharmacy/pharmacyFacilityAuthorityService.js';
import {
  addInventoryBatch,
  recallBatch,
} from '../services/pharmacySupply/pharmacySupplyService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000c07701e1';
const ACTOR = 'c0770000-0000-4000-8000-0000000000a1';
const WITNESS = 'c0770000-0000-4000-8000-0000000000a2';
const ADMIN = 'c0770000-0000-4000-8000-0000000000a3';
const EXPIRY_DATE = '2099-12-31';

describeIfDb('typed pharmacy inventory custody workflows', () => {
  let facilityId;
  let storageLocationId;
  let supplierId;
  let xRecallItemId;
  let xRecallBatchId;
  let otcRecallItemId;
  let otcRecallBatchId;
  let xDisposeItemId;
  let xDisposeBatchId;
  let h1ItemId;
  let h1BaselineBatchId;

  async function cleanup() {
    await setTenantTx(TENANT, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
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
      for (const sql of [
        `DELETE FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid`,
        `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid`,
        `DELETE FROM approvals WHERE tenant_id=$1::uuid`,
        `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid`,
        `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid`,
        `DELETE FROM pharmacy_catalog WHERE tenant_id=$1::uuid`,
        `DELETE FROM pharmacy_suppliers WHERE tenant_id=$1::uuid`,
        `DELETE FROM facility_locations WHERE tenant_id=$1::uuid`,
        `DELETE FROM staff WHERE tenant_id=$1::uuid`,
        `DELETE FROM users WHERE tenant_id=$1::uuid`,
        `DELETE FROM facilities WHERE tenant_id=$1::uuid`,
      ]) {
        await tx.$executeRawUnsafe(sql, TENANT);
      }
    });
  }

  async function seedItem({ sku, name, scheduleClass, isNarcotic = false }) {
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, is_available, in_stock)
       VALUES ($1::uuid, $2, TRUE, TRUE, TRUE)
       RETURNING id`,
      TENANT,
      `${name} catalog`,
    );
    const itemRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, catalog_id, default_supplier_id,
          sku_code, display_name, unit_label, schedule_class,
          is_narcotic, status)
       VALUES ($1::uuid, $2::int, $3::int, $4::int,
               $5, $6, 'unit', $7, $8, 'active')
       RETURNING id`,
      TENANT,
      facilityId,
      Number(catalogRows[0].id),
      supplierId,
      sku,
      name,
      scheduleClass,
      isNarcotic,
    );
    return Number(itemRows[0].id);
  }

  async function seedBatch({ itemId, batchNumber, lotNumber, quantity = 100 }) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, supplier_id,
          storage_location_id, batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::int, $4::int,
               $5::int, $6, $7, $8::date, $9::numeric, $9::numeric, 'in_stock')
       RETURNING id`,
      TENANT,
      itemId,
      facilityId,
      supplierId,
      storageLocationId,
      batchNumber,
      lotNumber,
      EXPIRY_DATE,
      quantity,
    );
    return Number(rows[0].id);
  }

  const remaining = async (batchId) => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT,
      batchId,
    );
    return Number(rows[0].remaining_quantity);
  };

  const movementRows = (batchId) => prisma.$queryRawUnsafe(
    `SELECT id, movement_kind, quantity_delta, reference_type, reference_id,
            performed_by::text, metadata
       FROM pharmacy_stock_movements
      WHERE tenant_id=$1::uuid AND inventory_batch_id=$2::int
      ORDER BY id`,
    TENANT,
    batchId,
  );

  const registerRows = (batchId) => prisma.$queryRawUnsafe(
    `SELECT id, facility_id, movement_kind, quantity, running_balance,
            schedule_class, performed_by::text, performed_by_name,
            witness_uid::text, witness_name, reference_movement_id
       FROM pharmacy_schedule_register
      WHERE tenant_id=$1::uuid AND inventory_batch_id=$2::int
      ORDER BY id`,
    TENANT,
    batchId,
  );

  function disposalIntent(quantity = 4) {
    return {
      facility_id: facilityId,
      inventory_item_id: xDisposeItemId,
      inventory_batch_id: xDisposeBatchId,
      quantity,
      reason_code: 'damaged',
      disposition_method: 'authorized_incineration',
      authority_reference: 'CMOV-DISPOSAL-AUTH-001',
      expected_batch_number: 'CMOV-X-DISPOSE-BATCH',
      expected_lot_number: 'CMOV-X-DISPOSE-LOT',
      expected_expiry_date: EXPIRY_DATE,
      notes: 'Destroyed under independent controlled-drug custody',
    };
  }

  function disposalCommand(overrides = {}) {
    return {
      tenantId: TENANT,
      ...disposalIntent(),
      performed_by: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      commandKey: 'cmov-schedule-x-disposal',
      requestFingerprint: 'd'.repeat(64),
      ...overrides,
    };
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, 'cmov-typed-test', 'CMOV typed custody test',
               'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    const facilityRows = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, 'CMOV-PHARMACY', 'CMOV Pharmacy', 'active', FALSE)
       RETURNING id`,
      TENANT,
    );
    facilityId = Number(facilityRows[0].id);
    const locationRows = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, location_kind, status)
       VALUES ($1::uuid, $2::int, 'CMOV-STORE', 'CMOV Pharmacy Store',
               'pharmacy', 'active')
       RETURNING id`,
      TENANT,
      facilityId,
    );
    storageLocationId = Number(locationRows[0].id);
    const supplierRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_suppliers
         (tenant_id, facility_id, supplier_code, display_name, status)
       VALUES ($1::uuid, $2::int, 'CMOV-SUPPLIER', 'CMOV Supplier', 'active')
       RETURNING id`,
      TENANT,
      facilityId,
    );
    supplierId = Number(supplierRows[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, name, role, tenant_id, is_active, status, updated_at)
       VALUES
         ($1::uuid, 'Movement Pharmacist', 'PHARMACY_INCHARGE',
          $4::uuid, TRUE, 'active', NOW()),
         ($2::uuid, 'Movement Witness', 'PHARMACY_STAFF',
          $4::uuid, TRUE, 'active', NOW()),
         ($3::uuid, 'Movement Grant Administrator', 'ADMIN',
          $4::uuid, TRUE, 'active', NOW())`,
      ACTOR,
      WITNESS,
      ADMIN,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'CMOV-ACTOR', 'Roster Movement Pharmacist',
          'Pharmacist', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW()),
         ($1::uuid, $3::uuid, 'CMOV-WITNESS', 'Roster Movement Witness',
          'Pharmacist', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
      TENANT,
      ACTOR,
      WITNESS,
    );
    await grantPharmacyFacilityAuthority({
      tenantId: TENANT,
      facilityId,
      staffUid: ACTOR,
      actorUid: ADMIN,
      actorRole: 'ADMIN',
      reason: 'Explicit typed inventory custody test authority',
      commandKey: 'cmov-fixture-actor-facility-grant',
    });
    await grantPharmacyFacilityAuthority({
      tenantId: TENANT,
      facilityId,
      staffUid: WITNESS,
      actorUid: ADMIN,
      actorRole: 'ADMIN',
      reason: 'Explicit independent witness facility authority',
      commandKey: 'cmov-fixture-witness-facility-grant',
    });

    xRecallItemId = await seedItem({
      sku: 'CMOV-RECALL-X',
      name: 'CMOV Schedule X recall item',
      scheduleClass: 'X',
      isNarcotic: true,
    });
    xRecallBatchId = await seedBatch({
      itemId: xRecallItemId,
      batchNumber: 'CMOV-X-RECALL-BATCH',
      lotNumber: 'CMOV-X-RECALL-LOT',
    });
    otcRecallItemId = await seedItem({
      sku: 'CMOV-RECALL-OTC',
      name: 'CMOV OTC recall item',
      scheduleClass: 'OTC',
    });
    otcRecallBatchId = await seedBatch({
      itemId: otcRecallItemId,
      batchNumber: 'CMOV-OTC-RECALL-BATCH',
      lotNumber: 'CMOV-OTC-RECALL-LOT',
    });
    xDisposeItemId = await seedItem({
      sku: 'CMOV-DISPOSE-X',
      name: 'CMOV Schedule X disposal item',
      scheduleClass: 'X',
      isNarcotic: true,
    });
    xDisposeBatchId = await seedBatch({
      itemId: xDisposeItemId,
      batchNumber: 'CMOV-X-DISPOSE-BATCH',
      lotNumber: 'CMOV-X-DISPOSE-LOT',
    });
    h1ItemId = await seedItem({
      sku: 'CMOV-RECEIVE-H1',
      name: 'CMOV Schedule H1 receipt item',
      scheduleClass: 'H1',
    });
    h1BaselineBatchId = await seedBatch({
      itemId: h1ItemId,
      batchNumber: 'CMOV-H1-BASELINE-BATCH',
      lotNumber: 'CMOV-H1-BASELINE-LOT',
    });
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('typed recall is status-only for controlled and OTC batches and replays exactly', async () => {
    const controlledReference = 'CMOV-CDSCO-RECALL-X-001';
    const otcReference = 'CMOV-MANUFACTURER-RECALL-OTC-001';
    const controlled = await recallBatch({
      tenantId: TENANT,
      id: xRecallBatchId,
      recallReference: controlledReference,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    const otc = await recallBatch({
      tenantId: TENANT,
      id: otcRecallBatchId,
      recallReference: otcReference,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });

    expect(controlled).toMatchObject({
      id: xRecallBatchId,
      status: 'recalled',
      recall_reference: controlledReference,
    });
    expect(otc).toMatchObject({
      id: otcRecallBatchId,
      status: 'recalled',
      recall_reference: otcReference,
    });
    expect(Number(controlled.remaining_quantity)).toBe(100);
    expect(Number(otc.remaining_quantity)).toBe(100);
    expect(await movementRows(xRecallBatchId)).toHaveLength(0);
    expect(await registerRows(xRecallBatchId)).toHaveLength(0);
    expect(await movementRows(otcRecallBatchId)).toHaveLength(0);
    expect(await registerRows(otcRecallBatchId)).toHaveLength(0);

    const replay = await recallBatch({
      tenantId: TENANT,
      id: xRecallBatchId,
      recallReference: controlledReference,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(replay).toEqual(controlled);
    await expect(recallBatch({
      tenantId: TENANT,
      id: xRecallBatchId,
      recallReference: 'CMOV-CDSCO-RECALL-X-CHANGED',
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    })).rejects.toMatchObject({ code: 'BATCH_RECALL_REPLAY_MISMATCH' });
    expect(await remaining(xRecallBatchId)).toBe(100);
    expect(await movementRows(xRecallBatchId)).toHaveLength(0);
    expect(await registerRows(xRecallBatchId)).toHaveLength(0);
  });

  test.each([
    ['movement_kind', 'dispose'],
    ['witness_uid', WITNESS],
    ['witness_name', 'Caller supplied witness'],
    ['performed_by_name', 'Caller supplied performer'],
    ['schedule_class', 'X'],
    ['batch_policy', 'caller_override'],
    ['controlled_authority', { source: 'caller' }],
    ['reference_type', 'caller_reference'],
    ['reference_id', 'caller-reference-id'],
  ])('typed disposal rejects caller-supplied authority field %s', async (field, value) => {
    await expect(disposeInventoryBatch(disposalCommand({
      [field]: value,
      commandKey: `cmov-forged-${field}`,
      requestFingerprint: 'c'.repeat(64),
    }))).rejects.toMatchObject({ code: 'INVENTORY_DISPOSAL_CALLER_AUTHORITY_REJECTED' });
    expect(await remaining(xDisposeBatchId)).toBe(100);
    expect(await movementRows(xDisposeBatchId)).toHaveLength(0);
    expect(await registerRows(xDisposeBatchId)).toHaveLength(0);
  });

  test('Schedule X disposal consumes one canonical witness approval and replays once', async () => {
    const command = disposalCommand();
    await expect(disposeInventoryBatch({
      ...command,
      commandKey: 'cmov-schedule-x-disposal-missing-completed-replay',
      requestFingerprint: '9'.repeat(64),
      requireExistingReceipt: true,
    })).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_COMPLETED_REPLAY_RECEIPT_REQUIRED',
      statusCode: 409,
    });
    expect(await remaining(xDisposeBatchId)).toBe(100);
    expect(await movementRows(xDisposeBatchId)).toHaveLength(0);
    expect(await registerRows(xDisposeBatchId)).toHaveLength(0);

    await expect(disposeInventoryBatch(command)).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
    });
    expect(await remaining(xDisposeBatchId)).toBe(100);

    const approval = await requestInventoryDisposalWitnessApproval({
      tenantId: TENANT,
      ...disposalIntent(),
      requested_by: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(approval.id).toMatch(/^[1-9][0-9]*$/);
    const approved = await approveInventoryDisposalWitnessApproval({
      tenantId: TENANT,
      approvalId: approval.id,
      actorUid: WITNESS,
      requesterUid: ACTOR,
      disposal: disposalIntent(),
    });
    expect(approved.witness).toEqual({
      uid: WITNESS,
      name: 'Roster Movement Witness',
      role: 'PHARMACY_STAFF',
      facility_grant_id: expect.stringMatching(/^[1-9][0-9]*$/),
    });

    await expect(disposeInventoryBatch({
      ...command,
      ...disposalIntent(5),
      witness_approval_id: approval.id,
      commandKey: 'cmov-schedule-x-disposal-approval-mismatch',
      requestFingerprint: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH' });
    expect(await remaining(xDisposeBatchId)).toBe(100);
    expect(await movementRows(xDisposeBatchId)).toHaveLength(0);
    expect(await registerRows(xDisposeBatchId)).toHaveLength(0);

    const disposed = await disposeInventoryBatch({
      ...command,
      witness_approval_id: approval.id,
    });
    expect(disposed.idempotent_replay).toBe(false);
    expect(disposed.disposal).toMatchObject({
      contract: 'pharmacy_inventory_disposal_v1',
      facility_id: facilityId,
      inventory_item_id: xDisposeItemId,
      inventory_batch_id: xDisposeBatchId,
      reason_code: 'damaged',
      disposition_method: 'authorized_incineration',
      authority_reference: 'CMOV-DISPOSAL-AUTH-001',
      source_batch_status: 'in_stock',
      resulting_batch_status: 'in_stock',
      witness_approval_id: approval.id,
      performed_by: ACTOR,
      witness_uid: WITNESS,
      witness_facility_grant_id: approved.witness.facility_grant_id,
    });
    expect(Number(disposed.disposal.quantity)).toBe(4);
    expect(disposed.disposal.command_key_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(disposed.disposal.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await remaining(xDisposeBatchId)).toBe(96);

    let movements = await movementRows(xDisposeBatchId);
    let registers = await registerRows(xDisposeBatchId);
    expect(movements).toHaveLength(1);
    expect(registers).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      movement_kind: 'dispose',
      reference_type: 'inventory_batch_disposal',
      reference_id: String(xDisposeBatchId),
      performed_by: ACTOR,
    });
    expect(Number(movements[0].quantity_delta)).toBe(-4);
    expect(movements[0].metadata).toMatchObject({
      contract: 'pharmacy_inventory_disposal_v1',
      witness_approval_id: approval.id,
      receipt: expect.objectContaining({
        witness_facility_grant_id: approved.witness.facility_grant_id,
      }),
    });
    expect(registers[0]).toMatchObject({
      facility_id: facilityId,
      movement_kind: 'dispose',
      schedule_class: 'X',
      performed_by: ACTOR,
      performed_by_name: 'Roster Movement Pharmacist',
      witness_uid: WITNESS,
      witness_name: 'Roster Movement Witness',
    });
    expect(Number(registers[0].quantity)).toBe(4);
    expect(Number(registers[0].running_balance)).toBe(96);
    expect(Number(registers[0].reference_movement_id)).toBe(Number(movements[0].id));
    expect(Number(disposed.disposal.movement_id)).toBe(Number(movements[0].id));
    expect(Number(disposed.disposal.schedule_register_id)).toBe(Number(registers[0].id));
    const approvalEvidence = (await prisma.$queryRawUnsafe(
      `SELECT subject_resource_type, status, metadata
         FROM approvals
        WHERE tenant_id=$1::uuid AND id=$2::bigint`,
      TENANT,
      approval.id,
    ))[0];
    expect(approvalEvidence).toMatchObject({
      subject_resource_type: 'pharmacy_inventory_controlled_disposal',
      status: 'approved',
      metadata: expect.objectContaining({
        scope: 'pharmacy_inventory_controlled_disposal',
        consumed_by: ACTOR,
        witness_facility_grant_id: approved.witness.facility_grant_id,
        approved_witness_name: 'Roster Movement Witness',
        approved_witness_role: 'PHARMACY_STAFF',
        canonical_witness_name: 'Roster Movement Witness',
        canonical_witness_role: 'PHARMACY_STAFF',
      }),
    });

    const replay = await disposeInventoryBatch({
      ...command,
      witness_approval_id: approval.id,
      requireExistingReceipt: true,
    });
    expect(replay.idempotent_replay).toBe(true);
    expect(Number(replay.disposal.movement_id)).toBe(Number(disposed.disposal.movement_id));
    expect(Number(replay.disposal.schedule_register_id))
      .toBe(Number(disposed.disposal.schedule_register_id));
    expect(await remaining(xDisposeBatchId)).toBe(96);
    movements = await movementRows(xDisposeBatchId);
    registers = await registerRows(xDisposeBatchId);
    expect(movements).toHaveLength(1);
    expect(registers).toHaveLength(1);

    await expect(disposeInventoryBatch({
      ...command,
      witness_approval_id: approval.id,
      requestFingerprint: 'e'.repeat(64),
    })).rejects.toMatchObject({ code: 'INVENTORY_DISPOSAL_IDEMPOTENCY_MISMATCH' });
    await expect(disposeInventoryBatch({
      ...command,
      witness_approval_id: approval.id,
      commandKey: 'cmov-schedule-x-disposal-consumed-retry',
      requestFingerprint: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONSUMED' });
    expect(await remaining(xDisposeBatchId)).toBe(96);
    expect(await movementRows(xDisposeBatchId)).toHaveLength(1);
    expect(await registerRows(xDisposeBatchId)).toHaveLength(1);
  });

  test('typed Schedule H1 receipt writes one register row and replays without duplication', async () => {
    expect(await remaining(h1BaselineBatchId)).toBe(100);
    const receipt = {
      tenantId: TENANT,
      inventoryItemId: h1ItemId,
      facilityId,
      batchNumber: 'CMOV-H1-TYPED-RECEIPT',
      lotNumber: 'CMOV-H1-TYPED-LOT',
      manufactureDate: '2026-01-01',
      expiryDate: EXPIRY_DATE,
      receivedQuantity: 20,
      unitCostMinor: 1250,
      mrpMinor: 1500,
      supplierId,
      storageLocationId,
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      metadata: { fixture: 'typed-h1-receipt' },
      commandKey: 'cmov-h1-typed-receipt',
      requestFingerprint: '1'.repeat(64),
    };
    const received = await addInventoryBatch(receipt);
    const receivedBatchId = Number(received.id);
    expect(Number(received.remaining_quantity)).toBe(20);

    const itemBalance = (await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
      TENANT,
      h1ItemId,
    ))[0];
    expect(Number(itemBalance.quantity)).toBe(120);
    let movements = await movementRows(receivedBatchId);
    let registers = await registerRows(receivedBatchId);
    expect(movements).toHaveLength(1);
    expect(registers).toHaveLength(1);
    expect(movements[0].movement_kind).toBe('receive');
    expect(Number(movements[0].quantity_delta)).toBe(20);
    expect(registers[0]).toMatchObject({
      movement_kind: 'receive',
      schedule_class: 'H1',
      performed_by: ACTOR,
      witness_uid: null,
      witness_name: null,
    });
    expect(Number(registers[0].quantity)).toBe(20);
    expect(Number(registers[0].running_balance)).toBe(120);
    expect(Number(registers[0].reference_movement_id)).toBe(Number(movements[0].id));

    const replay = await addInventoryBatch(receipt);
    expect(Number(replay.id)).toBe(receivedBatchId);
    expect(await remaining(receivedBatchId)).toBe(20);
    movements = await movementRows(receivedBatchId);
    registers = await registerRows(receivedBatchId);
    expect(movements).toHaveLength(1);
    expect(registers).toHaveLength(1);

    await expect(addInventoryBatch({
      ...receipt,
      requestFingerprint: '2'.repeat(64),
    })).rejects.toMatchObject({ code: 'PHARMACY_STOCK_RECEIPT_IDEMPOTENCY_CONFLICT' });
    expect(await remaining(receivedBatchId)).toBe(20);
    expect(await movementRows(receivedBatchId)).toHaveLength(1);
    expect(await registerRows(receivedBatchId)).toHaveLength(1);
  });
});
