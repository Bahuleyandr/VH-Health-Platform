import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const CANONICAL_PATH = '/api/v1/admin/pharmacy-supply/reserve-stock';
const STOCK_MOVEMENT_PATH = '/api/v1/admin/pharmacy-supply/stock-movements';

const claimIdempotencyKeyMock = jest.fn();
const finaliseIdempotencyKeyMock = jest.fn(async () => ({ id: 1 }));
const releaseIdempotencyKeyMock = jest.fn(async () => null);
const appendStockMovementMock = jest.fn();
const supplyRouteMocks = {
  addPurchaseOrderItem: jest.fn(),
  bridgeForecastToBatches: jest.fn(),
  computeExpiryAlerts: jest.fn(),
  listBatches: jest.fn(),
  listExpiryAlerts: jest.fn(),
  listGoodsReceipts: jest.fn(),
  listInventoryItems: jest.fn(),
  listPurchaseOrders: jest.fn(),
  listStockMovements: jest.fn(),
  listSubstitutes: jest.fn(),
  listSuppliers: jest.fn(),
  recordGoodsReceiptItemQc: jest.fn(),
  transitionGoodsReceipt: jest.fn(),
  upsertInventoryItem: jest.fn(),
  upsertSupplier: jest.fn(),
};

jest.unstable_mockModule('../../services/idempotency/idempotencyService.js', () => ({
  claimIdempotencyKey: claimIdempotencyKeyMock,
  finaliseIdempotencyKey: finaliseIdempotencyKeyMock,
  releaseIdempotencyKey: releaseIdempotencyKeyMock,
  hashRequestBody: (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  isValidIdempotencyKey: (key) => /^[A-Za-z0-9_\-:.]{1,200}$/.test(String(key || '')),
}));

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  default: () => (_req, _res, next) => next(),
}));

const unused = jest.fn();
jest.unstable_mockModule('../../services/pharmacySupply/pharmacySupplyService.js', () => ({
  acknowledgeExpiryAlert: unused,
  addInventoryBatch: unused,
  addPurchaseOrderItem: supplyRouteMocks.addPurchaseOrderItem,
  addSubstitute: unused,
  appendStockMovement: appendStockMovementMock,
  bridgeForecastToBatches: supplyRouteMocks.bridgeForecastToBatches,
  computeExpiryAlerts: supplyRouteMocks.computeExpiryAlerts,
  createGoodsReceipt: unused,
  createPurchaseOrder: unused,
  listBatches: supplyRouteMocks.listBatches,
  listExpiryAlerts: supplyRouteMocks.listExpiryAlerts,
  listGoodsReceipts: supplyRouteMocks.listGoodsReceipts,
  listInventoryItems: supplyRouteMocks.listInventoryItems,
  listPurchaseOrders: supplyRouteMocks.listPurchaseOrders,
  listStockMovements: supplyRouteMocks.listStockMovements,
  listSubstitutes: supplyRouteMocks.listSubstitutes,
  listSuppliers: supplyRouteMocks.listSuppliers,
  recordGoodsReceiptItemQc: supplyRouteMocks.recordGoodsReceiptItemQc,
  recallBatch: unused,
  receivePurchaseOrderLine: unused,
  transitionGoodsReceipt: supplyRouteMocks.transitionGoodsReceipt,
  transitionPurchaseOrder: unused,
  upsertInventoryItem: supplyRouteMocks.upsertInventoryItem,
  upsertSupplier: supplyRouteMocks.upsertSupplier,
}));

const { default: pharmacySupplyRoutes } = await import('../../routes/admin/pharmacySupplyRoutes.js');
const pharmacyOpenApi = await import('../../../scripts/openapi/schemas/pharmacy.mjs');

function testApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role: 'PHARMACY_INCHARGE' };
    req.id = 'pharmacy-supply-route-test';
    next();
  });
  app.use('/api/v1/admin/pharmacy-supply', pharmacySupplyRoutes);
  app.use('/api/v1/pharmacy-supply', pharmacySupplyRoutes);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({
    success: false,
    code: err.code || 'INTERNAL_ERROR',
  }));
  return app;
}

const app = testApp();
const body = {
  inventory_item_id: 7,
  quantity: 5,
  movement_kind: 'issue',
  reference_type: 'ward_stock_request',
  reference_id: 'request-7',
  notes: 'Issue five units',
};

