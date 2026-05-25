import { jest } from '@jest/globals';

const findManyMock = jest.fn();
const countMock = jest.fn();
const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    appointments: {
      count: countMock,
      findMany: findManyMock,
    },
    $queryRawUnsafe: queryUnsafeMock,
  },
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
