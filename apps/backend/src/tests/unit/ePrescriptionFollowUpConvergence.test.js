import { jest } from '@jest/globals';
import { AppError } from '../../utils/AppError.js';

const prismaQueryMock = jest.fn();
const prismaExecuteMock = jest.fn();
const setTenantTxMock = jest.fn();
const txQueryMock = jest.fn();
const validatePrescriptionSafetyMock = jest.fn();
const createFollowUpMock = jest.fn();
const publishOpChildResourceLinkedTxMock = jest.fn();
const ensureEncounterForAppointmentMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const recordMedicationSafetyReviewsMock = jest.fn();

const tx = {
  $queryRawUnsafe: txQueryMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: prismaQueryMock,
    $executeRawUnsafe: prismaExecuteMock,
  },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: validatePrescriptionSafetyMock,
}));
jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  enrichMedicationsWithComposition: jest.fn(async (_tenantId, medications) => medications),
  resolveCompositionIdentitiesByCatalogIds: jest.fn(async () => new Map()),
}));
jest.unstable_mockModule('../../services/pharmacy/compositionSubstitutionAudit.js', () => ({
  recordBrandSubstitutionAudit: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ensureEncounterForAppointment: ensureEncounterForAppointmentMock,
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordMedicationSafetyReviews: recordMedicationSafetyReviewsMock,
}));
jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  maybePropagateAncSupplements: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/patient/medicationReminderService.js', () => ({
  createPrescriptionReminders: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../services/carePlan/carePlanService.js', () => ({
  createFollowUp: createFollowUpMock,
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(async () => null),
  getSignedFileUrl: jest.fn(async () => 'https://example.invalid/file'),
}));
jest.unstable_mockModule('../../services/prescription/prescriptionPdfHelper.js', () => ({
  formatTemperatureForDisplay: jest.fn(value => value),
  generatePrescriptionPDFBuffer: jest.fn(async () => Buffer.alloc(0)),
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId,
}));
jest.unstable_mockModule(
  '../../services/appointment/opChildResourceEventService.js',
  () => ({
    publishOpChildResourceLinkedTx: publishOpChildResourceLinkedTxMock,
  }),
);
jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  assertPrivilegeForGate: jest.fn(async () => null),
  isGateEnabled: jest.fn(async () => false),
}));

const { createPrescription } = await import(
  '../../controllers/prescription/ePrescriptionController.js'
);

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '30000000-0000-4000-8000-000000000001';
const APPOINTMENT_UID = '40000000-0000-4000-8000-000000000001';
const PATIENT_ID = 21;
const DOCTOR_ID = 31;

function makeRequest(overrides = {}) {
  return {
    id: 'request-id',
    tenantId: TENANT_ID,
    user: {
      id: DOCTOR_ID,
      uid: DOCTOR_UID,
      role: 'DOCTOR',
      tenant_id: TENANT_ID,
    },
    body: {
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      diagnosis: 'Review medication response',
      medications: [{ name: 'Paracetamol', dose: '500 mg' }],
      follow_up_date: '2026-08-01',
      follow_up_notes: 'Review symptoms',
      ...overrides,
    },
  };
}

function makeResponse(req) {
  return {
    req,
    statusCode: null,
    body: null,
    status: jest.fn(function setStatus(statusCode) {
      this.statusCode = statusCode;
      return this;
    }),
    json: jest.fn(function sendJson(body) {
      this.body = body;
      return this;
    }),
  };
}

function savedPrescription(overrides = {}) {
  return {
    id: 51,
    appointment_id: null,
    patient_id: PATIENT_ID,
    doctor_id: DOCTOR_ID,
    patient_uid: PATIENT_UID,
    doctor_uid: DOCTOR_UID,
    medications: [{ name: 'Paracetamol', dose: '500 mg' }],
    status: 'active',
    lifecycle_status: 'draft',
    revision: 1,
    prescription_number: 'RX-TEST-51',
    tenant_id: TENANT_ID,
    ...overrides,
  };
}