beforeEach(() => {
  claimIdempotencyKeyMock.mockReset();
  finaliseIdempotencyKeyMock.mockClear();
  releaseIdempotencyKeyMock.mockClear();
  appendStockMovementMock.mockReset();
  for (const mock of Object.values(supplyRouteMocks)) {
    mock.mockReset();
    mock.mockResolvedValue({});
  }
  appendStockMovementMock.mockResolvedValue({ id: 81, quantity_delta: 2 });
});

describe('pharmacy-supply reserve-stock idempotency boundary', () => {
  test.each([CANONICAL_PATH, '/api/v1/pharmacy-supply/reserve-stock'])(
    'retires the untyped reservation endpoint at %s without claiming or mutating stock',
    async (path) => {
      const response = await request(app)
        .post(path)
        .set('Idempotency-Key', 'retired-reservation')
        .send(body);

      expect(response.status).toBe(410);
      expect(response.body.code).toBe('PHARMACY_SUPPLY_RESERVE_STOCK_RETIRED');
      expect(claimIdempotencyKeyMock).not.toHaveBeenCalled();
      expect(appendStockMovementMock).not.toHaveBeenCalled();
      expect(unused).not.toHaveBeenCalled();
    },
  );
});

describe('pharmacy-supply facility authority route wiring', () => {
  test.each([
    ['suppliers', '/suppliers?facility_id=11', supplyRouteMocks.listSuppliers],
    ['inventory items', '/inventory-items?facility_id=11', supplyRouteMocks.listInventoryItems],
    ['batches', '/batches?facility_id=11', supplyRouteMocks.listBatches],
    ['purchase orders', '/purchase-orders?facility_id=11', supplyRouteMocks.listPurchaseOrders],
    ['goods receipts', '/goods-receipts?facility_id=11', supplyRouteMocks.listGoodsReceipts],
    ['stock movements', '/stock-movements?facility_id=11', supplyRouteMocks.listStockMovements],
    ['expiry alerts', '/expiry-alerts?facility_id=11', supplyRouteMocks.listExpiryAlerts],
    ['substitutes', '/substitutes?facility_id=11', supplyRouteMocks.listSubstitutes],
  ])('passes exact facility and canonical actor to %s reads', async (_label, suffix, serviceMock) => {
    const response = await request(app).get(`/api/v1/admin/pharmacy-supply${suffix}`);

    expect(response.status).toBe(200);
    expect(serviceMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      facilityId: 11,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    }));
  });

  test('passes item authority and canonical actor to inventory upsert', async () => {
    const response = await request(app)
      .put('/api/v1/admin/pharmacy-supply/inventory-items')
      .send({
        facility_id: 11,
        catalog_id: 31,
        sku_code: 'ROUTE-ITEM-1',
        display_name: 'Route item',
      });

    expect(response.status).toBe(200);
    expect(supplyRouteMocks.upsertInventoryItem).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      facilityId: 11,
      catalogId: 31,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    }));
  });

  test('passes exact facility and canonical actor to sensitive supplier upsert', async () => {
    const response = await request(app)
      .put('/api/v1/admin/pharmacy-supply/suppliers')
      .send({
        facility_id: 11,
        supplier_code: 'ROUTE-SUPPLIER-1',
        display_name: 'Route supplier',
      });

    expect(response.status).toBe(200);
    expect(supplyRouteMocks.upsertSupplier).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      facilityId: 11,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      createdBy: ACTOR,
    }));
  });

  test('passes canonical actor and exact GRN line identity to QC recording', async () => {
    const response = await request(app)
      .patch('/api/v1/admin/pharmacy-supply/goods-receipts/22/items/100/qc')
      .send({ qc_status: 'passed', qc_notes: 'Packaging intact' });

    expect(response.status).toBe(200);
    expect(supplyRouteMocks.recordGoodsReceiptItemQc).toHaveBeenCalledWith({
      tenantId: TENANT,
      goodsReceiptId: '22',
      goodsReceiptItemId: '100',
      qcStatus: 'passed',
      qcNotes: 'Packaging intact',
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
  });

  test('passes canonical actor to the governed GRN transition', async () => {
    const response = await request(app)
      .patch('/api/v1/admin/pharmacy-supply/goods-receipts/22/transition')
      .send({ action: 'finalize' });

    expect(response.status).toBe(200);
    expect(supplyRouteMocks.transitionGoodsReceipt).toHaveBeenCalledWith({
      tenantId: TENANT,
      id: '22',
      action: 'finalize',
      performedBy: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    });
  });

  test('passes canonical actor when adding a purchase-order item', async () => {
    const response = await request(app)
      .post('/api/v1/admin/pharmacy-supply/purchase-orders/7/items')
      .send({ inventory_item_id: 41, ordered_quantity: 5 });

    expect(response.status).toBe(201);
    expect(supplyRouteMocks.addPurchaseOrderItem).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      purchaseOrderId: '7',
      inventoryItemId: 41,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    }));
  });

  test.each([
    ['forecast bridge', '/forecast-bridge', supplyRouteMocks.bridgeForecastToBatches],
    ['expiry scan', '/expiry-alerts/scan', supplyRouteMocks.computeExpiryAlerts],
  ])('passes exact facility and canonical actor to %s', async (_label, suffix, serviceMock) => {
    const response = await request(app)
      .post(`/api/v1/admin/pharmacy-supply${suffix}`)
      .send({ facility_id: 11 });

    expect(response.status).toBe(200);
    expect(serviceMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      facilityId: 11,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
    }));
  });
});

