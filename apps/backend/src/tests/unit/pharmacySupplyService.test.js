/**
 * Phase C4 — pharmacySupplyService unit tests.
 *
 * Covers validation, retired reservation authority, expiry-severity bands, status-only
 * batch recall, PO state machine, and
 * substitute-graph guards. Mocks prisma.$queryRawUnsafe.
 */

import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const facilityGrantMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: executeUnsafeMock,
  $transaction: transactionMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => transactionMock(fn),
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  assertPharmacyFacilityGrant: facilityGrantMock,
}));

const supply = await import('../../services/pharmacySupply/pharmacySupplyService.js');

const {
  acknowledgeExpiryAlert,
  __testing__,
} = supply;

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';
const FACILITY = 11;
const SUPPLIER = 21;
const CATALOG = 31;
const ACTOR_ROLE = 'PHARMACIST';
const REQUEST_FINGERPRINT = 'a'.repeat(64);
const SERVICE_SOURCE = readFileSync(
  new URL('../../services/pharmacySupply/pharmacySupplyService.js', import.meta.url),
  'utf8',
);

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const aliasFields = (prefix, values) => Object.fromEntries(
  Object.entries(values).map(([key, value]) => [`${prefix}_${key}`, value]),
);
const exportedFunctionSource = (name) => {
  const start = SERVICE_SOURCE.indexOf(`export async function ${name}`);
  const next = SERVICE_SOURCE.indexOf('\nexport async function ', start + 1);
  return SERVICE_SOURCE.slice(start, next === -1 ? undefined : next);
};
const controlledRegisterRow = ({
  id,
  inventoryItemId,
  inventoryBatchId,
  scheduleClass,
  movementKind,
  quantity,
  runningBalance,
  unitLabel,
  referenceMovementId,
  notes = null,
}) => ({
  id,
  tenant_id: TENANT,
  facility_id: FACILITY,
  inventory_item_id: inventoryItemId,
  inventory_batch_id: inventoryBatchId,
  schedule_class: scheduleClass,
  movement_kind: movementKind,
  quantity: String(quantity),
  unit_label: unitLabel,
  running_balance: String(runningBalance),
  performed_by: USER,
  reference_movement_id: referenceMovementId,
  notes,
});

