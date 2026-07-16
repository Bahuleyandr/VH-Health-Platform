import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — cathQualityRoutes member of the
// relayAppError sweep (mirrors paediatricImmunisationRoutesAppErrorPropagation).
//
// cathQualityRoutes.js funnels every catch through handleFailure(), whose
// AppError branch used `err.details ?? { code: err.code }` (the R3 family):
// err.code was dropped whenever details existed and otherwise nested under
// `details.code`. Ported to responseHelper.relayAppError.

const getDoseRollupMock = jest.fn();
const setDoseAlertSettingsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/cathSchedulingRegistryService.js', () => ({
  getDoseAlertSettings: jest.fn(),
  getDoseRollup: getDoseRollupMock,
  listRegistry: jest.fn(async () => []),
  setDoseAlertSettings: setDoseAlertSettingsMock,
  updateRegistryReview: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: cathQualityRoutes } = await import('../../routes/quality/cathQualityRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'QUALITY_OFFICER' };
  next();
});
app.use('/api/v1/quality/cath', cathQualityRoutes);

beforeEach(() => {
  getDoseRollupMock.mockReset();
  setDoseAlertSettingsMock.mockReset();
});

describe('cath quality handleFailure() relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    setDoseAlertSettingsMock.mockRejectedValueOnce(AppError.badRequest(
      'Dose alert thresholds must be positive numbers',
      'CATH_DOSE_THRESHOLDS_INVALID',
      { reason: 'x' },
    ));

    const response = await request(app)
      .put('/api/v1/quality/cath/dose-settings')
      .send({ dap_threshold: -1 });

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Dose alert thresholds must be positive numbers');
    expect(response.body.code).toBe('CATH_DOSE_THRESHOLDS_INVALID');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    getDoseRollupMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'dose_rows')"),
    );

    const response = await request(app).get('/api/v1/quality/cath/dose-rollup');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to compute dose rollup');
    expect(response.body.message).not.toMatch(/dose_rows/);
  });
});
