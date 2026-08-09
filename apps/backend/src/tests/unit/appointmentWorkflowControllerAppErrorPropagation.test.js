import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of
// appointmentWorkflowController.js (the R1 fold of the five
// `if (err?.statusCode) return error(res, err.message, err.statusCode)` +
// locally-logged-generic-500 catches on confirm / no-show / reschedule /
// complete / cancel). Mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js: supertest over the
// REAL route module, service seams mocked, asserting the wire envelope.

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  isTenantTransactionClient: () => true,
  pickTenantClient: (client) => client,
  runTenantScopedTransaction: async (_client, _guc, fn) => fn({ $queryRawUnsafe: jest.fn(async () => []) }),
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: jest.fn(async () => []) }),
  setTenantTx: setTenantTxMock,
}));

// Sibling controllers mounted by the same routes file — not under test.
jest.unstable_mockModule('../../controllers/appointment/appointmentDocumentController.js', () => ({
  getPatientAllRecords: jest.fn((_req, res) => res.status(200).json({})),
  uploadPatientRecord: jest.fn((_req, res) => res.status(200).json({})),
  getPatientRecordExtraction: jest.fn((_req, res) => res.status(200).json({})),
  processPatientRecordExtraction: jest.fn((_req, res) => res.status(200).json({})),
  reviewPatientRecordExtraction: jest.fn((_req, res) => res.status(200).json({})),
  deletePatientRecord: jest.fn((_req, res) => res.status(200).json({})),
  uploadAppointmentDocument: jest.fn((_req, res) => res.status(200).json({})),
  getAppointmentDocuments: jest.fn((_req, res) => res.status(200).json({})),
  getAllDocumentsAdmin: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../controllers/appointment/appointmentAdminController.js', () => ({
  getAppointmentSLADashboard: jest.fn((_req, res) => res.status(200).json({})),
  getStatusAuditTrail: jest.fn((_req, res) => res.status(200).json({})),
}));
jest.unstable_mockModule('../../controllers/appointment/appointmentPathwayController.js', () => ({
  getPathwayWork: jest.fn((_req, res) => res.status(200).json({})),
  recordClosureEvidence: jest.fn((_req, res) => res.status(200).json({})),
  requestInpatientTransfer: jest.fn((_req, res) => res.status(200).json({})),
  acceptInpatientTransfer: jest.fn((_req, res) => res.status(200).json({})),
}));

// Route-level guard shims (RBAC / PHI / upload / validators pass through).
const passThrough = (_req, _res, next) => next();
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => passThrough,
  patientAccessGuardForResource: () => passThrough,
}));
jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: () => passThrough,
}));
jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  rejectMobileClinicalWrite: passThrough,
}));
jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  upload: { single: () => passThrough },
  validateFileContent: passThrough,
  validatePatientUpload: passThrough,
}));
jest.unstable_mockModule('../../validators/sharedValidators.js', () => ({
  paramId: () => passThrough,
}));
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: {
    PATIENT_APPOINTMENT_VIEW: 'PATIENT_APPOINTMENT_VIEW',
    PATIENT_APPOINTMENT_WRITE: 'PATIENT_APPOINTMENT_WRITE',
    PATIENT_RECORD_VIEW: 'PATIENT_RECORD_VIEW',
    PATIENT_RECORD_UPLOAD: 'PATIENT_RECORD_UPLOAD',
    PATIENT_RECORD_EXTRACTION_VIEW: 'PATIENT_RECORD_EXTRACTION_VIEW',
    PATIENT_RECORD_EXTRACTION_REVIEW: 'PATIENT_RECORD_EXTRACTION_REVIEW',
    PATIENT_RECORD_DELETE: 'PATIENT_RECORD_DELETE',
  },
  authorizePatientAccessRequest: jest.fn(async () => ({ allowed: true })),
  SAFE_PATIENT_ACCESS_DENIAL_MESSAGE: 'Access denied',
}));

// Controller service seams.
jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  computeGestationalAge: jest.fn(() => null),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  currentCanonicalTransactionRevision: jest.fn(async () => 1),
  recordCanonicalClinicalEvent: jest.fn(async () => null),
  recordClinicalAuditEvent: jest.fn(async () => null),
  recordTimelineEvent: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queueAppointmentConfirmationSms: jest.fn(async () => ({ queued: true, outboxId: 1 })),
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorRef: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitAppointmentEvent: jest.fn(),
}));
jest.unstable_mockModule('../../services/appointment/appointmentQueueService.js', () => ({
  ensureAppointmentQueueForAppointment: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/appointment/appointmentTeleconsultStateService.js', () => ({
  attachTeleconsultState: jest.fn(async (rows) => rows),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT_ID,
  getTenantById: jest.fn(async () => ({ id: TENANT_ID, settings: {} })),
  requireTenantId: (req) => req.tenantId,
  resolveTenantOrThrow: (req) => req.tenantId,
}));

const { default: workflowRoutes } = await import('../../routes/appointment/appointmentWorkflowRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = TENANT_ID;
  req.user = { id: 7, uid: '11111111-1111-4111-8111-111111111111', role: 'RECEPTIONIST', name: 'Front Desk' };
  next();
});
app.use('/api/v1/appointments', workflowRoutes);

beforeEach(() => {
  setTenantTxMock.mockReset();
});

describe('appointmentWorkflowController relays AppError code + details over HTTP', () => {
  test('confirm relays an AppError with code and details (409)', async () => {
    setTenantTxMock.mockRejectedValueOnce(AppError.conflict(
      'Cannot confirm a cancelled appointment',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/appointments/123/confirm')
      .send({});

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Cannot confirm a cancelled appointment');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('confirm returns the generic 500 for a non-AppError and never leaks err.message', async () => {
    setTenantTxMock.mockRejectedValueOnce(new Error('deadlock detected on appointments_pkey'));

    const response = await request(app)
      .post('/api/v1/appointments/123/confirm')
      .send({});

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to confirm appointment');
    expect(response.body.message).not.toMatch(/deadlock/);
  });

  test('a bare statusCode error (file-local Not Found shape) relays byte-identically with no code key', async () => {
    setTenantTxMock.mockRejectedValueOnce(Object.assign(
      new Error('Appointment not found'),
      { statusCode: 404 },
    ));

    const response = await request(app)
      .post('/api/v1/appointments/123/confirm')
      .send({});

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toBe('Appointment not found');
    expect(response.body).not.toHaveProperty('code');
    expect(response.body).not.toHaveProperty('details');
  });

  test('cancel keeps its own generic label (Failed) for non-AppError rejections', async () => {
    setTenantTxMock.mockRejectedValueOnce(new Error('tx aborted: internal cursor state'));

    const response = await request(app)
      .post('/api/v1/appointments/123/cancel')
      .send({});

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed');
    expect(response.body.message).not.toMatch(/cursor/);
  });
});
