import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// microbiologyRoutes.js wraps every handler in a local `wrap()` whose catch
// branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). Before the
// relayAppError port the catch dropped `err.code`/`err.details` AND relayed
// raw `err.message` on the 500 branch (`err.message || 'Microbiology
// error'`) — the exact leak CLAUDE.md's security checklist forbids. The
// port hardens the 500 to the generic message only.

const createOrderMock = jest.fn();
const listOrdersMock = jest.fn();

jest.unstable_mockModule('../../services/lab/microbiologyService.js', () => ({
  createOrder: createOrderMock,
  listOrders: listOrdersMock,
  getOrder: jest.fn(async () => ({})),
  transitionOrder: jest.fn(async () => ({})),
  addIsolate: jest.fn(async () => ({})),
  addSensitivity: jest.fn(async () => ({})),
  antibiogram90d: jest.fn(async () => []),
  listResistantIsolates: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// realtimeEmitter pulls in prisma + wsServer — keep the unit test DB-free.
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitMicroEvent: jest.fn(),
}));

const { default: microbiologyRoutes } = await import('../../routes/lab/microbiologyRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'LAB_STAFF' };
  next();
});
app.use('/api/v1/microbiology', microbiologyRoutes);

beforeEach(() => {
  createOrderMock.mockReset();
  listOrdersMock.mockReset();
});

describe('microbiology route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    createOrderMock.mockRejectedValueOnce(AppError.conflict(
      'A culture order for this specimen is already in progress',
      'MICRO_ORDER_ALREADY_OPEN',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/microbiology/orders')
      .send({
        patient_uid: '22222222-2222-4222-8222-222222222222',
        specimen_type: 'blood',
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('MICRO_ORDER_ALREADY_OPEN');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old catch relayed `err.message || 'Microbiology error'` — this
    // pins the hardened generic-only behaviour.
    listOrdersMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'micro_orders')"),
    );

    const response = await request(app).get('/api/v1/microbiology/orders');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Microbiology error');
    expect(response.body.message).not.toMatch(/micro_orders/);
  });
});
