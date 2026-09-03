import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import appointmentQueryService from '../../services/appointment/appointmentQueryService.js';
import appointmentValidationService from '../../services/appointment/appointmentValidationService.js';
import { checkAppointmentPermission } from '../../utils/appointment/appointmentHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { logAudit } from '../../utils/logAudit.js';
import { recordPatientFeedNotification } from '../../utils/notifications/patientNotificationFeed.js';
import { isValidPhone, normalizePhone } from '../../utils/phoneUtils.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { emitAppointmentEvent } from '../../utils/websocket/realtimeEmitter.js';
import { AppError } from '../../utils/AppError.js';
import { withAuthIdentityLifecycleLocks } from '../../utils/tokenBlacklist.js';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

async function resolveOrCreatePatientFromPhone({ patientPhone, patientName, tenantId }) {
  const normalizedPhone = normalizePhone(patientPhone);
  if (!normalizedPhone || !isValidPhone(normalizedPhone)) {
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
  // Tenant-scoped on purpose. A bare `prisma.$transaction` hands back the
  // raw itx client, which skips the prisma proxy's tenant wrapper, so
  // `app.current_tenant_id` stays unset inside it. `public.users` carries
  // the RESTRICTIVE `explicit_tenant_context_753` policy (migration 758)
  // whose WITH CHECK requires that GUC — naming tenant_id in the INSERT is
  // not enough, the unscoped write is rejected 42501.
  const created = await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, registered_at, updated_at)
       VALUES ($1, $2, 'PATIENT', true, $3::uuid, NOW(), NOW())
       RETURNING id, uid, phone, name`,
      normalizedPhone,
      name,
      tenantId,
    );
    return withAuthIdentityLifecycleLocks(tx, [rows[0].uid], async () => rows);
  });

  return { patient: created[0], created: true };
}

async function assertPatientPhoneMatches({ patientId, patientPhone, tenantId }) {
  const normalizedPhone = normalizePhone(patientPhone);
  if (!normalizedPhone || !isValidPhone(normalizedPhone)) {
    throw AppError.badRequest(
      'Valid patient phone is required when patient_id and patient_phone are both provided',
      'APPOINTMENT_PATIENT_PHONE_INVALID',
    );
  }

  const patientRows = await prisma.$queryRawUnsafe(
    `SELECT id, phone
       FROM users
      WHERE id = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    patientId,
    tenantId,
  );
  if (patientRows.length === 0) return;

  const requestedLast10 = normalizedPhone.replace(/\D/g, '').slice(-10);
  const storedLast10 = normalizePhone(patientRows[0].phone)
    ?.replace(/\D/g, '')
    .slice(-10);
  if (!storedLast10 || requestedLast10 !== storedLast10) {
    throw AppError.conflict(
      'patient_id and patient_phone identify different patients',
      'APPOINTMENT_PATIENT_ID_PHONE_MISMATCH',
    );
  }
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
    if (req.body.patient_id && patientPhone) {
      await assertPatientPhoneMatches({
        patientId: req.body.patient_id,
        patientPhone,
        tenantId,
      });
    }
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
      patient_phone: patientPhone,
      doctor_id: req.body.doctor_id,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      reason: req.body.reason,
      notes: req.body.notes || null,
      department: req.body.department || null,
      visit_type: req.body.visit_type || null,
      tenant_id: tenantId,
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
    const appointment = await appointmentService.createAppointment(appointmentData, {
      actorUid: req.user?.uid || null,
      actorId: req.user?.id || null,
      actorRole: req.user?.role || null,
      requirePatientPhoneMatch: req.user?.role !== 'PATIENT',
    });
    const hydratedAppointment =
      (await appointmentQueryService.getAppointmentById(appointment.id, tenantId)) || appointment;
    const patientUid =
      hydratedAppointment.patient_uid
      ?? validation.patient.uid
      ?? resolvedPatient?.uid
      ?? null;

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

    emitAppointmentEvent('book', {
      tenantId,
      patientUid,
      appointmentId: hydratedAppointment.id,
      status: hydratedAppointment.status ?? appointment.status ?? 'SCHEDULED',
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
      return relayAppError(res, err, 'Failed to book appointment');
    }
    if (err.isConflict) {
      return error(res, 'Time slot already booked', HTTP_STATUS.CONFLICT, {
        conflicting_appointment_id: err.conflictingId,
        ...(err.code ? { topLevel: { code: err.code } } : {}),
      });
    }
    return relayAppError(res, err, 'Failed to book appointment');
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

    const scheduleChanging = (
      updateData.appointment_date !== undefined
      || updateData.appointment_time !== undefined
    );
    let updatedAppointment;
    if (scheduleChanging) {
      const currentDate = appointment.appointment_date instanceof Date
        ? appointment.appointment_date.toISOString().slice(0, 10)
        : String(appointment.appointment_date || '').slice(0, 10);
      const rescheduled = await appointmentService.rescheduleAppointmentInPlace(
        id,
        {
          appointment_date: updateData.appointment_date ?? currentDate,
          appointment_time: updateData.appointment_time ?? appointment.appointment_time,
          notes: updateData.notes,
        },
        {
          tenantId,
          actorUid: req.user?.uid || null,
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
        },
      );
      updatedAppointment = rescheduled.appointment;
      if (updateData.reason !== undefined || updateData.visit_type !== undefined) {
        updatedAppointment = {
          ...updatedAppointment,
          ...(await appointmentService.updateAppointment(
            id,
            {
              reason: updateData.reason,
              visit_type: updateData.visit_type,
            },
            tenantId,
            req.user?.uid || null,
          )),
        };
      }
    } else {
      updatedAppointment = await appointmentService.updateAppointment(
        id,
        updateData,
        tenantId,
        req.user?.uid || null,
      );
    }

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

    emitAppointmentEvent('update', {
      tenantId,
      patientUid: updatedAppointment?.patient_uid ?? appointment.patient_uid ?? null,
      appointmentId: updatedAppointment?.id ?? appointment.id ?? id,
      status: updatedAppointment?.status ?? appointment.status ?? null,
    });

    success(res, {
      appointment: updatedAppointment,
      updated_by: req.user?.name,
      addendum: validation.isAddendum || false,
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_UPDATED);
  } catch (err) {
    logger.error('Error updating appointment:', err);
    return relayAppError(res, err, 'Failed to update appointment');
  }
};

