import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const txMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  isTenantTransactionClient: () => true,
  setTenantTx: setTenantTxMock,
}));

const { listItems, recordMovement } = await import('../../services/pharmacy/inventoryV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

// recordMovement() first resolves the item's schedule_class/is_narcotic in-tx
// (controlled-drug register + witness enforcement, commit b07405f4) before
// dispatching to recordMovementTx. A non-controlled item routes straight to the
// ordinary movement path exercised by these cases, so every recordMovement()
// call issues this item lookup as its first $queryRawUnsafe.
const NON_CONTROLLED_ITEM = {
  id: 17,
  schedule_class: 'OTC',
  is_narcotic: false,
  unit_label: 'unit',
};

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
});

describe('inventoryV2Service.listItems', () => {
  test('projects catalog and composition links for exact ward-indent stock joins', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listItems({ tenantId: TENANT, catalogId: 17, search: 'morphine' });

    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/catalog_id/);
    expect(sql).toMatch(/composition_id/);
    expect(sql).toMatch(/catalog_id = \$3::int/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      TENANT,
      'active',
      17,
      '%morphine%',
      100,
    ]);
  });

  test('rejects an invalid exact catalog lookup before querying', async () => {
    await expect(listItems({ tenantId: TENANT, catalogId: 'not-an-id' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('inventoryV2Service.recordMovement', () => {
  test('rejects a batch outside the requested tenant/item scope', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([NON_CONTROLLED_ITEM])
      .mockResolvedValueOnce([]);

    await expect(recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity: 1,
      performed_by: ACTOR,
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toEqual(expect.stringContaining('FOR UPDATE'));
    expect(queryRawUnsafeMock.mock.calls[1][0]).toEqual(
      expect.stringContaining('inventory_item_id = $3::int'),
    );
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain(
      "expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date",
    );
    expect(queryRawUnsafeMock.mock.calls[1].slice(1)).toEqual([29, TENANT, 17]);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('rejects insufficient stock before updating the batch or writing a movement', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([NON_CONTROLLED_ITEM])
      .mockResolvedValueOnce([{
        id: 29,
        inventory_item_id: 17,
        remaining_quantity: '2.0000',
        status: 'in_stock',
      }]);

    await expect(recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity: 3,
      performed_by: ACTOR,
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ status: 'recalled', is_expired: false }, 'INVENTORY_BATCH_UNAVAILABLE'],
    [{ status: 'in_stock', is_expired: true }, 'INVENTORY_BATCH_EXPIRED'],
  ])('rejects a non-usable exact batch before any decrement', async (batchState, code) => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([NON_CONTROLLED_ITEM])
      .mockResolvedValueOnce([{
        id: 29,
        inventory_item_id: 17,
        batch_number: 'BATCH-29',
        lot_number: 'LOT-29',
        expiry_date: new Date('2028-12-31T00:00:00.000Z'),
        remaining_quantity: '5.0000',
        ...batchState,
      }]);

    await expect(recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity: 1,
      performed_by: ACTOR,
      require_usable_batch: true,
      expected_batch_number: 'BATCH-29',
      expected_lot_number: 'LOT-29',
      expected_expiry_date: '2028-12-31',
    })).rejects.toMatchObject({ statusCode: 400, code });

    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  test('rejects a selected batch whose locked lineage differs from the clinical record', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([NON_CONTROLLED_ITEM])
      .mockResolvedValueOnce([{
        id: 29,
        inventory_item_id: 17,
        batch_number: 'BATCH-29',
        lot_number: 'LOT-29',
        expiry_date: new Date('2028-12-31T00:00:00.000Z'),
        remaining_quantity: '5.0000',
        status: 'in_stock',
        is_expired: false,
      }]);

    await expect(recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity: 1,
      performed_by: ACTOR,
      require_usable_batch: true,
      expected_batch_number: 'DIFFERENT-BATCH',
      expected_lot_number: 'LOT-29',
      expected_expiry_date: '2028-12-31',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVENTORY_BATCH_LINEAGE_MISMATCH',
    });

    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  test('updates the locked batch and writes its movement in one tenant transaction', async () => {
    const movement = {
      id: 41,
      tenant_id: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity_delta: '-1.0000',
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([NON_CONTROLLED_ITEM])
      .mockResolvedValueOnce([{
        id: 29,
        inventory_item_id: 17,
        batch_number: 'BATCH-29',
        lot_number: 'LOT-29',
        expiry_date: new Date('2028-12-31T00:00:00.000Z'),
        remaining_quantity: '5.0000',
        status: 'in_stock',
        is_expired: false,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([movement]);

    const result = await recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity: 1,
      reference_type: 'cath_consumable_usage',
      reference_id: '73',
      notes: 'Cath consumable used',
      performed_by: ACTOR,
      require_usable_batch: true,
      expected_batch_number: 'BATCH-29',
      expected_lot_number: 'LOT-29',
      expected_expiry_date: new Date('2028-12-31T00:00:00.000Z'),
    });

    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pharmacy_inventory_batches'),
      -1,
      29,
      TENANT,
      17,
    );
    expect(queryRawUnsafeMock.mock.calls[3][0]).toEqual(
      expect.stringContaining('INSERT INTO pharmacy_stock_movements'),
    );
    expect(queryRawUnsafeMock.mock.calls[3].slice(1)).toEqual([
      TENANT,
      17,
      29,
      'issue',
      -1,
      'cath_consumable_usage',
      '73',
      ACTOR,
      'Cath consumable used',
    ]);
    expect(result).toEqual({ movement, increasing: false, decreasing: true });
  });

  test('reuses an already-committed cath movement without decrementing its batch again', async () => {
    const movement = {
      id: 41,
      tenant_id: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity_delta: '-1.0000',
      reference_type: 'cath_consumable_usage',
      reference_id: '73',
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([NON_CONTROLLED_ITEM])
      .mockResolvedValueOnce([{
        id: 29,
        inventory_item_id: 17,
        batch_number: 'BATCH-29',
        lot_number: 'LOT-29',
        expiry_date: new Date('2028-12-31T00:00:00.000Z'),
        remaining_quantity: '4.0000',
        status: 'in_stock',
        is_expired: false,
      }])
      .mockResolvedValueOnce([movement]);

    const result = await recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity: 1,
      reference_type: 'cath_consumable_usage',
      reference_id: '73',
      performed_by: ACTOR,
      require_usable_batch: true,
      expected_batch_number: 'BATCH-29',
      expected_lot_number: 'LOT-29',
      expected_expiry_date: '2028-12-31',
    });

    expect(result).toEqual({
      movement,
      increasing: false,
      decreasing: true,
      idempotent_replay: true,
    });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
  });

  test('resolves a unique-index race to the winning cath movement without decrementing', async () => {
    const movement = {
      id: 42,
      tenant_id: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity_delta: '-1.0000',
      reference_type: 'cath_consumable_usage',
      reference_id: '74',
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([NON_CONTROLLED_ITEM])
      .mockResolvedValueOnce([{
        id: 29,
        inventory_item_id: 17,
        batch_number: 'BATCH-29',
        lot_number: 'LOT-29',
        expiry_date: new Date('2028-12-31T00:00:00.000Z'),
        remaining_quantity: '4.0000',
        status: 'in_stock',
        is_expired: false,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([movement]);

    const result = await recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'issue',
      quantity: 1,
      reference_type: 'cath_consumable_usage',
      reference_id: '74',
      performed_by: ACTOR,
      require_usable_batch: true,
      expected_batch_number: 'BATCH-29',
      expected_lot_number: 'LOT-29',
      expected_expiry_date: '2028-12-31',
    });

    expect(result).toMatchObject({
      movement,
      idempotent_replay: true,
    });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock.mock.calls[3][0]).toContain('ON CONFLICT DO NOTHING');
  });
});
