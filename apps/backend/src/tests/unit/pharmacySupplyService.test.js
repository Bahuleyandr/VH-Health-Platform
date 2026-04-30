/**
 * Phase C4 — pharmacySupplyService unit tests.
 *
 * Covers validation, FEFO reservation, expiry-severity bands, recall
 * flow with stock-movement ledger entry, PO state machine, and
 * substitute-graph guards. Mocks prisma.$queryRawUnsafe.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  acknowledgeExpiryAlert,
  addInventoryBatch,
  addPurchaseOrderItem,
  addSubstitute,
  appendStockMovement,
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
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, batch_number: 'B1', inventory_item_id: 5, received_quantity: 100, remaining_quantity: 100,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // movement insert
    const batch = await addInventoryBatch({
      tenantId: TENANT, inventoryItemId: 5, batchNumber: 'B1',
      expiryDate: '2026-12-31', receivedQuantity: 100,
    });
    expect(batch.id).toBe(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO pharmacy_stock_movements/);
  });

  it('throws conflict on duplicate (item, batch)', async () => {
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
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-06-01', remaining_quantity: 50 },
      { id: 11, batch_number: 'B2', expiry_date: '2026-12-01', remaining_quantity: 100 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, remaining_quantity: 0, status: 'depleted' }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // movement insert
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11, remaining_quantity: 70, status: 'in_stock' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
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
  });

  it('reports short_by when stock insufficient', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-06-01', remaining_quantity: 5 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, remaining_quantity: 0 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await reserveStock({
      tenantId: TENANT, inventoryItemId: 5, quantity: 50,
    });
    expect(result.fulfilled).toBe(5);
    expect(result.short_by).toBe(45);
  });

  it('throws conflict on concurrent batch update', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, batch_number: 'B1', expiry_date: '2026-06-01', remaining_quantity: 50 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]); // optimistic update finds 0 rows
    await expect(reserveStock({
      tenantId: TENANT, inventoryItemId: 5, quantity: 10,
    })).rejects.toThrow(/Concurrent batch update/);
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
    queryUnsafeMock.mockResolvedValueOnce([]); // movement insert
    const row = await recallBatch({
      tenantId: TENANT, id: 1, recallReference: 'CDSCO-2026-04', performedBy: USER,
    });
    expect(row.status).toBe('recalled');
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/movement_kind/);
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
