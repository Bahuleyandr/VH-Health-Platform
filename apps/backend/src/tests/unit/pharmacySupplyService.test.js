/**
 * Phase C4 — pharmacySupplyService unit tests.
 *
 * Covers validation, FEFO reservation, expiry-severity bands, recall
 * flow with stock-movement ledger entry, PO state machine, and
 * substitute-graph guards. Mocks prisma.$queryRawUnsafe.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const transactionMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $transaction: transactionMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => transactionMock(fn),
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  acknowledgeExpiryAlert,
  addInventoryBatch,
  addPurchaseOrderItem,
  addSubstitute,
  appendStockMovement,
  bridgeForecastToBatches,
  computeExpiryAlerts,
  createGoodsReceipt,
  createPurchaseOrder,
  listBatches,
  listExpiryAlerts,
  listGoodsReceipts,
  listInventoryItems,
  listPurchaseOrders,
  listStockMovements,
  listSubstitutes,
  listSuppliers,
  recallBatch,
  receivePurchaseOrderLine,
  reserveStock,
  transitionPurchaseOrder,
  upsertInventoryItem,
  upsertSupplier,
  __testing__,
} = await import('../../services/pharmacySupply/pharmacySupplyService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  transactionMock.mockReset();
  transactionMock.mockImplementation(async (cb) => cb({ $queryRawUnsafe: queryUnsafeMock }));
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
  });

  it('throws conflict on duplicate supplier_code', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertSupplier({
      tenantId: TENANT, supplierCode: 'X', displayName: 'X',
    })).rejects.toThrow(/already exists/);
  });
});

describe('listSuppliers degrades gracefully', () => {
  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_suppliers" does not exist'));
    expect(await listSuppliers({ tenantId: TENANT })).toEqual({ suppliers: [], count: 0 });
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
    const [sql, tenantId, query] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('LOWER(display_name)');
    expect(sql).toContain('LOWER(sku_code)');
    expect(sql).toContain("LOWER(COALESCE(manufacturer, ''))");
    expect(tenantId).toBe(TENANT);
    expect(query).toBe('%coronary stent%');
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_inventory_items" does not exist'));
    expect(await listInventoryItems({ tenantId: TENANT })).toEqual({ items: [], count: 0 });
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

  it('inserts batch + appends receive movement', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, batch_number: 'B1', inventory_item_id: 5, received_quantity: 100, remaining_quantity: 100,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // movement insert
    const batch = await addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 5, batchNumber: 'B1',
      expiryDate: '2026-12-31', receivedQuantity: 100,
    });
    expect(batch.id).toBe(1);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
  });

  it('throws conflict on duplicate (item, batch)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, schedule_class: null, is_narcotic: false }]); // controlled classification
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 1, batchNumber: 'B1',
      expiryDate: '2026-12-31', receivedQuantity: 100,
    })).rejects.toThrow(/already exists/);
  });
});

describe('reserveStock — FEFO', () => {
  it('consumes oldest-expiry batches first and returns breakdown', async () => {
    // Two batches: B1 expires 2026-06-01 (50 left), B2 expires 2026-12-01 (100 left)
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-06-01', remaining_quantity: 50 },
      { id: 11, batch_number: 'B2', expiry_date: '2026-12-01', remaining_quantity: 100 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 101 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, remaining_quantity: 0, status: 'depleted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 102 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11, remaining_quantity: 70, status: 'in_stock' }]);
    const result = await reserveStock({
      tenantId: TENANT, inventoryItemId: 5, quantity: 80, performedBy: USER,
    });
    expect(result.requested).toBe(80);
    expect(result.fulfilled).toBe(80);
    expect(result.short_by).toBe(0);
    expect(result.consumed).toEqual([
      { batch_id: 10, batch_number: 'B1', quantity_taken: 50 },
      { batch_id: 11, batch_number: 'B2', quantity_taken: 30 },
    ]);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[1][0]).toContain(
      "expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date",
    );
  });

  it('reports short_by when stock insufficient', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-06-01', remaining_quantity: 5 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 101 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, remaining_quantity: 0 }]);
    const result = await reserveStock({
      tenantId: TENANT, inventoryItemId: 5, quantity: 50,
    });
    expect(result.fulfilled).toBe(5);
    expect(result.short_by).toBe(45);
  });

  it('throws conflict on concurrent batch update', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-06-01', remaining_quantity: 50 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 101 }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // locked update finds 0 rows
    await expect(reserveStock({
      tenantId: TENANT, inventoryItemId: 5, quantity: 10,
    })).rejects.toThrow(/Concurrent batch update/);
  });

  it('fails the transaction when a movement insert fails', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-06-01', remaining_quantity: 50 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]); // no committed replay
    queryUnsafeMock.mockRejectedValueOnce(new Error('movement insert failed'));

    await expect(reserveStock({
      tenantId: TENANT,
      inventoryItemId: 5,
      quantity: 10,
      referenceType: 'cath_consumable_usage',
      referenceId: '71',
    })).rejects.toThrow(/movement insert failed/);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('reuses committed FEFO movements without consuming stock twice', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 11, batch_number: 'B2', expiry_date: '2026-12-01', remaining_quantity: 70 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 101,
      inventory_batch_id: 10,
      batch_number: 'B1',
      movement_kind: 'issue',
      quantity_delta: '-30.0000',
      reference_type: 'cath_consumable_usage',
      reference_id: '71',
    }]);

    const result = await reserveStock({
      tenantId: TENANT,
      inventoryItemId: 5,
      quantity: 30,
      referenceType: 'cath_consumable_usage',
      referenceId: '71',
    });

    expect(result).toEqual({
      requested: 30,
      fulfilled: 30,
      short_by: 0,
      consumed: [{ batch_id: 10, batch_number: 'B1', quantity_taken: 30 }],
      idempotent_replay: true,
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a FEFO unique-index race from the winning movement', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-12-01', remaining_quantity: 50 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]); // preflight finds no movement
    queryUnsafeMock.mockResolvedValueOnce([]); // ON CONFLICT winner
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 102,
      inventory_batch_id: 10,
      batch_number: 'B1',
      movement_kind: 'issue',
      quantity_delta: '-20.0000',
      reference_type: 'cath_consumable_usage',
      reference_id: '72',
    }]);

    const result = await reserveStock({
      tenantId: TENANT,
      inventoryItemId: 5,
      quantity: 20,
      referenceType: 'cath_consumable_usage',
      referenceId: '72',
    });

    expect(result).toMatchObject({
      requested: 20,
      fulfilled: 20,
      short_by: 0,
      idempotent_replay: true,
    });
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[3][0]).toContain('ON CONFLICT DO NOTHING');
  });

  it('rejects unknown movement_kind', async () => {
    await expect(reserveStock({
      tenantId: TENANT, inventoryItemId: 5, quantity: 1, movementKind: 'magic',
    })).rejects.toThrow(/movement_kind must be one of/);
  });
});

describe('listBatches', () => {
  it('filters by expiringWithinDays', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listBatches({ tenantId: TENANT, expiringWithinDays: 30 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/INTERVAL '1 day'/);
  });
});

describe('recallBatch', () => {
  it('flips status to recalled + writes recall movement', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'recalled', recall_reference: 'CDSCO-2026-04', inventory_item_id: 5,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([]); // movement insert
    const row = await recallBatch({
      tenantId: TENANT, id: 1, recallReference: 'CDSCO-2026-04', performedBy: USER,
    });
    expect(row.status).toBe('recalled');
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/movement_kind/);
  });

  it('throws 404 when already recalled', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(recallBatch({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

describe('createPurchaseOrder + transitionPurchaseOrder', () => {
  it('creates a draft PO', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'draft' }]);
    const row = await createPurchaseOrder({
      tenantId: TENANT, poNumber: 'PO-001', supplierId: 5,
    });
    expect(row.status).toBe('draft');
  });

  it('transition to submitted stamps ordered_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'submitted' }]);
    await transitionPurchaseOrder({
      tenantId: TENANT, id: 1, nextStatus: 'submitted',
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/ordered_at = \$\d::timestamptz/);
  });

  it('transition to approved stamps approved_by + approved_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    await transitionPurchaseOrder({
      tenantId: TENANT, id: 1, nextStatus: 'approved', approvedBy: USER,
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/approved_at = \$\d::timestamptz/);
    expect(sql).toMatch(/approved_by = \$\d::uuid/);
  });

  it('rejects unknown next_status', async () => {
    await expect(transitionPurchaseOrder({
      tenantId: TENANT, id: 1, nextStatus: 'magic',
    })).rejects.toThrow(/next_status must be one of/);
  });
});

describe('addPurchaseOrderItem', () => {
  it('rejects tax_rate_pct out of range', async () => {
    await expect(addPurchaseOrderItem({
      tenantId: TENANT, purchaseOrderId: 1, inventoryItemId: 5,
      orderedQuantity: 10, taxRatePct: 200,
    })).rejects.toThrow(/tax_rate_pct must be 0..100/);
  });

  it('throws conflict on duplicate item per PO', async () => {
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
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'received', grn_number: 'GRN-001' }]);
    const row = await createGoodsReceipt({
      tenantId: TENANT, grnNumber: 'GRN-001', supplierId: 5,
      invoiceNumber: 'INV-99', invoiceDate: '2026-04-15',
    });
    expect(row.status).toBe('received');
  });

  it('listGoodsReceipts degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_goods_receipts" does not exist'));
    expect(await listGoodsReceipts({ tenantId: TENANT })).toEqual({ goods_receipts: [], count: 0 });
  });
});

describe('listPurchaseOrders degrades gracefully', () => {
  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_purchase_orders" does not exist'));
    expect(await listPurchaseOrders({ tenantId: TENANT })).toEqual({ purchase_orders: [], count: 0 });
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
    })).rejects.toThrow(/quantity_delta must be numeric/);
  });

  it('inserts a movement row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, schedule_class: null, is_narcotic: false }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, movement_kind: 'adjust_decrease' }]);
    const row = await appendStockMovement({
      tenantId: TENANT, inventoryItemId: 5, movementKind: 'adjust_decrease',
      quantityDelta: -2, performedBy: USER, notes: 'damaged',
    });
    expect(row.id).toBe(1);
  });
});

describe('listStockMovements', () => {
  it('filters by inventory_batch_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listStockMovements({ tenantId: TENANT, inventoryBatchId: 7 });
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

  it('degrades to zeros on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_inventory_batches" does not exist'));
    const result = await computeExpiryAlerts({ tenantId: TENANT });
    expect(result.scanned).toBe(0);
  });
});

describe('acknowledgeExpiryAlert', () => {
  it('rejects when acknowledged_by missing', async () => {
    await expect(acknowledgeExpiryAlert({ tenantId: TENANT, id: 1 }))
      .rejects.toThrow(/acknowledged_by is required/);
  });

  it('flips to acknowledged with resolution', async () => {
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
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, primary_item_id: 1, substitute_item_id: 2, substitution_kind: 'generic_equivalent',
    }]);
    const row = await addSubstitute({
      tenantId: TENANT, primaryItemId: 1, substituteItemId: 2,
    });
    expect(row.substitution_kind).toBe('generic_equivalent');
  });

  it('throws conflict on duplicate pair', async () => {
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

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pharmacy_substitutes" does not exist'));
    expect(await listSubstitutes({ tenantId: TENANT })).toEqual({ substitutes: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// receivePurchaseOrderLine — atomic GRN line orchestration (C4 follow-up)
// ---------------------------------------------------------------------------

describe('receivePurchaseOrderLine', () => {
  it('inserts batch + GRN item + bumps PO line + appends receive movement in one transaction', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 0,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, batch_number: 'B1', inventory_item_id: 7,
      received_quantity: 50, remaining_quantity: 50, status: 'in_stock',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, ordered_quantity: 100, received_quantity: 50,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 100, goods_receipt_id: 22, inventory_item_id: 7,
      inventory_batch_id: 50, purchase_order_item_id: 5, received_quantity: 50,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      total_ordered: 100, total_received: 50, partial_count: 1,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, status: 'partially_received' }]);

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

    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO pharmacy_inventory_batches/);
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/UPDATE pharmacy_purchase_order_items/);
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/INSERT INTO pharmacy_goods_receipt_items/);
    expect(queryUnsafeMock.mock.calls[5][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    expect(queryUnsafeMock.mock.calls[5][0]).toMatch(/'receive'/);
  });

  it('refuses to over-receive (received_quantity + delta > ordered → 409)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 80,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 51, batch_number: 'B2', inventory_item_id: 7,
      received_quantity: 50, remaining_quantity: 50,
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
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 80,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, schedule_class: null, is_narcotic: false, unit_label: 'tab' }]); // controlled classification
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 52, batch_number: 'B3', inventory_item_id: 7,
      received_quantity: 20, remaining_quantity: 20,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, ordered_quantity: 100, received_quantity: 100,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 101 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      total_ordered: 100, total_received: 100, partial_count: 1,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, status: 'fully_received' }]);

    const result = await receivePurchaseOrderLine({
      tenantId: TENANT,
      purchaseOrderItemId: 5,
      goodsReceiptId: 22,
      batchNumber: 'B3',
      expiryDate: '2027-01-01',
      receivedQuantity: 20,
    });

    expect(result.purchase_order.status).toBe('fully_received');
    const parentUpdateArgs = queryUnsafeMock.mock.calls[7];
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
  const CONTROLLED_ITEM = { id: 7, schedule_class: 'X', is_narcotic: true, unit_label: 'amp' };
  const H1_ITEM = { id: 7, schedule_class: 'H1', is_narcotic: false, unit_label: 'tab' };

  it('exposes the schedule vocabulary through __testing__', () => {
    expect(__testing__.CONTROLLED_SCHEDULES).toEqual(['H', 'H1', 'X']);
    expect(__testing__.SUPPLY_DECREASING_MOVEMENTS.has('issue')).toBe(true);
    expect(__testing__.SUPPLY_DECREASING_MOVEMENTS.has('receive')).toBe(false);
    expect(__testing__.SUPPLY_REGISTER_KIND_BY_MOVEMENT.receive).toBe('receive');
    expect(__testing__.SUPPLY_REGISTER_KIND_BY_MOVEMENT.issue).toBeUndefined();
    expect(__testing__.isControlledSupplyItem({ schedule_class: 'H' })).toBe(true);
    expect(__testing__.isControlledSupplyItem({ schedule_class: null, is_narcotic: true })).toBe(true);
    expect(__testing__.isControlledSupplyItem({ schedule_class: 'OTC', is_narcotic: false })).toBe(false);
  });

  it('reserveStock refuses a controlled issue with the dispense-path steer (409)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]);

    await expect(reserveStock({
      tenantId: TENANT, inventoryItemId: 7, quantity: 2,
    })).rejects.toMatchObject({
      statusCode: 409, code: 'CONTROLLED_MOVEMENT_REQUIRES_DISPENSE_PATH',
    });
    // Fails closed before any batch lock: only the classification query ran.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('reserveStock refuses a controlled non-issue decrement with the register-path steer (409)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([H1_ITEM]);

    await expect(reserveStock({
      tenantId: TENANT, inventoryItemId: 7, quantity: 2, movementKind: 'transfer_out',
    })).rejects.toMatchObject({
      statusCode: 409, code: 'CONTROLLED_MOVEMENT_REQUIRES_REGISTER_PATH',
    });
  });

  it('appendStockMovement refuses controlled decrement kinds (409)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]);

    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, movementKind: 'adjust_decrease', quantityDelta: 5,
    })).rejects.toMatchObject({
      statusCode: 409, code: 'CONTROLLED_MOVEMENT_REQUIRES_REGISTER_PATH',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('appendStockMovement refuses a controlled negative delta even on an increasing kind (409)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([H1_ITEM]);

    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, movementKind: 'return', quantityDelta: -3,
    })).rejects.toMatchObject({
      statusCode: 409, code: 'CONTROLLED_MOVEMENT_REQUIRES_REGISTER_PATH',
    });
  });

  it('appendStockMovement requires a named performer for controlled custody events (400)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([H1_ITEM]);

    await expect(appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, movementKind: 'receive', quantityDelta: 10,
    })).rejects.toMatchObject({
      statusCode: 400, code: 'CONTROLLED_MOVEMENT_PERFORMER_REQUIRED',
    });
  });

  it('appendStockMovement writes movement + running balance + register row in one tx for a controlled receive', async () => {
    queryUnsafeMock.mockResolvedValueOnce([H1_ITEM]); // classification
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 900, tenant_id: TENANT, inventory_item_id: 7, inventory_batch_id: null,
      movement_kind: 'receive', quantity_delta: 10,
    }]); // movement INSERT
    queryUnsafeMock.mockResolvedValueOnce([{ bal: '40' }]); // in-tx running balance
    queryUnsafeMock.mockResolvedValueOnce([{ id: 77 }]); // register INSERT

    const result = await appendStockMovement({
      tenantId: TENANT, inventoryItemId: 7, movementKind: 'receive',
      quantityDelta: 10, performedBy: USER,
    });

    expect(result.id).toBe(900);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/SUM\(remaining_quantity\)/);
    const registerArgs = queryUnsafeMock.mock.calls[3];
    expect(registerArgs[0]).toMatch(/INSERT INTO pharmacy_schedule_register/);
    expect(registerArgs[4]).toBe('H1');        // schedule snapshot
    expect(registerArgs[5]).toBe('receive');   // register kind
    expect(registerArgs[6]).toBe(10);          // quantity (abs)
    expect(registerArgs[8]).toBe(40);          // running balance from the same tx
    expect(registerArgs[9]).toBe(USER);        // named performer
    expect(registerArgs[10]).toBe(900);        // reference_movement_id
  });

  it('addInventoryBatch requires a performer for a controlled receipt (400)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]);

    await expect(addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 7, batchNumber: 'CX1',
      expiryDate: '2027-06-30', receivedQuantity: 10,
    })).rejects.toMatchObject({
      statusCode: 400, code: 'CONTROLLED_MOVEMENT_PERFORMER_REQUIRED',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('addInventoryBatch lands batch + movement + register atomically for controlled stock', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]); // classification (plain prisma)
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 60, batch_number: 'CX1', inventory_item_id: 7,
      received_quantity: 10, remaining_quantity: 10, status: 'in_stock',
    }]); // batch INSERT
    queryUnsafeMock.mockResolvedValueOnce([{ id: 901 }]); // movement INSERT
    queryUnsafeMock.mockResolvedValueOnce([{ bal: '10' }]); // running balance
    queryUnsafeMock.mockResolvedValueOnce([{ id: 78 }]); // register INSERT

    const batch = await addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 7, batchNumber: 'CX1',
      expiryDate: '2027-06-30', receivedQuantity: 10, performedBy: USER,
    });

    expect(batch.id).toBe(60);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO pharmacy_inventory_batches/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/INSERT INTO pharmacy_schedule_register/);
    expect(queryUnsafeMock.mock.calls[4][4]).toBe('X'); // schedule snapshot
  });

  it('recallBatch requires a performer for a controlled recall (400)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 61, inventory_item_id: 7, remaining_quantity: 12, status: 'recalled',
    }]); // UPDATE
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]); // classification

    await expect(recallBatch({
      tenantId: TENANT, id: 61, recallReference: 'CDSCO alert',
    })).rejects.toMatchObject({
      statusCode: 400, code: 'CONTROLLED_MOVEMENT_PERFORMER_REQUIRED',
    });
  });

  it('recallBatch appends a register recall row carrying the pulled quantity', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 61, inventory_item_id: 7, remaining_quantity: 12, status: 'recalled',
    }]); // UPDATE
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]); // classification
    queryUnsafeMock.mockResolvedValueOnce([{ id: 902 }]); // movement INSERT (tx)
    queryUnsafeMock.mockResolvedValueOnce([{ bal: '0' }]); // running balance
    queryUnsafeMock.mockResolvedValueOnce([{ id: 79 }]); // register INSERT

    const result = await recallBatch({
      tenantId: TENANT, id: 61, recallReference: 'CDSCO alert', performedBy: USER,
    });

    expect(result.id).toBe(61);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const registerArgs = queryUnsafeMock.mock.calls[4];
    expect(registerArgs[0]).toMatch(/INSERT INTO pharmacy_schedule_register/);
    expect(registerArgs[5]).toBe('recall');
    expect(registerArgs[6]).toBe(12); // the batch's remaining quantity leaves custody
    expect(registerArgs[9]).toBe(USER);
  });

  it('receivePurchaseOrderLine requires a performer for a controlled GRN receipt (400)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 0,
    }]); // PO line
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]); // classification

    await expect(receivePurchaseOrderLine({
      tenantId: TENANT, purchaseOrderItemId: 5, goodsReceiptId: 22,
      batchNumber: 'CX2', expiryDate: '2027-01-01', receivedQuantity: 50,
    })).rejects.toMatchObject({
      statusCode: 400, code: 'CONTROLLED_MOVEMENT_PERFORMER_REQUIRED',
    });
  });

  it('receivePurchaseOrderLine appends a register receipt row for controlled stock', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, inventory_item_id: 7,
      ordered_quantity: 100, received_quantity: 0,
    }]); // PO line
    queryUnsafeMock.mockResolvedValueOnce([CONTROLLED_ITEM]); // classification
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, batch_number: 'CX2', inventory_item_id: 7,
      received_quantity: 50, remaining_quantity: 50, status: 'in_stock',
    }]); // batch INSERT
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, purchase_order_id: 10, ordered_quantity: 100, received_quantity: 50,
    }]); // PO line bump
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100, inventory_batch_id: 50 }]); // GRN item
    queryUnsafeMock.mockResolvedValueOnce([{ id: 903 }]); // receive movement
    queryUnsafeMock.mockResolvedValueOnce([{ bal: '50' }]); // running balance
    queryUnsafeMock.mockResolvedValueOnce([{ id: 80 }]); // register INSERT
    queryUnsafeMock.mockResolvedValueOnce([{
      total_ordered: 100, total_received: 50, partial_count: 1,
    }]); // aggregate
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, status: 'partially_received' }]); // parent PO

    const result = await receivePurchaseOrderLine({
      tenantId: TENANT, purchaseOrderItemId: 5, goodsReceiptId: 22,
      batchNumber: 'CX2', expiryDate: '2027-01-01', receivedQuantity: 50,
      performedBy: USER,
    });

    expect(result.batch.id).toBe(50);
    expect(result.purchase_order.status).toBe('partially_received');
    expect(queryUnsafeMock.mock.calls[5][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
    const registerArgs = queryUnsafeMock.mock.calls[7];
    expect(registerArgs[0]).toMatch(/INSERT INTO pharmacy_schedule_register/);
    expect(registerArgs[5]).toBe('receive');
    expect(registerArgs[6]).toBe(50);
    expect(registerArgs[9]).toBe(USER);
    expect(registerArgs[10]).toBe(903);
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
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "clinical_ai_inventory_alerts" does not exist'));

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
