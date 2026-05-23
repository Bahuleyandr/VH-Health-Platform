import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { AppError } from '../AppError.js';
import { isDoctor, isAdmin, isLeadership, isMedicalRecords } from '../roleHelpers.js';

export const hasPermission = (userRole, action) => {
  const allowedRoles = APPOINTMENT_CONFIG.PERMISSIONS[action];
  return allowedRoles && allowedRoles.includes(userRole);
};

export const canAccessAppointment = (user, appointment) => {
  if (user.role === 'ADMIN' || user.role === 'NURSE' || user.role === 'NURSING_STAFF') {
    return true;
  }
  if (user.role === 'DOCTOR' && String(appointment.doctor_id) === String(user.id)) {
    return true;
  }
  if (user.role === 'PATIENT' && String(appointment.patient_id) === String(user.id)) {
    return true;
  }
  return false;
};

export const buildPaginationMeta = (page, limit, total) => {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page * limit < total,
    hasPrev: page > 1
  };
};

export const normalizeStatus = (status) => {
  return status ? status.toUpperCase() : null;
};

export const checkAppointmentPermission = (user, appointment, action) => {
  // Admin and Nurse have full access
  if (['ADMIN', 'NURSE', 'NURSING_STAFF'].includes(user.role)) {
    return true;
  }

  // P1 IDOR: Use String() comparison to avoid type coercion issues (DB int vs JWT string)
  // Doctor can access their own appointments
  if (user.role === 'DOCTOR' && String(appointment.doctor_id) === String(user.id)) {
    return ['view', 'update', 'cancel'].includes(action);
  }

  // ER read-access shim. Emergency walk-ins arrive with `doctor_id=null`
  // (the consultant only claims/assigns at triage), but the rest of the
  // ER workflow already lets the treating doctor write notes + orders
  // on the same encounter via different RBAC paths. Without this branch,
  // the doctor could write but couldn't READ the appointment shell — they
  // had to fall back to admin creds to verify their own
  // advised_for_admission queue state. Strictly read-only: claim must
  // happen before update/cancel. Fires only when `doctor_id` is
  // unassigned AND the appointment is department/visit-type emergency,
  // so an unrelated specialty appointment with a null doctor_id
  // (transient pre-confirmation state) stays gated.
  // Finding: 2026-05-23-emergency-walk-in-doctor-70bf7587.
  if (user.role === 'DOCTOR'
      && action === 'view'
      && (appointment.doctor_id == null || appointment.doctor_id === '')) {
    const isEmergency =
      appointment.visit_type === 'EMERGENCY'
      || /emergency/i.test(String(appointment.department ?? ''));
    if (isEmergency) return true;
  }

  // Patient can view, update, and cancel their own appointments
  if (user.role === 'PATIENT' && String(appointment.patient_id) === String(user.id)) {
    return ['view', 'update', 'cancel'].includes(action);
  }

  // Receptionist can view and create appointments
  if (user.role === 'RECEPTIONIST') {
    return ['view', 'create'].includes(action);
  }

  return false;
};

// ===================================================================
// Clinical-write authorization for a specific appointment/visit
// ===================================================================

/**
 * Supervisory roles allowed to write/sign/complete clinical work on a visit
 * they are NOT personally assigned to. Mirrors the override allowance the
 * GET/PUT/DELETE appointment paths grant to ADMIN + administrative roles,
 * extended to clinical leadership (CMO/CNO/DEPARTMENT_HEAD) and MEDICAL_RECORDS
 * who legitimately act across a department's caseload. A *peer* doctor who is
 * not the assigned clinician is intentionally NOT here — that is the H2 leak.
 */
const isAppointmentClinicalSupervisor = (role) =>
  isAdmin(role) || role === 'SUPER_ADMIN' || isLeadership(role) || isMedicalRecords(role);

/**
 * True when `actingUser` may author / sign / complete clinical work bound to
 * `appointment`. Either:
 *   - the acting user is the assigned doctor on the appointment, OR
 *   - the acting user holds an authorized supervisory role.
 *
 * Assignment is matched on whichever identifier the caller has available
 * (the int users.id from the JWT, or the user uid resolved to the
 * appointment's assigned-doctor uid) using the codebase String() IDOR
 * convention (DB int vs JWT string).
 *
 * @param {{ id?: number|string, uid?: string, role: string }} actingUser
 * @param {{ doctor_id?: number|string|null, assigned_doctor_uid?: string|null }} appointment
 * @returns {boolean}
 */
export const canWriteAppointmentClinical = (actingUser, appointment) => {
  if (!actingUser || !appointment) return false;

  // Supervisory override — department/admin roles act across the caseload.
  if (isAppointmentClinicalSupervisor(actingUser.role)) return true;

  // Only doctors can be the *assigned* clinician on an appointment.
  if (!isDoctor(actingUser.role)) return false;

  // Match on int users.id when the caller threaded it (controllers), else on
  // the assigned-doctor uid that the caller resolved (service layer).
  const matchById =
    actingUser.id !== undefined &&
    actingUser.id !== null &&
    appointment.doctor_id !== undefined &&
    appointment.doctor_id !== null &&
    String(appointment.doctor_id) === String(actingUser.id);

  const matchByUid =
    !!actingUser.uid &&
    !!appointment.assigned_doctor_uid &&
    String(appointment.assigned_doctor_uid) === String(actingUser.uid);

  return matchById || matchByUid;
};

/**
 * Throwing variant of {@link canWriteAppointmentClinical}. Raises
 * `AppError.forbidden` when the acting user is neither the assigned doctor
 * nor an authorized supervisor for the appointment. No-op (allow) when the
 * appointment has no assigned doctor yet — assignment is enforced elsewhere
 * and an unassigned OPD slot must stay writable by the first treating doctor.
 *
 * @param {{ id?: number|string, uid?: string, role: string }} actingUser
 * @param {{ doctor_id?: number|string|null, assigned_doctor_uid?: string|null }} appointment
 */
export const assertCanWriteAppointmentClinical = (actingUser, appointment) => {
  // Unassigned appointment (doctor_id null) — no owner to protect; the first
  // treating clinician legitimately picks it up. Assignment correctness is
  // handled by the booking/queue flow, not this guard.
  if (!appointment || appointment.doctor_id === undefined || appointment.doctor_id === null) {
    return;
  }
  if (!canWriteAppointmentClinical(actingUser, appointment)) {
    throw AppError.forbidden(
      'You are not the assigned clinician for this appointment',
      'NOT_ASSIGNED_CLINICIAN',
    );
  }
};