beforeEach(() => {
  prismaQueryMock.mockReset();
  prismaExecuteMock.mockReset();
  setTenantTxMock.mockReset();
  txQueryMock.mockReset();
  validatePrescriptionSafetyMock.mockReset();
  createFollowUpMock.mockReset();
  publishOpChildResourceLinkedTxMock.mockReset();
  ensureEncounterForAppointmentMock.mockReset();
  recordCanonicalClinicalEventMock.mockReset();
  recordMedicationSafetyReviewsMock.mockReset();

  validatePrescriptionSafetyMock.mockResolvedValue({
    safe: true,
    blockers: [],
    warnings: [],
    reviews: [],
  });
  prismaQueryMock.mockImplementation(async (sql) => {
    if (/role = 'PATIENT'/.test(sql)) {
      return [{
        id: PATIENT_ID,
        uid: PATIENT_UID,
        name: 'Patient One',
        phone: '+919876543210',
      }];
    }
    if (/u\.role = 'DOCTOR'/.test(sql)) {
      return [{
        id: DOCTOR_ID,
        uid: DOCTOR_UID,
        name: 'Doctor One',
        phone: '+919876543211',
        specialization: 'General Medicine',
      }];
    }
    return [];
  });
  txQueryMock.mockImplementation(async (sql) => {
    if (/FROM users AS prescription_patient_identity/.test(sql)) {
      return [{ id: PATIENT_ID }];
    }
    if (/FROM users AS prescription_doctor_identity/.test(sql)) {
      return [{ id: DOCTOR_ID }];
    }
    if (/FROM appointments AS prescription_source_appointment/.test(sql)) {
      return [{ id: 71 }];
    }
    if (/FROM admissions AS prescription_source_admission/.test(sql)) {
      return [{ id: 91 }];
    }
    if (/INSERT INTO e_prescriptions/.test(sql)) return [savedPrescription()];
    return [];
  });
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
  createFollowUpMock.mockResolvedValue({ id: 81, status: 'open' });
  ensureEncounterForAppointmentMock.mockResolvedValue(null);
  recordCanonicalClinicalEventMock.mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } });
  recordMedicationSafetyReviewsMock.mockResolvedValue([]);
  publishOpChildResourceLinkedTxMock.mockResolvedValue({
    linked: { appointment_uid: APPOINTMENT_UID },
  });
});

test('date-only prescription follow-up becomes durable plan work on the same transaction', async () => {
  const req = makeRequest();
  const res = makeResponse(req);

  await createPrescription(req, res);

  expect(res.statusCode).toBe(201);
  expect(setTenantTxMock).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
  expect(createFollowUpMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    doctorUid: DOCTOR_UID,
    originKind: 'consultation',
    originResourceType: 'e_prescription',
    originResourceId: '51',
    dueAt: '2026-08-01',
    bookAppointment: false,
    tx,
    metadata: expect.objectContaining({
      prescription_id: 51,
      due_precision: 'date',
      appointment_slot_required: true,
    }),
  }));
  const everySql = [
    ...prismaQueryMock.mock.calls,
    ...txQueryMock.mock.calls,
  ].map(call => String(call[0]));
  expect(everySql.some(sql => /INSERT INTO appointments/i.test(sql))).toBe(false);
  expect(prismaExecuteMock).not.toHaveBeenCalled();
});

