import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// labPanelRoutes.js wraps every handler in a local `wrap()` whose catch
// branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). Before the
// relayAppError port the catch called `error(res, err.message,
// err.statusCode)` with no 4th arg, dropping `err.code` and `err.details`.
// Non-AppErrors must return the file's hand-written generic 500 and never
// relay raw err.message (finding
// 2026-05-10-lab-walk-in-lab-tech-result-submit-500).

const recordLabPanelMock = jest.fn();
const getLabPanelMock = jest.fn();

jest.unstable_mockModule('../../services/lab/labPanelService.js', () => ({
  recordLabPanel: recordLabPanelMock,
  getLabPanel: getLabPanelMock,
  listPatientPanels: jest.fn(async () => []),
  getAnalyteTrend: jest.fn(async () => []),
  listReferenceRanges: jest.fn(async () => []),
  upsertReferenceRange: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: labPanelRoutes } = await import('../../routes/lab/labPanelRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'LAB_STAFF' };
  next();
});
app.use('/api/v1/lab', labPanelRoutes);

beforeEach(() => {
  recordLabPanelMock.mockReset();
  getLabPanelMock.mockReset();
});

describe('lab panel route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    recordLabPanelMock.mockRejectedValueOnce(AppError.conflict(
      'A result for this panel has already been finalised',
      'LAB_PANEL_ALREADY_FINALISED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/lab/panels')
      .send({
        panelCode: 'CBC',
        patientUid: '22222222-2222-4222-8222-222222222222',
        analytes: [{ test_code: 'HGB', test_name: 'Hemoglobin', value_numeric: 13.2 }],
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('LAB_PANEL_ALREADY_FINALISED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The exact class of leak the original catch was hand-written to stop:
    // a stale Prisma client surfacing driver internals to the client.
    getLabPanelMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'findMany')"),
    );

    const response = await request(app)
      .get('/api/v1/lab/panels/33333333-3333-4333-8333-333333333333');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Lab panel error');
    expect(response.body.message).not.toMatch(/findMany/);
  });
});