const actor = Object.freeze({ actorUid: USER, actorRole: ACTOR_ROLE });
const upsertSupplier = (options = {}) => supply.upsertSupplier({
  facilityId: FACILITY,
  createdBy: USER,
  ...actor,
  ...options,
});
const listSuppliers = (options = {}) => supply.listSuppliers({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const upsertInventoryItem = (options = {}) => supply.upsertInventoryItem({
  facilityId: FACILITY,
  catalogId: CATALOG,
  ...actor,
  ...options,
});
const listInventoryItems = (options = {}) => supply.listInventoryItems({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const addInventoryBatch = (options = {}) => supply.addInventoryBatch({
  facilityId: FACILITY,
  supplierId: SUPPLIER,
  storageLocationId: 51,
  performedBy: USER,
  actorRole: ACTOR_ROLE,
  commandKey: 'direct-receive-test',
  requestFingerprint: REQUEST_FINGERPRINT,
  ...options,
});
const listBatches = (options = {}) => supply.listBatches({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const recallBatch = (options = {}) => supply.recallBatch({
  performedBy: USER,
  actorRole: ACTOR_ROLE,
  ...options,
});
const createPurchaseOrder = (options = {}) => supply.createPurchaseOrder({
  facilityId: FACILITY,
  supplierId: SUPPLIER,
  createdBy: USER,
  actorRole: ACTOR_ROLE,
  ...options,
});
const transitionPurchaseOrder = (options = {}) => supply.transitionPurchaseOrder({
  approvedBy: USER,
  actorRole: ACTOR_ROLE,
  ...options,
});
const addPurchaseOrderItem = (options = {}) => supply.addPurchaseOrderItem({
  ...actor,
  ...options,
});
const listPurchaseOrders = (options = {}) => supply.listPurchaseOrders({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const createGoodsReceipt = (options = {}) => supply.createGoodsReceipt({
  facilityId: FACILITY,
  supplierId: SUPPLIER,
  purchaseOrderId: 10,
  receivedBy: USER,
  actorRole: ACTOR_ROLE,
  ...options,
});
const listGoodsReceipts = (options = {}) => supply.listGoodsReceipts({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const appendStockMovement = (options = {}) => supply.appendStockMovement({
  performedBy: USER,
  actorRole: ACTOR_ROLE,
  commandKey: 'stock-movement-test',
  requestFingerprint: REQUEST_FINGERPRINT,
  ...options,
});
const listStockMovements = (options = {}) => supply.listStockMovements({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const computeExpiryAlerts = (options = {}) => supply.computeExpiryAlerts({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const listExpiryAlerts = (options = {}) => supply.listExpiryAlerts({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const addSubstitute = (options = {}) => supply.addSubstitute({
  createdBy: USER,
  actorRole: ACTOR_ROLE,
  ...options,
});
const listSubstitutes = (options = {}) => supply.listSubstitutes({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const receivePurchaseOrderLine = (options = {}) => supply.receivePurchaseOrderLine({
  purchaseOrderId: 10,
  storageLocationId: 51,
  performedBy: USER,
  actorRole: ACTOR_ROLE,
  commandKey: 'grn-receive-test',
  requestFingerprint: REQUEST_FINGERPRINT,
  ...options,
});
const bridgeForecastToBatches = (options = {}) => supply.bridgeForecastToBatches({
  facilityId: FACILITY,
  ...actor,
  ...options,
});
const recordGoodsReceiptItemQc = (options = {}) => supply.recordGoodsReceiptItemQc({
  performedBy: USER,
  actorRole: ACTOR_ROLE,
  ...options,
});
const transitionGoodsReceipt = (options = {}) => supply.transitionGoodsReceipt({
  performedBy: USER,
  actorRole: ACTOR_ROLE,
  ...options,
});

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
  transactionMock.mockReset();
  facilityGrantMock.mockReset();
  facilityGrantMock.mockImplementation(async (_db, options) => ({
    actor_uid: options.actorUid,
    actor_role: options.actorRole || ACTOR_ROLE,
    facility_id: Number(options.facilityId),
    grant_id: 1,
  }));
  transactionMock.mockImplementation(async (cb) => cb({
    $queryRawUnsafe: queryUnsafeMock,
    $executeRawUnsafe: executeUnsafeMock,
  }));
});

describe('append-only pharmacy stock command receipts', () => {
  it('never updates or deletes immutable stock movements after insertion', () => {
    expect(SERVICE_SOURCE).not.toMatch(/\bUPDATE\s+pharmacy_stock_movements\b/i);
    expect(SERVICE_SOURCE).not.toMatch(/\bDELETE\s+FROM\s+pharmacy_stock_movements\b/i);
    expect(SERVICE_SOURCE).not.toMatch(/response_snapshot/);
    expect(SERVICE_SOURCE.match(/response_payload: responseSnapshot/g)).toHaveLength(2);
    expect(SERVICE_SOURCE).toMatch(/response: movementResponse/);
  });

  it('reconstructs receipts through exact canonical lineage joins', () => {
    expect(SERVICE_SOURCE).toMatch(/LEFT JOIN pharmacy_inventory_batches batch/);
    expect(SERVICE_SOURCE).toMatch(/FROM pharmacy_schedule_register register/);
    expect(SERVICE_SOURCE).toMatch(/LEFT JOIN pharmacy_goods_receipt_items grn_line/);
    expect(SERVICE_SOURCE).toMatch(/LEFT JOIN pharmacy_goods_receipts grn/);
    expect(SERVICE_SOURCE).toMatch(/LEFT JOIN pharmacy_purchase_order_items po_line/);
    expect(SERVICE_SOURCE).toMatch(/LEFT JOIN pharmacy_purchase_orders po/);
    expect(SERVICE_SOURCE).toMatch(/register\.facility_id/);
    expect(SERVICE_SOURCE).toMatch(/register\.running_balance/);
    expect(SERVICE_SOURCE).toMatch(/intentMatches\(responseSnapshot,[\s\S]*unit_cost_minor:[\s\S]*mrp_minor:/);
    expect(SERVICE_SOURCE).toMatch(/qc_status: 'pending',[\s\S]*qc_notes: null/);
    expect(SERVICE_SOURCE).toMatch(/po_line_received_before:[\s\S]*total_received_before:/);
  });

  it('keeps safety and closure queries available for paused, blacklisted, and archived suppliers', () => {
    for (const operation of [
      'listBatches',
      'recallBatch',
      'recordGoodsReceiptItemQc',
      'transitionGoodsReceipt',
      'listStockMovements',
      'computeExpiryAlerts',
      'acknowledgeExpiryAlert',
      'listExpiryAlerts',
    ]) {
      expect(exportedFunctionSource(operation)).toMatch(/JOIN pharmacy_suppliers supplier/);
      expect(exportedFunctionSource(operation)).not.toMatch(/supplier\.status/);
    }
    for (const operation of [
      'addInventoryBatch',
      'createPurchaseOrder',
      'createGoodsReceipt',
      'receivePurchaseOrderLine',
    ]) {
      expect(exportedFunctionSource(operation)).toMatch(/supplier\.status='active'/);
    }
  });

  it('uses exact scaled NUMERIC(14,4) arithmetic for decimal GRN replay evidence', () => {
    const tenth = __testing__.normalizeQuantity(0.1, 'received_quantity', {
      min: 0.0001,
      required: true,
    });
    const fifth = __testing__.normalizeQuantity(0.2, 'received_quantity', {
      min: 0.0001,
      required: true,
    });
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(
      __testing__.numeric14_4ToScaled(tenth)
        + __testing__.numeric14_4ToScaled(fifth),
    ).toBe(__testing__.numeric14_4ToScaled('0.3000'));
    expect(__testing__.canonicalNumeric14_4(0.3)).toBe('0.3000');
    expect(__testing__.normalizeQuantity('-0.1000', 'quantity_delta', {
      min: -1_000_000_000,
      max: 1_000_000_000,
      required: true,
    })).toBe(-0.1);
    const receiveSource = exportedFunctionSource('receivePurchaseOrderLine');
    expect(receiveSource).toMatch(/movementQuantityScaled = numeric14_4ToScaled/);
    expect(receiveSource).toMatch(/commandLineReceivedScaled/);
    expect(receiveSource).not.toMatch(/commandLineReceived = poLineReceivedBefore \+ movementQuantity/);
    const appendSource = exportedFunctionSource('appendStockMovement');
    expect(appendSource).not.toMatch(/Number\(quantityDelta\)/);
    expect(appendSource).not.toMatch(/Math\.abs\(rawDelta\)/);
  });

  it('parses minor units lexically before returning a safe SQL-compatible number', () => {
    expect(__testing__.normalizeBigInt('1000000000000', 'unit_cost_minor', {
      min: 0,
      max: 1_000_000_000_000,
    })).toBe(1_000_000_000_000);
    for (const invalid of [
      '999999999999.9999999999999999',
      '1e3',
      ' 100 ',
    ]) {
      expect(() => __testing__.normalizeBigInt(invalid, 'unit_cost_minor', {
        min: 0,
        max: 1_000_000_000_000,
      })).toThrow('unit_cost_minor must be an integer number of minor units');
    }
  });
});

describe('facility custody authority and immutable supply lineage', () => {
  it('does not export the retired untyped reservation workflow', () => {
    expect(supply.reserveStock).toBeUndefined();
  });

  it('rejects a direct receipt before any batch mutation when the actor grant is absent', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    facilityGrantMock.mockRejectedValueOnce(Object.assign(new Error('grant required'), {
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    }));

    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 7,
      batchNumber: 'NO-GRANT',
      expiryDate: '2028-01-01',
      receivedQuantity: 5,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/pg_advisory_xact_lock/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/pharmacy_inventory_direct_receive_v1/);
  });

  it('rejects a cross-facility read before querying inventory', async () => {
    facilityGrantMock.mockRejectedValueOnce(Object.assign(new Error('grant required'), {
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    }));

    await expect(listInventoryItems({
      tenantId: TENANT,
      facilityId: FACILITY + 1,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });

    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('requires grants on both facilities before an unhistoried item can move', async () => {
    facilityGrantMock.mockResolvedValueOnce({
      actor_uid: USER,
      actor_role: ACTOR_ROLE,
      facility_id: FACILITY + 1,
      grant_id: 1,
    });
    facilityGrantMock.mockRejectedValueOnce(Object.assign(new Error('old facility grant required'), {
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    }));
    queryUnsafeMock.mockResolvedValueOnce([{
      facility_id: FACILITY + 1,
      catalog_id: CATALOG,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      facility_id: FACILITY,
      catalog_id: CATALOG,
      default_supplier_id: null,
      status: 'active',
    }]);

    await expect(upsertInventoryItem({
      tenantId: TENANT,
      id: 7,
      facilityId: FACILITY + 1,
      skuCode: 'ITEM-7',
      displayName: 'Item 7',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });

    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE pharmacy_inventory_items/.test(sql)))
      .toBe(false);
  });

  it('rejects a GRN receipt before batch or movement mutation when the facility grant is absent', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5,
      purchase_order_id: 10,
      inventory_item_id: 7,
      ordered_quantity: 10,
      received_quantity: 0,
      facility_id: FACILITY,
      supplier_id: SUPPLIER,
      purchase_order_status: 'approved',
      goods_receipt_status: 'received',
    }]);
    facilityGrantMock.mockRejectedValueOnce(Object.assign(new Error('grant required'), {
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    }));

    await expect(receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'GRN-NO-GRANT',
      expiryDate: '2028-01-01',
      receivedQuantity: 5,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_inventory_batches/.test(sql)))
      .toBe(false);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_stock_movements/.test(sql)))
      .toBe(false);
  });

  it('rejects an expired direct-receipt batch through the active receipt authority query', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 7,
      batchNumber: 'EXPIRED-DIRECT',
      expiryDate: '2000-01-01',
      receivedQuantity: 5,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_INVENTORY_AUTHORITY_INVALID',
    });

    expect(queryUnsafeMock.mock.calls[2][0])
      .toMatch(/\$5::date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date/);
    expect(queryUnsafeMock.mock.calls[2][5]).toBe('2000-01-01');
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_inventory_batches/.test(sql)))
      .toBe(false);
  });

  it('requires an exact storage location to be active in the receipt facility', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 7,
      storageLocationId: 99,
      batchNumber: 'WRONG-LOCATION',
      expiryDate: '2099-01-01',
      receivedQuantity: 5,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_INVENTORY_AUTHORITY_INVALID',
    });

    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/FROM facility_locations location/);
    expect(queryUnsafeMock.mock.calls[2][6]).toBe(99);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_inventory_batches/.test(sql)))
      .toBe(false);
  });

  it('rejects a direct receipt without exact storage lineage before opening a transaction', async () => {
    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 7,
      storageLocationId: null,
      batchNumber: 'NO-LOCATION',
      expiryDate: '2099-01-01',
      receivedQuantity: 5,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('detects cross-facility direct-receipt key reuse instead of creating a second lineage', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      movement_metadata: {
        request_fingerprint: 'b'.repeat(64),
      },
    }]);

    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 7,
      batchNumber: 'CROSS-FACILITY-REPLAY',
      expiryDate: '2099-01-01',
      receivedQuantity: 5,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_STOCK_RECEIPT_IDEMPOTENCY_CONFLICT',
    });

    expect(queryUnsafeMock.mock.calls[1][0]).not.toMatch(/item\.facility_id=\$3/);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_inventory_batches/.test(sql)))
      .toBe(false);
  });

  it('reconstructs a direct-receipt replay from its exact movement and batch lineage', async () => {
    const stored = {
      id: 51,
      tenant_id: TENANT,
      inventory_item_id: 7,
      facility_id: FACILITY,
      batch_number: 'DIRECT-REPLAY',
      lot_number: null,
      manufacture_date: null,
      expiry_date: '2099-01-01',
      received_quantity: 5,
      remaining_quantity: 5,
      unit_cost_minor: 123,
      mrp_minor: 150,
      supplier_id: SUPPLIER,
      goods_receipt_id: null,
      storage_location_id: 51,
      status: 'in_stock',
    };
    const movement = {
      id: 81,
      tenant_id: TENANT,
      inventory_item_id: 7,
      inventory_batch_id: 51,
      movement_kind: 'receive',
      quantity_delta: 5,
      reference_type: 'direct_supply_receipt',
      reference_id: '51',
      performed_by: USER,
      notes: 'Batch DIRECT-REPLAY received',
    };
    const metadata = {
      contract: 'pharmacy_inventory_direct_receive_v1',
      command_key_sha256: sha256('direct-receive-test'),
      request_fingerprint: REQUEST_FINGERPRINT,
      facility_id: FACILITY,
      intent: {
        facility_id: FACILITY,
        inventory_item_id: 7,
        inventory_batch_id: 51,
        movement_kind: 'receive',
        quantity_delta: 5,
        reference_type: 'direct_supply_receipt',
        reference_id: '51',
        performed_by: USER,
        supplier_id: SUPPLIER,
        storage_location_id: 51,
        goods_receipt_id: null,
        batch_number: 'DIRECT-REPLAY',
        lot_number: null,
        manufacture_date: null,
        expiry_date: '2099-01-01',
        received_quantity: 5,
        unit_cost_minor: 123,
        mrp_minor: 150,
        controlled: false,
        register_evidence: null,
      },
      response_payload: stored,
    };
    const currentBatch = {
      ...stored,
      remaining_quantity: 2,
      status: 'in_stock',
    };
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      ...aliasFields('movement', { ...movement, metadata }),
      ...aliasFields('batch', currentBatch),
      lineage_item_id: 7,
      lineage_item_facility_id: FACILITY,
      lineage_item_schedule_class: 'OTC',
      lineage_item_is_narcotic: false,
      lineage_item_unit_label: 'tab',
      controlled_register_count: 0,
    }]);

    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 7,
      batchNumber: 'DIRECT-REPLAY',
      expiryDate: '2099-01-01',
      receivedQuantity: 5,
      unitCostMinor: 123,
      mrpMinor: 150,
    })).resolves.toEqual(stored);

    expect(facilityGrantMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      facilityId: FACILITY,
      actorUid: USER,
    }));
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/LEFT JOIN pharmacy_inventory_batches batch/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/pharmacy_schedule_register register/);
  });

  it('reconstructs a GRN replay from its exact movement, batch, register, GRN, and PO lineage', async () => {
    const stored = {
      batch: {
        id: 52,
        tenant_id: TENANT,
        inventory_item_id: 7,
        facility_id: FACILITY,
        batch_number: 'GRN-REPLAY',
        lot_number: null,
        manufacture_date: null,
        expiry_date: '2099-01-01',
        received_quantity: '0.3000',
        remaining_quantity: '0.3000',
        unit_cost_minor: null,
        mrp_minor: null,
        supplier_id: SUPPLIER,
        goods_receipt_id: 22,
        storage_location_id: 51,
        status: 'quarantined',
      },
      goods_receipt_item: {
        id: 100,
        tenant_id: TENANT,
        goods_receipt_id: 22,
        inventory_item_id: 7,
        inventory_batch_id: 52,
        purchase_order_item_id: 5,
        received_quantity: '0.3000',
        unit_cost_minor: null,
        qc_status: 'pending',
        qc_notes: null,
      },
      goods_receipt: {
        id: 22,
        facility_id: FACILITY,
        supplier_id: SUPPLIER,
        purchase_order_id: 10,
        status: 'qc_pending',
      },
      purchase_order_item: {
        id: 5,
        purchase_order_id: 10,
        ordered_quantity: '1.0000',
        received_quantity: '0.3000',
      },
      purchase_order: {
        id: 10,
        tenant_id: TENANT,
        facility_id: FACILITY,
        supplier_id: SUPPLIER,
        status: 'partially_received',
      },
      total_ordered: 1,
      total_received: 0.3,
    };
    const movement = {
      id: 82,
      tenant_id: TENANT,
      inventory_item_id: 7,
      inventory_batch_id: 52,
      movement_kind: 'receive',
      quantity_delta: '0.3000',
      reference_type: 'goods_receipt',
      reference_id: '22',
      performed_by: USER,
      notes: 'Received via GRN 22, batch GRN-REPLAY',
    };
    const metadata = {
      contract: 'pharmacy_grn_receive_line_v1',
      command_key_sha256: sha256('grn-receive-test'),
      request_fingerprint: REQUEST_FINGERPRINT,
      facility_id: FACILITY,
      intent: {
        facility_id: FACILITY,
        inventory_item_id: 7,
        inventory_batch_id: 52,
        movement_kind: 'receive',
        quantity_delta: '0.3000',
        reference_type: 'goods_receipt',
        reference_id: '22',
        performed_by: USER,
        purchase_order_id: 10,
        purchase_order_item_id: 5,
        goods_receipt_id: 22,
        goods_receipt_item_id: 100,
        supplier_id: SUPPLIER,
        storage_location_id: 51,
        batch_number: 'GRN-REPLAY',
        lot_number: null,
        manufacture_date: null,
        expiry_date: '2099-01-01',
        received_quantity: '0.3000',
        unit_cost_minor: null,
        po_line_received_before: '0.0000',
        total_ordered: '1.0000',
        total_received_before: '0.0000',
        controlled: false,
        register_evidence: null,
      },
      response_payload: stored,
    };
    const currentBatch = {
      ...stored.batch,
      remaining_quantity: '0.1000',
      status: 'in_stock',
    };
    const currentPoLine = {
      ...stored.purchase_order_item,
      received_quantity: '0.6000',
    };
    const currentPo = {
      ...stored.purchase_order,
      status: 'fully_received',
    };
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      ...aliasFields('movement', { ...movement, metadata }),
      ...aliasFields('batch', currentBatch),
      ...aliasFields('grn_line', stored.goods_receipt_item),
      ...aliasFields('grn', stored.goods_receipt),
      ...aliasFields('po_line', currentPoLine),
      ...aliasFields('po', currentPo),
      lineage_item_id: 7,
      lineage_item_facility_id: FACILITY,
      lineage_item_schedule_class: 'OTC',
      lineage_item_is_narcotic: false,
      lineage_item_unit_label: 'tab',
      controlled_register_count: 0,
    }]);

    await expect(receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'GRN-REPLAY',
      expiryDate: '2099-01-01',
      receivedQuantity: 0.3,
    })).resolves.toEqual(stored);

    expect(facilityGrantMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      facilityId: FACILITY,
      actorUid: USER,
    }));
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/LEFT JOIN pharmacy_goods_receipt_items grn_line/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/LEFT JOIN pharmacy_purchase_orders po/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/pharmacy_schedule_register register/);
    expect(queryUnsafeMock.mock.calls[1][0]).not.toMatch(/SUM\(total_line\.received_quantity\)/);
  });

  it('rejects an expired GRN batch before any receipt lineage is mutated', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'EXPIRED-GRN',
      expiryDate: '2000-01-01',
      receivedQuantity: 5,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_GRN_AUTHORITY_INVALID',
    });

    expect(queryUnsafeMock.mock.calls[2][0])
      .toMatch(/\$5::date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date/);
    expect(queryUnsafeMock.mock.calls[2][5]).toBe('2000-01-01');
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_inventory_batches/.test(sql)))
      .toBe(false);
  });

  it('prohibits facility, catalog, supplier, or status rehome after descendants exist', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      facility_id: FACILITY,
      catalog_id: CATALOG + 1,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: SUPPLIER }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      facility_id: FACILITY,
      catalog_id: CATALOG,
      default_supplier_id: SUPPLIER,
      status: 'active',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ has_history: true }]);

    await expect(upsertInventoryItem({
      tenantId: TENANT,
      id: 7,
      catalogId: CATALOG + 1,
      defaultSupplierId: SUPPLIER,
      skuCode: 'ITEM-7',
      displayName: 'Item 7',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_INVENTORY_ITEM_REHOME_FORBIDDEN',
    });

    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE pharmacy_inventory_items/.test(sql)))
      .toBe(false);
  });

  it('requires an active same-tenant supplier before a purchase order is created', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(createPurchaseOrder({
      tenantId: TENANT,
      poNumber: 'PO-INACTIVE-SUPPLIER',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PURCHASE_ORDER_AUTHORITY_INVALID',
    });

    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/supplier\.status='active'/);
  });

  it('rejects zero direct-receipt quantity before opening a transaction', async () => {
    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 7,
      batchNumber: 'ZERO-QTY',
      expiryDate: '2028-01-01',
      receivedQuantity: 0,
    })).rejects.toThrow(/received_quantity must be >= 0\.0001/);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects zero GRN-receipt quantity before opening a transaction', async () => {
    await expect(receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'ZERO-GRN-QTY',
      expiryDate: '2099-01-01',
      receivedQuantity: 0,
    })).rejects.toThrow(/received_quantity must be >= 0\.0001/);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Severity bands
