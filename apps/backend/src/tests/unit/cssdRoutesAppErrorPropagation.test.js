import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — cssdRoutes member of the relayAppError
// sweep (mirrors paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// cssdRoutes.js `wrap()` already lifted err.code to the envelope root via the
// hand-rolled `{ ...err.details, topLevel: { code: err.code } }` builder — a
// pure recombination of err.code / err.details (R7 → plain relay). The port
// to responseHelper.relayAppError must keep that wire shape byte-identical:
// code at the root, details nested, no spurious `details` key.

const getCssdBoardMock = jest.fn();
const issueSetMock = jest.fn();

jest.unstable_mockModule('../../services/cssd/cssdService.js', () => ({
  getCssdBoard: getCssdBoardMock,
  listInstrumentSets: jest.fn(async () => []),
  createInstrumentSet: jest.fn(),
  getInstrumentSetLabel: jest.fn(),
  listSterilizationLoads: jest.fn(async () => []),
  createSterilizationLoad: jest.fn(),
  transitionSterilizationLoad: jest.fn(),
  listIssues: jest.fn(async () => []),
  issueSet: issueSetMock,
  markTheatreUse: jest.fn(),
  returnIssuedSet: jest.fn(),
  markDecontaminated: jest.fn(),
  cancelIssue: jest.fn(),
  getOtSterilityWarnings: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  // cssdRoutes now also mounts the reprocessable-device queue, whose service
  // resolves its tenant through requireTenantId.
  requireTenantId: (value) => value,
}));

// The device queue's service is not under test here (this suite pins wrap()'s
// AppError wire shape on the instrument-set routes); stub it so the suite does
// not drag the reuse register's whole dependency graph in.
jest.unstable_mockModule('../../services/clinical/cathDeviceReuseService.js', () => ({
  discardDevice: jest.fn(),
  listDevices: jest.fn(async () => []),
  markDeviceReprocessed: jest.fn(),
  quarantineDevice: jest.fn(),
  receiveDevice: jest.fn(),
  releaseDevice: jest.fn(),
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => function idempotencyMiddleware(_req, _res, next) {
    return next();
  },
}));

const { default: cssdRoutes } = await import('../../routes/cssd/cssdRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'CSSD_TECHNICIAN' };
  next();
});
app.use('/api/v1/cssd', cssdRoutes);

beforeEach(() => {
  getCssdBoardMock.mockReset();
  issueSetMock.mockReset();
});

describe('CSSD wrap() relays AppError code + details (pre-existing wire shape kept)', () => {
  test('AppError code stays at the envelope root with details nested', async () => {
    issueSetMock.mockRejectedValueOnce(AppError.conflict(
      'Instrument set is not sterile and cannot be issued',
      'CSSD_SET_UNUSABLE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/cssd/issues')
      .send({ set_id: 3 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Instrument set is not sterile and cannot be issued');
    expect(response.body.code).toBe('CSSD_SET_UNUSABLE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('AppError with a code but no details produces no details key at all', async () => {
    issueSetMock.mockRejectedValueOnce(AppError.conflict(
      'Instrument set already issued',
      'CSSD_SET_ALREADY_ISSUED',
    ));

    const response = await request(app)
      .post('/api/v1/cssd/issues')
      .send({ set_id: 3 });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('CSSD_SET_ALREADY_ISSUED');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    getCssdBoardMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'sterilization_loads')"),
    );

    const response = await request(app).get('/api/v1/cssd/board');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('CSSD request failed');
    expect(response.body.message).not.toMatch(/sterilization_loads/);
  });
});
