import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the patient-portal member of the
// relayAppError sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// patientPortalRoutes.js has two shapes of the pasted catch pattern:
//
//   * `wrap()` used to call `error(res, err.message, err.statusCode)` with no
//     4th arg (dropping err.code / err.details) and, for non-AppErrors,
//     relayed `err.message || 'Portal error'` — leaking internals on non-prod
//     deployments where sanitize passes 5xx messages through.
//   * The three inline binary-PDF handlers (/bills/:id/pdf,
//     /discharge-summaries/:id/pdf|download, /lab-orders/:id/pdf) dropped
//     code/details the same way and fell through to `next(err)`, whose global
//     handler also relays raw err.message on non-prod.
//
// Both shapes are ported to responseHelper.relayAppError. These tests drive
// the endpoints over HTTP (supertest) and assert the response body itself.

const listMyBillsMock = jest.fn();
const generateMyInvoicePdfBufferMock = jest.fn();
const generateMyDischargeSummaryPdfBufferMock = jest.fn();
const generateMyLabOrderPdfBufferMock = jest.fn();

jest.unstable_mockModule('../../services/portal/patientPortalService.js', () => ({
  listMyBills: listMyBillsMock,
  generateMyInvoicePdfBuffer: generateMyInvoicePdfBufferMock,
  generateMyDischargeSummaryPdfBuffer: generateMyDischargeSummaryPdfBufferMock,
  generateMyLabOrderPdfBuffer: generateMyLabOrderPdfBufferMock,
}));

// The route module imports a wide graph; stub every non-trivial neighbour so
// the suite stays hermetic (no prisma / R2 / controller service graphs).
jest.unstable_mockModule('../../controllers/appointment/appointmentListController.js', () => ({
  getPatientAppointments: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../controllers/prescription/ePrescriptionController.js', () => ({
  getMyPrescriptions: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../controllers/record/patientRecordController.js', () => ({
  getHealthRecordsByPhone: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  getActivePregnancyForPatient: jest.fn(async () => null),
  getAncTimelineForPatient: jest.fn(async () => ({})),
  projectAncTimelineForPatient: jest.fn(() => ({})),
  getAncAdvice: jest.fn(async () => []),
  listFetalKicks: jest.fn(async () => []),
  recordFetalKick: jest.fn(async () => ({})),
  setSupplementReminder: jest.fn(async () => ({})),
  listMaternityPackages: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../services/portal/portalAccessService.js', () => ({
  resolvePortalPatient: jest.fn(async () => ({ patientUid: null, grantId: null })),
  getLabTrend: jest.fn(async () => ({})),
  createProxyGrant: jest.fn(async () => ({})),
  listProxyGrants: jest.fn(async () => []),
  revokeProxyGrant: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/carePlan/carePlanService.js', () => ({
  getPatientWhatsNext: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/telemedicine/teleconsultProvisioningService.js', () => ({
  getPatientTeleconsultLobbyStateForAppointment: jest.fn(async () => ({})),
  issueJoinToken: jest.fn(async () => ({})),
  recordTeleconsultConsent: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  singleUpload: (_req, _res, next) => next(),
  validateFileContent: (_req, _res, next) => next(),
  validatePatientUpload: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(async () => 'https://r2.example/key'),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: portalRoutes } = await import('../../routes/portal/patientPortalRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // requirePatient gate: role must be PATIENT and the token must carry a uid.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'PATIENT' };
  next();
});
app.use('/api/v1/portal', portalRoutes);

beforeEach(() => {
  listMyBillsMock.mockReset();
  generateMyInvoicePdfBufferMock.mockReset();
  generateMyDischargeSummaryPdfBufferMock.mockReset();
  generateMyLabOrderPdfBufferMock.mockReset();
});

describe('patient portal wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    listMyBillsMock.mockRejectedValueOnce(AppError.conflict(
      'Bill payment already in flight for this invoice',
      'PORTAL_BILL_PAYMENT_IN_FLIGHT',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/portal/bills');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Bill payment already in flight for this invoice');
    // The bug: these assertions FAIL on the unmodified wrap (both dropped).
    expect(response.body.code).toBe('PORTAL_BILL_PAYMENT_IN_FLIGHT');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old branch relayed `err.message || 'Portal error'` — sanitize only
    // genericises 5xx in production, so that leaked on test/staging deploys.
    listMyBillsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'invoice_rows')"),
    );

    const response = await request(app).get('/api/v1/portal/bills');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Portal error');
    expect(response.body.message).not.toMatch(/invoice_rows/);
    expect(response.body).not.toHaveProperty('details');
  });
});

describe('inline binary-PDF catch blocks relay via the shared helper', () => {
  test('/bills/:id/pdf — AppError statusCode + code + details propagate', async () => {
    generateMyInvoicePdfBufferMock.mockRejectedValueOnce(AppError.conflict(
      'Invoice is being regenerated',
      'PORTAL_INVOICE_PDF_REGENERATING',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/portal/bills/42/pdf');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PORTAL_INVOICE_PDF_REGENERATING');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('/bills/:id/pdf — non-AppError returns this site\'s generic 500, thrown text absent', async () => {
    // Previously fell through to next(err); the global handler relays raw
    // err.message on non-prod deployments. The port must answer generically.
    generateMyInvoicePdfBufferMock.mockRejectedValueOnce(
      new Error("Cannot read properties of null (reading 'pdf_key')"),
    );

    const response = await request(app).get('/api/v1/portal/bills/42/pdf');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('patient bill PDF error');
    expect(response.body.message).not.toMatch(/pdf_key/);
  });

  test('/discharge-summaries/:id/pdf — non-AppError returns its own generic 500', async () => {
    generateMyDischargeSummaryPdfBufferMock.mockRejectedValueOnce(
      new Error("Cannot read properties of null (reading 'summary_html')"),
    );

    const response = await request(app).get('/api/v1/portal/discharge-summaries/7/pdf');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('patient discharge summary PDF error');
    expect(response.body.message).not.toMatch(/summary_html/);
  });

  test('/lab-orders/:id/pdf — non-AppError returns its own generic 500', async () => {
    generateMyLabOrderPdfBufferMock.mockRejectedValueOnce(
      new Error("Cannot read properties of null (reading 'result_rows')"),
    );

    const response = await request(app).get('/api/v1/portal/lab-orders/9/pdf');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('patient lab report PDF error');
    expect(response.body.message).not.toMatch(/result_rows/);
  });
});
