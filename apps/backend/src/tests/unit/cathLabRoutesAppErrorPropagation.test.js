import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for cathLabRoutes.js — relay-variants port
// of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`, so `code` was only visible when
// a service attached no details; the relay lifts err.code to the envelope root
// unconditionally and keeps err.details under `details`.

const getCaseMock = jest.fn();
const listCasesMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/cathLabService.js', () => ({
  addContrastRadiationRecord: jest.fn(),
  addDeviceLink: jest.fn(),
  addHemodynamicSummary: jest.fn(),
  addPostProcedureOrder: jest.fn(),
  createCase: jest.fn(),
  getCase: getCaseMock,
  listCatalogBatches: jest.fn(),
  listCases: listCasesMock,
  listCaseConsumableUsage: jest.fn(),
  listConsumableCatalog: jest.fn(),
  recordConsumableUsage: jest.fn(),
  recordProcedureLog: jest.fn(),
  transitionCaseStatus: jest.fn(),
  updateReadinessCheck: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/cathQuickWinsService.js', () => ({
  applyCathOrderSetSlot: jest.fn(),
  getCaseQuickWins: jest.fn(),
  refreshReadinessEvidence: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/cathReportService.js', () => ({
  addReportAddendum: jest.fn(),
  createReport: jest.fn(),
  getReport: jest.fn(),
  getSignedReportForPdf: jest.fn(),
  listReports: jest.fn(),
  listReportTemplates: jest.fn(),
  markReportPreliminary: jest.fn(),
  resolveCaseViewerLink: jest.fn(),
  signReport: jest.fn(),
  supersedeReportTemplate: jest.fn(),
  updateReport: jest.fn(),
}));

jest.unstable_mockModule('../../services/documents/cathReportPdfService.js', () => ({
  renderCathReportPdf: jest.fn(),
}));

// cathLabRoutes mounts cathSchedulingRoutes; mock its service so the
// Scheduling 2.0 chain stays out of this suite's module graph.
jest.unstable_mockModule('../../services/clinical/cathSchedulingRegistryService.js', () => ({
  addRegistryEntry: jest.fn(),
  cancelCaseSchedule: jest.fn(),
  getCaseSchedule: jest.fn(),
  getScheduleStrip: jest.fn(),
  scheduleCase: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

const { default: cathLabRoutes } = await import('../../routes/clinical/cathLabRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'DOCTOR',
    rawRole: 'DOCTOR',
    roles: ['DOCTOR'],
  };
  next();
});
app.use('/api/v1/cath-lab', cathLabRoutes);

beforeEach(() => {
  getCaseMock.mockReset();
  listCasesMock.mockReset();
});

describe('cath-lab handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    getCaseMock.mockRejectedValueOnce(
      AppError.conflict('Case is already in a terminal status', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app).get('/api/v1/cath-lab/cases/42');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    listCasesMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'procedure_type')"),
    );

    const response = await request(app).get('/api/v1/cath-lab/cases');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list cases');
    expect(response.body.message).not.toMatch(/procedure_type/);
  });
});
