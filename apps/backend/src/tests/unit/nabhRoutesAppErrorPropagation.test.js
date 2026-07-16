import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — nabhRoutes member of the relayAppError
// sweep (mirrors paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// nabhRoutes.js funnels every catch through handleFailure(), whose AppError
// branch used to call `error(res, err.message, err.statusCode,
// err.details ?? { code: err.code })` — err.code only reached the wire when
// details were absent, and then nested under `details.code` instead of the
// documented envelope root. Ported to responseHelper.relayAppError.

const computeIndicatorsMock = jest.fn();
const freezePeriodPackMock = jest.fn();

jest.unstable_mockModule('../../services/quality/nabhIndicatorService.js', () => ({
  computeIndicators: computeIndicatorsMock,
  snapshotIndicators: jest.fn(),
  listSnapshots: jest.fn(async () => []),
  freezePeriodPack: freezePeriodPackMock,
  getFrozenPeriodPack: jest.fn(),
  packToCsv: jest.fn(() => ''),
  packToPdfBuffer: jest.fn(async () => Buffer.alloc(0)),
}));

const { default: nabhRoutes } = await import('../../routes/quality/nabhRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'QUALITY_OFFICER' };
  next();
});
app.use('/api/v1/quality/nabh', nabhRoutes);

beforeEach(() => {
  computeIndicatorsMock.mockReset();
  freezePeriodPackMock.mockReset();
});

describe('NABH handleFailure() relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    computeIndicatorsMock.mockRejectedValueOnce(AppError.conflict(
      'Indicator pack already frozen for this period',
      'NABH_PACK_ALREADY_FROZEN',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/quality/nabh/indicators?from=2026-06-01&to=2026-06-30');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Indicator pack already frozen for this period');
    expect(response.body.code).toBe('NABH_PACK_ALREADY_FROZEN');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    computeIndicatorsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'indicator_rows')"),
    );

    const response = await request(app).get('/api/v1/quality/nabh/indicators?from=2026-06-01&to=2026-06-30');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to compute indicators');
    expect(response.body.message).not.toMatch(/indicator_rows/);
  });

  test('per-context generic survives on a different endpoint', async () => {
    freezePeriodPackMock.mockRejectedValueOnce(
      new Error("Cannot read properties of null (reading 'period')"),
    );

    const response = await request(app)
      .post('/api/v1/quality/nabh/period-pack')
      .send({ from: '2026-06-01', to: '2026-06-30' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to freeze period pack');
    expect(response.body.message).not.toMatch(/Cannot read properties/);
  });
});