// ---------------------------------------------------------------------------

describe('severityForDaysRemaining', () => {
  it('maps day windows to severity bands', () => {
    expect(__testing__.severityForDaysRemaining(120)).toBe('low');
    expect(__testing__.severityForDaysRemaining(80)).toBe('medium');
    expect(__testing__.severityForDaysRemaining(45)).toBe('high');
    expect(__testing__.severityForDaysRemaining(15)).toBe('critical');
    expect(__testing__.severityForDaysRemaining(0)).toBe('critical');
    expect(__testing__.severityForDaysRemaining(-5)).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

describe('upsertSupplier', () => {
  it('rejects missing supplier_code', async () => {
    await expect(upsertSupplier({ tenantId: TENANT, displayName: 'X' }))
      .rejects.toThrow(/supplier_code is required/);
  });

  it('rejects rating > 5', async () => {
    await expect(upsertSupplier({
      tenantId: TENANT, supplierCode: 'X', displayName: 'X', rating: 7,
    })).rejects.toThrow(/rating must be 0..5/);
  });

  it('inserts a supplier', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, supplier_code: 'STAR_PHARMA' }]);
    const row = await upsertSupplier({
      tenantId: TENANT, supplierCode: 'STAR_PHARMA', displayName: 'Star Pharmaceuticals',
      gstin: '29AAAAA0000A1Z5',
    });
    expect(row.id).toBe(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/tenant_id, facility_id, supplier_code/);
    expect(queryUnsafeMock.mock.calls[0][2]).toBe(FACILITY);
  });

  it('throws conflict on duplicate supplier_code', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertSupplier({
      tenantId: TENANT, supplierCode: 'X', displayName: 'X',
    })).rejects.toThrow(/already exists/);
  });

  it('rejects supplier writes before exposing or mutating supplier data when the facility grant is absent', async () => {
    facilityGrantMock.mockRejectedValueOnce(Object.assign(new Error('grant required'), {
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    }));

    await expect(upsertSupplier({
      tenantId: TENANT,
      supplierCode: 'NO_GRANT',
      displayName: 'No grant supplier',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('cannot update a supplier owned by another facility', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(upsertSupplier({
      tenantId: TENANT,
      id: 9,
      supplierCode: 'OTHER_FACILITY',
      displayName: 'Other facility supplier',
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/facility_id=\$17::int/);
    expect(queryUnsafeMock.mock.calls[0][17]).toBe(FACILITY);
  });
});

describe('listSuppliers facility authority', () => {
  it('rejects supplier reads before querying sensitive supplier data when the facility grant is absent', async () => {
    facilityGrantMock.mockRejectedValueOnce(Object.assign(new Error('grant required'), {
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    }));

    await expect(listSuppliers({ tenantId: TENANT })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('fails closed on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_suppliers" does not exist'));
    await expect(listSuppliers({ tenantId: TENANT }))
      .rejects.toThrow(/pharmacy_suppliers/);
  });

  it('only returns sensitive suppliers owned by the exact granted facility', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, facility_id: FACILITY }]);

    const result = await listSuppliers({ tenantId: TENANT });

    expect(result.count).toBe(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/facility_id = \$2::int/);
    expect(queryUnsafeMock.mock.calls[0][2]).toBe(FACILITY);
  });
});

// ---------------------------------------------------------------------------
// Inventory items
// ---------------------------------------------------------------------------

