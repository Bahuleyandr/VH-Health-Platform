import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Controller-layer contract regression — investigationController member of
// the relayAppError sweep, driven over HTTP through the REAL
// routes/investigation/investigationRoutes.js mount (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// Three catch sites are ported:
//   * listInvestigations relayed `err.details` with no code at all;
//   * markInvestigationCollected nested code under `details.code` behind an
//     `err?.isOperational && err?.statusCode` predicate (kept verbatim);
//   * addInvestigationResults built `{ code, ...details }` behind an
//     `err?.isOperational && err?.statusCode && err?.code` predicate (kept).

const getInvestigationsMock = jest.fn();
const markSampleCollectedMock = jest.fn();
const addResultsMock = jest.fn();
const canUpdateStatusMock = jest.fn(() => true);
const canAddResultsMock = jest.fn(() => true);

jest.unstable_mockModule('../../services/investigation/investigationService.js', () => ({
  getInvestigations: getInvestigationsMock,
  getInvestigationById: jest.fn(),
  getPatientInvestigations: jest.fn(),
  canViewDoctorInvestigations: jest.fn(() => true),
  getDoctorInvestigations: jest.fn(),
  canViewByType: jest.fn(() => true),
  getInvestigationsByType: jest.fn(),
  canViewPending: jest.fn(() => true),
  getPendingInvestigations: jest.fn(),
  canUpdateStatus: canUpdateStatusMock,
  markSampleCollected: markSampleCollectedMock,
  updateStatus: jest.fn(),
  canAddResults: canAddResultsMock,
  addResults: addResultsMock,
}));

jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorFilterId: jest.fn(async () => null),
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenantTx: jest.fn(),
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));

// Sibling controllers mounted by the same routes file — stub their module
// graphs so the suite stays hermetic (no prisma / R2 / booking services).
jest.unstable_mockModule('../../controllers/investigation/bookingController.js', () => ({
  getMyBookings: jest.fn((_req, res) => res.status(200).json({})),
  getBookingQueue: jest.fn((_req, res) => res.status(200).json({})),
  getBookingSLADashboard: jest.fn((_req, res) => res.status(200).json({})),
  getBookingDetail: jest.fn((_req, res) => res.status(200).json({})),
  createBooking: jest.fn((_req, res) => res.status(200).json({})),
  confirmBooking: jest.fn((_req, res) => res.status(200).json({})),
  dispatchCollector: jest.fn((_req, res) => res.status(200).json({})),
  markCollected: jest.fn((_req, res) => res.status(200).json({})),
  startProcessing: jest.fn((_req, res) => res.status(200).json({})),
  uploadResult: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../controllers/investigation/bulkController.js', () => ({
  updateStatus: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../controllers/investigation/orderController.js', () => ({
  orderInvestigation: jest.fn((_req, res) => res.status(200).json({})),
  legacyInvestigationRequest: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../controllers/investigation/uploadController.js', () => ({
  getFiles: jest.fn((_req, res) => res.status(200).json({})),
  getFileInfo: jest.fn((_req, res) => res.status(200).json({})),
  downloadFile: jest.fn((_req, res) => res.status(200).json({})),
  uploadResult: jest.fn((_req, res) => res.status(200).json({})),
  removeFile: jest.fn((_req, res) => res.status(200).json({})),
}));

// Route-wrapper middleware chain — pass-throughs keep the test hermetic.
jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  default: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/auditLogger.js', () => ({
  auditLogger: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  dynamicRoleRateLimiter: (_req, _res, next) => next(),
  getRateLimiter: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/identityValidator.js', () => ({
  validateUID: (_req, _res, next) => next(),
  validatePhone: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/sanitizeMiddleware.js', () => ({
  sanitizeInvestigationFields: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
  // Per-route guards (re-audit M mount fix) — pass-through: this suite pins
  // controller AppError propagation, not access decisions.
  patientAccessGuard: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  rejectMobileClinicalWrite: (_req, _res, next) => next(),
  default: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  validateFileContent: (_req, _res, next) => next(),
  validateGenericDocumentUpload: (_req, _res, next) => next(),
  validatePatientUpload: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../validators/investigation/investigationValidators.js', () => ({
  investigationRequestValidator: (_req, _res, next) => next(),
  idValidator: (_req, _res, next) => next(),
  updateStatusValidator: (_req, _res, next) => next(),
  addResultsValidator: (_req, _res, next) => next(),
  listInvestigationsValidator: (_req, _res, next) => next(),
  patientIdValidator: (_req, _res, next) => next(),
  doctorIdValidator: (_req, _res, next) => next(),
  typeValidator: (_req, _res, next) => next(),
}));

