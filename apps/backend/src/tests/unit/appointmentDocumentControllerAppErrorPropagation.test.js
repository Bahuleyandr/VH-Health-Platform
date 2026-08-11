import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of
// appointmentDocumentController.js (sites: getPatientAllRecords,
// uploadPatientRecord, getPatientRecordExtraction,
// processPatientRecordExtraction, reviewPatientRecordExtraction). Driven over
// HTTP through the real appointmentWorkflowRoutes module, mirroring
// paediatricImmunisationRoutesAppErrorPropagation.test.js.
//
// The two extraction reads keep a site-local isMissingSchemaError middle
// branch (42P01 -> friendly 404) between the operational relay and the
// generic tail — pinned below so the port cannot drop it.

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenantTx: jest.fn(),
}));

// Sibling controllers mounted by the same routes file — not under test.
jest.unstable_mockModule('../../controllers/appointment/appointmentWorkflowController.js', () => ({
  getTodayQueue: jest.fn((_req, res) => res.status(200).json({})),
  getPendingAppointments: jest.fn((_req, res) => res.status(200).json({})),
  getDoctorOptions: jest.fn((_req, res) => res.status(200).json({})),
  getAvailableSlots: jest.fn((_req, res) => res.status(200).json({})),
  registerWalkIn: jest.fn((_req, res) => res.status(200).json({})),
  confirmAppointment: jest.fn((_req, res) => res.status(200).json({})),
  markNoShow: jest.fn((_req, res) => res.status(200).json({})),
  rescheduleAppointment: jest.fn((_req, res) => res.status(200).json({})),
  completeAppointment: jest.fn((_req, res) => res.status(200).json({})),
  cancelAppointment: jest.fn((_req, res) => res.status(200).json({})),
  adviseForAdmission: jest.fn((_req, res) => res.status(200).json({})),
  getAppointmentHistory: jest.fn((_req, res) => res.status(200).json({})),
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

jest.unstable_mockModule('../../services/ai/documentIntelligenceService.js', () => ({
  decideClinicalDocumentIntake: jest.fn(async () => ({})),
  ingestClinicalDocumentUpload: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT_ID,
  resolveTenantOrThrow: () => TENANT_ID,
  requireTenantId: (req) => req.tenantId,
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(async () => null),
  getSignedFileUrl: jest.fn(async () => null),
  getFileFromR2: jest.fn(async () => Buffer.from('')),
  deleteObject: jest.fn(async () => null),
}));

const { default: workflowRoutes } = await import('../../routes/appointment/appointmentWorkflowRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = TENANT_ID;
  req.user = { id: 7, uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/appointments', workflowRoutes);

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
});

describe('appointmentDocumentController relays AppError code + details over HTTP', () => {
  test('extraction review relays an AppError with code and details (409)', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(AppError.conflict(
      'Extraction draft already reviewed',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .patch('/api/v1/appointments/patient/records/12/extraction-review')
      .send({ decision: 'approved' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Extraction draft already reviewed');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('extraction review returns the generic 500 for a non-AppError and never leaks err.message', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(
      new Error('connection to server at 10.0.0.5 refused'),
    );

    const response = await request(app)
      .patch('/api/v1/appointments/patient/records/12/extraction-review')
      .send({ decision: 'approved' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to review extraction');
    expect(response.body.message).not.toMatch(/10\.0\.0\.5/);
  });

  test('the preserved isMissingSchemaError branch still maps 42P01 to the friendly 404', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(Object.assign(
      new Error('relation "clinical_document_intake" does not exist'),
      { meta: { code: '42P01' } },
    ));

    const response = await request(app)
      .get('/api/v1/appointments/patient/records/12/extraction');

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toBe('Extraction draft not found for this record');
    expect(response.body).not.toHaveProperty('code');
  });

  test('record delete relays the scoped-lookup miss as 404, not 500', async () => {
    // findPatientRecordWithExtraction returns no rows -> statusCode-404 Error;
    // deletePatientRecord must relay it instead of the old blanket 500.
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const response = await request(app)
      .delete('/api/v1/appointments/patient/records/999999');

    expect(response.statusCode).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Record not found');
  });

  test('record delete relays a malformed id as 400, not 500', async () => {
    const response = await request(app)
      .delete('/api/v1/appointments/patient/records/not-a-number');

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toBe('Invalid record id');
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('records list relays a bare statusCode error byte-identically with no code key', async () => {
    // Staff caller with no patient identifier — the controller's own
    // 400-with-statusCode Error shape, relayed unchanged.
    const response = await request(app)
      .get('/api/v1/appointments/patient/records/all');

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toBe('patient_id, patient_uid, or patient_phone is required');
    expect(response.body).not.toHaveProperty('code');
    expect(response.body).not.toHaveProperty('details');
  });
});