describe('upsertInventoryItem', () => {
  it('rejects missing sku_code', async () => {
    await expect(upsertInventoryItem({ tenantId: TENANT, displayName: 'X' }))
      .rejects.toThrow(/sku_code is required/);
  });

  it('inserts an active item with narcotic flag', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      facility_id: FACILITY,
      catalog_id: CATALOG,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, sku_code: 'MORPH_10', is_narcotic: true,
    }]);
    const row = await upsertInventoryItem({
      tenantId: TENANT, skuCode: 'MORPH_10', displayName: 'Morphine 10mg',
      isNarcotic: true, scheduleClass: 'X',
    });
    expect(row.is_narcotic).toBe(true);
  });
});

describe('listInventoryItems', () => {
  it('filters by isNarcotic', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listInventoryItems({ tenantId: TENANT, isNarcotic: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/is_narcotic = \$\d/);
  });

  it('searches the inventory master by identity fields', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listInventoryItems({ tenantId: TENANT, q: 'coronary stent' });
    const [sql, tenantId, facilityId, query] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('LOWER(display_name)');
    expect(sql).toContain('LOWER(sku_code)');
    expect(sql).toContain("LOWER(COALESCE(manufacturer, ''))");
    expect(tenantId).toBe(TENANT);
    expect(facilityId).toBe(FACILITY);
    expect(query).toBe('%coronary stent%');
  });

  it('fails closed when the inventory schema is missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_inventory_items" does not exist'));
    await expect(listInventoryItems({ tenantId: TENANT }))
      .rejects.toThrow(/pharmacy_inventory_items/);
  });
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

describe('addInventoryBatch', () => {
  it('rejects missing batch_number', async () => {
    await expect(addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 1, expiryDate: '2026-12-31', receivedQuantity: 100,
    })).rejects.toThrow(/batch_number is required/);
  });

  it('rejects malformed expiry_date', async () => {
    await expect(addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 1, batchNumber: 'B1',
      expiryDate: 'tomorrow', receivedQuantity: 100,
    })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it.each(['2028-02-30', '2028-01-01junk'])(
    'rejects non-calendar or suffix-junk expiry date %s',
    async (expiryDate) => {
      await expect(addInventoryBatch({
        tenantId: TENANT,
        inventoryItemId: 1,
        batchNumber: 'B-STRICT-DATE',
        expiryDate,
        receivedQuantity: 100,
      })).rejects.toMatchObject({ statusCode: 400 });
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it('rejects manufacture_date after expiry_date before opening a transaction', async () => {
    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 1,
      batchNumber: 'B-DATE-RANGE',
      manufactureDate: '2099-02-01',
      expiryDate: '2099-01-01',
      receivedQuantity: 100,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_BATCH_DATE_RANGE_INVALID',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unitCostMinor', 100.5, 'unit_cost_minor'],
    ['mrpMinor', 200.25, 'mrp_minor'],
  ])('rejects fractional %s instead of rounding minor units', async (field, value, label) => {
    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 1,
      batchNumber: 'B-FRACTIONAL-MINOR',
      expiryDate: '2099-01-01',
      receivedQuantity: 1,
      [field]: value,
    })).rejects.toThrow(`${label} must be an integer number of minor units`);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['999999999999.9999999999999999', 'unit_cost_minor'],
    ['1e3', 'unit_cost_minor'],
    [' 100 ', 'unit_cost_minor'],
  ])('rejects non-integer lexical minor-unit input %s', async (value, label) => {
    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 1,
      batchNumber: 'B-LEXICAL-MINOR',
      expiryDate: '2099-01-01',
      receivedQuantity: 1,
      unitCostMinor: value,
    })).rejects.toThrow(`${label} must be an integer number of minor units`);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects a high-magnitude fifth decimal before quantity conversion can round it', async () => {
    await expect(addInventoryBatch({
      tenantId: TENANT,
      inventoryItemId: 1,
      batchNumber: 'B-FIFTH-DECIMAL',
      expiryDate: '2099-01-01',
      receivedQuantity: '999999999.99999',
    })).rejects.toThrow(
      'received_quantity must be a plain decimal with at most 4 decimal places',
    );
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('inserts batch + appends receive movement', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5,
      facility_id: FACILITY,
      catalog_id: CATALOG,
      supplier_id: SUPPLIER,
      schedule_class: null,
      is_narcotic: false,
      unit_label: 'tab',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, batch_number: 'B1', inventory_item_id: 5, facility_id: FACILITY,
      received_quantity: 100, remaining_quantity: 0, status: 'in_stock',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      inventory_item_id: 5,
      facility_id: FACILITY,
      batch_number: 'B1',
      expiry_date: '2026-12-31',
      remaining_quantity: 0,
      status: 'in_stock',
      is_expired: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 91, movement_kind: 'receive' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, batch_number: 'B1', inventory_item_id: 5, facility_id: FACILITY,
      received_quantity: 100, remaining_quantity: 100, status: 'in_stock',
    }]);
    const batch = await addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 5, batchNumber: 'B1',
      expiryDate: '2026-12-31', receivedQuantity: 100,
    });
    expect(batch.id).toBe(1);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[5][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    const insertedMetadata = JSON.parse(queryUnsafeMock.mock.calls[5].at(-1));
    expect(insertedMetadata).toMatchObject({
      contract: 'pharmacy_inventory_direct_receive_v1',
      request_fingerprint: REQUEST_FINGERPRINT,
      facility_id: FACILITY,
      intent: {
        facility_id: FACILITY,
        inventory_item_id: 5,
        inventory_batch_id: 1,
        movement_kind: 'receive',
        quantity_delta: 100,
        supplier_id: SUPPLIER,
        storage_location_id: 51,
        controlled: false,
        register_evidence: null,
      },
      response_payload: {
        id: 1,
        inventory_item_id: 5,
        facility_id: FACILITY,
        batch_number: 'B1',
        received_quantity: 100,
        remaining_quantity: 100,
        status: 'in_stock',
      },
    });
    expect(executeUnsafeMock.mock.calls.some(([sql]) => /UPDATE pharmacy_stock_movements/.test(sql)))
      .toBe(false);
  });

  it('throws conflict on duplicate (item, batch)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      facility_id: FACILITY,
      catalog_id: CATALOG,
      supplier_id: SUPPLIER,
      schedule_class: null,
      is_narcotic: false,
    }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 1, batchNumber: 'B1',
      expiryDate: '2026-12-31', receivedQuantity: 100,
    })).rejects.toThrow(/already exists/);
  });
});

describe('listBatches', () => {
  it('filters by expiringWithinDays', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listBatches({ tenantId: TENANT, expiringWithinDays: 30 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/INTERVAL '1 day'/);
    expect(sql).toMatch(/supplier\.id=pharmacy_inventory_batches\.supplier_id/);
    expect(sql).not.toMatch(/movement\./);
  });
});

describe('recallBatch', () => {
  it('flips status to recalled without writing a stock movement or register row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ facility_id: FACILITY }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'recalled', recall_reference: 'CDSCO-2026-04',
      inventory_item_id: 5, remaining_quantity: 12,
    }]);
    const row = await recallBatch({
      tenantId: TENANT, id: 1, recallReference: 'CDSCO-2026-04', performedBy: USER,
    });
    expect(row.status).toBe('recalled');
    expect(row.remaining_quantity).toBe(12);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/UPDATE pharmacy_inventory_batches/);
  });

  it('fails closed when the batch authority chain is missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(recallBatch({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'PHARMACY_BATCH_AUTHORITY_INVALID',
      });
  });

  it('returns an exact same-reference recall replay and rejects a changed reference', async () => {
    const recalled = {
      id: 1, status: 'recalled', recall_reference: 'CDSCO-2026-04',
      inventory_item_id: 5, remaining_quantity: 12,
    };
    queryUnsafeMock.mockResolvedValueOnce([{ facility_id: FACILITY }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([recalled]);
    await expect(recallBatch({
      tenantId: TENANT, id: 1, recallReference: 'CDSCO-2026-04',
    })).resolves.toEqual(recalled);

    queryUnsafeMock.mockResolvedValueOnce([{ facility_id: FACILITY }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([recalled]);
    await expect(recallBatch({
      tenantId: TENANT, id: 1, recallReference: 'CDSCO-2026-05',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BATCH_RECALL_REPLAY_MISMATCH',
    });
  });
});

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

describe('createPurchaseOrder + transitionPurchaseOrder', () => {
  it('creates a draft PO', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ facility_id: FACILITY, supplier_id: 5 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'draft' }]);
    const row = await createPurchaseOrder({
      tenantId: TENANT, poNumber: 'PO-001', supplierId: 5,
    });
    expect(row.status).toBe('draft');
  });

  it.each(['2028-02-30T10:30:00+05:30', '2028-01-01T10:30:00Zjunk'])(
    'rejects invalid expected_at value %s before opening a transaction',
    async (expectedAt) => {
      await expect(createPurchaseOrder({
        tenantId: TENANT,
        poNumber: 'PO-BAD-DATE',
        expectedAt,
      })).rejects.toMatchObject({ statusCode: 400 });
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it('transition to submitted stamps ordered_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'draft', facility_id: FACILITY, supplier_id: SUPPLIER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'submitted' }]);
    await transitionPurchaseOrder({
      tenantId: TENANT, id: 1, nextStatus: 'submitted',
    });
    const sql = queryUnsafeMock.mock.calls.at(-1)[0];
    expect(sql).toMatch(/ordered_at = \$\d::timestamptz/);
  });

  it('transition to approved stamps approved_by + approved_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'submitted', facility_id: FACILITY, supplier_id: SUPPLIER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ uid: USER }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    await transitionPurchaseOrder({
      tenantId: TENANT, id: 1, nextStatus: 'approved', approvedBy: USER,
    });
    const sql = queryUnsafeMock.mock.calls.at(-1)[0];
    expect(sql).toMatch(/approved_at = \$\d::timestamptz/);
    expect(sql).toMatch(/approved_by = \$\d::uuid/);
  });

  it('rejects unknown next_status', async () => {
    await expect(transitionPurchaseOrder({
      tenantId: TENANT, id: 1, nextStatus: 'magic',
    })).rejects.toThrow(/next_status must be one of/);
  });

  it.each(['partially_received', 'fully_received'])(
    'reserves %s for the governed receive-line workflow',
    async (nextStatus) => {
      await expect(transitionPurchaseOrder({
        tenantId: TENANT,
        id: 1,
        nextStatus,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'PHARMACY_PURCHASE_ORDER_RECEIPT_STATE_DERIVED',
      });
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );
});

