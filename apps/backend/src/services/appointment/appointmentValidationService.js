import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import appointmentService from './appointmentService.js';

// Fields that can be amended on a COMPLETED appointment as a late
// clinical addendum. The doctor's natural flow is mark complete then
// write the note; we keep clinical context on the appointment record
// rather than forcing it onto the progress-notes path. Anything else
// (date/time/visit_type) would re-open a finalized appointment.
const ADDENDUM_FIELDS = new Set(['notes', 'reason']);

function isAddendumOnlyUpdate(updateData) {
  const supplied = Object.entries(updateData || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k]) => k);
  if (supplied.length === 0) return false;
  return supplied.every((field) => ADDENDUM_FIELDS.has(field));
}

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
    const doctor = await appointmentService.validateDoctor(bookingData.doctor_id);
    if (!doctor) {
      errors.push('Doctor not found');
    } else {
      bookingData.doctor_id = doctor.id;
    }

    // P1 IDOR: patient may only book for themselves. jwtMiddleware now surfaces the
    // int DB id as `user.id` (when the token carries it); fall back to a uid→id lookup
    // if the token is uid-only.
    if (user.role === 'PATIENT') {
      let callerInt = user.id;
      if (callerInt == null && user.uid) {
        const prismaMod = await import('../../lib/prisma.js');
        const rows = await prismaMod.default.$queryRawUnsafe(
          `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`, user.uid);
        callerInt = rows[0]?.id ?? null;
      }
      if (String(callerInt) !== String(bookingData.patient_id)) {
        errors.push('Can only book appointments for yourself');
      }
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
    let isAddendum = false;

    // Get existing appointment
    const appointment = await appointmentService.getAppointmentById(appointmentId);
    if (!appointment) {
      errors.push('Appointment not found');
      return { valid: false, errors };
    }

    // Check if appointment is scheduled. Late clinical addendum exception:
    // a doctor's natural OPD flow is see patient → mark complete → write
    // note. If we hard-lock the record on COMPLETED, the note has to be
    // entered before status change — which contradicts how clinicians
    // actually work and forces clinical context onto the separate
    // progress-notes path (which has its own friction).
    // Allow notes/reason to be updated on COMPLETED appointments by
    // clinical staff (not patients); date/time/visit_type stay locked
    // since those would re-open a finalized appointment. Finding:
    //   2026-05-09-follow-up-opd-doctor-no-edit-after-complete
    const isScheduled = appointment.status === APPOINTMENT_CONFIG.STATUSES.SCHEDULED;
    if (!isScheduled) {
      const addendumOnly = isAddendumOnlyUpdate(updateData);
      const isClinical = ['DOCTOR', 'ADMIN', 'NURSING_STAFF', 'NURSE', 'RECEPTIONIST'].includes(user.role);
      if (
        appointment.status === APPOINTMENT_CONFIG.STATUSES.COMPLETED
        && addendumOnly
        && isClinical
      ) {
        isAddendum = true;
      } else {
        errors.push('Can only update scheduled appointments');
      }
    }

    // P1 IDOR: compare appointment.patient_id to caller's int id (uid→id fallback
    // when the token didn't carry `id`).
    if (user.role === 'PATIENT') {
      let callerInt = user.id;
      if (callerInt == null && user.uid) {
        const prismaMod = await import('../../lib/prisma.js');
        const rows = await prismaMod.default.$queryRawUnsafe(
          `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`, user.uid);
        callerInt = rows[0]?.id ?? null;
      }
      if (String(appointment.patient_id) !== String(callerInt)) {
        errors.push('Can only update your own appointments');
      }
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
      appointment,
      isAddendum
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