test('source appointment and user identity probes are exact-tenant before follow-up work', async () => {
  prismaQueryMock.mockImplementation(async (sql) => {
    if (/FROM appointments/.test(sql)) return [{ id: 71 }];
    if (/FROM e_prescriptions/.test(sql)) return [];
    if (/role = 'PATIENT'/.test(sql)) {
      return [{
        id: PATIENT_ID,
        uid: PATIENT_UID,
        name: 'Patient One',
        phone: '+919876543210',
      }];
    }
    if (/u\.role = 'DOCTOR'/.test(sql)) {
      return [{
        id: DOCTOR_ID,
        uid: DOCTOR_UID,
        name: 'Doctor One',
        phone: '+919876543211',
      }];
    }
    return [];
  });
  txQueryMock.mockImplementation(async (sql) => {
    if (/FROM users AS prescription_patient_identity/.test(sql)) {
      return [{ id: PATIENT_ID }];
    }
    if (/FROM users AS prescription_doctor_identity/.test(sql)) {
      return [{ id: DOCTOR_ID }];
    }
    if (/FROM appointments AS prescription_source_appointment/.test(sql)) {
      return [{ id: 71 }];
    }
    if (/INSERT INTO e_prescriptions/.test(sql)) {
      return [savedPrescription({ appointment_id: 71 })];
    }
    return [];
  });
  ensureEncounterForAppointmentMock.mockResolvedValueOnce({ id: 61 });
  const req = makeRequest({ appointment_id: 71 });
  const res = makeResponse(req);

  await createPrescription(req, res);

  expect(res.statusCode).toBe(201);
  const appointmentProbe = prismaQueryMock.mock.calls.find(
    call => /FROM appointments/.test(call[0]),
  );
  expect(appointmentProbe[0]).toContain('tenant_id = $2::uuid');
  expect(appointmentProbe.slice(1)).toEqual([
    71,
    TENANT_ID,
    PATIENT_ID,
    DOCTOR_ID,
  ]);
  const patientProbe = prismaQueryMock.mock.calls.find(
    call => /role = 'PATIENT'/.test(call[0]),
  );
  const doctorProbe = prismaQueryMock.mock.calls.find(
    call => /u\.role = 'DOCTOR'/.test(call[0]),
  );
  expect(patientProbe.slice(1)).toEqual([PATIENT_ID, TENANT_ID]);
  expect(doctorProbe.slice(1)).toEqual([DOCTOR_ID, TENANT_ID]);
  expect(createFollowUpMock).toHaveBeenCalledWith(expect.objectContaining({
    originResourceType: 'appointment',
    originResourceId: '71',
    encounterId: 61,
    tx,
  }));
  const lockedAppointmentProbe = txQueryMock.mock.calls.find(
    call => /FROM appointments AS prescription_source_appointment/.test(call[0]),
  );
  expect(lockedAppointmentProbe.slice(1)).toEqual([
    TENANT_ID,
    71,
    PATIENT_ID,
    DOCTOR_ID,
  ]);
});

test('follow-up write failure is relayed and cannot be silently swallowed after prescription insert', async () => {
  createFollowUpMock.mockRejectedValueOnce(AppError.conflict(
    'Follow-up work could not be recorded',
    'PRESCRIPTION_FOLLOW_UP_UNAVAILABLE',
  ));
  const req = makeRequest();
  const res = makeResponse(req);

  await createPrescription(req, res);

  expect(res.statusCode).toBe(409);
  expect(res.body).toMatchObject({
    success: false,
    code: 'PRESCRIPTION_FOLLOW_UP_UNAVAILABLE',
  });
  expect(createFollowUpMock).toHaveBeenCalledWith(expect.objectContaining({ tx }));
  expect(prismaQueryMock.mock.calls.some(call => /UPDATE e_prescriptions/.test(call[0]))).toBe(false);
});

test('transaction-time identity drift fails before prescription or follow-up mutation', async () => {
  txQueryMock.mockImplementation(async (sql) => {
    if (/FROM users AS prescription_patient_identity/.test(sql)) {
      return [{ id: PATIENT_ID }];
    }
    if (/FROM users AS prescription_doctor_identity/.test(sql)) {
      return [];
    }
    if (/INSERT INTO e_prescriptions/.test(sql)) {
      return [savedPrescription()];
    }
    return [];
  });
  const req = makeRequest();
  const res = makeResponse(req);

  await createPrescription(req, res);

  expect(res.statusCode).toBe(409);
  expect(res.body).toMatchObject({
    success: false,
    code: 'PRESCRIPTION_IDENTITY_CONTEXT_CHANGED',
  });
  expect(
    txQueryMock.mock.calls.some(call => /INSERT INTO e_prescriptions/.test(call[0])),
  ).toBe(false);
  expect(createFollowUpMock).not.toHaveBeenCalled();
});