describe('addPurchaseOrderItem', () => {
  it('rejects tax_rate_pct out of range', async () => {
    await expect(addPurchaseOrderItem({
      tenantId: TENANT, purchaseOrderId: 1, inventoryItemId: 5,
      orderedQuantity: 10, taxRatePct: 200,
    })).rejects.toThrow(/tax_rate_pct must be 0..100/);
  });

  it('throws conflict on duplicate item per PO', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, facility_id: FACILITY }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(addPurchaseOrderItem({
      tenantId: TENANT, purchaseOrderId: 1, inventoryItemId: 5, orderedQuantity: 10,
    })).rejects.toThrow(/already on this PO/);
  });
});

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

describe('createGoodsReceipt + listGoodsReceipts', () => {
  it('creates a received GRN', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 10,
      facility_id: FACILITY,
      supplier_id: 5,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'received', grn_number: 'GRN-001' }]);
    const row = await createGoodsReceipt({
      tenantId: TENANT, grnNumber: 'GRN-001', supplierId: 5,
      invoiceNumber: 'INV-99', invoiceDate: '2026-04-15',
    });
    expect(row.status).toBe('received');
  });

  it('listGoodsReceipts fails closed on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_goods_receipts" does not exist'));
    await expect(listGoodsReceipts({ tenantId: TENANT }))
      .rejects.toThrow(/pharmacy_goods_receipts/);
  });
});

describe('goods receipt QC and terminal lifecycle', () => {
  it('moves a passed QC line from exact active quarantine storage into usable stock', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      goods_receipt_id: 22,
      facility_id: FACILITY,
      goods_receipt_status: 'qc_pending',
      goods_receipt_item_id: 100,
      inventory_item_id: 7,
      inventory_batch_id: 50,
      qc_status: 'pending',
      qc_notes: null,
      batch_status: 'quarantined',
      expiry_date: '2099-01-01',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ today: '2026-08-29' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 100, goods_receipt_id: 22, inventory_batch_id: 50, qc_status: 'passed',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, facility_id: FACILITY, storage_location_id: 51, status: 'in_stock',
    }]);

    const result = await recordGoodsReceiptItemQc({
      tenantId: TENANT,
      goodsReceiptId: 22,
      goodsReceiptItemId: 100,
      qcStatus: 'passed',
      qcNotes: 'Packaging intact',
    });

    expect(result.goods_receipt_item.qc_status).toBe('passed');
    expect(result.batch.status).toBe('in_stock');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/JOIN facility_locations location/);
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/status='quarantined'/);
  });

  it('makes a completed line decision immutable', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      goods_receipt_id: 22,
      facility_id: FACILITY,
      goods_receipt_status: 'qc_pending',
      goods_receipt_item_id: 100,
      inventory_item_id: 7,
      inventory_batch_id: 50,
      qc_status: 'passed',
      qc_notes: 'Accepted',
      batch_status: 'in_stock',
      expiry_date: '2099-01-01',
    }]);

    await expect(recordGoodsReceiptItemQc({
      tenantId: TENANT,
      goodsReceiptId: 22,
      goodsReceiptItemId: 100,
      qcStatus: 'failed',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_GRN_QC_IMMUTABLE',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('governs reject, finalize, close, and archive as explicit one-way transitions', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 22, facility_id: FACILITY, status: 'received' }])
      .mockResolvedValueOnce([{
        total_count: 0, pending_count: 0, passed_count: 0, failed_count: 0,
      }])
      .mockResolvedValueOnce([{ id: 22, facility_id: FACILITY, status: 'rejected' }])
      .mockResolvedValueOnce([{ id: 23, facility_id: FACILITY, status: 'qc_pending' }])
      .mockResolvedValueOnce([{
        total_count: 2, pending_count: 0, passed_count: 1, failed_count: 1,
      }])
      .mockResolvedValueOnce([{ id: 23, facility_id: FACILITY, status: 'partial' }])
      .mockResolvedValueOnce([{ id: 23, facility_id: FACILITY, status: 'partial' }])
      .mockResolvedValueOnce([{
        total_count: 2, pending_count: 0, passed_count: 1, failed_count: 1,
      }])
      .mockResolvedValueOnce([{ id: 23, facility_id: FACILITY, status: 'closed' }])
      .mockResolvedValueOnce([{ id: 23, facility_id: FACILITY, status: 'closed' }])
      .mockResolvedValueOnce([{
        total_count: 2, pending_count: 0, passed_count: 1, failed_count: 1,
      }])
      .mockResolvedValueOnce([{ id: 23, facility_id: FACILITY, status: 'archived' }]);

    await expect(transitionGoodsReceipt({
      tenantId: TENANT, id: 22, action: 'reject',
    })).resolves.toMatchObject({ status: 'rejected' });
    await expect(transitionGoodsReceipt({
      tenantId: TENANT, id: 23, action: 'finalize',
    })).resolves.toMatchObject({ status: 'partial' });
    await expect(transitionGoodsReceipt({
      tenantId: TENANT, id: 23, action: 'close',
    })).resolves.toMatchObject({ status: 'closed' });
    await expect(transitionGoodsReceipt({
      tenantId: TENANT, id: 23, action: 'archive',
    })).resolves.toMatchObject({ status: 'archived' });

    const updateStatuses = queryUnsafeMock.mock.calls
      .filter(([sql]) => /UPDATE pharmacy_goods_receipts/.test(sql))
      .map((call) => call[3]);
    expect(updateStatuses).toEqual(['rejected', 'partial', 'closed', 'archived']);
  });
});

describe('listPurchaseOrders fail-closed behavior', () => {
  it('rejects on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_purchase_orders" does not exist'));
    await expect(listPurchaseOrders({ tenantId: TENANT }))
      .rejects.toThrow(/pharmacy_purchase_orders/);
  });
});

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------

