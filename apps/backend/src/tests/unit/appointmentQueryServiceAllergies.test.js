import { jest } from '@jest/globals';

const findManyMock = jest.fn();
const countMock = jest.fn();
const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  appointments: {
    count: countMock,
    findMany: findManyMock,
  },
  $queryRawUnsafe: queryUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn() },
}));

const appointmentQueryService = (await import('../../services/appointment/appointmentQueryService.js')).default;

beforeEach(() => {
  countMock.mockReset();
  findManyMock.mockReset();
  queryUnsafeMock.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('appointmentQueryService allergy propagation', () => {
  it('surfaces profile and structured allergies on the doctor appointment queue', async () => {
    const patientUid = 'ba000000-0000-4000-8000-00000000b011';
    findManyMock.mockResolvedValueOnce([
      {
        id: 101,
        appointment_date: new Date('2026-05-20T09:00:00.000Z'),
        appointment_time: '09:00',
        status: 'CONFIRMED',
        reason: 'Acute abdomen',
        notes: null,
        patient_id: 11,
        token_number: '7',
        visit_no: 'OPD-20260520-007',
        visit_type: 'NEW',
        department: 'General Medicine',
        users_appointments_patient_idTousers: {
          id: 11,
          uid: patientUid,
          name: 'Allergy Queue Patient',
          phone: '+919000000011',
          guardian_phone: null,
          email: null,
          allergies: 'Latex',
        },
      },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      {
        patient_id: null,
        patient_uid: patientUid,
        allergy_name: 'Penicillin',
        severity: 'SEVERE',
        reaction: 'Wheeze',
      },
    ]);

    const rows = await appointmentQueryService.getDoctorAppointments(5);

    expect(rows).toHaveLength(1);
    expect(rows[0].has_allergies).toBe(true);
    expect(rows[0].allergy_flag).toBe(true);
    expect(rows[0].allergies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ allergy_name: 'Latex', source: 'profile' }),
        expect.objectContaining({ allergy_name: 'Penicillin', severity: 'SEVERE', source: 'structured' }),
      ]),
    );
  });
});

describe('appointmentQueryService today date handling', () => {
  it('defaults today appointments to the IST calendar date', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-21T20:00:00Z'));
    findManyMock.mockResolvedValueOnce([]);

    const result = await appointmentQueryService.getTodayAppointments('DOCTOR', 7);

    expect(result.date).toBe('2026-05-22');
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(findManyMock.mock.calls[0][0].where).toEqual(expect.objectContaining({
      doctor_id: 7,
      appointment_date: {
        gte: new Date('2026-05-22T00:00:00.000Z'),
        lt: new Date('2026-05-23T00:00:00.000Z'),
      },
    }));
  });
});

