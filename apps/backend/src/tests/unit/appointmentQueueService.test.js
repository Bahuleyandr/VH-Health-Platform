import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  appointmentQueueKindForAppointment,
  attachAppointmentQueues,
  ensureAppointmentQueueForAppointment,
} = await import('../../services/appointment/appointmentQueueService.js');

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
});

describe('appointmentQueueService', () => {
  it('classifies doctor, department, walk-in, and emergency appointment queues', () => {
    expect(appointmentQueueKindForAppointment({ doctor_id: 10 })).toBe('doctor');
    expect(appointmentQueueKindForAppointment({ department: 'Cardiology' })).toBe('department');
    expect(appointmentQueueKindForAppointment({ appointment_time: 'Walk-in', doctor_id: 10 })).toBe('walk_in');
    expect(appointmentQueueKindForAppointment({ visit_type: 'EMERGENCY', doctor_id: 10 })).toBe('emergency');
  });

  it('creates/reuses queue context and links the appointment row', async () => {
    const db = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{
          id: 42,
          uid: '11111111-1111-4111-8111-111111111111',
          name: 'Dr Test',
          department_id: 3,
          department_name: 'Cardiology',
        }])
        .mockResolvedValueOnce([{ id: 3, name: 'Cardiology' }])
        .mockResolvedValueOnce([{
          id: 77,
          queue_date: '2026-06-02',
          queue_kind: 'doctor',
          department_id: 3,
          department_name: 'Cardiology',
          doctor_id: 42,
          doctor_uid: '11111111-1111-4111-8111-111111111111',
          queue_label: 'Dr Test - Cardiology',
          status: 'open',
          created_now: true,
        }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    const queue = await ensureAppointmentQueueForAppointment(db, {
      id: 9,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      appointment_date: '2026-06-02',
      appointment_time: '10:30',
      doctor_id: 42,
      department: 'Cardiology',
    }, {
      actorUid: '22222222-2222-4222-8222-222222222222',
      source: 'book',
    });

    expect(queue).toEqual(expect.objectContaining({
      id: 77,
      queue_kind: 'doctor',
      department_name: 'Cardiology',
      doctor_id: 42,
    }));
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(db.$queryRawUnsafe.mock.calls[2][0]).toContain('INSERT INTO appointment_queues');
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(db.$executeRawUnsafe.mock.calls[0][0]).toContain('UPDATE appointments');
    expect(db.$executeRawUnsafe.mock.calls[0][1]).toBe(77);
    expect(db.$executeRawUnsafe.mock.calls[0][2]).toBe(9);
    expect(db.$executeRawUnsafe.mock.calls[1][0]).toContain('appointment_queue_status_history');
  });

  it('decorates appointment rows with queue summaries', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{
      appointment_id: 9,
      queue_id: 77,
      queue_date: '2026-06-02',
      queue_kind: 'doctor',
      queue_label: 'Dr Test - Cardiology',
      status: 'open',
      department_id: 3,
      department_name: 'Cardiology',
      doctor_id: 42,
      doctor_uid: '11111111-1111-4111-8111-111111111111',
    }]);

    const rows = await attachAppointmentQueues([{ id: 9, patient_name: 'Patient' }]);

    expect(rows[0]).toEqual(expect.objectContaining({
      id: 9,
      queue_id: 77,
      appointment_queue: expect.objectContaining({
        queue_kind: 'doctor',
        queue_label: 'Dr Test - Cardiology',
      }),
    }));
  });
});
