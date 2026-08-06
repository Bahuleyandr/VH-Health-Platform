import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const publishOpChildResourceLinkedTxMock = jest.fn();
const recordAppointmentCreatedEvidenceTxMock = jest.fn();
const publishEventMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
// createFollowUp now emits a canonical timeline + audit event atomically on the
// caller transaction. Stub it so the real writer does not run against the tx's
// $queryRawUnsafe mock and throw CANONICAL_TIMELINE_REQUIRED.
jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({
    recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  }),
);
jest.unstable_mockModule(
  '../../services/appointment/opChildResourceEventService.js',
  () => ({
    publishOpChildResourceLinkedTx: publishOpChildResourceLinkedTxMock,
  }),
);
jest.unstable_mockModule(
  '../../services/appointment/appointmentLifecycleService.js',
  () => ({
    recordAppointmentCreatedEvidenceTx: recordAppointmentCreatedEvidenceTxMock,
  }),
);
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId,
}));

const { createFollowUp } = await import(
  '../../services/carePlan/carePlanService.js'
);

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '30000000-0000-4000-8000-000000000001';
const ACTOR_UID = '40000000-0000-4000-8000-000000000001';

beforeEach(() => {
  setTenantTxMock.mockReset();
  publishOpChildResourceLinkedTxMock.mockReset();
  recordAppointmentCreatedEvidenceTxMock.mockReset();
  publishEventMock.mockReset();
  recordCanonicalClinicalEventMock.mockReset().mockResolvedValue({
    timeline: { id: 1 },
    audit: { id: 1 },
  });
});

test('bookAppointment=false records the plan on the caller transaction without nesting', async () => {
  const followUp = {
    id: 91,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    status: 'open',
    appointment_status: 'pending',
  };
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValueOnce([followUp]),
  };

  await expect(createFollowUp({
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    originKind: 'consultation',
    originResourceType: 'e_prescription',
    originResourceId: '51',
    doctorUid: DOCTOR_UID,
    dueAt: '2026-08-01',
    reason: 'Review prescription',
    metadata: {
      prescription_id: 51,
      due_precision: 'date',
      appointment_slot_required: true,
    },
    createdBy: ACTOR_UID,
    bookAppointment: false,
    tx,
  })).resolves.toBe(followUp);

  expect(setTenantTxMock).not.toHaveBeenCalled();
  expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('INSERT INTO follow_up_plans');
  expect(tx.$queryRawUnsafe.mock.calls[0]).toContain('e_prescription');
  expect(tx.$queryRawUnsafe.mock.calls[0]).toContain('51');
  expect(tx.$queryRawUnsafe.mock.calls[0]).toContain('2026-08-01T00:00:00.000Z');
  expect(recordAppointmentCreatedEvidenceTxMock).not.toHaveBeenCalled();
});

test('appointment-origin follow-up evidence and outbox use the same caller transaction', async () => {
  const followUp = {
    id: 92,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    status: 'open',
    appointment_status: 'pending',
  };
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValueOnce([followUp]),
  };
  publishOpChildResourceLinkedTxMock.mockResolvedValueOnce({
    linked: { appointment_uid: '50000000-0000-4000-8000-000000000001' },
  });
  publishEventMock.mockResolvedValueOnce({ id: 801 });

  await expect(createFollowUp({
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    originKind: 'consultation',
    originResourceType: 'appointment',
    originResourceId: '71',
    doctorUid: DOCTOR_UID,
    dueAt: '2026-08-01',
    createdBy: ACTOR_UID,
    bookAppointment: false,
    tx,
  })).resolves.toBe(followUp);

  expect(publishOpChildResourceLinkedTxMock).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      tenantId: TENANT_ID,
      appointmentId: 71,
      patientUid: PATIENT_UID,
      resourceType: 'follow_up_plan',
      resourceId: 92,
    }),
  );
  expect(publishEventMock).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: 'appointment.follow_up_recorded',
      aggregateId: '71',
      patientUid: PATIENT_UID,
      tx,
      tenantId: TENANT_ID,
    }),
  );
  expect(setTenantTxMock).not.toHaveBeenCalled();
});

test('missing appointment follow-up outbox evidence rejects the caller transaction', async () => {
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
      id: 93,
      tenant_id: TENANT_ID,
      patient_uid: PATIENT_UID,
    }]),
  };
  publishOpChildResourceLinkedTxMock.mockResolvedValueOnce({
    linked: { appointment_uid: '50000000-0000-4000-8000-000000000001' },
  });
  publishEventMock.mockResolvedValueOnce(null);

  await expect(createFollowUp({
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    originKind: 'consultation',
    originResourceType: 'appointment',
    originResourceId: '71',
    doctorUid: DOCTOR_UID,
    dueAt: '2026-08-01',
    createdBy: ACTOR_UID,
    bookAppointment: false,
    tx,
  })).rejects.toMatchObject({
    code: 'APPOINTMENT_FOLLOW_UP_OUTBOX_REQUIRED',
  });
  expect(setTenantTxMock).not.toHaveBeenCalled();
});

test('missing follow-up insert result rejects before child evidence is published', async () => {
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValueOnce([]),
  };

  await expect(createFollowUp({
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    originKind: 'consultation',
    originResourceType: 'appointment',
    originResourceId: '71',
    doctorUid: DOCTOR_UID,
    dueAt: '2026-08-01',
    createdBy: ACTOR_UID,
    bookAppointment: false,
    tx,
  })).rejects.toMatchObject({
    code: 'FOLLOW_UP_PLAN_REQUIRED',
  });
  expect(publishOpChildResourceLinkedTxMock).not.toHaveBeenCalled();
  expect(publishEventMock).not.toHaveBeenCalled();
  expect(setTenantTxMock).not.toHaveBeenCalled();
});
