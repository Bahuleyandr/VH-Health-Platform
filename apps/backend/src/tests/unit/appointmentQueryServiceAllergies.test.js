import { jest } from '@jest/globals';

const findManyMock = jest.fn();
const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    appointments: {
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
  findManyMock.mockReset();
  queryUnsafeMock.mockReset();
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
