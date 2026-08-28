import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const CANONICAL_PATH = '/api/v1/admin/pharmacy-supply/reserve-stock';

const claimIdempotencyKeyMock = jest.fn();
const finaliseIdempotencyKeyMock = jest.fn(async () => ({ id: 1 }));
const releaseIdempotencyKeyMock = jest.fn(async () => null);
const reserveStockMock = jest.fn();

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
  addPurchaseOrderItem: unused,
  addSubstitute: unused,
  appendStockMovement: unused,
  bridgeForecastToBatches: unused,
  computeExpiryAlerts: unused,
  createGoodsReceipt: unused,
  createPurchaseOrder: unused,
  listBatches: unused,
  listExpiryAlerts: unused,
  listGoodsReceipts: unused,
  listInventoryItems: unused,
  listPurchaseOrders: unused,
  listStockMovements: unused,
  listSubstitutes: unused,
  listSuppliers: unused,
  recallBatch: unused,
  receivePurchaseOrderLine: unused,
  reserveStock: reserveStockMock,
  transitionPurchaseOrder: unused,
  upsertInventoryItem: unused,
  upsertSupplier: unused,
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
  reserveStockMock.mockReset();
  reserveStockMock.mockResolvedValue({
    requested: 5,
    fulfilled: 5,
    short_by: 0,
    consumed: [{ batch_id: 17, batch_number: 'B-17', quantity_taken: 5 }],
  });
});

describe('pharmacy-supply reserve-stock idempotency boundary', () => {
  test('rejects missing business lineage before claiming an idempotency key', async () => {
    const response = await request(app)
      .post(CANONICAL_PATH)
      .set('Idempotency-Key', 'reserve-route-missing-lineage')
      .send({ inventory_item_id: 7, quantity: 5, movement_kind: 'issue' });

    expect(response.status).toBe(400);
    expect(claimIdempotencyKeyMock).not.toHaveBeenCalled();
    expect(reserveStockMock).not.toHaveBeenCalled();
  });

  test('rejects a missing Idempotency-Key before invoking the service', async () => {
    const response = await request(app)
      .post(CANONICAL_PATH)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key header is required/);
    expect(claimIdempotencyKeyMock).not.toHaveBeenCalled();
    expect(reserveStockMock).not.toHaveBeenCalled();
  });

  test('canonicalizes both aliases and forwards the durable command evidence', async () => {
    claimIdempotencyKeyMock.mockResolvedValueOnce({ state: 'claimed', id: 71 });

    const response = await request(app)
      .post('/api/v1/pharmacy-supply/reserve-stock')
      .set('Idempotency-Key', 'reserve-route-71')
      .send(body);

    expect(response.status).toBe(200);
    expect(claimIdempotencyKeyMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      userUid: ACTOR,
      requestKey: 'reserve-route-71',
      requestMethod: 'POST',
      requestPath: CANONICAL_PATH,
      requestBodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(reserveStockMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      inventoryItemId: 7,
      quantity: 5,
      movementKind: 'issue',
      performedBy: ACTOR,
      commandKey: 'reserve-route-71',
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      httpIdempotencyClaimId: 71,
      requestId: 'pharmacy-supply-route-test',
    }));
  });

  test('replays the exact cross-alias request without invoking stock mutation twice', async () => {
    claimIdempotencyKeyMock.mockResolvedValueOnce({ state: 'claimed', id: 72 });
    const first = await request(app)
      .post(CANONICAL_PATH)
      .set('Idempotency-Key', 'reserve-route-72')
      .send(body);
    expect(first.status).toBe(200);

    claimIdempotencyKeyMock.mockResolvedValueOnce({
      state: 'replay',
      response_status: first.status,
      response_body: first.body,
    });
    const replay = await request(app)
      .post('/api/v1/pharmacy-supply/reserve-stock')
      .set('Idempotency-Key', 'reserve-route-72')
      .send(body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(reserveStockMock).toHaveBeenCalledTimes(1);
    expect(claimIdempotencyKeyMock.mock.calls.map(([claim]) => claim.requestPath))
      .toEqual([CANONICAL_PATH, CANONICAL_PATH]);
  });

  test('rejects a changed-body key reuse without invoking the service', async () => {
    claimIdempotencyKeyMock.mockResolvedValueOnce({ state: 'mismatch' });
    const response = await request(app)
      .post('/api/v1/pharmacy-supply/reserve-stock')
      .set('Idempotency-Key', 'reserve-route-mismatch')
      .send({ ...body, quantity: 6 });

    expect(response.status).toBe(422);
    expect(reserveStockMock).not.toHaveBeenCalled();
  });

  test('returns in-flight conflict to a concurrent duplicate and runs one handler', async () => {
    claimIdempotencyKeyMock
      .mockResolvedValueOnce({ state: 'claimed', id: 73 })
      .mockResolvedValueOnce({ state: 'in_flight' });
    let releaseHandler;
    let handlerEnteredResolve;
    const handlerEntered = new Promise((resolve) => { handlerEnteredResolve = resolve; });
    reserveStockMock.mockImplementationOnce(() => {
      handlerEnteredResolve();
      return new Promise((resolve) => { releaseHandler = resolve; });
    });

    const firstPending = request(app)
      .post(CANONICAL_PATH)
      .set('Idempotency-Key', 'reserve-route-concurrent')
      .send(body);
    const firstResult = firstPending.then((response) => response);
    await handlerEntered;
    const duplicate = await request(app)
      .post('/api/v1/pharmacy-supply/reserve-stock')
      .set('Idempotency-Key', 'reserve-route-concurrent')
      .send(body);
    releaseHandler({
      requested: 5,
      fulfilled: 5,
      short_by: 0,
      consumed: [{ batch_id: 17, batch_number: 'B-17', quantity_taken: 5 }],
    });
    const first = await firstResult;

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
    expect(reserveStockMock).toHaveBeenCalledTimes(1);
  });

  test('retains an uncertain 5xx claim instead of releasing it for a second decrement', async () => {
    claimIdempotencyKeyMock.mockResolvedValueOnce({ state: 'claimed', id: 74 });
    reserveStockMock.mockRejectedValueOnce(new Error('response assembly failed'));

    const response = await request(app)
      .post(CANONICAL_PATH)
      .set('Idempotency-Key', 'reserve-route-uncertain')
      .send(body);

    expect(response.status).toBe(500);
    expect(releaseIdempotencyKeyMock).not.toHaveBeenCalled();
    expect(finaliseIdempotencyKeyMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 74,
      status: 'failed',
      responseStatus: 500,
    }));
  });
});

describe('pharmacy-supply reserve-stock OpenAPI source', () => {
  test('documents the same required header and decreasing-kind contract on both aliases', () => {
    for (const prefix of ['/api/v1/admin/pharmacy-supply', '/api/v1/pharmacy-supply']) {
      const operation = pharmacyOpenApi.operations[`POST ${prefix}/reserve-stock`];
      expect(operation).toMatchObject({
        request: 'PharmacySupplyReservationRequest',
        response: 'PharmacySupplyReservationResponse',
      });
      expect(operation.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
    }
    expect(pharmacyOpenApi.schemas.PharmacySupplyReservationRequest.properties.movement_kind.enum)
      .toEqual(['issue', 'transfer_out', 'adjust_decrease', 'dispose', 'expire']);
    expect(pharmacyOpenApi.schemas.PharmacySupplyReservationRequest.required)
      .toEqual(expect.arrayContaining(['reference_type', 'reference_id']));
    expect(pharmacyOpenApi.schemas.PharmacySupplyReservationRequest.properties.quantity.multipleOf)
      .toBe(0.0001);
  });
});