describe('appointmentQueryService department flattening', () => {
  it('adds unassigned same-department appointments to doctor-scoped lists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ department: 'Cardiology' }]);
    countMock.mockResolvedValueOnce(1);
    findManyMock.mockResolvedValueOnce([
      {
        id: 401,
        appointment_date: new Date('2026-06-03T10:00:00.000Z'),
        appointment_time: '10:00',
        status: 'SCHEDULED',
        reason: 'Department queue booking',
        notes: null,
        patient_id: 12,
        doctor_id: null,
        phone: '+919000000013',
        patient_name: 'Department Queue Patient',
        doctor_name: '',
        department: 'Cardiology',
        token_number: null,
        visit_no: null,
        advised_for_admission_at: null,
        advised_for_admission_by: null,
        advised_for_admission_note: null,
        created_at: new Date('2026-06-03T09:30:00.000Z'),
        updated_at: new Date('2026-06-03T09:30:00.000Z'),
        users_appointments_patient_idTousers: {
          id: 12,
          uid: 'ba000000-0000-4000-8000-00000000b013',
          name: 'Department Queue Patient',
          phone: '+919000000013',
          guardian_phone: null,
          email: null,
          allergies: null,
        },
        users_appointments_doctor_idTousers: null,
      },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    const result = await appointmentQueryService.getAppointments(
      { date: '2026-06-03' },
      {},
      'DOCTOR',
      22,
    );

    expect(queryUnsafeMock.mock.calls[0][0]).toContain('FROM doctors doc');
    expect(countMock.mock.calls[0][0].where.AND[0]).toEqual({
      OR: [
        { doctor_id: 22 },
        {
          doctor_id: null,
          department: { equals: 'Cardiology', mode: 'insensitive' },
        },
      ],
    });
    expect(findManyMock.mock.calls[0][0].where.AND[0]).toEqual(
      countMock.mock.calls[0][0].where.AND[0],
    );
    expect(result.appointments[0]).toEqual(
      expect.objectContaining({
        id: 401,
        doctor_id: null,
        department: 'Cardiology',
      }),
    );
  });

  it('scopes duty-doctor lists to the authenticated doctor, ignoring foreign doctor filters', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ department: 'Emergency' }]);
    countMock.mockResolvedValueOnce(1);
    findManyMock.mockResolvedValueOnce([
      {
        id: 402,
        appointment_date: new Date('2026-06-04T11:00:00.000Z'),
        appointment_time: '11:00',
        status: 'CONFIRMED',
        reason: 'Duty doctor review',
        notes: null,
        patient_id: 13,
        doctor_id: 23,
        phone: '+919000000014',
        patient_name: 'Duty Queue Patient',
        doctor_name: 'Dr Duty',
        department: 'Emergency',
        token_number: null,
        visit_no: null,
        advised_for_admission_at: null,
        advised_for_admission_by: null,
        advised_for_admission_note: null,
        created_at: new Date('2026-06-04T10:30:00.000Z'),
        updated_at: new Date('2026-06-04T10:30:00.000Z'),
        users_appointments_patient_idTousers: {
          id: 13,
          uid: 'ba000000-0000-4000-8000-00000000b014',
          name: 'Duty Queue Patient',
          phone: '+919000000014',
          guardian_phone: null,
          email: null,
          allergies: null,
        },
        users_appointments_doctor_idTousers: {
          id: 23,
          uid: 'da000000-0000-4000-8000-00000000d023',
          name: 'Dr Duty',
          doctors: [
            { specialty: 'Emergency Medicine', department: 'Emergency' },
          ],
        },
      },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    await appointmentQueryService.getAppointments(
      { date: '2026-06-04', doctor_id: '999' },
      {},
      'DUTY_DOCTOR',
      23,
    );

    expect(countMock.mock.calls[0][0].where.doctor_id).toBeUndefined();
    expect(countMock.mock.calls[0][0].where.AND[0]).toEqual({
      OR: [
        { doctor_id: 23 },
        {
          doctor_id: null,
          department: { equals: 'Emergency', mode: 'insensitive' },
        },
      ],
    });
    expect(findManyMock.mock.calls[0][0].where.AND[0]).toEqual(
      countMock.mock.calls[0][0].where.AND[0],
    );
  });

  it('preserves appointment department and exposes consultant department separately', async () => {
    countMock.mockResolvedValueOnce(1);
    findManyMock.mockResolvedValueOnce([
      {
        id: 301,
        appointment_date: new Date('2026-05-23T09:00:00.000Z'),
        appointment_time: '09:00',
        status: 'SCHEDULED',
        reason: 'Advised admission',
        notes: null,
        patient_id: 11,
        doctor_id: 22,
        token_number: '12',
        visit_no: 'OPD-20260523-012',
        visit_type: 'FOLLOW_UP',
        department: 'Emergency',
        users_appointments_patient_idTousers: {
          id: 11,
          uid: 'ba000000-0000-4000-8000-00000000b012',
          name: 'Department Patient',
          phone: '+919000000012',
          guardian_phone: null,
          email: null,
          allergies: null,
        },
        users_appointments_doctor_idTousers: {
          id: 22,
          uid: 'da000000-0000-4000-8000-00000000d022',
          name: 'Dr Cardio',
          doctors: [{ specialty: 'Cardiology', department: 'Cardiology' }],
        },
      },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    const result = await appointmentQueryService.getAppointments({}, {}, 'ADMIN', null);

    expect(result.appointments[0]).toEqual(expect.objectContaining({
      department: 'Emergency',
      appointment_department: 'Emergency',
      consultant_department: 'Cardiology',
      doctor_department: 'Cardiology',
    }));
  });
});

describe('appointmentQueryService admission-source lineage', () => {
  it('adds only the exact accepted OP transfer tuple to the advised worklist', async () => {
    const patientUid = 'ba000000-0000-4000-8000-00000000b015';
    const pathwayId = 'ca000000-0000-4000-8000-00000000c015';
    const handoffId = 'da000000-0000-4000-8000-00000000d015';
    const recipientUid = 'ea000000-0000-4000-8000-00000000e015';
    countMock.mockResolvedValueOnce(1);
    findManyMock.mockResolvedValueOnce([{
      id: 501,
      appointment_date: new Date('2026-07-24T09:00:00.000Z'),
      appointment_time: '09:00',
      status: 'SCHEDULED',
      reason: 'Advised admission',
      patient_id: 15,
      doctor_id: 25,
      department: 'General Medicine',
      advised_for_admission_at: new Date('2026-07-23T09:00:00.000Z'),
      advised_for_admission_by: recipientUid,
      advised_for_admission_note: 'Admit',
      users_appointments_patient_idTousers: {
        id: 15,
        uid: patientUid,
        name: 'Admission Source Patient',
        phone: '+919000000015',
        guardian_phone: null,
        email: null,
        allergies: null,
      },
      users_appointments_doctor_idTousers: {
        id: 25,
        name: 'Dr Sender',
        doctors: [{ specialty: 'Medicine', department: 'General Medicine' }],
      },
    }]);
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        appointment_id: 501,
        source_pathway_instance_id: pathwayId,
        source_handoff_id: handoffId,
        accepted_recipient_uid: recipientUid,
        exact_match_count: 1,
      }]);

    const result = await appointmentQueryService.getAppointments(
      { advised_for_admission: 'true' },
      {},
      'ADMIN',
      null,
      '00000000-0000-4000-8000-000000000001',
    );

    expect(result.appointments[0].admission_source).toEqual({
      appointment_id: 501,
      source_pathway_instance_id: pathwayId,
      source_handoff_id: handoffId,
      accepted_recipient_uid: recipientUid,
    });
    const sql = queryUnsafeMock.mock.calls[3][0];
    expect(sql).toContain("handoff.status = 'accepted'");
    expect(sql).toContain('handoff.accepted_by_uid = handoff.intended_recipient_uid');
    expect(sql).toContain('appointment.tenant_id = $1::uuid');
  });

  it('fails closed when more than one accepted tuple matches an advice', async () => {
    countMock.mockResolvedValueOnce(1);
    findManyMock.mockResolvedValueOnce([{
      id: 502,
      appointment_date: new Date('2026-07-24T09:00:00.000Z'),
      appointment_time: '09:00',
      status: 'SCHEDULED',
      patient_id: 16,
      doctor_id: 26,
      advised_for_admission_at: new Date(),
      users_appointments_patient_idTousers: {
        id: 16,
        uid: 'ba000000-0000-4000-8000-00000000b016',
        name: 'Ambiguous Patient',
        phone: '+919000000016',
        guardian_phone: null,
        email: null,
        allergies: null,
      },
      users_appointments_doctor_idTousers: null,
    }]);
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        appointment_id: 502,
        source_pathway_instance_id: 'ca000000-0000-4000-8000-00000000c016',
        source_handoff_id: 'da000000-0000-4000-8000-00000000d016',
        accepted_recipient_uid: 'ea000000-0000-4000-8000-00000000e016',
        exact_match_count: 2,
      }]);

    await expect(appointmentQueryService.getAppointments(
      { advised_for_admission: true },
      {},
      'ADMIN',
      null,
      '00000000-0000-4000-8000-000000000001',
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'OP_INPATIENT_ADMISSION_SOURCE_AMBIGUOUS',
    });
  });
});
