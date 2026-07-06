import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import appointmentQueryService from '../../services/appointment/appointmentQueryService.js';
import appointmentValidationService from '../../services/appointment/appointmentValidationService.js';
import { checkAppointmentPermission } from '../../utils/appointment/appointmentHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { logAudit } from '../../utils/logAudit.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';
import { emitAppointmentEvent } from '../../utils/websocket/realtimeEmitter.js';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

async function resolveOrCreatePatientFromPhone({ patientPhone, patientName, tenantId }) {
  const normalizedPhone = normalizePhone(patientPhone);
  if (!normalizedPhone) {
    const err = new Error('Valid patient phone is required');
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }

  const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, uid, phone, name, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND (phone = $2 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $3)
      ORDER BY CASE WHEN phone = $2 THEN 0 ELSE 1 END, registered_at DESC NULLS LAST
      LIMIT 1`,
    tenantId,
    normalizedPhone,
    `%${last10}`,
  );

  if (existing.length > 0) {
    if (existing[0].role !== 'PATIENT') {
      const err = new Error('This phone number belongs to a non-patient account');
      err.statusCode = HTTP_STATUS.CONFLICT;
      throw err;
    }
    return { patient: existing[0], created: false };
  }

  const name = (patientName || '').trim() || 'New Patient';
  const created = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, name, role, is_active, tenant_id, registered_at, updated_at)
     VALUES ($1, $2, 'PATIENT', true, $3::uuid, NOW(), NOW())
     RETURNING id, uid, phone, name`,
    normalizedPhone,
    name,
    tenantId,
  );

  return { patient: created[0], created: true };
}

