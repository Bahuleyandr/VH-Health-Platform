import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { receivePurchaseOrderLine } from '../services/pharmacySupply/pharmacySupplyService.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000c0940a11';
const ACTOR = 'c0940a11-0000-4000-8000-000000000001';
const COMMAND_A = 'pr940-grn-receipt-a';
const COMMAND_B = 'pr940-grn-receipt-b';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

describeIfDb('pharmacy supply immutable receipt replay stability', () => {
  let facilityId;
  let storageLocationId;
  let supplierId;
  let inventoryItemId;
  let purchaseOrderId;
  let purchaseOrderItemId;
  let goodsReceiptAId;
  let goodsReceiptBId;

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
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_goods_receipt_items WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_goods_receipts WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_purchase_order_items WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_purchase_orders WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_authority_recovery_events WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_authority_recovery_worklist WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_catalog WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_suppliers WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM facility_locations WHERE tenant_id=$1::uuid`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM staff WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
        TENANT,
        ACTOR,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id=$1::uuid AND uid=$2::uuid`,
        TENANT,
        ACTOR,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM facilities WHERE tenant_id=$1::uuid`,
        TENANT,
      );
    });
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, 'pr940-receipt-replay', 'PR 940 Receipt Replay',
               'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    const facilityRows = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, 'PR940-REPLAY', 'PR 940 Replay Pharmacy', 'active', TRUE)
       RETURNING id`,
      TENANT,
    );
    facilityId = Number(facilityRows[0].id);
    const locationRows = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, status)
       VALUES ($1::uuid, $2::int, 'PR940-STORE', 'PR 940 Store', 'active')
       RETURNING id`,
      TENANT,
      facilityId,
    );
    storageLocationId = Number(locationRows[0].id);
    const supplierRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_suppliers
         (tenant_id, facility_id, supplier_code, display_name, status)
       VALUES ($1::uuid, $2::int, 'PR940-SUPPLIER', 'PR 940 Supplier', 'active')
       RETURNING id`,
      TENANT,
      facilityId,
    );
    supplierId = Number(supplierRows[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, name, role, tenant_id, is_active, status, updated_at)
       VALUES ($1::uuid, 'PR 940 Pharmacist', 'PHARMACY_INCHARGE',
               $2::uuid, TRUE, 'active', NOW())`,
      ACTOR,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'PR940-ACTOR', 'PR 940 Pharmacist',
               'Pharmacist', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
      TENANT,
      ACTOR,
    );
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO pharmacy_staff_facility_grants
         (tenant_id, facility_id, staff_uid, status, grant_source,
          grant_reason, granted_by)
       VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'test_fixture',
               'PR 940 immutable receipt replay fixture', $3::uuid)`,
      TENANT,
      facilityId,
      ACTOR,
    ));
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, is_available, in_stock)
       VALUES ($1::uuid, 'PR 940 H1 Receipt Item', TRUE, TRUE, TRUE)
       RETURNING id`,
      TENANT,
    );
    const itemRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, catalog_id, default_supplier_id,
          sku_code, display_name, unit_label, schedule_class, is_narcotic, status)
       VALUES ($1::uuid, $2::int, $3::int, $4::int,
               'PR940-H1', 'PR 940 H1 Item', 'tablet', 'H1', FALSE, 'active')
       RETURNING id`,
      TENANT,
      facilityId,
      Number(catalogRows[0].id),
      supplierId,
    );
    inventoryItemId = Number(itemRows[0].id);
    const purchaseOrderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_purchase_orders
         (tenant_id, facility_id, po_number, supplier_id, status,
          ordered_at, approved_by, approved_at, created_by)
       VALUES ($1::uuid, $2::int, 'PR940-PO', $3::int, 'approved',
               NOW(), $4::uuid, NOW(), $4::uuid)
       RETURNING id`,
      TENANT,
      facilityId,
      supplierId,
      ACTOR,
    );
    purchaseOrderId = Number(purchaseOrderRows[0].id);
    const purchaseOrderItemRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_purchase_order_items
         (tenant_id, purchase_order_id, inventory_item_id,
          ordered_quantity, received_quantity, unit_price_minor)
       VALUES ($1::uuid, $2::int, $3::int, 10, 0, 100)
       RETURNING id`,
      TENANT,
      purchaseOrderId,
      inventoryItemId,
    );
    purchaseOrderItemId = Number(purchaseOrderItemRows[0].id);
    const receiptRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_goods_receipts
         (tenant_id, facility_id, grn_number, purchase_order_id,
          supplier_id, status, received_by)
       VALUES ($1::uuid, $2::int, 'PR940-GRN-A', $3::int,
               $4::int, 'received', $5::uuid),
              ($1::uuid, $2::int, 'PR940-GRN-B', $3::int,
               $4::int, 'received', $5::uuid)
       RETURNING id, grn_number`,
      TENANT,
      facilityId,
      purchaseOrderId,
      supplierId,
      ACTOR,
    );
    goodsReceiptAId = Number(receiptRows.find((row) => row.grn_number === 'PR940-GRN-A').id);
    goodsReceiptBId = Number(receiptRows.find((row) => row.grn_number === 'PR940-GRN-B').id);
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('receipt A replays its original response after receipt B advances mutable PO totals', async () => {
    const receive = ({ goodsReceiptId, batchNumber, quantity, commandKey, fingerprint }) => (
      receivePurchaseOrderLine({
        tenantId: TENANT,
        purchaseOrderId,
        purchaseOrderItemId,
        goodsReceiptId,
        batchNumber,
        expiryDate: '2099-12-31',
        receivedQuantity: quantity,
        unitCostMinor: 100,
        supplierId,
        storageLocationId,
        performedBy: ACTOR,
        actorRole: 'PHARMACY_INCHARGE',
        commandKey,
        requestFingerprint: fingerprint,
      })
    );

    const firstA = await receive({
      goodsReceiptId: goodsReceiptAId,
      batchNumber: 'PR940-BATCH-A',
      quantity: 4,
      commandKey: COMMAND_A,
      fingerprint: 'a'.repeat(64),
    });
    expect(firstA).toMatchObject({
      purchase_order: { status: 'partially_received' },
      purchase_order_item: { received_quantity: expect.anything() },
      goods_receipt_item: { qc_status: 'pending', qc_notes: null },
      total_ordered: 10,
      total_received: 4,
    });
    expect(Number(firstA.purchase_order_item.received_quantity)).toBe(4);

    const firstB = await receive({
      goodsReceiptId: goodsReceiptBId,
      batchNumber: 'PR940-BATCH-B',
      quantity: 6,
      commandKey: COMMAND_B,
      fingerprint: 'b'.repeat(64),
    });
    expect(firstB).toMatchObject({
      purchase_order: { status: 'fully_received' },
      total_ordered: 10,
      total_received: 10,
    });

    const replayA = await receive({
      goodsReceiptId: goodsReceiptAId,
      batchNumber: 'PR940-BATCH-A',
      quantity: 4,
      commandKey: COMMAND_A,
      fingerprint: 'a'.repeat(64),
    });
    expect(replayA).toEqual(firstA);
    expect(replayA.purchase_order.status).toBe('partially_received');
    expect(replayA.total_received).toBe(4);

    const evidence = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT movement.id)::int AS movement_count,
              COUNT(register.id)::int AS register_count,
              MIN(movement.metadata#>>'{response_payload,total_received}') AS stored_total_received,
              MIN(register.facility_id)::int AS register_facility_id,
              MIN(register.schedule_class) AS register_schedule_class,
              MIN(register.running_balance)::double precision AS register_running_balance,
              MIN(batch.status) AS batch_status
         FROM pharmacy_stock_movements movement
         LEFT JOIN pharmacy_schedule_register register
           ON register.tenant_id=movement.tenant_id
          AND register.reference_movement_id=movement.id
         LEFT JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=movement.tenant_id
          AND batch.id=movement.inventory_batch_id
          AND batch.inventory_item_id=movement.inventory_item_id
        WHERE movement.tenant_id=$1::uuid
          AND movement.metadata->>'contract'='pharmacy_grn_receive_line_v1'
          AND movement.metadata->>'command_key_sha256'=$2`,
      TENANT,
      sha256(COMMAND_A),
    ))[0];
    expect(evidence).toMatchObject({
      movement_count: 1,
      register_count: 1,
      stored_total_received: '4',
      register_facility_id: facilityId,
      register_schedule_class: 'H1',
      register_running_balance: 4,
      batch_status: 'quarantined',
    });

    const allCommands = await prisma.$queryRawUnsafe(
      `SELECT movement.metadata->>'command_key_sha256' AS command_key_sha256,
              register.facility_id,
              register.schedule_class,
              register.running_balance::double precision AS running_balance
         FROM pharmacy_stock_movements movement
         JOIN pharmacy_schedule_register register
           ON register.tenant_id=movement.tenant_id
          AND register.reference_movement_id=movement.id
        WHERE movement.tenant_id=$1::uuid
          AND movement.metadata->>'contract'='pharmacy_grn_receive_line_v1'
        ORDER BY movement.id`,
      TENANT,
    );
    expect(allCommands).toEqual([
      {
        command_key_sha256: sha256(COMMAND_A),
        facility_id: facilityId,
        schedule_class: 'H1',
        running_balance: 4,
      },
      {
        command_key_sha256: sha256(COMMAND_B),
        facility_id: facilityId,
        schedule_class: 'H1',
        running_balance: 10,
      },
    ]);
  });
});
