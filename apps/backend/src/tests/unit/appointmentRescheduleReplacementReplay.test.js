import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const ACTOR_UID = '30000000-0000-4000-8000-000000000001';
const ORIGINAL_UID = '40000000-0000-4000-8000-000000000001';
const REPLACEMENT_UID = '50000000-0000-4000-8000-000000000001';

const transitionAppointmentMock = jest.fn();
const logAuditMock = jest.fn();
const emitAppointmentEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  computeGestationalAge: jest.fn(),
}));
jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({
    recordCanonicalClinicalEvent: jest.fn(),
  }),
);
jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queueAppointmentConfirmationSms: jest.fn(async () => ({ queued: true, outboxId: 1 })),
}));
jest.unstable_mockModule(
  '../../utils/notifications/sendPushNotification.js',
  () => ({
    sendPushNotification: jest.fn(),
  }),
);
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));
jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorRef: jest.fn(),
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitAppointmentEvent: emitAppointmentEventMock,
}));
jest.unstable_mockModule(
  '../../services/appointment/appointmentQueueService.js',
  () => ({
    ensureAppointmentQueueForAppointment: jest.fn(),
  }),
);
jest.unstable_mockModule(
  '../../services/appointment/appointmentTeleconsultStateService.js',
  () => ({
    attachTeleconsultState: jest.fn(),
  }),
);
jest.unstable_mockModule(
  '../../services/appointment/appointmentLifecycleService.js',
  () => ({
    lockAppointmentForLifecycleTx: jest.fn(),
    recordAppointmentCreatedEvidenceTx: jest.fn(),
    recordAppointmentMutationEvidenceTx: jest.fn(),
    transitionAppointment: transitionAppointmentMock,
  }),
);
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: value => value,
}));

const { rescheduleAppointment } = await import(
  '../../controllers/appointment/appointmentWorkflowController.js'
);

function originalAppointment() {
  return {
    id: 42,
    uid: ORIGINAL_UID,
    tenant_id: TENANT_ID,
    patient_id: 81,
    patient_uid: PATIENT_UID,
    doctor_id: 91,
    doctor_uid: ACTOR_UID,
    appointment_date: '2026-07-23',
    appointment_time: '10:00',
    status: 'RESCHEDULED',
  };
}

function replacementAppointment() {
  return {
    id: 84,
    uid: REPLACEMENT_UID,
    tenant_id: TENANT_ID,
    patient_id: 81,
    doctor_id: 91,
    appointment_date: '2026-07-24',
    appointment_time: '11:00',
    status: 'SCHEDULED',
    parent_appointment_id: 42,
  };
}

function req() {
  return {
    id: 'request-1',
    params: { id: '42' },
    body: {
      appointment_date: '2026-07-24',
      appointment_time: '11:00',
      confirmation_notes: 'Patient requested a later visit',
    },
    tenantId: TENANT_ID,
    user: {
      id: 9,
      uid: ACTOR_UID,
      role: 'RECEPTIONIST',
      tenant_id: TENANT_ID,
    },
  };
}

function res(request) {
  return {
    req: request,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('an exact lost-response retry returns the existing linked replacement without new side effects', async () => {
  const query = jest.fn(async () => [replacementAppointment()]);
  transitionAppointmentMock.mockImplementationOnce(async (input) => {
    const current = originalAppointment();
    const replay = await input.resolveIdempotent({
      tx: { $queryRawUnsafe: query },
      current,
      mode: 'active',
    });
    return {
      appointment: current,
      previous: current,
      from_status: 'RESCHEDULED',
      to_status: 'RESCHEDULED',
      mode: 'active',
      idempotent: true,
      ...replay,
    };
  });
  const request = req();
  const response = res(request);

  await rescheduleAppointment(request, response);

  expect(response.status).toHaveBeenCalledWith(200);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
    success: true,
    data: {
      original: expect.objectContaining({ id: 42, status: 'RESCHEDULED' }),
      appointment: expect.objectContaining({
        id: 84,
        status: 'SCHEDULED',
        parent_appointment_id: 42,
      }),
    },
  }));
  expect(logAuditMock).not.toHaveBeenCalled();
  expect(emitAppointmentEventMock).not.toHaveBeenCalled();
  const [sql, ...params] = query.mock.calls[0];
  expect(sql).toContain('child.parent_appointment_id = $2::integer');
  expect(sql).toContain("history.to_status = 'RESCHEDULED'");
  expect(sql).toContain('history.changed_by IS NOT DISTINCT FROM $6::integer');
  expect(sql).toContain('history.reason = $7::text');
  expect(params).toEqual([
    TENANT_ID,
    42,
    81,
    91,
    '2026-07-24',
    9,
    'Rescheduled to 2026-07-24 11:00: Patient requested a later visit',
    '11:00',
  ]);
});

test('a changed or missing retry target is an explicit 409 and never a replacement dereference 500', async () => {
  transitionAppointmentMock.mockImplementationOnce(async (input) => {
    const current = originalAppointment();
    return input.resolveIdempotent({
      tx: { $queryRawUnsafe: jest.fn(async () => []) },
      current,
      mode: 'active',
    });
  });
  const request = req();
  const response = res(request);

  await rescheduleAppointment(request, response);

  expect(response.status).toHaveBeenCalledWith(409);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
    success: false,
    code: 'APPOINTMENT_RESCHEDULE_RETRY_MISMATCH',
  }));
  expect(logAuditMock).not.toHaveBeenCalled();
  expect(emitAppointmentEventMock).not.toHaveBeenCalled();
});