describe('appendStockMovement', () => {
  it('rejects unknown movement_kind', async () => {
    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 1, movementKind: 'magic', quantityDelta: 10,
    })).rejects.toThrow(/movement_kind must be one of/);
  });

  it('rejects non-numeric quantity_delta', async () => {
    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 1, movementKind: 'issue', quantityDelta: 'lots',
    })).rejects.toThrow(
      'quantity_delta must be a plain decimal with at most 4 decimal places',
    );
  });

  it.each([1.00001, '999999999.99999', 1_000_000_000.0001])(
    'rejects movement quantity %s outside ledger precision or range',
    async (quantityDelta) => {
      await expect(appendStockMovement({
        tenantId: TENANT,
        inventoryItemId: 1,
        inventoryBatchId: 2,
        movementKind: 'adjust_increase',
        quantityDelta,
      })).rejects.toMatchObject({ statusCode: 400 });
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it('requires an exact batch for every authoritative movement', async () => {
    await expect(appendStockMovement({
      tenantId: TENANT,
      inventoryItemId: 1,
      movementKind: 'adjust_increase',
      quantityDelta: 1,
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVENTORY_BATCH_REQUIRED' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('requires durable idempotency before opening a stock transaction', async () => {
    await expect(supply.appendStockMovement({
      tenantId: TENANT,
      inventoryItemId: 1,
      inventoryBatchId: 2,
      movementKind: 'adjust_increase',
      quantityDelta: 1,
      performedBy: USER,
      actorRole: ACTOR_ROLE,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_STOCK_MOVEMENT_IDEMPOTENCY_REQUIRED',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('fails closed when a stock-movement command has duplicate durable receipts', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([
      {
        movement_metadata: { request_sha256: REQUEST_FINGERPRINT },
      },
      {
        movement_metadata: { request_sha256: REQUEST_FINGERPRINT },
      },
    ]);

    await expect(appendStockMovement({
      tenantId: TENANT,
      inventoryItemId: 5,
      inventoryBatchId: 51,
      movementKind: 'adjust_increase',
      quantityDelta: 2,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVENTORY_COMMAND_REPLAY_CONFLICT',
    });

    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/LIMIT 2/);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_stock_movements/.test(sql)))
      .toBe(false);
  });

  it('reconstructs a movement replay from the immutable movement and its exact batch lineage', async () => {
    const metadata = {
      contract: 'pharmacy_supply_stock_movement_v1',
      command_key_sha256: sha256('stock-movement-test'),
      request_sha256: REQUEST_FINGERPRINT,
      facility_id: FACILITY,
      intent: {
        facility_id: FACILITY,
        inventory_item_id: 5,
        inventory_batch_id: 51,
        movement_kind: 'adjust_increase',
        quantity_delta: 2,
        reference_type: null,
        reference_id: null,
        performed_by: USER,
        notes: null,
        controlled: false,
        register_evidence: null,
      },
      response: {
        contract: 'pharmacy_supply_stock_movement_v1',
        facility_id: FACILITY,
        inventory_item_id: 5,
        inventory_batch_id: 51,
        movement_kind: 'adjust_increase',
        quantity_delta: 2,
        reference_type: null,
        reference_id: null,
        performed_by: USER,
        notes: null,
      },
    };
    const storedMovement = {
      id: 81,
      tenant_id: TENANT,
      inventory_item_id: 5,
      inventory_batch_id: 51,
      movement_kind: 'adjust_increase',
      quantity_delta: 2,
      reference_type: null,
      reference_id: null,
      performed_by: USER,
      notes: null,
      metadata,
    };
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      ...aliasFields('movement', storedMovement),
      lineage_batch_id: 51,
      lineage_inventory_item_id: 5,
      lineage_facility_id: FACILITY,
      lineage_item_id: 5,
      lineage_item_facility_id: FACILITY,
      lineage_item_schedule_class: 'OTC',
      lineage_item_is_narcotic: false,
      lineage_item_unit_label: 'tab',
      controlled_register_count: 0,
    }]);

    await expect(appendStockMovement({
      tenantId: TENANT,
      inventoryItemId: 5,
      inventoryBatchId: 51,
      movementKind: 'adjust_increase',
      quantityDelta: 2,
    })).resolves.toEqual({ ...storedMovement, facility_id: FACILITY });

    expect(facilityGrantMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      facilityId: FACILITY,
      actorUid: USER,
    }));
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/LEFT JOIN pharmacy_inventory_batches batch/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/pharmacy_schedule_register register/);
  });

  it('fails closed when a matching movement receipt lacks immutable reconstruction intent', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      movement_metadata: {
        contract: 'pharmacy_supply_stock_movement_v1',
        command_key_sha256: sha256('stock-movement-test'),
        request_sha256: REQUEST_FINGERPRINT,
        facility_id: FACILITY,
      },
    }]);

    await expect(appendStockMovement({
      tenantId: TENANT,
      inventoryItemId: 5,
      inventoryBatchId: 51,
      movementKind: 'adjust_increase',
      quantityDelta: 2,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVENTORY_COMMAND_RECEIPT_INCOMPLETE',
    });

    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO pharmacy_stock_movements/.test(sql)))
      .toBe(false);
  });

  it('locks the exact batch, writes the movement, and projects its balance', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5,
      facility_id: FACILITY,
      status: 'active',
      schedule_class: null,
      is_narcotic: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 51,
      inventory_item_id: 5,
      batch_number: 'UNIT-B1',
      lot_number: null,
      expiry_date: '2028-01-01',
      remaining_quantity: 10,
      status: 'in_stock',
      is_expired: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, movement_kind: 'adjust_increase' }]);
    const row = await appendStockMovement({
      tenantId: TENANT, inventoryItemId: 5, inventoryBatchId: 51,
      movementKind: 'adjust_increase',
      quantityDelta: 2, performedBy: USER, notes: 'count correction',
    });
    expect(row.id).toBe(1);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/pharmacy_inventory_items[\s\S]*FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    const insertedMetadata = JSON.parse(queryUnsafeMock.mock.calls[4].at(-1));
    expect(insertedMetadata).toMatchObject({
      contract: 'pharmacy_supply_stock_movement_v1',
      request_sha256: REQUEST_FINGERPRINT,
      facility_id: FACILITY,
      intent: {
        facility_id: FACILITY,
        inventory_item_id: 5,
        inventory_batch_id: 51,
        movement_kind: 'adjust_increase',
        quantity_delta: 2,
        controlled: false,
        register_evidence: null,
      },
      response: {
        contract: 'pharmacy_supply_stock_movement_v1',
        facility_id: FACILITY,
        inventory_item_id: 5,
        inventory_batch_id: 51,
        movement_kind: 'adjust_increase',
        quantity_delta: 2,
        notes: 'count correction',
      },
    });
    expect(executeUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeUnsafeMock.mock.calls[0][0]).toMatch(/UPDATE pharmacy_inventory_batches/);
    expect(executeUnsafeMock.mock.calls.some(([sql]) => /UPDATE pharmacy_stock_movements/.test(sql)))
      .toBe(false);
  });
});

describe('listStockMovements', () => {
  it('filters by inventory_batch_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listStockMovements({ tenantId: TENANT, inventoryBatchId: 7 });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/inventory_batch_id = \$\d/);
  });
});

// ---------------------------------------------------------------------------
// Expiry alerts
// ---------------------------------------------------------------------------

describe('computeExpiryAlerts', () => {
  it('creates a new alert when none exists for a batch', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, inventory_item_id: 5, expiry_date: '2026-05-15', days_remaining: 15 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]); // existing alert lookup
    queryUnsafeMock.mockResolvedValueOnce([]); // INSERT
    const result = await computeExpiryAlerts({ tenantId: TENANT, lookaheadDays: 90 });
    expect(result.scanned).toBe(1);
    expect(result.created).toBe(1);
    const insertSql = queryUnsafeMock.mock.calls[2][0];
    expect(insertSql).toMatch(/INSERT INTO pharmacy_expiry_alerts/);
  });

  it('refreshes existing alert instead of duplicating', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, inventory_item_id: 5, expiry_date: '2026-05-15', days_remaining: 15 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99 }]); // existing alert
    queryUnsafeMock.mockResolvedValueOnce([]); // UPDATE
    const result = await computeExpiryAlerts({ tenantId: TENANT, lookaheadDays: 90 });
    expect(result.created).toBe(0);
  });

  it('fails closed on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_inventory_batches" does not exist'));
    await expect(computeExpiryAlerts({ tenantId: TENANT }))
      .rejects.toThrow(/pharmacy_inventory_batches/);
  });
});

describe('acknowledgeExpiryAlert', () => {
  it('rejects when acknowledged_by missing', async () => {
    await expect(acknowledgeExpiryAlert({ tenantId: TENANT, id: 1 }))
      .rejects.toThrow(/acknowledged_by is required/);
  });

  it('flips to acknowledged with resolution', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ facility_id: FACILITY }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'acknowledged' }]);
    const row = await acknowledgeExpiryAlert({
      tenantId: TENANT, id: 1, acknowledgedBy: USER, resolution: 'returned_to_supplier',
    });
    expect(row.status).toBe('acknowledged');
  });

  it('throws 404 when alert not open', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(acknowledgeExpiryAlert({
      tenantId: TENANT, id: 1, acknowledgedBy: USER,
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listExpiryAlerts', () => {
  it('filters by severity + status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listExpiryAlerts({ tenantId: TENANT, severity: 'critical', status: 'open' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/severity = \$\d/);
    expect(sql).toMatch(/status = \$\d/);
  });
});

// ---------------------------------------------------------------------------
// Substitutes
// ---------------------------------------------------------------------------

describe('addSubstitute', () => {
  it('rejects self-substitution', async () => {
    await expect(addSubstitute({
      tenantId: TENANT, primaryItemId: 1, substituteItemId: 1,
    })).rejects.toThrow(/must differ/);
  });

  it('rejects unknown substitution_kind', async () => {
    await expect(addSubstitute({
      tenantId: TENANT, primaryItemId: 1, substituteItemId: 2,
      substitutionKind: 'magic',
    })).rejects.toThrow(/substitution_kind must be one of/);
  });

  it('inserts a generic-equivalent pair', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ facility_id: FACILITY }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, primary_item_id: 1, substitute_item_id: 2, substitution_kind: 'generic_equivalent',
    }]);
    const row = await addSubstitute({
      tenantId: TENANT, primaryItemId: 1, substituteItemId: 2,
    });
    expect(row.substitution_kind).toBe('generic_equivalent');
  });

  it('throws conflict on duplicate pair', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ facility_id: FACILITY }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(addSubstitute({
      tenantId: TENANT, primaryItemId: 1, substituteItemId: 2,
    })).rejects.toThrow(/already exists/);
  });
});

describe('listSubstitutes', () => {
  it('looks up by either direction when bidirectional', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listSubstitutes({ tenantId: TENANT, primaryItemId: 5 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/is_bidirectional = true/);
  });

  it('fails closed on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_substitutes" does not exist'));
    await expect(listSubstitutes({ tenantId: TENANT }))
      .rejects.toThrow(/pharmacy_substitutes/);
  });
});

// ---------------------------------------------------------------------------
// receivePurchaseOrderLine — atomic GRN line orchestration (C4 follow-up)
// ---------------------------------------------------------------------------