describe('pharmacy-supply stock-movement idempotency boundary', () => {
  const movementBody = {
    inventory_item_id: 7,
    inventory_batch_id: 17,
    movement_kind: 'adjust_increase',
    quantity_delta: 2,
    reference_type: 'cycle_count',
    reference_id: 'count-81',
  };

  test('requires a command key before stock mutation', async () => {
    const response = await request(app).post(STOCK_MOVEMENT_PATH).send(movementBody);

    expect(response.status).toBe(400);
    expect(appendStockMovementMock).not.toHaveBeenCalled();
  });

  test('replays one canonical cross-alias movement without a second decrement', async () => {
    claimIdempotencyKeyMock.mockResolvedValueOnce({ state: 'claimed', id: 81 });
    const first = await request(app)
      .post(STOCK_MOVEMENT_PATH)
      .set('Idempotency-Key', 'stock-movement-81')
      .send(movementBody);

    claimIdempotencyKeyMock.mockResolvedValueOnce({
      state: 'replay',
      response_status: first.status,
      response_body: first.body,
    });
    const replay = await request(app)
      .post('/api/v1/pharmacy-supply/stock-movements')
      .set('Idempotency-Key', 'stock-movement-81')
      .send(movementBody);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(appendStockMovementMock).toHaveBeenCalledTimes(1);
    expect(claimIdempotencyKeyMock.mock.calls.map(([claim]) => claim.requestPath))
      .toEqual([STOCK_MOVEMENT_PATH, STOCK_MOVEMENT_PATH]);
  });

  test('changed-body key reuse conflicts before stock mutation', async () => {
    claimIdempotencyKeyMock.mockResolvedValueOnce({ state: 'mismatch' });
    const response = await request(app)
      .post(STOCK_MOVEMENT_PATH)
      .set('Idempotency-Key', 'stock-movement-mismatch')
      .send({ ...movementBody, quantity_delta: 3 });

    expect(response.status).toBe(422);
    expect(appendStockMovementMock).not.toHaveBeenCalled();
  });

  test('retains an uncertain 5xx movement claim so retry cannot double-decrement', async () => {
    claimIdempotencyKeyMock.mockResolvedValueOnce({ state: 'claimed', id: 82 });
    appendStockMovementMock.mockRejectedValueOnce(new Error('response lost after commit'));

    const response = await request(app)
      .post(STOCK_MOVEMENT_PATH)
      .set('Idempotency-Key', 'stock-movement-uncertain')
      .send(movementBody);

    expect(response.status).toBe(500);
    expect(releaseIdempotencyKeyMock).not.toHaveBeenCalled();
    expect(finaliseIdempotencyKeyMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 82,
      status: 'failed',
      responseStatus: 500,
    }));
  });
});

describe('pharmacy-supply inventory mutation OpenAPI source', () => {
  test('documents the required command header for the remaining stock-movement endpoint', () => {
    for (const prefix of ['/api/v1/admin/pharmacy-supply', '/api/v1/pharmacy-supply']) {
      const movementOperation = pharmacyOpenApi.operations[`POST ${prefix}/stock-movements`];
      expect(movementOperation.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
    }
    expect(Object.keys(pharmacyOpenApi.operations).filter((key) => key.endsWith('/reserve-stock')))
      .toEqual([]);
    expect(Object.keys(pharmacyOpenApi.schemas)
      .filter((key) => /^PharmacySupplyReservation/.test(key))).toEqual([]);
  });
});
