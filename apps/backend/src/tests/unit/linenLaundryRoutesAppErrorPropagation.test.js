import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — linenLaundryRoutes member of the
// relayAppError sweep (mirrors paediatricImmunisationRoutesAppErrorPropagation).
//
// linenLaundryRoutes.js `wrap()` already lifted err.code to the envelope root
// via the hand-rolled `{ ...err.details, topLevel: { code: err.code } }`
// builder — a pure recombination of err.code / err.details (R7 → plain
// relay). The port to responseHelper.relayAppError keeps that wire shape.

const getLinenBoardMock = jest.fn();
const createLaundryCycleMock = jest.fn();

jest.unstable_mockModule('../../services/linen/linenLaundryService.js', () => ({
  getLinenBoard: getLinenBoardMock,
  listItemTypes: jest.fn(async () => []),
  upsertItemType: jest.fn(),
  upsertWardParLevel: jest.fn(),
  createLaundryCycle: createLaundryCycleMock,
  getLaundryCycle: jest.fn(),
  collectLaundryCycle: jest.fn(),
  sendCycleToLaundry: jest.fn(),
  returnLaundryCycle: jest.fn(),
  reconcileLaundryCycle: jest.fn(),
  cancelLaundryCycle: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: linenLaundryRoutes } = await import('../../routes/linen/linenLaundryRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'HOUSEKEEPING_SUPERVISOR' };
  next();
});
app.use('/api/v1/linen', linenLaundryRoutes);

beforeEach(() => {
  getLinenBoardMock.mockReset();
  createLaundryCycleMock.mockReset();
});

describe('linen/laundry wrap() relays AppError code + details (pre-existing wire shape kept)', () => {
  test('AppError code stays at the envelope root with details nested', async () => {
    createLaundryCycleMock.mockRejectedValueOnce(AppError.conflict(
      'An open laundry cycle already exists for this ward',
      'LINEN_CYCLE_ALREADY_OPEN',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/linen/cycles')
      .send({ ward_id: 4 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An open laundry cycle already exists for this ward');
    expect(response.body.code).toBe('LINEN_CYCLE_ALREADY_OPEN');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    getLinenBoardMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'par_levels')"),
    );

    const response = await request(app).get('/api/v1/linen/board');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Linen/laundry request failed');
    expect(response.body.message).not.toMatch(/par_levels/);
  });
});