async function resolveDoctorIdFromUid(doctorUid, tenantId) {
  if (!doctorUid) return null;
  const row = await prisma.users.findFirst({
    where: {
      uid: String(doctorUid).trim(),
      role: 'DOCTOR',
      is_active: true,
      tenant_id: tenantId,
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

export const createAppointment = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const appointmentDate = req.body.appointment_date || req.body.date;
    const appointmentTime = req.body.appointment_time || req.body.time;
    const patientPhone = req.body.patient_phone || req.body.phone || req.body.phoneNumber;

    if (req.body.doctor_uid) {
      req.body.doctor_id = await resolveDoctorIdFromUid(req.body.doctor_uid, tenantId);
    }

    let resolvedPatient = null;
    let createdNewPatient = false;
    if (!req.body.patient_id && patientPhone) {
      const resolved = await resolveOrCreatePatientFromPhone({
        patientPhone,
        patientName: req.body.patient_name,
        tenantId,
      });
      resolvedPatient = resolved.patient;
      createdNewPatient = resolved.created;
      req.body.patient_id = resolved.patient.id;
    }

    const appointmentData = {
      patient_id: req.body.patient_id,
      doctor_id: req.body.doctor_id,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      reason: req.body.reason,
      notes: req.body.notes || null,
      department: req.body.department || null,
      visit_type: req.body.visit_type || null,
      tenant_id: tenantId,
      created_by: req.user?.uid || null,
    };

    // Validate the booking request
    const validation = await appointmentValidationService.validateBookingRequest(
      appointmentData,
      req.user
    );

    if (!validation.valid) {
      if (validation.conflict) {
        return error(res, 'Time slot already booked', HTTP_STATUS.CONFLICT, { conflicting_appointment_id: validation.conflict.id });
      }
      return error(res, validation.errors.join(', '), HTTP_STATUS.BAD_REQUEST);
    }

    // Duplicate-detection guard: if this patient already has a SCHEDULED
    // appointment with the same doctor on the same date, surface a 409 with
    // the existing id unless the caller explicitly opts in via
    // `confirm_duplicate: true`. Receptionists can still book a second slot
    // (re-attempt after no-show, mid-day re-evaluation, etc.) but must
    // acknowledge it. See finding
    // 2026-05-08-follow-up-opd-receptionist-duplicate-appt-no-warning.
    if (
      appointmentData.patient_id &&
      appointmentData.doctor_id &&
      appointmentData.appointment_date &&
      req.body.confirm_duplicate !== true
    ) {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id, status, appointment_time
           FROM appointments
         WHERE patient_id = $1
           AND doctor_id = $2
           AND DATE(appointment_date) = $3::date
           AND tenant_id = $4::uuid
           AND status IN ('SCHEDULED', 'CONFIRMED')
         LIMIT 1`,
        appointmentData.patient_id,
        appointmentData.doctor_id,
        appointmentData.appointment_date,
        tenantId,
      );
      if (existing.length > 0) {
        return error(
          res,
          'This patient already has an appointment with this doctor today. Pass `confirm_duplicate: true` to book a second slot.',
          HTTP_STATUS.CONFLICT,
          {
            code: 'DUPLICATE_APPOINTMENT_SAME_DAY',
            existing_appointment_id: existing[0].id,
            existing_appointment_status: existing[0].status,
            existing_appointment_time: existing[0].appointment_time,
          },
        );
      }
    }

    // Create the appointment (uses transaction with row-level locking to prevent double-booking)
    const appointment = await appointmentService.createAppointment(appointmentData);
    const hydratedAppointment =
      (await appointmentQueryService.getAppointmentById(appointment.id, tenantId)) || appointment;
    const patientUid = validation.patient.uid ?? resolvedPatient?.uid ?? null;

    await logAudit(req, 'FRONT_OFFICE_APPOINTMENT_BOOKED', {
      appointment_id: hydratedAppointment.id,
      appointment_uid: hydratedAppointment.uid || null,
      patient_id: hydratedAppointment.patient_id ?? validation.patient.id ?? resolvedPatient?.id ?? null,
      patient_uid: patientUid,
      doctor_id: hydratedAppointment.doctor_id ?? validation.doctor?.id ?? null,
      appointment_date: hydratedAppointment.appointment_date ?? appointmentDate,
      appointment_time: hydratedAppointment.appointment_time ?? appointmentTime,
      department: hydratedAppointment.department ?? appointmentData.department ?? null,
      visit_type: hydratedAppointment.visit_type ?? appointmentData.visit_type ?? null,
      created_patient: createdNewPatient,
    }, {
      resource: 'appointment',
      resourceId: hydratedAppointment.id,
    });

    success(res, {
      appointment: hydratedAppointment,
      patient_name: hydratedAppointment.patient_name ?? validation.patient.name ?? resolvedPatient?.name,
      patient: {
        id: validation.patient.id ?? resolvedPatient?.id,
        uid: patientUid,
        name: validation.patient.name ?? resolvedPatient?.name,
        phone: validation.patient.phone ?? resolvedPatient?.phone,
        created: createdNewPatient,
      },
      doctor_name: hydratedAppointment.doctor_name_detail ?? hydratedAppointment.doctor_name ?? validation.doctor?.name ?? null,
      booked_by: req.user?.name
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_BOOKED, HTTP_STATUS.CREATED);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode);
    }
    if (err.isConflict) {
      return error(res, 'Time slot already booked', HTTP_STATUS.CONFLICT, { conflicting_appointment_id: err.conflictingId });
    }
    logger.error('Error creating appointment:', err);
    error(res, 'Failed to book appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateAppointment = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { id } = req.params;

    // Reject status updates explicitly — the previous handler silently
    // dropped `status` from the patch and returned 200, which made callers
    // believe the visit was closed when nothing changed. State transitions
    // belong on the dedicated sub-resources. See finding
    // 2026-05-08-follow-up-opd-doctor-status-update-silently-ignored.
    if (req.body.status !== undefined) {
      return error(
        res,
        'Status updates are not accepted on PUT /appointments/:id. Use POST /appointments/:id/{confirm|complete|cancel|no-show} or PUT /appointments/:id/status.',
        HTTP_STATUS.BAD_REQUEST,
        { code: 'STATUS_UPDATE_NOT_ALLOWED_HERE' },
      );
    }

    const updateData = {
      appointment_date: req.body.appointment_date,
      appointment_time: req.body.appointment_time,
      reason: req.body.reason,
      notes: req.body.notes,
      // visit_type is a first-class field for new vs follow-up vs review.
      // Migration 169 added the column. See finding
      // 2026-05-08-follow-up-opd-doctor-no-visit-type-flag.
      visit_type: req.body.visit_type,
    };

    // P1 IDOR: Verify the authenticated user owns/can access this appointment
    const appointment = await appointmentService.getAppointmentById(id, tenantId);
    if (!appointment) {
      return error(res, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (!checkAppointmentPermission(req.user, appointment, 'update')) {
      return error(res, 'Insufficient permissions to update this appointment', HTTP_STATUS.FORBIDDEN);
    }

    // Validate the update request
    const validation = await appointmentValidationService.validateUpdateRequest(
      id,
      updateData,
      req.user,
      tenantId,
    );

    if (!validation.valid) {
      if (validation.conflict) {
        return error(res, 'Time slot already booked', HTTP_STATUS.CONFLICT, { conflicting_appointment_id: validation.conflict.id });
      }
      return error(res, validation.errors.join(', '), HTTP_STATUS.BAD_REQUEST);
    }

    // Update the appointment
    const updatedAppointment = await appointmentService.updateAppointment(
      id,
      updateData,
      tenantId,
      req.user?.uid || null,
    );

    // Late clinical addendum on a COMPLETED appointment — record the
    // who/what/when separately so audit can distinguish a "real" update
    // from a post-completion note. Best-effort: failure here must not
    // break the user-facing update. Finding:
    //   2026-05-09-follow-up-opd-doctor-no-edit-after-complete
    const changedFields = Object.keys(updateData).filter(
      (field) => updateData[field] !== undefined && updateData[field] !== null,
    );

    await logAudit(req, validation.isAddendum ? 'FRONT_OFFICE_APPOINTMENT_ADDENDUM' : 'FRONT_OFFICE_APPOINTMENT_UPDATED', {
      appointment_id: Number(id),
      appointment_uid: appointment.uid || updatedAppointment?.uid || null,
      patient_id: appointment.patient_id ?? null,
      patient_uid: appointment.patient_uid ?? null,
      doctor_id: appointment.doctor_id ?? null,
      prior_status: appointment.status,
      updated_status: updatedAppointment?.status ?? appointment.status,
      changed_fields: changedFields,
    }, {
      resource: 'appointment',
      resourceId: id,
    });

    if (validation.isAddendum) {
      try {
        await prisma.audit_logs.create({
          data: {
            uid: req.user?.uid || null,
            action: 'APPOINTMENT_ADDENDUM',
            resource: 'appointment',
            resource_id: String(id),
            metadata: {
              fields: Object.keys(updateData).filter(
                (k) => updateData[k] !== undefined && updateData[k] !== null
              ),
              patient_id: appointment.patient_id,
              doctor_id: appointment.doctor_id,
              prior_status: appointment.status,
            },
            ip_address: req.ip || null,
          },
        });
      } catch (e) {
        logger.warn(`Appointment ${id} addendum audit log failed: ${e.message}`);
      }
    }

    success(res, {
      appointment: updatedAppointment,
      updated_by: req.user?.name,
      addendum: validation.isAddendum || false,
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_UPDATED);
  } catch (err) {
    logger.error('Error updating appointment:', err);
    error(res, 'Failed to update appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

function conflictDetailsFromError(err) {
  const code = err?.meta?.driverAdapterError?.cause?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  if (String(code) === '23505') {
    return { statusCode: HTTP_STATUS.CONFLICT, details: { code: 'APPOINTMENT_SLOT_CONFLICT' } };
  }
  if (err?.statusCode === HTTP_STATUS.CONFLICT) {
    return {
      statusCode: HTTP_STATUS.CONFLICT,
      details: {
        code: 'APPOINTMENT_SLOT_CONFLICT',
        conflicting_appointment_id: err.conflictingId,
        conflicting_appointment_time: err.conflictingTime,
      },
    };
  }
  return null;
}

export const rescheduleAppointment = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { id } = req.params;

    const appointment = await appointmentService.getAppointmentById(id, tenantId);
    if (!appointment) {
      return error(res, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (!checkAppointmentPermission(req.user, appointment, 'update')) {
      return error(res, 'Insufficient permissions to reschedule this appointment', HTTP_STATUS.FORBIDDEN);
    }

    let doctorId = req.body.doctor_id;
    if (req.body.doctor_uid) {
      doctorId = await resolveDoctorIdFromUid(req.body.doctor_uid, tenantId);
      if (!doctorId) {
        return error(res, 'Doctor not found', HTTP_STATUS.BAD_REQUEST);
      }
    }

    const note = req.body.confirmation_notes || req.body.notes || null;
    const result = await appointmentService.rescheduleAppointmentInPlace(
      id,
      {
        appointment_date: req.body.appointment_date,
        appointment_time: req.body.appointment_time,
        doctor_id: doctorId,
        notes: note,
      },
      {
        tenantId,
        actorUid: req.user?.uid || null,
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
      },
    );

    await logAudit(req, 'FRONT_OFFICE_APPOINTMENT_RESCHEDULED', {
      appointment_id: Number(id),
      appointment_uid: appointment.uid || result.appointment?.uid || null,
      patient_id: appointment.patient_id ?? null,
      patient_uid: appointment.patient_uid ?? null,
      doctor_id: result.appointment?.doctor_id ?? appointment.doctor_id ?? null,
      from_status: result.from_status,
      to_status: result.to_status,
      prior_appointment_date: appointment.appointment_date,
      prior_appointment_time: appointment.appointment_time,
      appointment_date: result.appointment?.appointment_date,
      appointment_time: result.appointment?.appointment_time,
      reschedule_note: note,
    }, {
      resource: 'appointment',
      resourceId: id,
    });

    emitAppointmentEvent('reschedule', { tenantId });
    success(res, {
      appointment: result.appointment,
      previous: {
        appointment_date: result.previous?.appointment_date,
        appointment_time: result.previous?.appointment_time,
        doctor_id: result.previous?.doctor_id,
        status: result.previous?.status,
      },
      updated_by: req.user?.name,
    }, 'Appointment rescheduled');
  } catch (err) {
    const conflict = conflictDetailsFromError(err);
    if (conflict) {
      return error(res, 'Time slot already booked', conflict.statusCode, conflict.details);
    }
    if (err.statusCode) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Error rescheduling appointment:', err);
    error(res, 'Failed to reschedule appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deleteAppointment = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { id } = req.params;

    // Get appointment to check permissions
    const appointment = await appointmentService.getAppointmentById(id, tenantId);
    
    if (!appointment) {
      return error(res, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    // Check permissions
    if (!checkAppointmentPermission(req.user, appointment, 'cancel')) {
      return error(res, 'Insufficient permissions to cancel this appointment', HTTP_STATUS.FORBIDDEN);
    }

    // Cancel the appointment
    const cancelledAppointment = await appointmentService.cancelAppointment(
      id,
      req.user?.name || 'User'
    );
    await logAudit(req, 'FRONT_OFFICE_APPOINTMENT_CANCELLED', {
      appointment_id: Number(id),
      appointment_uid: appointment.uid || cancelledAppointment?.uid || null,
      patient_id: appointment.patient_id ?? null,
      patient_uid: appointment.patient_uid ?? null,
      doctor_id: appointment.doctor_id ?? null,
      prior_status: appointment.status,
      updated_status: cancelledAppointment?.status ?? 'CANCELLED',
    }, {
      resource: 'appointment',
      resourceId: id,
    });

    success(res, {
      appointment: cancelledAppointment,
      cancelled_by: req.user?.name
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_CANCELLED);
  } catch (err) {
    logger.error('Error cancelling appointment:', err);
    error(res, 'Failed to cancel appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
