import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Controller-layer contract regression — ePrescriptionController member of
// the relayAppError sweep, driven over HTTP through the REAL
// routes/prescription/index.js mount (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// Three catch sites used `err.details ?? { code: err.code }` (the R3
// family): create / update / sign. err.code was dropped whenever details
// existed and otherwise nested under `details.code`. All three now relay via
// responseHelper.relayAppError; the create site keeps its bespoke rich
// non-operational logging tail (err.code / err.meta / err.stack).

const prismaQueryMock = jest.fn();
const validatePrescriptionSafetyMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQueryMock },
  setTenantTx: jest.fn(),
}));

jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: validatePrescriptionSafetyMock,
}));
jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  enrichMedicationsWithComposition: jest.fn(async (_tenantId, meds) => meds),
  resolveCompositionIdentitiesByCatalogIds: jest.fn(async () => new Map()),
}));
jest.unstable_mockModule('../../services/pharmacy/compositionSubstitutionAudit.js', () => ({
  recordBrandSubstitutionAudit: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ensureEncounterForAppointment: jest.fn(async () => null),
  recordCanonicalClinicalEvent: jest.fn(async () => ({})),
  recordMedicationSafetyReviews: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  maybePropagateAncSupplements: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../services/patient/medicationReminderService.js', () => ({
  createPrescriptionReminders: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(async () => 'key'),
  getSignedFileUrl: jest.fn(async () => 'https://r2.example/key'),
}));
jest.unstable_mockModule('../../services/prescription/prescriptionPdfHelper.js', () => ({
  formatTemperatureForDisplay: jest.fn((v) => v),
  generatePrescriptionPDFBuffer: jest.fn(async () => Buffer.alloc(0)),
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (t) => t || '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));
jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  assertPrivilegeForGate: jest.fn(async () => {}),
  isGateEnabled: jest.fn(async () => false),
}));

// Sibling controller mounted by the same routes file.
jest.unstable_mockModule('../../controllers/pharmacy/pharmacyOrderController.js', () => ({
  getCatalog: jest.fn((_req, res) => res.status(200).json({})),
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
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
  default: { requireIdempotencyKey: () => (_req, _res, next) => next() },
}));
jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  rejectMobileClinicalWrite: (_req, _res, next) => next(),
  default: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  validateFileContent: (_req, _res, next) => next(),
}));

const { default: prescriptionRoutes } = await import('../../routes/prescription/index.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { id: 7, uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/prescriptions', prescriptionRoutes);

beforeEach(() => {
  prismaQueryMock.mockReset();
  validatePrescriptionSafetyMock.mockReset();
});

describe('updatePrescription catch relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    prismaQueryMock.mockRejectedValueOnce(AppError.conflict(
      'Prescription is locked by a concurrent edit',
      'PRESCRIPTION_EDIT_LOCKED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .put('/api/v1/prescriptions/12')
      .send({ medications: [{ name: 'Paracetamol' }] });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Prescription is locked by a concurrent edit');
    expect(response.body.code).toBe('PRESCRIPTION_EDIT_LOCKED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    prismaQueryMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'medication_rows')"),
    );

    const response = await request(app)
      .put('/api/v1/prescriptions/12')
      .send({ medications: [{ name: 'Paracetamol' }] });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to update prescription');
    expect(response.body.message).not.toMatch(/medication_rows/);
  });
});

describe('signPrescription catch relays AppError code + details', () => {
  test('AppError code reaches the envelope root (no details key when absent)', async () => {
    prismaQueryMock.mockRejectedValueOnce(AppError.conflict(
      'Prescription state changed before it could be signed',
      'PRESCRIPTION_STATE_CHANGED',
    ));

    const response = await request(app).post('/api/v1/prescriptions/12/sign').send({});

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('PRESCRIPTION_STATE_CHANGED');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError returns the site generic 500', async () => {
    prismaQueryMock.mockRejectedValueOnce(
      new Error("Cannot read properties of null (reading 'lifecycle_status')"),
    );

    const response = await request(app).post('/api/v1/prescriptions/12/sign').send({});

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to sign prescription');
    expect(response.body.message).not.toMatch(/lifecycle_status/);
  });
});

describe('createPrescription catch relays operational errors, keeps rich 500 tail', () => {
  const createBody = {
    patient_id: 1,
    doctor_id: 2,
    medications: [{ name: 'Paracetamol', dose: '500 mg' }],
  };

  test('AppError code + details reach the envelope root / details key', async () => {
    validatePrescriptionSafetyMock.mockRejectedValueOnce(AppError.conflict(
      'Safety check backend is mid-migration',
      'CDS_BACKEND_UNAVAILABLE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/prescriptions/create')
      .send(createBody);

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('CDS_BACKEND_UNAVAILABLE');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    validatePrescriptionSafetyMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'allergy_rows')"),
    );

    const response = await request(app)
      .post('/api/v1/prescriptions/create')
      .send(createBody);

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to create prescription');
    expect(response.body.message).not.toMatch(/allergy_rows/);
  });
});
