import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import appointmentService from './appointmentService.js';

export class AppointmentValidationService {
  // Validate appointment booking request
  async validateBookingRequest(bookingData, user) {
    const errors = [];

    // Check patient exists
    const patient = await appointmentService.validateUser(bookingData.patient_id);
    if (!patient) {
      errors.push('Patient not found');
    }

    // Check doctor exists and has correct role
    const doctor = await appointmentService.validateUser(bookingData.doctor_id, 'DOCTOR');
    if (!doctor) {
      errors.push('Doctor not found');
    }

    // P1 IDOR: Check for role-based access (String comparison for type safety)
    if (user.role === 'PATIENT' && String(user.id) !== String(bookingData.patient_id)) {
      errors.push('Can only book appointments for yourself');
    }

    // Check for conflicts if no errors so far
    if (errors.length === 0) {
      const conflict = await appointmentService.checkConflict(
        bookingData.doctor_id,
        bookingData.appointment_date,
        bookingData.appointment_time
      );
      
      if (conflict) {
        errors.push('Time slot already booked');
        return { valid: false, errors, conflict };
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      patient,
      doctor
    };
  }

  // Validate appointment update request
  async validateUpdateRequest(appointmentId, updateData, user) {
    const errors = [];

    // Get existing appointment
    const appointment = await appointmentService.getAppointmentById(appointmentId);
    if (!appointment) {
      errors.push('Appointment not found');
      return { valid: false, errors };
    }

    // Check if appointment is scheduled
    if (appointment.status !== APPOINTMENT_CONFIG.STATUSES.SCHEDULED) {
      errors.push('Can only update scheduled appointments');
    }

    // P1 IDOR: Check permissions (String comparison for type safety)
    if (user.role === 'PATIENT' && String(appointment.patient_id) !== String(user.id)) {
      errors.push('Can only update your own appointments');
    }

    // Check for conflicts if time is being changed
    if (errors.length === 0 && (updateData.appointment_date || updateData.appointment_time)) {
      const newDate = updateData.appointment_date || appointment.appointment_date;
      const newTime = updateData.appointment_time || appointment.appointment_time;
      
      const conflict = await appointmentService.checkConflict(
        appointment.doctor_id,
        newDate,
        newTime,
        appointmentId
      );
      
      if (conflict) {
        errors.push('Time slot already booked');
        return { valid: false, errors, conflict };
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      appointment
    };
  }

  // Validate status update
  validateStatusUpdate(status) {
    const validStatuses = Object.values(APPOINTMENT_CONFIG.STATUSES);
    const normalizedStatus = status.toUpperCase();
    
    if (!validStatuses.includes(normalizedStatus)) {
      return {
        valid: false,
        error: `Invalid status. Valid options: ${validStatuses.join(', ')}`
      };
    }
    
    return { valid: true, status: normalizedStatus };
  }
}

export default new AppointmentValidationService();