const { default: investigationRoutes } = await import('../../routes/investigation/investigationRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'LAB_TECHNICIAN' };
  next();
});
app.use('/api/v1/investigations', investigationRoutes);

beforeEach(() => {
  getInvestigationsMock.mockReset();
  markSampleCollectedMock.mockReset();
  addResultsMock.mockReset();
  canUpdateStatusMock.mockReturnValue(true);
  canAddResultsMock.mockReturnValue(true);
});

describe('listInvestigations catch relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    getInvestigationsMock.mockRejectedValueOnce(AppError.badRequest(
      'patient_uid must be a UUID',
      'INVALID_PATIENT_UID',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/investigations/list');

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('patient_uid must be a UUID');
    expect(response.body.code).toBe('INVALID_PATIENT_UID');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    getInvestigationsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'investigation_rows')"),
    );

    const response = await request(app).get('/api/v1/investigations/list');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to retrieve investigations');
    expect(response.body.message).not.toMatch(/investigation_rows/);
  });

  test('pre-existing USER_NOT_FOUND branch still answers 404', async () => {
    getInvestigationsMock.mockRejectedValueOnce(new Error('USER_NOT_FOUND'));

    const response = await request(app).get('/api/v1/investigations/list');

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toBe('User not found');
  });
});

describe('markInvestigationCollected catch keeps its isOperational predicate', () => {
  test('operational AppError relays status + code + details', async () => {
    markSampleCollectedMock.mockRejectedValueOnce(AppError.conflict(
      'Sample already collected for this investigation',
      'SAMPLE_ALREADY_COLLECTED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/investigations/12/collected')
      .send({ collected_notes: 'tube A' });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('SAMPLE_ALREADY_COLLECTED');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('a statusCode-bearing error WITHOUT isOperational still 500s generically', async () => {
    // The site predicate is `err?.isOperational && err?.statusCode` — a bare
    // statusCode (e.g. an axios-like error) must NOT be relayed.
    markSampleCollectedMock.mockRejectedValueOnce(
      Object.assign(new Error('upstream socket closed mid-write'), { statusCode: 502 }),
    );

    const response = await request(app)
      .post('/api/v1/investigations/12/collected')
      .send({});

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to mark sample collected');
    expect(response.body.message).not.toMatch(/socket/);
  });
});

describe('addInvestigationResults catch keeps its isOperational+code predicate', () => {
  test('operational AppError relays status + code + details', async () => {
    addResultsMock.mockRejectedValueOnce(AppError.conflict(
      'Results already submitted for this investigation',
      'RESULTS_ALREADY_SUBMITTED',
      { re_run_required: true },
    ));

    const response = await request(app)
      .put('/api/v1/investigations/12/results')
      .send({ results: { hb: 12 } });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('RESULTS_ALREADY_SUBMITTED');
    expect(response.body.details).toEqual({ re_run_required: true });
  });

  test('an operational error WITHOUT a code still 500s generically', async () => {
    const noCode = new AppError('half-shaped operational error', 422, 'X');
    noCode.code = null; // predicate requires err?.code — must fall to the tail

    addResultsMock.mockRejectedValueOnce(noCode);

    const response = await request(app)
      .put('/api/v1/investigations/12/results')
      .send({ results: { hb: 12 } });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to add investigation results');
    expect(response.body.message).not.toMatch(/half-shaped/);
  });
});