function conflictDetailsFromError(err) {
  const code = err?.meta?.driverAdapterError?.cause?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  if (String(code) === '23505') {
    return { statusCode: HTTP_STATUS.CONFLICT, details: { code: 'APPOINTMENT_SLOT_CONFLICT' } };
  }
  if (
    err?.statusCode === HTTP_STATUS.CONFLICT
    && (err.conflictingId != null || err.conflictingTime != null || !err.code)
  ) {
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

/**
 * Tell the patient, durably, that staff moved their appointment.
 *
 * Before this, `rescheduleAppointment` emitted only
 * `emitAppointmentEvent('reschedule')` — a websocket fan-out that reaches the
 * patient ONLY if their app happens to be open at that instant. Confirm and
 * cancel both send push + SMS + an in-app row; reschedule sent nothing
 * durable, so a patient could arrive at the old time.
 *
 * Every effect here is post-commit and fire-and-forget. It runs inside
 * `setImmediate` with its own try/catch and never touches `res`: the
 * reschedule is already committed and its response must not be able to fail
 * on the notification tail. The patient lookup is deliberately INSIDE the
 * callback for the same reason — an awaited lookup in the request path would
 * turn a transient DB blip into a 500 on a write that succeeded.
 *
 * `appointment_rescheduled` is the type string, chosen because the patient
 * app's inbox tap handler already routes it to /appointments
 * (apps/patient/lib/features/notifications/screens/notifications_screen.dart).
 * The push itself is privacy-stripped to the /notifications inbox, so the
 * in-app row below is the readable copy — the push data type never routes.
 */
function notifyPatientOfReschedule({
  tenantId, appointmentId, patientId, patientUid, patientName, fallbackPhone,
  doctorName, department, newDate, newTime, previousDate, previousTime,
}) {
  if (!patientId && !patientUid) return;
  setImmediate(async () => {
    try {
      const formatDate = (value) => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime())
          ? String(value ?? '')
          : parsed.toLocaleDateString('en-IN');
      };
      const title = 'Appointment Rescheduled';
      const body =
        `Your appointment has been moved to ${formatDate(newDate)} at ${newTime}`
        + `${doctorName ? ` with Dr. ${doctorName}` : ''}.`
        + `${previousDate || previousTime
          ? ` It was previously ${formatDate(previousDate)}${previousTime ? ` at ${previousTime}` : ''}.`
          : ''}`
        + ' Please do not attend at the earlier time.';
      // Every value a string, and absent rather than null: this object is
      // also the FCM `data` map, where non-string values are rejected.
      const data = {
        type: 'appointment_rescheduled',
        appointment_id: String(appointmentId),
        ...(newDate ? { appointment_date: String(newDate) } : {}),
        ...(newTime ? { appointment_time: String(newTime) } : {}),
      };

      const identifier = patientId ?? patientUid;
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, uid::text AS uid, phone, device_token
           FROM users
          WHERE tenant_id = $1::uuid
            AND (id::text = $2 OR uid::text = $2)
          LIMIT 1`,
        tenantId,
        String(identifier),
      );
      const patient = rows[0] || null;
      const phone = patient?.phone || fallbackPhone || null;

      // 1. In-app row — the durable, readable copy. First, and unconditional:
      //    it is the only surface a patient with no registered device sees.
      await recordPatientFeedNotification({
        tenantId,
        userId: patient?.id ?? patientId ?? null,
        uid: patient?.uid || patientUid || null,
        phone,
        title,
        body,
        type: 'appointment_rescheduled',
        data,
        context: 'appointment-rescheduled',
      });

      // 2. Push (best-effort transport for the row above). Imported lazily:
      //    sendPushNotification pulls the whole websocket-server graph
      //    (wsServer → subscriptionAuth → accessDecisionService), which has no
      //    business in this controller's static module graph for a tail that
      //    only runs after the response.
      if (patient?.device_token) {
        const { sendPushNotification } = await import('../../utils/notifications/sendPushNotification.js');
        await sendPushNotification({
          tokens: patient.device_token,
          title,
          body,
          data,
          userId: String(patient.id),
        }).catch(e => logger.warn('Reschedule push failed:', e.message));
      }

      // 3. SMS intent — the channel that reaches a patient who never opens
      //    the app. queuePatientSms never throws and never claims delivery.
      if (phone) {
        const { queueAppointmentRescheduleSms } = await import('../../utils/notifications/smsOutbox.js');
        await queueAppointmentRescheduleSms({
          tenantId,
          recipientId: patient?.id ?? patientId ?? null,
          phone,
          patientName: patientName || 'Patient',
          doctorName,
          date: newDate,
          time: newTime,
          previousDate,
          previousTime,
          department,
          appointmentId,
        });
      }
    } catch (e) {
      logger.warn('Reschedule notification failed:', e.message);
    }
  });
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

    emitAppointmentEvent('reschedule', {
      tenantId,
      patientUid:
        result.appointment?.patient_uid ?? appointment.patient_uid ?? null,
      appointmentId: result.appointment?.id ?? appointment.id ?? id,
      status: result.appointment?.status ?? null,
    });

    notifyPatientOfReschedule({
      tenantId,
      appointmentId: result.appointment?.id ?? appointment.id ?? id,
      patientId: result.appointment?.patient_id ?? appointment.patient_id ?? null,
      patientUid: result.appointment?.patient_uid ?? appointment.patient_uid ?? null,
      patientName: result.appointment?.patient_name ?? appointment.patient_name ?? null,
      fallbackPhone: result.appointment?.phone ?? appointment.phone ?? null,
      doctorName: result.appointment?.doctor_name ?? appointment.doctor_name ?? null,
      department: result.appointment?.department ?? appointment.department ?? null,
      newDate: result.appointment?.appointment_date ?? null,
      newTime: result.appointment?.appointment_time ?? null,
      previousDate: result.previous?.appointment_date ?? appointment.appointment_date ?? null,
      previousTime: result.previous?.appointment_time ?? appointment.appointment_time ?? null,
    });

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
      return error(res, 'Time slot already booked', conflict.statusCode, {
        ...conflict.details,
        ...(err.code ? { topLevel: { code: err.code } } : {}),
      });
    }
    return relayAppError(res, err, 'Failed to reschedule appointment');
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
      req.user?.name || 'User',
      {
        tenantId,
        actorUid: req.user?.uid || null,
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        source: 'delete_cancel',
      },
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

    emitAppointmentEvent('cancel', {
      tenantId,
      patientUid:
        cancelledAppointment?.patient_uid ?? appointment.patient_uid ?? null,
      appointmentId: cancelledAppointment?.id ?? appointment.id ?? id,
      status: cancelledAppointment?.status ?? 'CANCELLED',
    });

    success(res, {
      appointment: cancelledAppointment,
      cancelled_by: req.user?.name
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_CANCELLED);
  } catch (err) {
    logger.error('Error cancelling appointment:', err);
    return relayAppError(res, err, 'Failed to cancel appointment');
  }
};
