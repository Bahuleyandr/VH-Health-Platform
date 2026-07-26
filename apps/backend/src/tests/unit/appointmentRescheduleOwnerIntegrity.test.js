import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const DOCTOR_A_UID = '30000000-0000-4000-8000-000000000001';
const DOCTOR_B_UID = '40000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '50000000-0000-4000-8000-000000000001';

const resolveDoctorRefMock = jest.fn();
const transitionAppointmentMock = jest.fn();
const ensureQueueMock = jest.fn();
const populateCareTeamMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.unstable_mockModule(
  '../../controllers/appointment/appointmentWorkflowController.js',
  () => ({
    composeVisitNo: jest.fn(),
    deptPrefix: jest.fn(),
  }),
);
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: value => value,
}));
jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorRef: resolveDoctorRefMock,
}));
jest.unstable_mockModule(
  '../../services/appointment/appointmentQueueService.js',
  () => ({
    ensureAppointmentQueueForAppointment: ensureQueueMock,
  }),
);
jest.unstable_mockModule(
  '../../services/security/careTeamPopulationService.js',
  () => ({
    populateAppointmentCareTeam: populateCareTeamMock,
  }),
);
jest.unstable_mockModule(
  '../../services/appointment/appointmentLifecycleService.js',
  () => ({
    recordAppointmentCreatedEvidenceTx: jest.fn(),
    transitionAppointment: transitionAppointmentMock,
  }),
);

const { default: appointmentService } = await import(
  '../../services/appointment/appointmentService.js'
);

function currentAppointment() {
  return {
    id: 71,
    tenant_id: TENANT_ID,
    patient_id: 81,
    patient_uid: PATIENT_UID,
    doctor_id: 91,
    doctor_uid: DOCTOR_A_UID,
    doctor_name: 'Dr A',
    department: 'General Medicine',
    appointment_date: '2026-07-23',
    appointment_time: '10:00',
    status: 'SCHEDULED',
  };
}

function installTransition(tx) {
  transitionAppointmentMock.mockImplementationOnce(async (input) => {
    const current = currentAppointment();
    const mutation = await input.mutate({
      tx,
      current,
      mode: 'active',
      pathwayWork: null,
    });
    return {
      ...mutation,
      previous: current,
      from_status: 'SCHEDULED',
      to_status: 'SCHEDULED',
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  ensureQueueMock.mockResolvedValue(null);
  populateCareTeamMock.mockResolvedValue(null);
});

test('rejects a doctor-changing same-row reschedule when the exact OP pathway exists', async () => {
  resolveDoctorRefMock.mockResolvedValue({
    id: 92,
    uid: DOCTOR_B_UID,
    name: 'Dr B',
    department: 'General Medicine',
  });
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM care_pathway_instances')) {
      return [{ id: PATHWAY_ID, owning_clinician_uid: DOCTOR_A_UID }];
    }
    throw new Error(`Unexpected SQL after owner guard: ${sql}`);
  });
  installTransition({ $queryRawUnsafe: query });

  await expect(
    appointmentService.rescheduleAppointmentInPlace(
      71,
      {
        appointment_date: '2026-07-24',
        appointment_time: '11:00',
        doctor_id: 92,
      },
      {
        tenantId: TENANT_ID,
        actorUid: DOCTOR_A_UID,
        actorId: 91,
        actorRole: 'DOCTOR',
      },
    ),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'APPOINTMENT_RESCHEDULE_OWNER_CHANGE_REQUIRES_HANDOFF',
  });

  const [sql, ...params] = query.mock.calls[0];
  expect(sql).toContain("pathway_key = 'op_contact_to_recovery'");
  expect(sql).toContain("source_episode_type = 'appointment'");
  expect(sql).toContain("clinical_status IN ('planned', 'active', 'on_hold')");
  expect(params).toEqual([TENANT_ID, PATIENT_UID, 71]);
  expect(ensureQueueMock).not.toHaveBeenCalled();
  expect(populateCareTeamMock).not.toHaveBeenCalled();
});

test('preserves a same-doctor same-row retry without consulting or changing pathway ownership', async () => {
  resolveDoctorRefMock.mockResolvedValue({
    id: 91,
    uid: DOCTOR_A_UID,
    name: 'Dr A',
    department: 'General Medicine',
  });
  const updated = {
    ...currentAppointment(),
    appointment_date: '2026-07-23',
    appointment_time: '10:00',
  };
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM care_pathway_instances')) {
      throw new Error('Same-doctor retry must not enter the owner-change guard');
    }
    if (sql.includes('FROM appointments') && sql.includes('appointment_time::time')) {
      return [];
    }
    if (sql.includes('UPDATE appointments')) return [updated];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  installTransition({ $queryRawUnsafe: query });

  const result = await appointmentService.rescheduleAppointmentInPlace(
    71,
    {
      appointment_date: '2026-07-23',
      appointment_time: '10:00',
      doctor_id: 91,
    },
    {
      tenantId: TENANT_ID,
      actorUid: DOCTOR_A_UID,
      actorId: 91,
      actorRole: 'DOCTOR',
    },
  );

  expect(result.appointment).toMatchObject({
    id: 71,
    doctor_id: 91,
    doctor_uid: DOCTOR_A_UID,
    status: 'SCHEDULED',
  });
  expect(
    query.mock.calls.some(([sql]) => sql.includes('FROM care_pathway_instances')),
  ).toBe(false);
  expect(ensureQueueMock).toHaveBeenCalledTimes(1);
});
