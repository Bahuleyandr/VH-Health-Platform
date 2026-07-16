import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — infectionControlRoutes member of the
// relayAppError sweep (mirrors paediatricImmunisationRoutesAppErrorPropagation).
//
// infectionControlRoutes.js funnels every catch through handleFailure(),
// whose AppError branch used `err.details ?? { code: err.code }` — dropping
// err.code whenever details existed and otherwise nesting it under
// `details.code`. Ported to responseHelper.relayAppError.

const isolationBoardMock = jest.fn();
const createIsolationOrderMock = jest.fn();

jest.unstable_mockModule('../../services/quality/infectionControlWorkbenchService.js', () => ({
  isolationBoard: isolationBoardMock,
  listIsolationOrders: jest.fn(async () => []),
  createIsolationOrder: createIsolationOrderMock,
  updateIsolationChecklistItem: jest.fn(),
  discontinueIsolationOrder: jest.fn(),
  requestIsolationTerminalClean: jest.fn(),
  traceContacts: jest.fn(async () => []),
  antibiogram: jest.fn(),
  logDevicePresence: jest.fn(),
  stopDevicePresence: jest.fn(),
  calculateHaiRates: jest.fn(),
  createHaiCase: jest.fn(),
  snapshotHaiRates: jest.fn(),
  createOutbreakEpisode: jest.fn(),
  listOutbreakEpisodes: jest.fn(async () => []),
  linkOutbreakCase: jest.fn(),
  suggestOutbreakClusters: jest.fn(),
  outbreakEpiCurve: jest.fn(),
  createHandHygieneAudit: jest.fn(),
  listHandHygieneAudits: jest.fn(async () => []),
}));

const { default: infectionControlRoutes } = await import('../../routes/quality/infectionControlRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'INFECTION_CONTROL_OFFICER' };
  next();
});
app.use('/api/v1/infection-control', infectionControlRoutes);

beforeEach(() => {
  isolationBoardMock.mockReset();
  createIsolationOrderMock.mockReset();
});

describe('infection control handleFailure() relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    createIsolationOrderMock.mockRejectedValueOnce(AppError.conflict(
      'Patient already has an active isolation order',
      'ISOLATION_ORDER_ACTIVE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/infection-control/isolation-orders')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Patient already has an active isolation order');
    expect(response.body.code).toBe('ISOLATION_ORDER_ACTIVE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    isolationBoardMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'isolation_rows')"),
    );

    const response = await request(app).get('/api/v1/infection-control/isolation-board');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to build isolation board');
    expect(response.body.message).not.toMatch(/isolation_rows/);
  });
});