describe('receivePurchaseOrderLine', () => {
  it('inserts batch + GRN item + bumps PO line + appends receive movement in one transaction', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 0,
      facility_id: FACILITY, supplier_id: SUPPLIER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_id: FACILITY, status: 'active',
      schedule_class: null, is_narcotic: false, unit_label: 'tab',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, batch_number: 'B1', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 50, remaining_quantity: 0, status: 'quarantined',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, ordered_quantity: 100, received_quantity: 50,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 100, goods_receipt_id: 22, inventory_item_id: 7,
      inventory_batch_id: 50, purchase_order_item_id: 5, received_quantity: 50,
      tenant_id: TENANT, unit_cost_minor: 50000, qc_status: 'pending', qc_notes: null,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 22, status: 'qc_pending', facility_id: FACILITY,
      supplier_id: SUPPLIER, purchase_order_id: 10,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      total_ordered: 100, total_received: 50, total_received_before: 0, partial_count: 1,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 10, tenant_id: TENANT, facility_id: FACILITY,
      supplier_id: SUPPLIER, status: 'partially_received',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, inventory_item_id: 7, facility_id: FACILITY,
      batch_number: 'B1', expiry_date: '2027-01-01', remaining_quantity: 0,
      status: 'quarantined', is_expired: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 903, movement_kind: 'receive' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, batch_number: 'B1', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 50, remaining_quantity: 50, status: 'quarantined',
    }]);

    const result = await receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'B1',
      expiryDate: '2027-01-01',
      receivedQuantity: 50,
      unitCostMinor: 50000,
      performedBy: USER,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(result.batch.id).toBe(50);
    expect(result.goods_receipt_item.id).toBe(100);
    expect(result.purchase_order_item.received_quantity).toBe(50);
    expect(result.purchase_order.status).toBe('partially_received');

    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/INSERT INTO pharmacy_inventory_batches/);
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/storage_location_id, status[\s\S]*'quarantined'/);
    expect(queryUnsafeMock.mock.calls[4][12]).toBe(51);
    expect(queryUnsafeMock.mock.calls[5][0]).toMatch(/UPDATE pharmacy_purchase_order_items/);
    expect(queryUnsafeMock.mock.calls[6][0]).toMatch(/INSERT INTO pharmacy_goods_receipt_items/);
    expect(queryUnsafeMock.mock.calls[11][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    const insertedMetadata = JSON.parse(queryUnsafeMock.mock.calls[11].at(-1));
    expect(insertedMetadata).toMatchObject({
      contract: 'pharmacy_grn_receive_line_v1',
      request_fingerprint: REQUEST_FINGERPRINT,
      facility_id: FACILITY,
      intent: {
        facility_id: FACILITY,
        inventory_item_id: 7,
        inventory_batch_id: 50,
        movement_kind: 'receive',
        // Canonical fixed-scale decimal, like every other quantity in this
        // intent record — a bare number would accept float drift.
        quantity_delta: '50.0000',
        purchase_order_id: 10,
        purchase_order_item_id: 5,
        goods_receipt_id: 22,
        goods_receipt_item_id: 100,
        supplier_id: SUPPLIER,
        storage_location_id: 51,
        po_line_received_before: '0.0000',
        total_ordered: '100.0000',
        total_received_before: '0.0000',
        controlled: false,
        register_evidence: null,
      },
      response_payload: {
        batch: { id: 50, remaining_quantity: 50, status: 'quarantined' },
        goods_receipt_item: { id: 100, qc_status: 'pending', qc_notes: null },
        goods_receipt: { id: 22, status: 'qc_pending' },
        purchase_order_item: { id: 5, received_quantity: 50 },
        purchase_order: { id: 10, status: 'partially_received' },
        total_ordered: 100,
        total_received: 50,
      },
    });
    expect(executeUnsafeMock.mock.calls.some(([sql]) => /UPDATE pharmacy_stock_movements/.test(sql)))
      .toBe(false);
  });

  it('refuses to over-receive (received_quantity + delta > ordered → 409)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 80,
      facility_id: FACILITY, supplier_id: SUPPLIER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_id: FACILITY, status: 'active',
      schedule_class: null, is_narcotic: false, unit_label: 'tab',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 51, batch_number: 'B2', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 50, remaining_quantity: 0,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'B2',
      expiryDate: '2027-01-01',
      receivedQuantity: 50,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('auto-flips parent PO to fully_received when last line completes', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 80,
      facility_id: FACILITY, supplier_id: SUPPLIER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_id: FACILITY, status: 'active',
      schedule_class: null, is_narcotic: false, unit_label: 'tab',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 52, batch_number: 'B3', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 20, remaining_quantity: 0,
      status: 'quarantined',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, ordered_quantity: 100, received_quantity: 100,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 101 }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 22, status: 'qc_pending', facility_id: FACILITY,
      supplier_id: SUPPLIER, purchase_order_id: 10,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      total_ordered: 100, total_received: 100, total_received_before: 80, partial_count: 1,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 10, tenant_id: TENANT, facility_id: FACILITY,
      supplier_id: SUPPLIER, status: 'fully_received',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 52, inventory_item_id: 7, facility_id: FACILITY,
      batch_number: 'B3', expiry_date: '2027-01-01', remaining_quantity: 0,
      status: 'quarantined', is_expired: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 904, movement_kind: 'receive' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 52, batch_number: 'B3', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 20, remaining_quantity: 20,
      status: 'quarantined',
    }]);

    const result = await receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'B3',
      expiryDate: '2027-01-01',
      receivedQuantity: 20,
    });

    expect(result.purchase_order.status).toBe('fully_received');
    const parentUpdateArgs = queryUnsafeMock.mock.calls[9];
    expect(parentUpdateArgs[0]).toMatch(/UPDATE pharmacy_purchase_orders/);
    expect(parentUpdateArgs[1]).toBe('fully_received');
  });
});

// ---------------------------------------------------------------------------
// Controlled-substance discipline (N1) — schedule H/H1/X + narcotics must not
// move through pharmacy-supply without the statutory register, and decrements
// are refused entirely (witnessed inventory-v2 paths only).
// ---------------------------------------------------------------------------

