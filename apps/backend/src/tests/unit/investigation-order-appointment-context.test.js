import { jest } from '@jest/globals';

const prismaMock = {
  users: {
    findFirst: jest.fn(),
  },
  appointments: {
    findFirst: jest.fn(),
  },
  investigations: {
    create: jest.fn(),
  },
  notifications: {
    create: jest.fn(),
  },
  $queryRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

const recordCanonicalClinicalEventMock = jest.fn();
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const publishOpChildResourceLinkedTxMock = jest.fn();
jest.unstable_mockModule('../../services/appointment/opChildResourceEventService.js', () => ({
  publishOpChildResourceLinkedTx: publishOpChildResourceLinkedTxMock,
}));

jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  publishInpatientDiagnosticResourceLinkedTx: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { createInvestigationOrder } = await import(
  '../../services/investigation/orderService.js'
);

const DOCTOR_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.users.findFirst.mockResolvedValue({
    id: 17,
    uid: PATIENT_UID,
    name: 'OP Investigation Patient',
    phone: '+911234567890',
    tenant_id: TENANT_ID,
  });
  prismaMock.appointments.findFirst.mockResolvedValue({
    id: 44,
    patient_id: 17,
    doctor_id: 9,
    status: 'CONFIRMED',
  });
  prismaMock.$queryRawUnsafe.mockResolvedValue([]);
  prismaMock.investigations.create.mockImplementation(async ({ data }) => ({
    id: 101,
    uid: '33333333-3333-4333-8333-333333333333',
    requested_at: data.updated_at,
    ...data,
  }));
  prismaMock.notifications.create.mockResolvedValue({ id: 1 });
  recordCanonicalClinicalEventMock.mockResolvedValue({
    timeline: { id: 'timeline-1' },
    audit: { id: 'audit-1' },
  });
});

describe('createInvestigationOrder appointment context', () => {
  it('persists appointment_id for OP visit-scoped investigation orders', async () => {
    const result = await createInvestigationOrder({
      patient_id: 17,
      appointment_id: 44,
      doctor_uid: DOCTOR_UID,
      test_name: 'ECG',
      type: 'CARDIOLOGY',
      tenantId: TENANT_ID,
    });

    expect(prismaMock.appointments.findFirst).toHaveBeenCalledWith({
      where: { id: 44, tenant_id: TENANT_ID },
      select: { id: true, patient_id: true, doctor_id: true, status: true },
    });
    expect(prismaMock.investigations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          patient_id: 17,
          patient_uid: PATIENT_UID,
          appointment_id: 44,
          test_name: 'ECG',
          test_type: 'CARDIOLOGY',
          requested_by: DOCTOR_UID,
        }),
      }),
    );
    expect(result.investigation.appointment_id).toBe(44);
    expect(publishOpChildResourceLinkedTxMock).toHaveBeenCalledWith(prismaMock, {
      tenantId: TENANT_ID,
      appointmentId: 44,
      patientUid: PATIENT_UID,
      resourceType: 'investigation',
      resourceId: 101,
      source: 'investigations.create',
    });
  });

  it('rejects invalid appointment ids before touching appointment rows', async () => {
    await expect(createInvestigationOrder({
      patient_id: 17,
      appointment_id: 'not-a-number',
      doctor_uid: DOCTOR_UID,
      test_name: 'ECG',
      type: 'CARDIOLOGY',
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      message: 'INVALID_APPOINTMENT_ID',
      statusCode: 400,
      code: 'INVALID_APPOINTMENT_ID',
    });

    expect(prismaMock.appointments.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.investigations.create).not.toHaveBeenCalled();
  });

  it('rejects appointment ids that belong to a different patient', async () => {
    prismaMock.appointments.findFirst.mockResolvedValueOnce({
      id: 44,
      patient_id: 999,
      doctor_id: 9,
      status: 'CONFIRMED',
    });

    await expect(createInvestigationOrder({
      patient_id: 17,
      appointment_id: 44,
      doctor_uid: DOCTOR_UID,
      test_name: 'ECG',
      type: 'CARDIOLOGY',
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      message: 'APPOINTMENT_PATIENT_MISMATCH',
      statusCode: 400,
      code: 'APPOINTMENT_PATIENT_MISMATCH',
    });

    expect(prismaMock.investigations.create).not.toHaveBeenCalled();
  });

  it('rejects the investigation transaction when canonical persistence returns null', async () => {
    recordCanonicalClinicalEventMock.mockResolvedValueOnce({ timeline: null, audit: null });

    await expect(createInvestigationOrder({
      patient_id: 17,
      appointment_id: 44,
      doctor_uid: DOCTOR_UID,
      test_name: 'ECG',
      type: 'CARDIOLOGY',
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'INVESTIGATION_CANONICAL_EVENT_REQUIRED' });
  });
});
