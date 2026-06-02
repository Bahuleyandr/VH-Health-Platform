import { jest } from '@jest/globals';

const validateUserMock = jest.fn();
const validateDoctorMock = jest.fn();
const checkConflictMock = jest.fn();

jest.unstable_mockModule('../../services/appointment/appointmentService.js', () => ({
  default: {
    validateUser: validateUserMock,
    validateDoctor: validateDoctorMock,
    checkConflict: checkConflictMock,
  },
}));

const appointmentValidationService = (await import(
  '../../services/appointment/appointmentValidationService.js'
)).default;

beforeEach(() => {
  validateUserMock.mockReset();
  validateDoctorMock.mockReset();
  checkConflictMock.mockReset();
});

describe('appointmentValidationService.validateBookingRequest', () => {
  it('allows department-routed OP appointments without a specific doctor', async () => {
    validateUserMock.mockResolvedValueOnce({
      id: 10,
      uid: '00000000-0000-4000-8000-000000000010',
      name: 'Department Patient',
      phone: '+919000000010',
    });

    const result = await appointmentValidationService.validateBookingRequest(
      {
        patient_id: 10,
        department: 'Cardiology',
        appointment_date: '2026-06-03',
        appointment_time: '10:00',
      },
      { role: 'RECEPTIONIST' },
    );

    expect(result.valid).toBe(true);
    expect(result.doctor).toBeNull();
    expect(validateDoctorMock).not.toHaveBeenCalled();
    expect(checkConflictMock).not.toHaveBeenCalled();
  });

  it('rejects OP bookings with neither doctor nor department', async () => {
    validateUserMock.mockResolvedValueOnce({
      id: 11,
      uid: '00000000-0000-4000-8000-000000000011',
      name: 'Unrouted Patient',
      phone: '+919000000011',
    });

    const result = await appointmentValidationService.validateBookingRequest(
      {
        patient_id: 11,
        appointment_date: '2026-06-03',
        appointment_time: '10:30',
      },
      { role: 'RECEPTIONIST' },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Select a doctor or department');
    expect(validateDoctorMock).not.toHaveBeenCalled();
    expect(checkConflictMock).not.toHaveBeenCalled();
  });

  it('keeps conflict checks for doctor-specific appointments', async () => {
    validateUserMock.mockResolvedValueOnce({
      id: 12,
      uid: '00000000-0000-4000-8000-000000000012',
      name: 'Doctor Patient',
      phone: '+919000000012',
    });
    validateDoctorMock.mockResolvedValueOnce({
      id: 99,
      name: 'Dr Specific',
      department: 'Neurology',
    });
    checkConflictMock.mockResolvedValueOnce(null);

    const bookingData = {
      patient_id: 12,
      doctor_id: 99,
      appointment_date: '2026-06-03',
      appointment_time: '11:00',
    };
    const result = await appointmentValidationService.validateBookingRequest(
      bookingData,
      { role: 'RECEPTIONIST' },
    );

    expect(result.valid).toBe(true);
    expect(bookingData.doctor_id).toBe(99);
    expect(validateDoctorMock).toHaveBeenCalledWith(99, null);
    expect(checkConflictMock).toHaveBeenCalledWith(
      99,
      '2026-06-03',
      '11:00',
      null,
      null,
    );
  });
});