describe('controlled-substance discipline (N1)', () => {
  const CONTROLLED_ITEM = {
    id: 7, facility_id: FACILITY, status: 'active',
    schedule_class: 'OTC', is_narcotic: true, unit_label: 'amp',
  };
  const H1_ITEM = {
    id: 7, facility_id: FACILITY, status: 'active',
    schedule_class: 'H1', is_narcotic: false, unit_label: 'tab',
  };

  it('exposes the schedule vocabulary through __testing__', () => {
    expect(__testing__.CONTROLLED_SCHEDULES).toEqual(['H', 'H1', 'X']);
    expect(__testing__.SUPPLY_DECREASING_MOVEMENTS.has('issue')).toBe(true);
    expect(__testing__.SUPPLY_DECREASING_MOVEMENTS.has('receive')).toBe(false);
    expect(__testing__.SUPPLY_REGISTER_KIND_BY_MOVEMENT.receive).toBe('receive');
    expect(__testing__.SUPPLY_REGISTER_KIND_BY_MOVEMENT.issue).toBeUndefined();
    expect(__testing__.isControlledSupplyItem({ schedule_class: 'H' })).toBe(true);
    expect(__testing__.isControlledSupplyItem({ schedule_class: null, is_narcotic: true })).toBe(true);
    expect(__testing__.isControlledSupplyItem({ schedule_class: 'OTC', is_narcotic: false })).toBe(false);
    expect(__testing__.canonicalControlledScheduleClass({
      schedule_class: 'OTC', is_narcotic: true,
    })).toBe('X');
    expect(__testing__.CONTROLLED_CUSTODY_BATCH_STATUSES).toEqual([
      'in_stock', 'reserved', 'expired', 'recalled', 'quarantined',
    ]);
  });

  it('appendStockMovement refuses every untyped decrement before touching custody state (409)', async () => {
    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, inventoryBatchId: 71,
      movementKind: 'adjust_decrease', quantityDelta: -5,
    })).rejects.toMatchObject({
      statusCode: 409, code: 'INVENTORY_DECREASE_REQUIRES_GOVERNED_WORKFLOW',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('appendStockMovement rejects a movement-kind/sign mismatch before touching stock', async () => {
    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, inventoryBatchId: 71,
      movementKind: 'return', quantityDelta: -3,
    })).rejects.toMatchObject({
      statusCode: 400, code: 'PHARMACY_STOCK_MOVEMENT_DIRECTION_INVALID',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('appendStockMovement requires a canonical actor before controlled custody access (403)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([H1_ITEM]);

    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, inventoryBatchId: 71,
      movementKind: 'receive', quantityDelta: 10, performedBy: null,
    })).rejects.toMatchObject({
      statusCode: 403, code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });
  });

  it('appendStockMovement writes movement + running balance + register row in one tx for a controlled receive', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([H1_ITEM]); // classification
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]); // item register lock
    queryUnsafeMock.mockResolvedValueOnce([{
      current_balance: '30', running_balance: '40',
    }]); // command-time custody balance
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 71,
      inventory_item_id: 7,
      batch_number: 'H1-B1',
      lot_number: null,
      expiry_date: '2028-01-01',
      remaining_quantity: 30,
      status: 'in_stock',
      is_expired: false,
    }]); // exact batch lock
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 900, tenant_id: TENANT, inventory_item_id: 7, inventory_batch_id: 71,
      movement_kind: 'receive', quantity_delta: 10,
    }]); // movement INSERT
    queryUnsafeMock.mockResolvedValueOnce([{
      current_balance: '40', running_balance: '40',
    }]); // post-movement physical custody
    queryUnsafeMock.mockResolvedValueOnce([controlledRegisterRow({
      id: 77,
      inventoryItemId: 7,
      inventoryBatchId: 71,
      scheduleClass: 'H1',
      movementKind: 'receive',
      quantity: 10,
      runningBalance: 40,
      unitLabel: 'tab',
      referenceMovementId: 900,
    })]);

    const result = await appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, inventoryBatchId: 71, movementKind: 'receive',
      quantityDelta: 10, performedBy: USER,
    });

    expect(result.id).toBe(900);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/pharmacy_inventory_items[\s\S]*FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/pg_advisory_xact_lock/);
    expect(queryUnsafeMock.mock.calls[3][1])
      .toBe(`pharmacy-controlled-register:${TENANT}:7`);
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/status = ANY/);
    expect(queryUnsafeMock.mock.calls[5][0]).toMatch(/FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[6][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    const insertedMetadata = JSON.parse(queryUnsafeMock.mock.calls[6].at(-1));
    expect(insertedMetadata.intent.register_evidence).toEqual({
      facility_id: FACILITY,
      schedule_class: 'H1',
      movement_kind: 'receive',
      quantity: 10,
      unit_label: 'tab',
      running_balance: '40',
    });
    expect(queryUnsafeMock.mock.calls[7][0]).toMatch(/status = ANY/);
    const registerArgs = queryUnsafeMock.mock.calls[8];
    expect(registerArgs[0]).toMatch(/INSERT INTO pharmacy_schedule_register/);
    expect(registerArgs[2]).toBe(FACILITY);
    expect(registerArgs[5]).toBe('H1');
    expect(registerArgs[6]).toBe('receive');
    expect(registerArgs[7]).toBe(10);
    expect(registerArgs[9]).toBe('40');
    expect(registerArgs[10]).toBe(USER);
    expect(registerArgs[11]).toBe(900);
  });

  it('addInventoryBatch requires a canonical actor for a controlled receipt (403)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]);

    await expect(addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 7, batchNumber: 'CX1',
      expiryDate: '2027-06-30', receivedQuantity: 10, performedBy: null,
    })).rejects.toMatchObject({
      statusCode: 403, code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('addInventoryBatch lands batch + movement + register atomically for controlled stock', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 60, batch_number: 'CX1', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 10, remaining_quantity: 0, status: 'in_stock',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]); // item register lock
    queryUnsafeMock.mockResolvedValueOnce([{
      current_balance: '0', running_balance: '10',
    }]); // command-time custody balance
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 60, inventory_item_id: 7, facility_id: FACILITY,
      batch_number: 'CX1', expiry_date: '2027-06-30', remaining_quantity: 0,
      status: 'in_stock', is_expired: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 901, movement_kind: 'receive' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 60, batch_number: 'CX1', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 10, remaining_quantity: 10,
      status: 'in_stock',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      current_balance: '10', running_balance: '10',
    }]); // post-movement physical custody
    queryUnsafeMock.mockResolvedValueOnce([controlledRegisterRow({
      id: 78,
      inventoryItemId: 7,
      inventoryBatchId: 60,
      scheduleClass: 'X',
      movementKind: 'receive',
      quantity: 10,
      runningBalance: 10,
      unitLabel: 'amp',
      referenceMovementId: 901,
      notes: 'Batch CX1 received',
    })]);

    const batch = await addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 7, batchNumber: 'CX1',
      expiryDate: '2027-06-30', receivedQuantity: 10, performedBy: USER,
    });

    expect(batch.id).toBe(60);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/INSERT INTO pharmacy_inventory_batches/);
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/pg_advisory_xact_lock/);
    expect(queryUnsafeMock.mock.calls[6][0]).toMatch(/FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[7][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    const insertedMetadata = JSON.parse(queryUnsafeMock.mock.calls[7].at(-1));
    expect(insertedMetadata.intent.register_evidence).toMatchObject({
      facility_id: FACILITY,
      schedule_class: 'X',
      running_balance: '10',
    });
    expect(queryUnsafeMock.mock.calls[10][0]).toMatch(/INSERT INTO pharmacy_schedule_register/);
    expect(queryUnsafeMock.mock.calls[10][5]).toBe('X');
  });

  it('receivePurchaseOrderLine requires a canonical actor for a controlled GRN receipt (403)', async () => {
    await expect(receivePurchaseOrderLine({
      tenantId: TENANT, purchaseOrderItemId: 5, goodsReceiptId: 22,
      batchNumber: 'CX2', expiryDate: '2027-01-01', receivedQuantity: 50,
      performedBy: null,
    })).rejects.toMatchObject({
      statusCode: 403, code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('receivePurchaseOrderLine appends a register receipt row for controlled stock', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 0,
      facility_id: FACILITY, supplier_id: SUPPLIER,
    }]); // PO line
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]); // classification
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, batch_number: 'CX2', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 50, remaining_quantity: 0, status: 'quarantined',
    }]); // batch INSERT
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, ordered_quantity: 100, received_quantity: 50,
    }]); // PO line bump
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 100, tenant_id: TENANT, goods_receipt_id: 22, inventory_item_id: 7,
      inventory_batch_id: 50, purchase_order_item_id: 5, received_quantity: 50,
      unit_cost_minor: null, qc_status: 'pending', qc_notes: null,
    }]); // GRN item
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 22, status: 'qc_pending', facility_id: FACILITY,
      supplier_id: SUPPLIER, purchase_order_id: 10,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      total_ordered: 100, total_received: 50, total_received_before: 0, partial_count: 1,
    }]); // aggregate
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 10, tenant_id: TENANT, facility_id: FACILITY,
      supplier_id: SUPPLIER, status: 'partially_received',
    }]); // parent PO
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: null }]); // item register lock
    queryUnsafeMock.mockResolvedValueOnce([{
      current_balance: '0', running_balance: '50',
    }]); // quarantined receipt enters physical custody
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, inventory_item_id: 7, facility_id: FACILITY,
      batch_number: 'CX2', expiry_date: '2027-01-01', remaining_quantity: 0,
      status: 'quarantined', is_expired: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 903, movement_kind: 'receive' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, batch_number: 'CX2', inventory_item_id: 7,
      facility_id: FACILITY, received_quantity: 50, remaining_quantity: 50,
      status: 'quarantined',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      current_balance: '50', running_balance: '50',
    }]); // post-movement physical custody
    queryUnsafeMock.mockResolvedValueOnce([controlledRegisterRow({
      id: 80,
      inventoryItemId: 7,
      inventoryBatchId: 50,
      scheduleClass: 'X',
      movementKind: 'receive',
      quantity: 50,
      runningBalance: 50,
      unitLabel: 'amp',
      referenceMovementId: 903,
      notes: 'Received via GRN 22, batch CX2',
    })]);

    const result = await receivePurchaseOrderLine({
      tenantId: TENANT, purchaseOrderItemId: 5, goodsReceiptId: 22,
      batchNumber: 'CX2', expiryDate: '2027-01-01', receivedQuantity: 50,
      performedBy: USER,
    });

    expect(result.batch.id).toBe(50);
    expect(result.purchase_order.status).toBe('partially_received');
    expect(queryUnsafeMock.mock.calls[10][0]).toMatch(/pg_advisory_xact_lock/);
    expect(queryUnsafeMock.mock.calls[12][0]).toMatch(/FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[13][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    const insertedMetadata = JSON.parse(queryUnsafeMock.mock.calls[13].at(-1));
    expect(insertedMetadata.intent).toMatchObject({
      po_line_received_before: '0.0000',
      total_ordered: '100.0000',
      total_received_before: '0.0000',
      register_evidence: {
        facility_id: FACILITY,
        schedule_class: 'X',
        running_balance: '50',
      },
    });
    const registerArgs = queryUnsafeMock.mock.calls[16];
    expect(registerArgs[0]).toMatch(/INSERT INTO pharmacy_schedule_register/);
    expect(registerArgs[2]).toBe(FACILITY);
    expect(registerArgs[5]).toBe('X');
    expect(registerArgs[6]).toBe('receive');
    expect(registerArgs[7]).toBe(50);
    expect(registerArgs[10]).toBe(USER);
    expect(registerArgs[11]).toBe(903);
  });
});

// ---------------------------------------------------------------------------
// bridgeForecastToBatches — clinical_ai_inventory_alerts hook (C4 follow-up)
// ---------------------------------------------------------------------------

describe('bridgeForecastToBatches', () => {
  it('returns null days_to_reorder cleanly when there is no consumption in the lookback window', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, sku_code: 'SKU_A', display_name: 'Item A', reorder_level: 10 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ on_hand: '50' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ total_issued: '0' }]);

    const result = await bridgeForecastToBatches({ tenantId: TENANT, lookbackDays: 30 });

    expect(result.count).toBe(1);
    expect(result.items[0].days_to_reorder).toBeNull();
    expect(result.items[0].consumption_per_day).toBe(0);
    expect(result.items[0].alert_written).toBe(false);
  });

  it('degrades on schema-missing clinical_ai_inventory_alerts (forecast still returned)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, sku_code: 'SKU_B', display_name: 'Item B', reorder_level: 10 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ on_hand: '5' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ total_issued: '300' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ available: false }]);

    const result = await bridgeForecastToBatches({ tenantId: TENANT, lookbackDays: 30 });

    expect(result.count).toBe(1);
    expect(result.items[0].alert_written).toBe(false);
    expect(result.items[0].days_to_reorder).toBeLessThan(14);
    expect(result.items[0].on_hand).toBe(5);
  });

  it('only writes an alert when days_to_reorder < 14', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, sku_code: 'LOW', display_name: 'Low stock', reorder_level: 10 },
      { id: 2, sku_code: 'HIGH', display_name: 'High stock', reorder_level: 10 },
    ]);
    // Item 1: on-hand 15, consumption 1/day → days_to_reorder = 5 → alert
    queryUnsafeMock.mockResolvedValueOnce([{ on_hand: '15' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ total_issued: '30' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ available: true }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // alert insert
    // Item 2: on-hand 40, consumption 1/day → days_to_reorder = 30 → no alert
    queryUnsafeMock.mockResolvedValueOnce([{ on_hand: '40' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ total_issued: '30' }]);

    const result = await bridgeForecastToBatches({ tenantId: TENANT, lookbackDays: 30 });

    expect(result.count).toBe(2);
    expect(result.items[0].alert_written).toBe(true);
    expect(result.items[0].days_to_reorder).toBe(5);
    expect(result.items[1].alert_written).toBe(false);
    expect(result.items[1].days_to_reorder).toBe(30);

    const alertCalls = queryUnsafeMock.mock.calls.filter(
      (c) => /INSERT INTO clinical_ai_inventory_alerts/.test(c[0]),
    );
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0][1]).toBe(TENANT);
    expect(alertCalls[0][2]).toBe('LOW');
  });
});
