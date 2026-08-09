// src/controllers/appointment/appointmentWorkflowController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { computeGestationalAge } from '../../services/maternity/maternityService.js';
import { recordCanonicalClinicalEvent } from '../../services/clinical/canonicalClinicalPlatformService.js';
import { queueAppointmentConfirmationSms } from '../../utils/notifications/smsOutbox.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { logAudit } from '../../utils/logAudit.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { canWriteAppointmentClinical } from '../../utils/appointment/appointmentHelpers.js';
import { isDoctor } from '../../utils/roleHelpers.js';
import { AppError } from '../../utils/AppError.js';
import { istDateString } from '../../utils/dateUtils.js';
import { resolveDoctorRef } from '../../services/doctor/doctorRefService.js';
import { emitAppointmentEvent } from '../../utils/websocket/realtimeEmitter.js';
import { ensureAppointmentQueueForAppointment } from '../../services/appointment/appointmentQueueService.js';
import { attachTeleconsultState } from '../../services/appointment/appointmentTeleconsultStateService.js';
import {
  lockAppointmentForLifecycleTx,
  recordAppointmentCreatedEvidenceTx,
  recordAppointmentMutationEvidenceTx,
  transitionAppointment,
} from '../../services/appointment/appointmentLifecycleService.js';
// Aliased: this file has its own request-level requireTenantId(req); this is the
// value-level fail-closed guard for the anti-spoof claim source below.
import { requireTenantId as requireTenantValue } from '../../services/tenant/tenantService.js';

const FULL_OP_QUEUE_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'MEDICAL_SUPERINTENDENT',
  'CMO',
  'CNO',
  'NURSING_SUPERINTENDENT',
  'NURSING_INCHARGE',
  'OP_STAFF_NURSE',
  'OP_INCHARGE',
  'RECEPTIONIST',
  'RECEPTION_INCHARGE',
  'BILLING_STAFF',
  'BILLING_INCHARGE',
  'FINANCE_INCHARGE',
  'ADMISSION_OFFICER',
  'INSURANCE_COORDINATOR',
  'IPD_COUNSELLOR',
]);

function canViewFullOpQueue(role) {
  return FULL_OP_QUEUE_ROLES.has(String(role || '').toUpperCase());
}

async function resolveDoctorDepartmentForQueue(doctorId) {
  const parsed = Number.parseInt(doctorId, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(dept.name, doc.department) AS department
       FROM doctors doc
       LEFT JOIN departments dept ON dept.id = doc.department_id
      WHERE doc.user_id = $1::int OR doc.id = $1::int
      LIMIT 1`,
    parsed,
  );
  const department = rows[0]?.department;
  return department ? String(department).trim().slice(0, 100) : null;
}

// All four handlers below were originally written against a raw pg.Pool
// client (await pool.connect → client.query → client.release) and ported
// poorly when the codebase moved to Prisma — every call crashed with
// `client.release is not a function`. Ported to prisma.$transaction here
// and stripped column references that don't exist in the live schema:
// no confirmed_by, no confirmation_notes, no no_show_at, no completed_at,
// no cancellation_reason. Status transitions live on the appointments
// row plus an immutable appointment_status_history audit row.

function appointmentWorkflowAuditMetadata(appointment, extra = {}) {
  return {
    appointment_id: appointment?.id ?? null,
    appointment_uid: appointment?.uid ?? null,
    patient_id: appointment?.patient_id ?? null,
    patient_uid: appointment?.patient_uid ?? null,
    doctor_id: appointment?.doctor_id ?? null,
    appointment_date: appointment?.appointment_date ?? null,
    appointment_time: appointment?.appointment_time ?? null,
    department: appointment?.department ?? null,
    visit_no: appointment?.visit_no ?? null,
    token_number: appointment?.token_number ?? null,
    status: appointment?.status ?? null,
    ...extra,
  };
}

function attachAppointmentPhiContext(req, appointment) {
  req.phiContext = {
    ...(req.phiContext ?? {}),
    appointmentId: appointment?.id ?? req.params?.id ?? null,
    appointment_id: appointment?.id ?? req.params?.id ?? null,
    patientId: appointment?.patient_id ?? null,
    patient_id: appointment?.patient_id ?? null,
    patientUid: appointment?.patient_uid ?? null,
    patient_uid: appointment?.patient_uid ?? null,
  };
}

function tenantOf(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId || req.tenant?.id || null;
}

function requireTenantId(req) {
  const tenantId = tenantOf(req);
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for appointment workflow access', 'TENANT_CONTEXT_REQUIRED');
  }
  return tenantId;
}

async function logAppointmentWorkflowAudit(req, action, appointment, extra = {}) {
  await logAudit(
    req,
    action,
    appointmentWorkflowAuditMetadata(appointment, extra),
    {
      resource: 'appointment',
      resourceId: appointment?.id ?? req.params?.id ?? null,
    },
  );
}

export const getDoctorOptions = async (req, res) => {
  try {
    const listQuery = parseListQuery(req.query, {
      defaultLimit: 100,
      maxLimit: 500,
      defaultSortBy: 'name',
      defaultSortOrder: 'ASC',
    });
    const params = [];
    // Picker endpoint — INNER JOIN with users.role='DOCTOR' so every option
    // is bookable. Pre-fix the LEFT JOIN returned rows whose linked user
    // was a PATIENT (or no user at all), and the receptionist's selection
    // bounced from POST /appointments/book with "Doctor not found".
    // Wave-3 fix for findings:
    //   2026-05-11-follow-up-opd-receptionist-e9992d3f
    //   2026-05-10-follow-up-opd-receptionist-unbookable-paediatric-doctor
    //   2026-05-10-emergency-walk-in-receptionist-doctor-handoff-id-mismatch
    //   2026-05-10-walk-in-opd-receptionist-doctor-roster-not-assignable
    const where = [
      'd.is_active = true',
      `u.role = 'DOCTOR'`,
      'u.is_active = true',
    ];

    if (listQuery.search) {
      params.push(`%${listQuery.search}%`);
      where.push(
        `(COALESCE(u.name, d.name) ILIKE $${params.length}
          OR COALESCE(d.department, '') ILIKE $${params.length}
          OR COALESCE(d.specialty, '') ILIKE $${params.length})`,
      );
    }

    // Optional specialty filter — passes through to a substring match so
    // ?specialty=Paediatrics narrows the picker for a paeds walk-in
    // without depending on age_range seed values being maintained.
    if (req.query.specialty) {
      params.push(`%${req.query.specialty}%`);
      where.push(`COALESCE(d.specialty, '') ILIKE $${params.length}`);
    }
    if (req.query.department) {
      params.push(String(req.query.department).toUpperCase());
      where.push(`UPPER(COALESCE(d.department, '')) = $${params.length}`);
    }
    if (req.query.ageRange && ['paediatric', 'adult', 'all'].includes(req.query.ageRange)) {
      params.push(req.query.ageRange);
      where.push(`(COALESCE(d.age_range, 'all') = $${params.length} OR COALESCE(d.age_range, 'all') = 'all')`);
    }

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total
         FROM doctors d
         INNER JOIN users u ON u.id = d.user_id
        WHERE ${where.join(' AND ')}`,
      ...params,
    );

    const total = countRows[0]?.total ?? 0;
    params.push(listQuery.limit, listQuery.offset);
    // `id` and `user_id` are both set to users.id — the canonical
    // identifier the booking endpoint stores in appointments.doctor_id.
    // `doctor_row_id` exposes the legacy doctors.id PK for admin pages
    // that still key on it. Callers should submit `id` (== user_id).
    const doctors = await prisma.$queryRawUnsafe(
      `SELECT
          u.id AS id,
          u.uid AS uid,
          u.id AS user_id,
          d.id AS doctor_row_id,
          COALESCE(u.name, d.name) AS name,
          COALESCE(d.department, '') AS department,
          COALESCE(d.specialty, '') AS specialization,
          d.is_available
         FROM doctors d
         INNER JOIN users u ON u.id = d.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(u.name, d.name) ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params,
    );

    success(res, {
      doctors,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    }, 'Appointment doctor options retrieved successfully');
  } catch (err) {
    logger.error('Error fetching appointment doctor options:', err);
    error(res, 'Failed to retrieve doctor options', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff confirms an appointment — assigns token, sets confirmed_at, notifies patient
 */
export const confirmAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = requireTenantId(req);
    const { confirmation_notes, appointment_date, appointment_time } = req.body;

    const transition = await transitionAppointment({
      tenantId,
      appointmentId: Number(id),
      toStatus: 'CONFIRMED',
      actorUid: req.user?.uid || null,
      actorId: req.user?.id || null,
      actorRole: req.user?.role || null,
      reason: confirmation_notes || null,
      source: 'confirm',
      mutate: async ({ tx, current }) => {
        const targetDate = appointment_date || current.appointment_date;
        const targetTime = appointment_time || current.appointment_time;
        const date = targetDate instanceof Date ? targetDate : new Date(targetDate);
        const yyyymmdd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const visitNoLikePrefix = `${deptPrefix(current.department)}-${yyyymmdd}-`;
        let tokenNumber = current.token_number;
        if (!tokenNumber) {
          const tokenRows = await tx.$queryRawUnsafe(
            `SELECT COALESCE(MAX(NULLIF(token_number, '')::integer), 0) + 1 AS next_token
               FROM appointments
              WHERE DATE(appointment_date) = DATE($1::date)
                AND confirmed_at IS NOT NULL
                AND token_number ~ '^[0-9]+$'
                AND visit_no LIKE $2::text || '%'
                AND tenant_id = $3::uuid`,
            targetDate,
            visitNoLikePrefix,
            tenantId,
          );
          tokenNumber = String(Number(tokenRows[0].next_token));
        }
        const visitNo = current.visit_no || composeVisitNo({
          department: current.department,
          date: targetDate,
          tokenNumber,
        });
        const rows = await tx.$queryRawUnsafe(
          `UPDATE appointments
              SET status = 'CONFIRMED',
                  confirmed_at = COALESCE(confirmed_at, NOW()),
                  token_number = COALESCE(token_number, $1::text),
                  appointment_date = $2::date,
                  appointment_time = $3::text,
                  visit_no = COALESCE(visit_no, $4::text),
                  sla_target_at = COALESCE(
                    sla_target_at,
                    created_at + INTERVAL '30 minutes'
                  ),
                  updated_by = COALESCE($5::uuid, updated_by),
                  updated_at = NOW()
            WHERE id = $6::integer
              AND tenant_id = $7::uuid
            RETURNING id, uid, patient_id, doctor_id, appointment_date,
                      appointment_time, status, reason, notes, token_number,
                      visit_no, confirmed_at, department, queue_id, tenant_id,
                      created_at, updated_at`,
          tokenNumber,
          targetDate,
          targetTime,
          visitNo,
          req.user?.uid || null,
          Number(id),
          tenantId,
        );
        let appointment = {
          ...current,
          ...rows[0],
          patient_uid: current.patient_uid,
          doctor_uid: current.doctor_uid,
        };
        const queue = await ensureAppointmentQueueForAppointment(tx, appointment, {
          actorUid: req.user?.uid,
          source: 'confirm',
        });
        if (queue) {
          appointment = {
            ...appointment,
            queue_id: queue.id,
            appointment_queue: queue,
          };
        }
        return {
          appointment,
          eventPayload: {
            token_number: appointment.token_number,
            visit_no: appointment.visit_no,
          },
        };
      },
    });
    const result = transition.appointment;
    const a = transition.previous;
    const tokenNumber = result.token_number;
    const newDate = result.appointment_date;
    const newTime = result.appointment_time;

    attachAppointmentPhiContext(req, result);
    await logAppointmentWorkflowAudit(req, 'FRONT_OFFICE_APPOINTMENT_CONFIRMED', result, {
      from_status: a.status,
      to_status: 'CONFIRMED',
      confirmation_notes: confirmation_notes || null,
    });

    // Notify patient via FCM + SMS (fire-and-forget, outside transaction).
    const patient = await prisma.$queryRawUnsafe('SELECT device_token, name, phone FROM users WHERE id=$1 AND tenant_id=$2::uuid', a.patient_id, tenantId);
    const patientRow = patient[0];
    const doctorRow = await prisma.$queryRawUnsafe(
      'SELECT u.name, doc.department FROM users u LEFT JOIN doctors doc ON doc.user_id = u.id WHERE u.id=$1 AND u.tenant_id=$2::uuid',
      a.doctor_id,
      tenantId,
    );
    const doctorName = doctorRow[0]?.name || 'Doctor';
    const department = doctorRow[0]?.department || a.department || null;

    setImmediate(async () => {
      try {
        if (patientRow?.device_token) {
          await sendPushNotification({
            tokens: patientRow.device_token,
            title: 'Appointment Confirmed ✓',
            body: `Your appointment on ${new Date(newDate).toLocaleDateString('en-IN')} at ${newTime} is confirmed. Token #${tokenNumber}`,
            data: { type: 'appointment_confirmed', appointment_id: String(id), token: String(tokenNumber) },
            userId: String(a.patient_id),
          });
        }
        const smsPhone = patientRow?.phone || a.phone;
        await queueAppointmentConfirmationSms({
          tenantId,
          recipientId: a.patient_id,
          phone: smsPhone,
          patientName: patientRow?.name || 'Patient',
          doctorName,
          date: newDate,
          time: newTime,
          tokenNumber,
          department,
          appointmentId: id,
        });
      } catch (e) { logger.warn('Appointment notification/SMS failed:', e.message); }
    });

    emitAppointmentEvent('confirm', { tenantId });
    success(res, result, `Appointment confirmed. Token #${tokenNumber}`);
  } catch (err) {
    return relayAppError(res, err, 'Failed to confirm appointment');
  }
};

/**
 * Staff marks appointment as no-show
 */
export const markNoShow = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = requireTenantId(req);
    const transition = await transitionAppointment({
      tenantId,
      appointmentId: Number(id),
      toStatus: 'NO_SHOW',
      actorUid: req.user?.uid || null,
      actorId: req.user?.id || null,
      actorRole: req.user?.role || null,
      source: 'no_show',
    });
    const result = transition.appointment;
    const prevStatus = transition.from_status;

    attachAppointmentPhiContext(req, result);
    await logAppointmentWorkflowAudit(req, 'FRONT_OFFICE_APPOINTMENT_NO_SHOW', result, {
      from_status: prevStatus,
      to_status: 'NO_SHOW',
    });

    emitAppointmentEvent('no-show', { tenantId });
    success(res, result, 'Marked as no-show');
  } catch (err) {
    return relayAppError(res, err, 'Failed');
  }
};

/**
 * Staff reschedules an appointment by closing the original row as
 * RESCHEDULED and creating a new linked SCHEDULED row for the target slot.
 * This preserves the original day's queue trail while showing the future
 * appointment on the requested date.
 */
export const rescheduleAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = requireTenantId(req);
    const staffId = req.user?.id;
    const actorUid = req.user?.uid || null;
    const { appointment_date, appointment_time } = req.body;
    const note = req.body.confirmation_notes || req.body.notes || null;

    if (!appointment_date || !appointment_time) {
      return error(
        res,
        'appointment_date and appointment_time are required to reschedule',
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    const auditNote = note
      ? `Rescheduled to ${appointment_date} ${appointment_time}: ${note}`
      : `Rescheduled to ${appointment_date} ${appointment_time}`;
    const transition = await transitionAppointment({
      tenantId,
      appointmentId: Number(id),
      toStatus: 'RESCHEDULED',
      actorUid,
      actorId: staffId || null,
      actorRole: req.user?.role || null,
      reason: auditNote,
      source: 'reschedule',
      eventType: 'appointment.rescheduled',
      resolveIdempotent: async ({ tx, current }) => {
        const existingRows = await tx.$queryRawUnsafe(
          `SELECT child.id, child.uid, child.patient_id, child.doctor_id,
                  child.appointment_date, child.appointment_time, child.status,
                  child.reason, child.notes, child.token_number, child.visit_no,
                  child.department, child.parent_appointment_id, child.queue_id,
                  child.tenant_id, child.created_at, child.updated_at
             FROM appointments AS child
             JOIN appointment_status_history AS history
               ON history.tenant_id = child.tenant_id
              AND history.appointment_id = child.parent_appointment_id
              AND history.to_status = 'RESCHEDULED'
              AND history.changed_by IS NOT DISTINCT FROM $6::integer
              AND history.reason = $7::text
            WHERE child.tenant_id = $1::uuid
              AND child.parent_appointment_id = $2::integer
              AND child.patient_id = $3::integer
              AND child.doctor_id IS NOT DISTINCT FROM $4::integer
              AND child.appointment_date = $5::date
              AND child.appointment_time = $8::text
            ORDER BY child.created_at ASC, child.id ASC
            LIMIT 2
            FOR SHARE OF child`,
          tenantId,
          Number(id),
          Number(current.patient_id),
          current.doctor_id == null ? null : Number(current.doctor_id),
          appointment_date,
          staffId || null,
          auditNote,
          appointment_time,
        );
        if (existingRows.length !== 1) {
          throw AppError.conflict(
            'The appointment was already rescheduled with a different or ambiguous replacement',
            'APPOINTMENT_RESCHEDULE_RETRY_MISMATCH',
          );
        }
        return {
          replacement: {
            ...existingRows[0],
            patient_uid: current.patient_uid,
            doctor_uid: current.doctor_uid,
          },
        };
      },
      mutate: async ({ tx, current }) => {
        if (current.doctor_id) {
        const conflicts = await tx.$queryRawUnsafe(
          `SELECT id
             FROM appointments
            WHERE doctor_id = $1::int
              AND appointment_date::date = $2::date
              AND appointment_time = $3
              AND id <> $4::int
              AND tenant_id = $5::uuid
              AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
            LIMIT 1
            FOR UPDATE`,
          Number(current.doctor_id),
          appointment_date,
          appointment_time,
          Number(id),
            tenantId,
          );
        if (conflicts.length) {
          const err = new Error('Time slot already booked');
          err.statusCode = HTTP_STATUS.CONFLICT;
          throw err;
        }
        }
        const newRows = await tx.$queryRawUnsafe(
        `INSERT INTO appointments (
           phone, patient_id, patient_name, doctor_id, doctor_name,
           appointment_date, appointment_time, reason, notes, status,
           department, visit_type, parent_appointment_id,
           payer_type, patient_category, insurer_name, policy_number, scheme_name,
           triage_acuity, created_by, updated_by, tenant_id, created_at, updated_at
         )
         SELECT
           phone, patient_id, patient_name, doctor_id, doctor_name,
           $2::date, $3, reason,
           CASE
             WHEN $4::text IS NOT NULL
             THEN COALESCE(notes || ' | ', '') || $4::text
             ELSE notes
           END,
           'SCHEDULED',
           department, visit_type, id,
           payer_type, patient_category, insurer_name, policy_number, scheme_name,
           triage_acuity, $5::uuid, $5::uuid, tenant_id, NOW(), NOW()
         FROM appointments
         WHERE id = $1::int
           AND tenant_id = $6::uuid
         RETURNING id, uid, patient_id, doctor_id, appointment_date, appointment_time,
                   status, reason, notes, token_number, visit_no, department,
                   parent_appointment_id, tenant_id, created_at, updated_at`,
        Number(id),
        appointment_date,
        appointment_time,
        note || `Rescheduled from appointment #${id}`,
        actorUid,
        tenantId,
        );
        let replacement = {
          ...newRows[0],
          patient_uid: current.patient_uid,
          doctor_uid: current.doctor_uid,
        };
        await recordAppointmentCreatedEvidenceTx(tx, {
          tenantId,
          appointment: replacement,
          actorUid,
          actorId: staffId || null,
          actorRole: req.user?.role || null,
          source: 'reschedule_replacement',
        });
        const queue = await ensureAppointmentQueueForAppointment(tx, replacement, {
        actorUid,
        source: 'reschedule',
      });
        if (queue) {
          replacement = {
            ...replacement,
          queue_id: queue.id,
          appointment_queue: queue,
        };
        }
        const updatedOriginal = await tx.$queryRawUnsafe(
        `UPDATE appointments
            SET status = 'RESCHEDULED',
                notes = CASE
                          WHEN $2::text IS NOT NULL
                          THEN COALESCE(notes || ' | ', '') || $2::text
                          ELSE notes
                        END,
                updated_by = COALESCE($3::uuid, updated_by),
                updated_at = NOW()
          WHERE id = $1::int
            AND tenant_id = $4::uuid
          RETURNING id, uid, patient_id, doctor_id, appointment_date, appointment_time,
                    status, reason, notes, token_number, visit_no, department,
                    tenant_id, updated_at`,
        Number(id),
        auditNote,
        actorUid,
        tenantId,
        );
        return {
          appointment: {
            ...current,
            ...updatedOriginal[0],
            patient_uid: current.patient_uid,
            doctor_uid: current.doctor_uid,
          },
          replacement,
          eventPayload: {
            replacement_appointment_id: Number(replacement.id),
            replacement_appointment_uid: replacement.uid || null,
            replacement_appointment_date: replacement.appointment_date,
            replacement_appointment_time: replacement.appointment_time,
          },
        };
      },
    });
    const original = transition.appointment;
    const replacement = transition.replacement;
    const prevStatus = transition.from_status;

    attachAppointmentPhiContext(req, original);
    if (!transition.idempotent) {
      await logAppointmentWorkflowAudit(req, 'FRONT_OFFICE_APPOINTMENT_RESCHEDULED', original, {
        from_status: prevStatus,
        to_status: 'RESCHEDULED',
        replacement_appointment_id: replacement.id,
        replacement_appointment_uid: replacement.uid || null,
        replacement_appointment_date: replacement.appointment_date,
        replacement_appointment_time: replacement.appointment_time,
        reschedule_note: note || null,
      });
      emitAppointmentEvent('reschedule', { tenantId });
    }
    success(res, {
      original,
      appointment: replacement,
    }, 'Appointment rescheduled');
  } catch (err) {
    return relayAppError(res, err, 'Failed to reschedule appointment');
  }
};

/**
 * Staff marks appointment as completed (patient visited)
 */
export const completeAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = requireTenantId(req);
    const staffId = req.user?.id;
    const { notes } = req.body;

    const transition = await transitionAppointment({
      tenantId,
      appointmentId: Number(id),
      toStatus: 'COMPLETED',
      actorUid: req.user?.uid || null,
      actorId: staffId || null,
      actorRole: req.user?.role || null,
      reason: notes || null,
      source: 'complete',
      authorize: ({ current }) => {
        if (
          isDoctor(req.user?.role)
          && current.doctor_id !== null
          && current.doctor_id !== undefined
          && !canWriteAppointmentClinical(
            { id: req.user.id, uid: req.user.uid, role: req.user.role },
            { doctor_id: current.doctor_id },
          )
        ) {
          throw AppError.forbidden(
            'You are not the assigned clinician for this appointment',
            'NOT_ASSIGNED_CLINICIAN',
          );
        }
      },
      mutate: async ({ tx, current }) => {
        const rows = await tx.$queryRawUnsafe(
          `UPDATE appointments
              SET status = 'COMPLETED',
                  notes = COALESCE($1::text, notes),
                  updated_by = COALESCE($2::uuid, updated_by),
                  updated_at = NOW()
            WHERE id = $3::integer
              AND tenant_id = $4::uuid
            RETURNING id, uid, patient_id, doctor_id, appointment_date,
                      appointment_time, status, notes, token_number, visit_no,
                      department, queue_id, tenant_id, updated_at`,
          notes || null,
          req.user?.uid || null,
          Number(id),
          tenantId,
        );
        return {
          appointment: {
            ...current,
            ...rows[0],
            patient_uid: current.patient_uid,
            doctor_uid: current.doctor_uid,
          },
        };
      },
    });
    const result = transition.appointment;
    const prevStatus = transition.from_status;
    const patientId = transition.previous.patient_id;

    attachAppointmentPhiContext(req, result);
    await logAppointmentWorkflowAudit(req, 'FRONT_OFFICE_APPOINTMENT_COMPLETED', result, {
      from_status: prevStatus,
      to_status: 'COMPLETED',
      clinical_notes_present: Boolean(notes),
    });

    // Schedule feedback request 2 hours after visit (fire-and-forget, outside transaction)
    setImmediate(async () => {
      try {
        const scheduled = await prisma.$queryRawUnsafe(
          `INSERT INTO scheduled_notifications (user_id, type, data, send_at, status)
           SELECT $1::int, 'feedback_request', $2::jsonb, NOW() + INTERVAL '2 hours', 'pending'
            WHERE EXISTS (
              SELECT 1
                FROM users u
                JOIN patient_consents pc
                  ON pc.patient_uid = u.uid
                 AND pc.tenant_id = $4::uuid
               WHERE u.id = $1::int
                 AND u.tenant_id = $4::uuid
                 AND pc.consent_type IN ('nps_survey', 'feedback', 'patient_feedback', 'care_reminder_push', 'care_reminder_whatsapp')
                 AND pc.granted IS TRUE
                 AND pc.status = 'active'
                 AND pc.revoked_at IS NULL
                 AND (pc.expires_at IS NULL OR pc.expires_at > NOW())
            )
              AND NOT EXISTS (
                SELECT 1
                  FROM scheduled_notifications sn
                 WHERE sn.user_id = $1::int
                   AND sn.type IN ('feedback_request', 'nps_request')
                   AND COALESCE(sn.data->>'appointment_id', '') = $3::text
                   AND COALESCE(sn.data->>'survey', '') = 'nps'
                   AND sn.status IN ('pending', 'sent')
              )
           RETURNING id`,
          patientId,
          JSON.stringify({ appointment_id: id, type: 'appointment_feedback', survey: 'nps' }),
          String(id),
          tenantId,
        );
        if (scheduled.length) {
          logger.info(`[Feedback] Scheduled NPS feedback request for appointment ${id} in 2h`);
        } else {
          logger.info(`[Feedback] Skipped NPS feedback request for appointment ${id}: consent missing or request already exists`);
        }
      } catch (e) {
        logger.warn('[Feedback] Failed to schedule feedback notification:', e.message);
      }
    });

    emitAppointmentEvent('complete', { tenantId });
    success(res, result, 'Appointment completed');
  } catch (err) {
    return relayAppError(res, err, 'Failed');
  }
};

/**
 * Staff/patient cancels appointment
 */
export const cancelAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = requireTenantId(req);
    const { cancellation_reason } = req.body;

    const transition = await transitionAppointment({
      tenantId,
      appointmentId: Number(id),
      toStatus: 'CANCELLED',
      actorUid: req.user?.uid || null,
      actorId: req.user?.id || null,
      actorRole: req.user?.role || null,
      reason: cancellation_reason || null,
      source: 'cancel',
    });
    const result = transition.appointment;
    const patientId = transition.previous.patient_id;
    const prevStatus = transition.from_status;

    attachAppointmentPhiContext(req, result);
    await logAppointmentWorkflowAudit(req, 'FRONT_OFFICE_APPOINTMENT_CANCELLED', result, {
      from_status: prevStatus,
      to_status: 'CANCELLED',
      cancellation_reason: cancellation_reason || null,
    });

    // Notify patient (fire-and-forget, outside transaction)
    const patient = await prisma.$queryRawUnsafe('SELECT device_token FROM users WHERE id=$1 AND tenant_id=$2::uuid', patientId, tenantId);
    if (patient[0]?.device_token) {
      setImmediate(async () => {
        try {
          await sendPushNotification({
            tokens: patient[0].device_token,
            title: 'Appointment Cancelled',
            body: `Your appointment has been cancelled. ${cancellation_reason || 'Please rebook.'}`,
            data: { type: 'appointment_cancelled', appointment_id: String(id) },
            userId: String(patientId),
          });
        } catch (e) { logger.warn('Cancel notification failed:', e.message); }
      });
    }

    emitAppointmentEvent('cancel', { tenantId });
    success(res, result, 'Appointment cancelled');
  } catch (err) {
    return relayAppError(res, err, 'Failed');
  }
};

/**
 * Get today's appointment queue for staff (sorted by token then time).
 *
 * A9 — accepts an explicit `doctor_id` (parsed to int — string binding
 * against the integer column previously 500'd) or, when called via the
 * /queue/today/mine alias, derives the doctor id from the JWT.
 */
export const getTodayQueue = async (req, res) => {
  try {
    const { department } = req.query;
    const role = String(req.user?.role || '').toUpperCase();
    const requesterIsDoctor = isDoctor(role);
    const requesterCanViewFullQueue = canViewFullOpQueue(role);

    if (
      role &&
      !requesterIsDoctor &&
      !requesterCanViewFullQueue &&
      req.params?.scope !== 'mine'
    ) {
      return error(
        res,
        'OP appointment queue is not available for this role',
        HTTP_STATUS.FORBIDDEN,
      );
    }

    // doctor_id source order: doctor JWT -> explicit query param -> JWT
    // (mine alias). Doctor-tier callers are always constrained to their
    // assigned queue, even if they pass someone else's doctor_id.
    // parseInt the param so raw SQL doesn't bind a string against an
    // integer column. Finding:
    // 2026-05-08-follow-up-opd-receptionist-queue-today-doctor-filter-500.
    let doctorId = null;
    if (requesterIsDoctor) {
      doctorId = req.user?.id ?? null;
      if (!doctorId) {
        return error(
          res,
          'Assigned doctor identity unavailable',
          HTTP_STATUS.FORBIDDEN,
        );
      }
    } else if (req.params?.scope === 'mine') {
      doctorId = req.user?.id ?? null;
    } else if (req.query.doctor_id !== undefined && req.query.doctor_id !== '') {
      const parsed = Number.parseInt(req.query.doctor_id, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return error(res, 'doctor_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
      }
      doctorId = parsed;
    }

    const doctorDepartment = requesterIsDoctor && doctorId !== null
      ? await resolveDoctorDepartmentForQueue(doctorId)
      : null;

    const today = istDateString();
    let where = `WHERE a.appointment_date::date = $1::date AND a.status NOT IN ('CANCELLED')`;
    const params = [today];
    if (doctorId !== null) {
      params.push(doctorId);
      const doctorParamIndex = params.length;
      if (requesterIsDoctor && doctorDepartment) {
        params.push(doctorDepartment);
        where += ` AND (a.doctor_id=$${doctorParamIndex} OR (a.doctor_id IS NULL AND LOWER(COALESCE(a.department, '')) = LOWER($${params.length})))`;
      } else {
        where += ` AND a.doctor_id=$${doctorParamIndex}`;
      }
    }
    if (department) { params.push(department); where += ` AND a.department=$${params.length}`; }

    // Surface ER triage on the doctor's appointment queue.
    // emergency_visits has no FK back to appointments; the canonical
    // link is patient_uid + same-day arrival. The doctor's UI needs:
    //   * triage_priority — the recorded ED scale code (esi_*, ats_*,
    //     ctas_*, manchester_*), or an esi_N derived from the
    //     appointment's integer triage_acuity (lower number = more urgent)
    //   * emergency_visit_id — so the row can deep-link into the ED chart
    //   * acuity_rank — a small integer for client-side sort hints
    //   * is_emergent — boolean banner flag
    // Sort rule: emergent acuity (rank 1-2 on ANY scale) first, then
    // existing token + scheduled-time order. Rank 3-5 (or no ED row)
    // fall back to the original order. Findings:
    // 2026-05-10-emergency-walk-in-nurse-doctor-queue-missing-acuity,
    // 2026-05-22-emergency-walk-in-nurse-2dd88574 (ATS-2 unranked).
    //
    // ACUITY_RANK_SQL maps every triage scale the ED accepts onto the
    // shared 1..5 urgency rank (1 = most urgent). It mirrors
    // edOperationsService.PRIORITY_RANK_SQL so the doctor queue and the
    // ED board agree on what "emergent" means. `prio` is the COALESCE'd
    // priority string injected by interpolation below (no user input).
    const acuityRankCase = (prio) => `CASE LOWER(COALESCE(${prio}, ''))
          WHEN 'esi_1' THEN 1 WHEN 'manchester_red' THEN 1 WHEN 'ctas_1' THEN 1 WHEN 'ats_1' THEN 1
          WHEN 'esi_2' THEN 2 WHEN 'manchester_orange' THEN 2 WHEN 'ctas_2' THEN 2 WHEN 'ats_2' THEN 2
          WHEN 'esi_3' THEN 3 WHEN 'manchester_yellow' THEN 3 WHEN 'ctas_3' THEN 3 WHEN 'ats_3' THEN 3
          WHEN 'esi_4' THEN 4 WHEN 'manchester_green' THEN 4 WHEN 'ctas_4' THEN 4 WHEN 'ats_4' THEN 4
          WHEN 'esi_5' THEN 5 WHEN 'manchester_blue' THEN 5 WHEN 'ctas_5' THEN 5 WHEN 'ats_5' THEN 5
          ELSE NULL
        END`;
    // The COALESCE'd triage-priority expression, reused in every derived
    // column so they stay in lock-step. No params — pure column SQL.
    const triagePrioExpr = `COALESCE(
          ed.triage_priority,
          CASE WHEN a.triage_acuity BETWEEN 1 AND 5 THEN 'esi_' || a.triage_acuity::text ELSE NULL END
        )`;
    const result = await prisma.$queryRawUnsafe(`
      WITH ed_today AS (
        SELECT DISTINCT ON (patient_uid)
          id AS emergency_visit_id,
          patient_uid,
          triage_priority,
          status        AS ed_status,
          chief_complaint AS ed_chief_complaint,
          arrival_at
        FROM emergency_visits
        WHERE DATE(arrival_at AT TIME ZONE 'Asia/Kolkata') = $1::date
          AND COALESCE(disposition, '') NOT IN ('discharged', 'lama', 'expired')
        ORDER BY patient_uid, arrival_at DESC
      ),
      -- ANC context for the queue. One ongoing pregnancy per patient
      -- (DISTINCT ON mirrors ed_today). lmp_date drives the GA the
      -- receptionist confirms verbally at check-in. Finding:
      -- 2026-05-09-obstetric-anc-receptionist-walkin-response-missing-ga.
      anc_preg AS (
        SELECT DISTINCT ON (patient_uid)
          id AS pregnancy_id,
          patient_uid,
          lmp_date,
          edd_date
        FROM maternity_pregnancies
        WHERE status = 'ongoing'
        ORDER BY patient_uid, created_at DESC
      )
      SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.appointment_time,
        a.status, a.reason, a.notes, a.token_number, a.department, a.confirmed_at, a.created_at, a.updated_at,
        a.visit_type, a.triage_acuity, a.queue_id,
        q.queue_kind, q.queue_label, q.status AS queue_status,
        q.queue_date, q.department_name AS queue_department_name,
        q.doctor_id AS queue_doctor_id,
        p.name as patient_name, p.phone as patient_phone, p.blood_group, p.uid as patient_uid,
        d.name as doctor_display_name, doc.specialty AS specialization,
        doc.department as doctor_department,
        mp.pregnancy_id,
        mp.lmp_date  AS anc_lmp_date,
        mp.edd_date  AS anc_edd_date,
        ed.emergency_visit_id,
        ${triagePrioExpr} AS triage_priority,
        ed.ed_status,
        ed.ed_chief_complaint,
        ${acuityRankCase(triagePrioExpr)} AS acuity_rank,
        CASE
          WHEN ${acuityRankCase(triagePrioExpr)} IN (1, 2) THEN TRUE
          ELSE FALSE
        END AS is_emergent
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
      LEFT JOIN appointment_queues q ON q.id = a.queue_id
      LEFT JOIN ed_today ed ON ed.patient_uid = p.uid
      LEFT JOIN anc_preg mp ON mp.patient_uid = p.uid
      ${where}
      ORDER BY
        -- Triaged ER rows (any scale, rank 1-5) jump ahead of routine
        -- OPD tokens; everything else keeps its token/time order.
        CASE WHEN ${acuityRankCase(triagePrioExpr)} IS NOT NULL THEN 0 ELSE 1 END,
        COALESCE(${acuityRankCase(triagePrioExpr)}, 9),
        a.token_number NULLS LAST,
        a.appointment_time
    `, ...params);

    // Decorate ANC rows with computed GA so the receptionist queue can
    // render "GA 24+0" without each client repeating the LMP math.
    const enriched = result.map((row) => {
      const appointmentQueue = row.queue_id
        ? {
            id: row.queue_id,
            queue_id: row.queue_id,
            queue_kind: row.queue_kind ?? null,
            queue_label: row.queue_label ?? null,
            status: row.queue_status ?? null,
            queue_date: row.queue_date ?? null,
            department_name: row.queue_department_name ?? null,
            doctor_id: row.queue_doctor_id ?? null,
          }
        : null;
      return {
        ...row,
        appointment_queue: appointmentQueue,
        ...(row.anc_lmp_date
          ? { gestational_age: computeGestationalAge(row.anc_lmp_date) }
          : {}),
      };
    });

    success(res, await attachTeleconsultState(enriched, prisma), "Today's queue fetched");
  } catch (err) {
    logger.error('Get Queue Error:', err);
    error(res, 'Failed to fetch queue', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get pending appointments (SCHEDULED, not yet confirmed)
 */
export const getPendingAppointments = async (req, res) => {
  try {
    const { from_date, to_date, doctor_id } = req.query;
    let where = `WHERE a.status = 'SCHEDULED'`;
    const params = [];
    if (from_date) { params.push(from_date); where += ` AND DATE(a.appointment_date) >= $${params.length}`; }
    if (to_date) { params.push(to_date); where += ` AND DATE(a.appointment_date) <= $${params.length}`; }
    // Same parseInt guard as getTodayQueue — string binding against the
    // integer doctor_id column 500'd in production.
    if (doctor_id !== undefined && doctor_id !== '') {
      const parsed = Number.parseInt(doctor_id, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return error(res, 'doctor_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
      }
      params.push(parsed);
      where += ` AND a.doctor_id=$${params.length}`;
    }

    const result = await prisma.$queryRawUnsafe(`
      SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.appointment_time,
        a.status, a.reason, a.token_number, a.department, a.sla_target_at, a.created_at, a.updated_at,
        p.name as patient_name, p.phone as patient_phone,
        d.name as doctor_name,
        EXTRACT(EPOCH FROM (NOW() - a.created_at))/60 as minutes_since_booking,
        CASE WHEN a.sla_target_at IS NOT NULL AND NOW() > a.sla_target_at THEN TRUE ELSE FALSE END as sla_breached
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      ${where}
      ORDER BY a.sla_target_at NULLS FIRST, a.created_at
    `, ...params);

    success(res, result, 'Pending appointments fetched');
  } catch (err) {
    logger.error('Get Pending Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * GET /api/v1/appointments/slots?doctor_id=X&date=YYYY-MM-DD
 * Returns available 30-min time slots for a doctor on a given date
 */
export const getAvailableSlots = async (req, res) => {
  try {
    const { doctor_id, date } = req.query;
    if (!doctor_id || !date) {
      return error(res, 'doctor_id and date are required', HTTP_STATUS.BAD_REQUEST);
    }

    // Doctor can be referenced by users.id OR doctors.id. The query
    // param arrives as a string ('1'); explicit ::int cast keeps the
    // comparison against integer columns valid.
    const doctorIdInt = parseInt(doctor_id, 10);
    if (!Number.isFinite(doctorIdInt)) {
      return error(res, 'doctor_id must be numeric', HTTP_STATUS.BAD_REQUEST);
    }
    const doctorQuery = await prisma.$queryRawUnsafe(
      `SELECT doc.id, doc.user_id, doc.department, doc.specialty AS specialization, doc.available_days, doc.available_hours, u.name as doctor_name
       FROM doctors doc
       JOIN users u ON doc.user_id = u.id
       WHERE doc.id = $1 OR doc.user_id = $1`,
      doctorIdInt
    );
    if (!doctorQuery.length) {
      return error(res, 'Doctor not found', HTTP_STATUS.NOT_FOUND);
    }
    const doc = doctorQuery[0];
    const doctorUserId = doc.user_id;

    const requestedDate = new Date(date);
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][requestedDate.getDay()];

    // Check if doctor works this day
    if (doc.available_days && doc.available_days.length > 0 && !doc.available_days.includes(dayName)) {
      return success(res, {
        available: false,
        reason: 'Doctor not available on this day',
        day: dayName,
        slots: []
      }, 'Doctor unavailable on this day');
    }

    // Get booked slots for this doctor on this date
    const booked = await prisma.$queryRawUnsafe(`
      SELECT appointment_time FROM appointments
      WHERE doctor_id = $1
        AND DATE(appointment_date) = DATE($2)
        AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
    `, doctorUserId, date);

    const bookedTimes = new Set(booked.map(r => r.appointment_time));

    // Generate slots from available_hours JSONB { "Monday": { "start": "09:00", "end": "17:00" } }
    const slots = [];
    if (doc.available_hours && doc.available_hours[dayName]) {
      const hours = doc.available_hours[dayName];
      const start = hours.start || '09:00';
      const end = hours.end || '17:00';
      const [startH, startM] = start.split(':').map(Number);
      const [endH, endM] = end.split(':').map(Number);
      let current = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      while (current < endMinutes) {
        const h = Math.floor(current / 60);
        const m = current % 60;
        const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        slots.push({ time: timeStr, available: !bookedTimes.has(timeStr) });
        current += 30;
      }
    } else {
      // Fallback: 9am-5pm in 30-min slots
      for (let h = 9; h < 17; h++) {
        for (const m of [0, 30]) {
          const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          slots.push({ time: timeStr, available: !bookedTimes.has(timeStr) });
        }
      }
    }

    success(res, {
      doctor_id: parseInt(doctor_id),
      doctor_user_id: doctorUserId,
      doctor_name: doc.doctor_name,
      date,
      day: dayName,
      total_slots: slots.length,
      available_slots: slots.filter(s => s.available).length,
      slots
    }, 'Slots fetched');
  } catch (err) {
    logger.error('getAvailableSlots Error:', err);
    error(res, 'Failed to fetch slots', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * POST /api/v1/appointments/walk-in
 * Register a walk-in patient — creates appointment directly in CONFIRMED state.
 *
 * Originally written against a raw pg.Pool client; ported to Prisma's
 * $transaction so it stops crashing with `client.release is not a function`
 * (the rest of the codebase moved to Prisma in batch 26+).
 */
// E-2 — Department → routing prefix used in human-readable visit_no.
// Compose visit_no as `${PREFIX}-YYYYMMDD-${padded_token}`. Routing
// pathways (ER triage, lab worklist filters, paeds doctor list) key
// off the prefix, so it must be deterministic and case-insensitive.
const DEPT_PREFIX_MAP = {
  emergency: 'EMER', emer: 'EMER', er: 'EMER', ed: 'EMER',
  laboratory: 'LAB', lab: 'LAB',
  radiology: 'RAD', rad: 'RAD',
  pharmacy: 'PHARM',
  paediatrics: 'PAEDS', pediatrics: 'PAEDS', paeds: 'PAEDS', peds: 'PAEDS',
  obgyn: 'ANC', obstetrics: 'ANC', anc: 'ANC',
  icu: 'ICU', ccu: 'ICU',
  cardiology: 'CARD',
  orthopaedics: 'ORTHO', orthopedics: 'ORTHO',
  gastroenterology: 'GASTRO',
  // General medicine / OPD fallback
  general: 'OPD', 'general medicine': 'OPD', medicine: 'OPD', opd: 'OPD',
};

export function deptPrefix(department) {
  if (!department) return 'OPD';
  const key = String(department).trim().toLowerCase();
  if (DEPT_PREFIX_MAP[key]) return DEPT_PREFIX_MAP[key];
  // Loose substring fallback so unseeded departments still get a sensible
  // prefix. Skip tiny aliases like "er" / "ed" here: exact "ER" and "ED"
  // still work, but "Smoke Medicine" must not become an EMER visit just
  // because "medicine" contains "ed".
  for (const [k, v] of Object.entries(DEPT_PREFIX_MAP)) {
    if (k.length < 3) continue;
    if (key.includes(k)) return v;
  }
  // Last resort: first 4 letters uppercased.
  return key.replace(/[^a-z]/g, '').slice(0, 4).toUpperCase() || 'OPD';
}

export function composeVisitNo({ department, date, tokenNumber }) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const padded = String(parseInt(tokenNumber, 10) || 0).padStart(3, '0');
  return `${deptPrefix(department)}-${yyyy}${mm}${dd}-${padded}`;
}

function parsePositiveInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = parseInt(text, 10);
  return parsed > 0 ? parsed : null;
}

async function resolveWalkInDepartment(tx, { department, departmentId, doctorId }) {
  const departmentText = department === null || department === undefined
    ? ''
    : String(department).trim();
  const numericDepartmentId = parsePositiveInt(departmentId) ?? parsePositiveInt(departmentText);

  if (departmentText && !numericDepartmentId) {
    return departmentText.slice(0, 100);
  }

  if (numericDepartmentId) {
    const rows = await tx.$queryRawUnsafe(
      'SELECT name FROM departments WHERE id = $1 LIMIT 1',
      numericDepartmentId,
    );
    if (rows[0]?.name) return String(rows[0].name).trim().slice(0, 100);
  }

  const numericDoctorId = parsePositiveInt(doctorId);
  if (numericDoctorId) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(dept.name, doc.department) AS department
         FROM doctors doc
         LEFT JOIN departments dept ON dept.id = doc.department_id
        WHERE doc.id = $1 OR doc.user_id = $1
        LIMIT 1`,
      numericDoctorId,
    );
    if (rows[0]?.department) return String(rows[0].department).trim().slice(0, 100);
  }

  return null;
}

export const registerWalkIn = async (req, res) => {
  try {
    const role = String(req.user?.role || '').toUpperCase();
    const canRegisterWalkIn = [
      'RECEPTIONIST',
      'ADMISSION_OFFICER',
      'IPD_COUNSELLOR',
      'ADMIN',
      'SUPER_ADMIN',
    ].includes(role);
    if (!canRegisterWalkIn) {
      return error(res, 'Access denied: front-desk privileges required to register walk-ins', 403);
    }

    // appointments.created_by is uuid; appointment_status_history.changed_by is int.
    const staffUid = req.user?.uid;
    const staffId = req.user?.id;
    // C4 — bind every row this walk-in creates to the AUTHENTICATED tenant
    // (set by jwtMiddleware as snake_case `tenant_id`). The users /
    // appointments inserts previously omitted tenant_id and silently fell to
    // the DB column default, and the emergency_visits insert read a
    // non-existent camelCase `req.user.tenantId` (always undefined) and so
    // also defaulted. The `x-tenant-id` header is deliberately NOT consulted
    // here — it must remain UNTRUSTED. Finding:
    //   2026-05-22-cross-tenant-rls-receptionist-0ff7bac5.
    const actingTenantId = requireTenantValue(req.user?.tenant_id);
    // Accept common field-name aliases before destructure so callers using
    // `date_of_birth` / `dob` / `gender` / `birthdate` are not silently
    // dropped. The Paediatrics walk-in flow hit this — the receptionist
    // dialog and the swarm both send `date_of_birth`, but the controller
    // only read `patient_birthday`, so birthdayIndicatesMinor never
    // fired and minor-with-guardian-phone collapsed onto the adult row.
    // Finding: 2026-05-18-pediatric-opd-receptionist-185a6357.
    if (req.body && typeof req.body === 'object') {
      if (req.body.patient_birthday == null) {
        req.body.patient_birthday = req.body.date_of_birth ?? req.body.dob ?? req.body.birthdate ?? null;
      }
      if (req.body.patient_gender == null) {
        req.body.patient_gender = req.body.gender ?? null;
      }
    }
    const {
      patient_name, patient_phone, patient_id,
      patient_birthday, patient_gender, patient_address,
      doctor_id, department, department_id, departmentId,
      reason, notes,
      // E-10 — accept both `time` and `appointment_time` so phone-booked
      // follow-ups don't have their slot time silently replaced by the
      // 'Walk-in' literal. Finding:
      // 2026-05-08-follow-up-opd-receptionist-walkin-ignores-time.
      // Plus visit_type so the doctor list / billing can branch on
      // NEW vs FOLLOW_UP. Finding:
      // 2026-05-08-follow-up-opd-doctor-no-visit-type-flag.
      appointment_time, time, visit_type, parent_appointment_id,
      // E-9 — guardian fields for paediatric / minor walk-ins. Migration 189.
      // Captured at registration so the chart links to the legal-consent
      // contact. Finding:
      // 2026-05-08-pediatric-opd-receptionist-no-guardian-model.
      guardian_name, guardian_phone, guardian_relationship,
      // Wave-3 batch-2 — structured guardian legal-ID + dependent-profile
      // link + paediatric weight. Migration 202. Findings:
      //   2026-05-10-pediatric-opd-receptionist-minor-guardian-id-not-structured
      //   2026-05-11-pediatric-opd-receptionist-7501ae08
      //   2026-05-09-pediatric-opd-patient-no-dependent-profile
      //   2026-05-08-pediatric-opd-receptionist-no-dob-no-gender-walkin
      guardian_id_type, guardian_id, guardian_id_reference, guardian_user_id,
      patient_weight_kg, weight_kg,
      // Wave-3 batch-2 — unidentified-patient ER path. Migration 202.
      // `mode === 'unidentified'` flips two switches: phone becomes
      // optional (we mint UNIDENT-EMER-<ts>), and the resulting users
      // row is flagged is_unidentified=true. Finding:
      //   2026-05-09-emergency-walk-in-receptionist-no-phone-optional-er-path.
      mode, unidentified, is_unidentified,
      approximate_age_years, approximate_age_months, approximate_age_days,
      approximate_age, age_estimate,
      // E-12 — ANC fields captured at walk-in. When department routes
      // to ANC, lmp_date / edd_date / gravida / parity / blood_group
      // are written into a maternity_pregnancies row alongside the
      // appointment. Finding:
      // 2026-05-08-obstetric-anc-receptionist-walkin-drops-anc-fields.
      lmp_date, edd_date, gravida, parity, living_children, abortions,
      // Stage-5 — medico-legal-case flag for emergency walk-ins. RTA /
      // assault / poisoning victims brought by police must be tagged MLC
      // at first contact for legal + insurance handling. The
      // emergency_visits.is_mlc column already exists; the walk-in
      // controller just never wrote to it. mlc_number / mlc_notes are
      // optional (the police FIR number is often not known at intake).
      // Finding:
      //   2026-05-09-emergency-walk-in-receptionist-no-mlc-flag-at-registration.
      mlc, is_mlc, mlc_number, mlc_notes, chief_complaint,
      // Stage-5 — structured payer / category / scheme fields. Corporate-TPA
      // and govt-scheme-eligible walk-ins previously had nowhere but
      // appointments.notes to record insurer / policy / scheme, which broke
      // claim preparation and eligibility warnings downstream. Findings:
      //   2026-05-10-walk-in-opd-receptionist-no-tpa-fields
      //   2026-05-11-dynamic-acute-abdomen-receptionist-6b6a9d03
      payer_type, patient_category, insurer_name, insurer, tpa_name,
      policy_number, scheme_name, scheme,
      // Stage-5 — lab-only walk-in panel ordering. A LAB_ONLY walk-in (cash
      // patient booking CBC + Lipid etc. with no consult) used to be
      // saved as a bare visit, forcing the receptionist to a second
      // /investigations/order screen — and the patient could reach the
      // lab counter with a visit number but no order waiting. `lab_tests`
      // is an array of test-name strings or {test_name,test_type,
      // priority} objects; the investigation rows are created in the
      // SAME transaction as the visit so they commit together. Finding:
      // 2026-05-10-lab-walk-in-receptionist-no-panel-order-on-register.
      lab_tests,
      // Safety-critical: persist allergies captured at registration so the
      // chart shows a known allergy on the first consult. Previously the
      // controller silently dropped the field on the create path, which
      // for paediatric Cefixime allergies is a prescribing-time hazard.
      // Finding: 2026-05-18-pediatric-opd-receptionist-185a6357.
      allergies,
      // H' D17 — Walk-in registration dropped chronic medications.
      // Migration 209 added users.chronic_medications JSONB so the
      // discharge medication draft can reconcile pre-admission therapy
      // (Metformin / Atorvastatin / Levothyroxine etc.) with new
      // takeaway meds. Without capturing them at the walk-in counter
      // the patient turned up to the first consult with a blank
      // chronic-med list, the doctor stopped a long-running statin
      // without realising it was chronic, and the discharge summary
      // had no "continue Metformin" line. Accept either of:
      //   * Structured array: [{ name, dose, frequency, indication }, ...]
      //   * Free-text string: comma-separated names, each becomes
      //     { name } so a no-effort entry still leaves an audit trail.
      // Aliases `current_medications` / `existing_medications` cover the
      // common receptionist-dialog naming. Findings:
      //   2026-05-22-walk-in-opd-receptionist-56a203d0
      //   2026-05-22-walk-in-opd-receptionist-16e99276
      //   2026-05-22-walk-in-opd-receptionist-313b7af0.
      chronic_medications, current_medications, existing_medications,
    } = req.body;
    // Resolved time honours either field; falls back to 'Walk-in' only
    // when nothing was supplied. `appointments.appointment_time` is
    // VARCHAR(10), so free-text inputs like "Walk-in immediate" used to
    // crash the whole walk-in with `value too long for type character
    // varying(10)`. Reject anything longer than 10 chars by falling back
    // to the canonical 'Walk-in' literal. See finding
    // 2026-05-10-dynamic-acute-abdomen-receptionist-walkin-endpoint-500.
    const rawResolvedTime = String(appointment_time || time || 'Walk-in').trim();
    const resolvedTime = rawResolvedTime.length > 0 && rawResolvedTime.length <= 10
      ? rawResolvedTime
      : 'Walk-in';
    // LAB_ONLY routes a walk-in directly to the lab counter without
    // creating doctor workload — needed for cash patients booking a
    // CBC / lipid panel etc. without a consult. Without it the
    // walk-in endpoint silently dropped the field and the visit
    // could only be classified by the free-text department. Finding:
    // 2026-05-10-lab-walk-in-receptionist-lab-only-visit-type-dropped.
    // PAEDIATRIC_OPD distinguishes a paediatric visit from adult OPD so
    // billing / reporting / weight-based-dosing prompts can branch on it
    // instead of every child registering as a plain NEW visit. Finding:
    // 2026-05-09-pediatric-opd-receptionist-no-paediatric-visit-type.
    const VALID_VISIT_TYPES = new Set([
      'NEW', 'FOLLOW_UP', 'EMERGENCY', 'TELE', 'LAB_ONLY', 'PAEDIATRIC_OPD',
    ]);
    const resolvedVisitType = visit_type && VALID_VISIT_TYPES.has(String(visit_type).toUpperCase())
      ? String(visit_type).toUpperCase()
      : null;

    // Stage-5 — MLC flag. Accept `mlc` or `is_mlc`; coerce the common
    // truthy string forms a walk-in dialog / direct API caller might send.
    // Written onto emergency_visits.is_mlc below — only EMER walk-ins
    // create that row, and MLC is by definition an emergency-context
    // concept (RTA / assault / poisoning brought by police).
    const mlcRaw = mlc ?? is_mlc;
    const mlcFlag = mlcRaw === true ||
      ['true', '1', 'yes', 'mlc'].includes(String(mlcRaw ?? '').trim().toLowerCase());
    const mlcNumber = mlc_number ? String(mlc_number).trim().slice(0, 80) : null;
    const mlcNotes = mlc_notes ? String(mlc_notes).trim().slice(0, 2000) : null;
    const chiefComplaint = chief_complaint
      ? String(chief_complaint).trim().slice(0, 500)
      : null;
    const parseApproxAge = (value, max) => {
      if (value === undefined || value === null || value === '') return null;
      const parsed = Number.parseInt(String(value), 10);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
    };
    const approxAgeYears = parseApproxAge(approximate_age_years ?? approximate_age ?? age_estimate, 130);
    const approxAgeMonths = parseApproxAge(approximate_age_months, 11);
    const approxAgeDays = parseApproxAge(approximate_age_days, 31);
    const approximateAge = (approxAgeYears !== null || approxAgeMonths !== null || approxAgeDays !== null)
      ? {
          years: approxAgeYears,
          months: approxAgeMonths,
          days: approxAgeDays,
          source: 'reception_estimate',
        }
      : null;

    // Stage-5 — structured payer fields persisted on the appointment row.
    // `patient_category` is validated against the funding-source enum;
    // the rest are length-capped free text. Aliases (`insurer`, `tpa_name`,
    // `scheme`) are accepted so the admin walk-in dialog and direct API
    // callers can both submit without an exact-key contract.
    const VALID_PATIENT_CATEGORIES = new Set([
      'cash', 'corporate', 'insurance', 'tpa', 'scheme',
    ]);
    const patientCategoryNorm = patient_category
      ? String(patient_category).trim().toLowerCase().replace(/[\s-]+/g, '_')
      : null;
    const resolvedPatientCategory = patientCategoryNorm
      ? (VALID_PATIENT_CATEGORIES.has(patientCategoryNorm)
          ? patientCategoryNorm
          // `corporate_tpa` is the receptionist's common label for a
          // corporate group's TPA-administered cover — normalise to `tpa`.
          : (patientCategoryNorm === 'corporate_tpa' ? 'tpa' : null))
      : null;
    const resolvedPayerType = payer_type ? String(payer_type).trim().slice(0, 30) : null;
    const resolvedInsurerName = (insurer_name || insurer || tpa_name)
      ? String(insurer_name || insurer || tpa_name).trim().slice(0, 160) : null;
    const resolvedPolicyNumber = policy_number ? String(policy_number).trim().slice(0, 80) : null;
    const resolvedSchemeName = (scheme_name || scheme)
      ? String(scheme_name || scheme).trim().slice(0, 120) : null;

    // Wave-3 batch-2 — unidentified-ER walk-in. Honours either
    // `mode === 'unidentified'` or a top-level `unidentified: true`,
    // and only when the receptionist is already routing to EMERGENCY
    // (the only clinical context where phone-less intake is correct —
    // every other walk-in must keep the de-dupe-by-phone invariant
    // intact). When active, we mint a synthetic placeholder phone so
    // the existing UNIQUE(phone) constraint stays honoured and a
    // future identity-merge flow has a stable target. Finding:
    //   2026-05-09-emergency-walk-in-receptionist-no-phone-optional-er-path
    // Accept the full department label too — "Emergency Medicine" /
    // "Emergency Department" / "ER" / "ED" all resolve to the same
    // clinical context. The literal-only allowlist used to require the
    // caller to send `department: "emergency"` exactly, so legitimate
    // walk-in dialogs that pass the full department name failed the
    // phone-less fast path even though the visit_type already said
    // EMERGENCY. Finding:
    // 2026-05-10-emergency-walk-in-receptionist-no-unidentified-fast-path.
    const departmentForCheck = String(department || '').trim().toLowerCase();
    const visitTypeUpper = String(visit_type || '').toUpperCase();
    const departmentLooksEmergency =
      ['emergency', 'emer', 'er', 'ed'].includes(departmentForCheck) ||
      departmentForCheck.includes('emergency') ||
      departmentForCheck.includes('casualty') ||
      visitTypeUpper === 'EMERGENCY';
    const unidentifiedRaw = unidentified ?? is_unidentified;
    const explicitUnidentified =
      unidentifiedRaw === true ||
      ['true', '1', 'yes', 'unidentified'].includes(
        String(unidentifiedRaw ?? '').trim().toLowerCase(),
      );
    const unidentifiedSignal =
      String(mode || '').toLowerCase() === 'unidentified' ||
      explicitUnidentified ||
      (visitTypeUpper === 'EMERGENCY' && !patient_phone && !patient_id);
    const isUnidentifiedMode = unidentifiedSignal && departmentLooksEmergency;
    // Normalize the inbound phone to E.164 before any de-dupe / INSERT
    // path runs. The admin walk-in dialog asks for a "10-digit mobile",
    // but every other code path (Firebase OTP, SMS service, dependent
    // linking) keys on +91XXXXXXXXXX. Without normalization, the same
    // patient can register once as `9812605791` and once as
    // `+919812605791`, producing two distinct rows. Finding:
    // 2026-05-10-walk-in-opd-receptionist-phone-format-misleading.
    let resolvedPhone = patient_phone && !String(patient_phone).startsWith('UNIDENT-')
      ? (normalizePhone(patient_phone) || patient_phone)
      : patient_phone;
    const normalizedGuardianPhone = guardian_phone
      ? (normalizePhone(guardian_phone) || String(guardian_phone).trim())
      : null;
    const birthdayIndicatesMinor = (() => {
      if (!patient_birthday || !/^\d{4}-\d{2}-\d{2}$/.test(patient_birthday)) return false;
      const dob = new Date(patient_birthday);
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 18);
      return dob > cutoff;
    })();

    // D74 — Minor walk-in must carry the guardian's legal identifier
    // (Aadhaar / PAN / passport / etc.) so the chart's legal-consent
    // contact is verifiable. Pre-fix: a paediatric registration with
    // `guardian_name` / `guardian_phone` / `guardian_relationship` set
    // but no `guardian_id_type` + `guardian_id` could complete, and
    // the minor's row went to the chart with an unverifiable consent
    // proxy — breaking IRDAI cashless-claim KYC, MLC paperwork (when
    // the minor escalates to ER), and the discharge-handover contact
    // check. Only fires on a CREATE path (no `patient_id`) so updates
    // to existing minor profiles still flow through the normal path
    // and don't strand legacy rows. `guardian_user_id` (a self-FK to
    // an existing adult users row) is an acceptable substitute — the
    // legal ID lives on that adult row instead. Finding:
    //   2026-05-22-pediatric-opd-receptionist-69db0787.
    if (!patient_id && birthdayIndicatesMinor) {
      const guardianIdRefRaw = guardian_id_reference || guardian_id;
      const guardianIdRefPresent = Boolean(
        guardianIdRefRaw && String(guardianIdRefRaw).trim().length > 0,
      );
      const guardianIdTypePresent = Boolean(
        guardian_id_type && String(guardian_id_type).trim().length > 0,
      );
      const guardianUserIdPresent = Number.isFinite(parseInt(guardian_user_id, 10))
        && parseInt(guardian_user_id, 10) > 0;
      if (!guardianUserIdPresent && !(guardianIdTypePresent && guardianIdRefPresent)) {
        return error(
          res,
          'Minor (<18) walk-in requires guardian legal ID: send '
            + 'guardian_id_type (aadhaar / pan / passport / ...) AND '
            + 'guardian_id (reference number), OR link to an existing '
            + 'adult via guardian_user_id.',
          HTTP_STATUS.BAD_REQUEST,
          { code: 'MINOR_GUARDIAN_ID_REQUIRED' },
        );
      }
    }
    // A minor being registered under the guardian's phone must NEVER merge
    // onto the guardian's patient row, even when the receptionist omitted DOB.
    // Triggers when EITHER signal fires:
    //   (a) DOB-confirmed minor sharing the guardian's phone, OR
    //   (b) guardian_name + guardian_relationship + guardian_phone all set
    //       AND guardian_phone matches patient_phone — an unambiguous
    //       "child being registered under parent's number" pattern.
    // Without (b), a 2-year-old whose DOB the receptionist forgot to fill in
    // silently merges onto the adult patient row, dropping name/gender/
    // allergies/guardian fields. Safety-critical for paeds prescribing.
    // Finding: 2026-05-18-pediatric-opd-receptionist-185a6357.
    const guardianRelPresent = Boolean(
      guardian_relationship && String(guardian_relationship).trim().length > 0,
    );
    const guardianNamePresent = Boolean(
      guardian_name && String(guardian_name).trim().length > 0,
    );
    const looksLikeDependentRegistration =
      guardianNamePresent && guardianRelPresent;
    const minorUsesGuardianPhone = Boolean(
      !patient_id &&
      (birthdayIndicatesMinor || looksLikeDependentRegistration) &&
      normalizedGuardianPhone &&
      resolvedPhone &&
      normalizePhone(resolvedPhone) === normalizedGuardianPhone,
    );
    let isUnidentifiedFlag = false;
    if (isUnidentifiedMode && !patient_id) {
      // "UNIDENT-EMER-" + a 13-digit timestamp would overflow
      // VARCHAR(15). Use "UNIDENT-" + a 6-char base36 timestamp suffix
      // instead — fits in 15 chars, collision-resistant
      // over the lifetime of a hospital ER shift. Phone-search-hash on
      // this row is intentionally NULL; the row is merge-me target, not
      // an OTP recipient.
      resolvedPhone = `UNIDENT-${Date.now().toString(36).slice(-6).toUpperCase().padStart(6, '0')}`;
      isUnidentifiedFlag = true;
    }

    if (!resolvedPhone && !patient_id) {
      return error(res, 'patient_phone or patient_id is required', HTTP_STATUS.BAD_REQUEST);
    }

    // Phase 0 — DOCTOR-role gate. The walk-in admin dialog already
    // requests `assignable=true` from `/doctors` (Wave-3 doctor-roster
    // fix, commit 60ba8fba), so legitimate UI submissions always
    // resolve to a DOCTOR-role user. This is the defense-in-depth
    // check at the API boundary: a malformed payload (legacy client,
    // direct API consumer, race against a role downgrade) must not be
    // able to write a PATIENT- or RECEPTIONIST-role doctor_id onto the
    // appointment row. The ANC walk-in path is the highest-leverage
    // case — finding
    // 2026-05-10-obstetric-anc-doctor-visit-assigned-to-non-doctor —
    // because the assigned "doctor" surfaced on every downstream
    // chart, prescription PDF, and TPA claim header.
    let explicitDoctorUserId = null;
    if (doctor_id !== undefined && doctor_id !== null && doctor_id !== '') {
      const doctorIdInt = parsePositiveInt(doctor_id);
      if (!doctorIdInt) {
        return error(res, 'doctor_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
      }
      // Accept either users.id (assignable-mode dropdown) or an unambiguous
      // legacy doctors.id, but write only the canonical users.id into
      // appointments.doctor_id. Ambiguous collisions are rejected instead of
      // picking a clinician by accident.
      const resolvedDoctor = await resolveDoctorRef(prisma, doctorIdInt, { tenantId: actingTenantId });
      explicitDoctorUserId = resolvedDoctor?.id ?? null;
      if (!explicitDoctorUserId) {
        return error(
          res,
          `doctor_id ${doctorIdInt} is not an active DOCTOR — use /doctors?assignable=true to pick`,
          HTTP_STATUS.BAD_REQUEST,
          { code: 'INVALID_DOCTOR_ID' },
        );
      }
    }

    // Phase 0 — minor patient guard. Creating a new patient under 18
    // without guardian fields leaves consent forms, discharge handoffs,
    // and emergency call-back chains with nobody on file. Skip the
    // check for returning patients (already in the DB — guardian was
    // collected on the original registration) and for unidentified-ER
    // walk-ins (the family may not have arrived yet; merge flow will
    // attach guardian later). Finding:
    //   2026-05-09-pediatric-opd-receptionist-no-minor-age-guard.
    if (!patient_id && !isUnidentifiedMode && patient_birthday
        && /^\d{4}-\d{2}-\d{2}$/.test(patient_birthday)) {
      const dob = new Date(patient_birthday);
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 18);
      if (dob > cutoff) {
        const missing = [];
        if (!guardian_name || !String(guardian_name).trim()) missing.push('guardian_name');
        if (!guardian_phone || !String(guardian_phone).trim()) missing.push('guardian_phone');
        if (!guardian_relationship || !String(guardian_relationship).trim()) {
          missing.push('guardian_relationship');
        }
        if (missing.length) {
          return error(
            res,
            `Minor patient (age < 18) requires guardian fields: ${missing.join(', ')}`,
            HTTP_STATUS.BAD_REQUEST,
            { code: 'GUARDIAN_REQUIRED_FOR_MINOR', missing },
          );
        }
      }
    }

    const result = await setTenantTx(actingTenantId, async (tx) => {
      let appointmentDepartment = await resolveWalkInDepartment(tx, {
        department,
        departmentId: department_id ?? departmentId,
        doctorId: doctor_id,
      });
      if (!appointmentDepartment && resolvedVisitType === 'EMERGENCY') {
        appointmentDepartment = 'Emergency';
      }

      // Resolve patient — look up by phone or patient_id, or create minimal record.
      // `returning_patient` is set when a phone match found an existing row so
      // the admin UI can banner "Returning patient — last visit on …" and the
      // receptionist doesn't accidentally create a duplicate. See finding
      // 2026-05-08-follow-up-opd-receptionist-walkin-no-returning-patient-banner.
      let patientId = patient_id ? parseInt(patient_id) : null;
      let returningPatient = false;
      let priorVisitCount = 0;
      let lastVisitAt = null;
      if (patient_id && patientId) {
        // Caller already had a patient_id — count their prior visits so the UI
        // can still show context.
        const priors = await tx.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS count, MAX(created_at) AS last
             FROM appointments WHERE patient_id = $1`,
          patientId,
        );
        priorVisitCount = priors[0]?.count ?? 0;
        lastVisitAt = priors[0]?.last ?? null;
        returningPatient = priorVisitCount > 0;
      } else if (!patientId && resolvedPhone) {
        // Phone-based de-dupe only runs for real phones, not the
        // UNIDENT-EMER-* placeholder — every unidentified ER walk-in
        // is by definition a new row (a future identity-merge flow
        // collapses them once family arrives with ID).
        const existing = isUnidentifiedFlag || minorUsesGuardianPhone
          ? []
          : await tx.$queryRawUnsafe(
              `SELECT id FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
              resolvedPhone,
              resolvedPhone.replace(/\D/g, '').slice(-10),
            );
        if (existing.length > 0) {
          patientId = existing[0].id;
          returningPatient = true;
          const priors = await tx.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS count, MAX(created_at) AS last
               FROM appointments WHERE patient_id = $1`,
            patientId,
          );
          priorVisitCount = priors[0]?.count ?? 0;
          lastVisitAt = priors[0]?.last ?? null;
        } else {
          // updated_at is NOT NULL with no default — pass it explicitly.
          // Demographics (birthday/gender/address) are stored on the
          // initial create so the doctor doesn't have to re-collect them
          // at consult. See finding
          // 2026-05-08-walk-in-opd-receptionist-walkin-dialog-missing-demographics.
          const birthday = patient_birthday && /^\d{4}-\d{2}-\d{2}$/.test(patient_birthday)
            ? patient_birthday
            : null;
          // Normalise gender case-insensitively. The admin walk-in dialog
          // and external API callers typically send 'Male' / 'Female'
          // (capitalised) — the previous allowlist only matched the exact
          // lowercase form or single-char M/F/O, so those values silently
          // dropped to null. We now key on the first letter and validate
          // against the canonical set. Finding (follow-up):
          // 2026-05-18-pediatric-opd-receptionist-gender-capitalisation-dropped.
          const gender = (() => {
            const first = String(patient_gender ?? '').trim().toLowerCase().slice(0, 1);
            if (first === 'm') return 'male';
            if (first === 'f') return 'female';
            if (first === 'o') return 'other';
            return null;
          })();
          const address = patient_address ? String(patient_address).trim().slice(0, 500) : null;
          // E-9 — guardian fields persisted at registration for paeds.
          // Validate relationship enum lazily (free text is fine for
          // 'sister' / 'aunt' etc. that aren't in the canonical set).
          const validRel = ['mother', 'father', 'grandparent', 'legal_guardian', 'spouse', 'sibling', 'other'];
          const guardianRel = guardian_relationship && validRel.includes(String(guardian_relationship).toLowerCase())
            ? String(guardian_relationship).toLowerCase()
            : (guardian_relationship ? String(guardian_relationship).slice(0, 40) : null);
          // Wave-3 batch-2 — structured guardian legal-ID + dependent-profile
          // link + paediatric weight. Migration 202. Free-text ID kinds
          // outside the CHECK allowlist fall back to 'other' rather than
          // crashing the registration; the reference itself stays as
          // typed (the platform stores last4 / masked refs, not full PII).
          const validIdTypes = new Set([
            'aadhaar', 'pan', 'voter_id', 'passport', 'driving_licence',
            'ration_card', 'abha', 'other',
          ]);
          const guardianIdTypeNorm = guardian_id_type
            ? String(guardian_id_type).toLowerCase().trim().replace(/\s+/g, '_')
            : null;
          const guardianIdType = guardianIdTypeNorm
            ? (validIdTypes.has(guardianIdTypeNorm) ? guardianIdTypeNorm : 'other')
            : null;
          const guardianIdRef = (guardian_id_reference || guardian_id)
            ? String(guardian_id_reference || guardian_id).trim().slice(0, 80)
            : null;
          // guardian_user_id is a self-FK on users; only accept positive ints.
          let guardianUserIdInt = (() => {
            const n = parseInt(guardian_user_id, 10);
            return Number.isFinite(n) && n > 0 ? n : null;
          })();
          const weightKgRaw = patient_weight_kg ?? weight_kg;
          const weightKg = weightKgRaw !== undefined && weightKgRaw !== null && weightKgRaw !== ''
            ? (() => {
                const n = Number(weightKgRaw);
                // NUMERIC(6,2) → 9999.99 max. Reject NaN, negatives, and
                // absurd values rather than letting Postgres throw.
                return Number.isFinite(n) && n > 0 && n <= 9999.99 ? n : null;
              })()
            : null;
          // is_minor derives from birthday — 18y is the cutoff (Indian
          // age-of-majority + legal-consent threshold). The DB column
          // has a backfill from migration 202 for legacy rows.
          let isMinor = false;
          if (birthday) {
            const dob = new Date(birthday);
            const cutoff = new Date();
            cutoff.setFullYear(cutoff.getFullYear() - 18);
            isMinor = dob > cutoff;
          }
          if (isMinor && !guardianUserIdInt && normalizedGuardianPhone) {
            const guardianRows = await tx.$queryRawUnsafe(
              `SELECT id
                 FROM users
                WHERE phone = $1 OR phone = $2
                ORDER BY CASE WHEN phone = $1 THEN 0 ELSE 1 END
                LIMIT 1`,
              normalizedGuardianPhone,
              normalizedGuardianPhone.replace(/\D/g, '').slice(-10),
            );
            if (guardianRows[0]?.id) {
              guardianUserIdInt = guardianRows[0].id;
            } else {
              const newGuardian = await tx.$queryRawUnsafe(
                `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
                 VALUES ($1, $2, 'PATIENT', true, $3::uuid, NOW())
                 RETURNING id`,
                normalizedGuardianPhone,
                guardian_name ? String(guardian_name).trim().slice(0, 160) : 'Guardian',
                actingTenantId,
              );
              guardianUserIdInt = newGuardian[0].id;
            }
          }
          const patientPhoneForInsert = minorUsesGuardianPhone
            ? `DEPEND-${Date.now().toString(36).slice(-8).toUpperCase().padStart(8, '0')}`
            : resolvedPhone;
          const allergiesText = allergies
            ? String(allergies).trim().slice(0, 1000)
            : null;
          // H' D17 — normalise the chronic-medication input into the
          // JSONB shape `dischargeService` reconciles against. Caller
          // may supply structured array, a free-text comma list, or
          // skip the field entirely. Aliases collapse to the first
          // present source.
          const chronicMedsInput = chronic_medications ?? current_medications ?? existing_medications ?? null;
          let chronicMedsArr = null;
          if (Array.isArray(chronicMedsInput)) {
            chronicMedsArr = chronicMedsInput
              .map((m) => {
                if (!m) return null;
                if (typeof m === 'string') {
                  const name = m.trim().slice(0, 120);
                  return name ? { name } : null;
                }
                if (typeof m === 'object') {
                  const name = String(m.name || m.drug || '').trim().slice(0, 120);
                  if (!name) return null;
                  const entry = { name };
                  if (m.dose) entry.dose = String(m.dose).trim().slice(0, 60);
                  if (m.frequency) entry.frequency = String(m.frequency).trim().slice(0, 60);
                  if (m.indication) entry.indication = String(m.indication).trim().slice(0, 120);
                  return entry;
                }
                return null;
              })
              .filter(Boolean);
          } else if (typeof chronicMedsInput === 'string' && chronicMedsInput.trim().length > 0) {
            chronicMedsArr = chronicMedsInput
              .split(/[,\n;]+/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((name) => ({ name: name.slice(0, 120) }));
          }
          const chronicMedsJson = chronicMedsArr && chronicMedsArr.length > 0
            ? JSON.stringify(chronicMedsArr)
            : null;
          const newUser = await tx.$queryRawUnsafe(
            `INSERT INTO users (phone, name, birthday, gender, address, role,
                                guardian_name, guardian_phone, guardian_relationship,
                                guardian_id_type, guardian_id_reference, guardian_user_id,
                                weight_kg, is_minor, is_unidentified,
                                allergies,
                                chronic_medications, chronic_medications_updated_at,
                                tenant_id,
                                updated_at)
             VALUES ($1, $2, $3::date, $4, $5, 'PATIENT',
                     $6, $7, $8,
                     $9, $10, $11,
                     $12, $13, $14,
                     $15,
                     COALESCE($16::jsonb, '[]'::jsonb),
                     CASE WHEN $16 IS NOT NULL THEN NOW() ELSE NULL END,
                     $17::uuid,
                     NOW())
             RETURNING id`,
            patientPhoneForInsert,
            patient_name || (isUnidentifiedFlag ? 'Unidentified Patient' : 'Walk-in Patient'),
            birthday,
            gender,
            address,
            guardian_name ? String(guardian_name).trim().slice(0, 160) : null,
            normalizedGuardianPhone ? String(normalizedGuardianPhone).trim().slice(0, 20) : null,
            guardianRel,
            guardianIdType,
            guardianIdRef,
            guardianUserIdInt,
            weightKg,
            isMinor,
            isUnidentifiedFlag,
            allergiesText,
            chronicMedsJson,
            actingTenantId,
          );
          patientId = newUser[0].id;
          resolvedPhone = patientPhoneForInsert;
          returningPatient = false;
        }
      }

      // Atomic token number — scoped by (date, deptPrefix). A global-per-day
      // counter would mean the EMER walk-in and the OPD walk-in compete for
      // the same #8, but the receptionist on the ER counter expects
      // EMER-prefix tokens.
      //
      // The earlier implementation (E-2) scoped by raw `department` text,
      // which broke when multiple departments mapped to the same prefix —
      // e.g. NULL-department and 'General Medicine' both produce visit_no
      // OPD-YYYYMMDD-NNN, but ran independent counters from 1, so the
      // second department's first INSERT collided on visit_no's UNIQUE
      // constraint (idx_appointments_visit_no_unique) and 500'd. Switching
      // the scope to the LIKE-prefix of the visit_no we're about to compose
      // makes the counter consistent with what we'll actually persist.
      // Findings:
      //   2026-05-08-emergency-walk-in-receptionist-token-not-dept-scoped
      //   2026-05-08-emergency-walk-in-receptionist-visit-no-format
      //   2026-05-08-lab-walk-in-receptionist-no-dept-scoped-visit-no
      //   2026-05-08-dynamic-acute-abdomen-receptionist-walkin-token-not-dept-scoped
      //   2026-05-15-dynamic-acute-abdomen-receptionist-6e92df1b
      const todayDate = istDateString();
      const yyyymmdd = todayDate.replace(/-/g, '');
      const visitNoLikePrefix = `${deptPrefix(appointmentDepartment)}-${yyyymmdd}-`;
      const tokenResult = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(NULLIF(token_number, '')::int), 0) + 1 AS next_token
         FROM appointments
         WHERE appointment_date::date = $2::date
           AND confirmed_at IS NOT NULL
           AND token_number IS NOT NULL
           AND token_number ~ '^[0-9]+$'
           AND visit_no LIKE $1 || '%'`,
        visitNoLikePrefix,
        todayDate,
      );
      const tokenNumber = String(parseInt(tokenResult[0].next_token));

      // Compose the human-readable visit_no BEFORE the INSERT so we can
      // persist it on the row. Previously this was computed post-INSERT
      // and only echoed in the response, so search-by-visit_no found
      // nothing. Migration 217 added the column. Finding:
      // 2026-05-10-inpatient-admission-receptionist-visit-no-not-persisted.
      const visitNo = composeVisitNo({
        department: appointmentDepartment,
        date: todayDate,
        tokenNumber,
      });

      // Auto-assign next-available DOCTOR in the requested department when
      // the caller didn't pass doctor_id explicitly. Picks the doctor with
      // the fewest confirmed appointments today (least-loaded) and ties
      // break on users.id (deterministic). Without this the appointment
      // row is created with doctor_id=null and the receptionist has no
      // in-flow way to set it (PUT /appointments/:id is SUPER_ADMIN-only).
      // Findings:
      //   2026-05-17-walk-in-opd-receptionist-a99111c4
      //   2026-05-17-walk-in-opd-receptionist-e00d0e2e
      //   2026-05-18-dynamic-acute-abdomen-doctor-078cf751
      //   Paediatric variants where doctor_id stayed null for under-12 visits.
      let resolvedDoctorIdForInsert = explicitDoctorUserId;
      if (!resolvedDoctorIdForInsert && appointmentDepartment) {
        const candidates = await tx.$queryRawUnsafe(
          `SELECT u.id
             FROM users u
             JOIN doctors d ON d.user_id = u.id
             LEFT JOIN departments dept ON dept.id = d.department_id
            WHERE u.role = 'DOCTOR'
              AND u.is_active = true
              AND d.is_active = true
              AND (
                LOWER(COALESCE(dept.name, '')) = LOWER($1)
                OR LOWER(COALESCE(d.department, '')) = LOWER($1)
              )
            ORDER BY (
              SELECT COUNT(*) FROM appointments a
               WHERE a.doctor_id = u.id
                 AND a.appointment_date::date = $2::date
                 AND a.status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
            ) ASC, u.id ASC
            LIMIT 1`,
          appointmentDepartment,
          todayDate,
        );
        if (candidates.length > 0) {
          resolvedDoctorIdForInsert = candidates[0].id;
        }
      }

      // Same-day duplicate detection — pre-flight check. The receptionist
      // walking the patient through registration twice in the same minute
      // is a real workflow (paper-then-system, hand-off swap, accidental
      // resubmit) and should produce a visible warning rather than
      // silently creating a second active appointment + duplicate token
      // number for the doctor's queue. Find any non-cancelled same-day
      // visits for this patient with the same doctor — surface them on
      // the response so the admin UI can banner "Patient already has 1
      // open visit today — view existing? / create another anyway?".
      //
      // Finding: 2026-05-15-follow-up-opd-receptionist-35d7694d.
      let sameDayDuplicates = [];
      if (patientId) {
        sameDayDuplicates = await tx.$queryRawUnsafe(
          `SELECT id, visit_no, status, doctor_id, appointment_time, created_at
             FROM appointments
            WHERE patient_id = $1::int
              AND appointment_date::date = $3::date
              AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
              AND ($2::int IS NULL OR doctor_id = $2::int)
            ORDER BY created_at ASC`,
          patientId,
          resolvedDoctorIdForInsert || null,
          todayDate,
        );
      }

      // appointments has no `confirmed_by` column. created_by is uuid.
      // phone, appointment_date, appointment_time, updated_at are NOT NULL.
      // E-10 — visit_type + parent_appointment_id captured at walk-in time
      // (migration 190).
      const apptRows = await tx.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
            status, confirmed_at, token_number, visit_no, department, created_by, updated_at,
            visit_type, parent_appointment_id,
            payer_type, patient_category, insurer_name, policy_number, scheme_name,
            tenant_id)
         VALUES ($1, $2, $18::date, $3, $4, $5, $6, 'CONFIRMED', NOW(), $7, $8, $9, $10::uuid, NOW(),
                 $11, $12,
                 $13, $14, $15, $16, $17,
                 $19::uuid)
         RETURNING id, uid, patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
                   status, confirmed_at, token_number, visit_no, department, created_at,
                   visit_type, parent_appointment_id,
                   payer_type, patient_category, insurer_name, policy_number, scheme_name,
                   tenant_id`,
        patientId,
        resolvedDoctorIdForInsert,
        resolvedTime,
        // Wave-3 batch-2 — use the resolved phone so an unidentified-ER
        // walk-in's appointment row carries the UNIDENT-* synthetic
        // identifier instead of the empty-string default; downstream
        // ED queue / nurse worklist join on phone to locate the patient.
        resolvedPhone || '',
        reason || chiefComplaint || 'Walk-in consultation',
        notes || null,
        tokenNumber,
        visitNo,
        appointmentDepartment,
        staffUid,
        resolvedVisitType,
        parent_appointment_id ? parseInt(parent_appointment_id, 10) || null : null,
        // Stage-5 — structured payer / category / scheme columns (migration 228).
        resolvedPayerType,
        resolvedPatientCategory,
        resolvedInsurerName,
        resolvedPolicyNumber,
        resolvedSchemeName,
        todayDate,
        // C4 — bind the appointment to the authenticated tenant ($19).
        actingTenantId,
      );
      const appt = apptRows[0];
      const patientIdentityRows = await tx.$queryRawUnsafe(
        `SELECT uid
           FROM users
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
          LIMIT 1`,
        actingTenantId,
        patientId,
      );
      appt.patient_uid = patientIdentityRows[0]?.uid || null;
      if (!appt.patient_uid) {
        throw AppError.conflict(
          'Walk-in appointment is not linked to a patient identity',
          'APPOINTMENT_PATIENT_REQUIRED',
        );
      }
      const doctorIdentityRows = resolvedDoctorIdForInsert
        ? await tx.$queryRawUnsafe(
          `SELECT uid
             FROM users
            WHERE tenant_id = $1::uuid
              AND id = $2::integer
            LIMIT 1`,
          actingTenantId,
          resolvedDoctorIdForInsert,
        )
        : [];
      appt.doctor_uid = doctorIdentityRows[0]?.uid || null;
      await recordAppointmentCreatedEvidenceTx(tx, {
        tenantId: actingTenantId,
        appointment: appt,
        actorUid: staffUid,
        actorId: staffId || null,
        actorRole: req.user?.role || null,
        source: 'walk_in',
      });

      const queue = await ensureAppointmentQueueForAppointment(tx, appt, {
        actorUid: staffUid,
        source: 'walk_in',
      });
      if (queue) {
        appt.queue_id = queue.id;
        appt.appointment_queue = queue;
      }

      // visit_no was computed pre-INSERT and persisted on the appointments
      // row (migration 217). Use it for the ER visit_number FK below.

      // Lab-only panel ordering — create the requested investigation
      // rows in the same transaction so the visit and its CBC + Lipid
      // (etc.) panel commit atomically and the response can hand the
      // receptionist both the visit number and the lab order IDs for
      // the printed slip. Finding:
      // 2026-05-10-lab-walk-in-receptionist-no-panel-order-on-register.
      const labOrders = [];
      if (Array.isArray(lab_tests) && lab_tests.length > 0) {
        const patientRow = await tx.$queryRawUnsafe(
          'SELECT uid, phone FROM users WHERE id = $1::int LIMIT 1',
          patientId,
        );
        const patientUid = patientRow[0]?.uid ?? null;
        // investigations.phone is VARCHAR(15) NOT NULL — fall back to the
        // resolved walk-in phone, then a placeholder, and always clamp.
        const investigationPhone = String(
          patientRow[0]?.phone || resolvedPhone || 'unknown',
        ).slice(0, 15);
        for (const entry of lab_tests) {
          const testName = (typeof entry === 'string'
            ? entry
            : String(entry?.test_name ?? entry?.name ?? '')).trim();
          if (!testName) continue;
          const testType = (typeof entry === 'object' && entry?.test_type
            ? String(entry.test_type)
            : 'LAB').toUpperCase().slice(0, 100);
          const testPriority = (typeof entry === 'object' && entry?.priority
            ? String(entry.priority)
            : 'NORMAL').toUpperCase().slice(0, 20);
          const invRows = await tx.$queryRawUnsafe(
            `INSERT INTO investigations
               (phone, patient_id, patient_uid, test_name, test_type,
                status, priority, requested_by, requested_at, updated_at, tenant_id)
             VALUES ($1, $2::int, $3::uuid, $4, $5, 'REQUESTED', $6, $7::uuid, NOW(), NOW(), $8::uuid)
             RETURNING id, test_name, test_type, status, priority`,
            investigationPhone, patientId, patientUid,
            testName.slice(0, 255), testType, testPriority, staffUid, actingTenantId,
          );
          labOrders.push(invRows[0]);
        }
      }

      // E-12 — ANC walk-ins also need a maternity_pregnancies row so
      // the OB doctor's chart open + the new prior-orders endpoint
      // have a pregnancy_id to attach to. Skipped if lmp_date is
      // missing (walk-in might just be a routine OBGYN consult).
      //
      // Trigger when the receptionist provides an explicit lmp_date —
      // that's the unambiguous "this is an ANC visit" signal,
      // independent of how the department prefix landed (OBGYN /
      // GYNECOLOGY / unspecified). Without this, the receptionist had
      // to make a second POST to /maternity/pregnancies before any
      // GA / supplement / timeline view worked.
      // Findings:
      //   2026-05-15-obstetric-anc-receptionist-6b88aaaa
      //   2026-05-16-obstetric-anc-receptionist-4d685e54
      if (lmp_date) {
        // Cast the bound `id` parameter explicitly so a Prisma binding that
        // ever lands as text doesn't trigger `operator does not exist:
        // integer = text` against `users.id`. See finding
        // 2026-05-09-obstetric-anc-receptionist-walkin-anc-500-prisma-integer-bug.
        const patientRow = await tx.$queryRawUnsafe(
          'SELECT uid FROM users WHERE id = $1::int LIMIT 1', patientId,
        );
        const patientUid = patientRow[0]?.uid;
        if (patientUid) {
          // Idempotent: don't double-insert if an ongoing pregnancy
          // already exists for this patient.
          const existingPreg = await tx.$queryRawUnsafe(
            `SELECT id FROM maternity_pregnancies
              WHERE patient_uid = $1::uuid AND status = 'ongoing' LIMIT 1`,
            patientUid,
          );
          if (!existingPreg.length) {
            const computedEdd = edd_date || (lmp_date
              ? new Date(new Date(lmp_date).getTime() + 280 * 86400 * 1000).toISOString().slice(0, 10)
              : null);
            const pregnancyRows = await tx.$queryRawUnsafe(
              `INSERT INTO maternity_pregnancies
                 (patient_uid, lmp_date, edd_date, edd_method,
                  gravida, parity, living_children, abortions,
                  booking_status, booking_visit_date, status, created_by, tenant_id)
               VALUES ($1::uuid, $2::date, $3::date, 'lmp',
                       $4, $5, $6, $7, 'booked', $9::date, 'ongoing', $8::uuid, $10::uuid)
               RETURNING id, pregnancy_number, status, created_at`,
              patientUid, lmp_date, computedEdd,
              parseInt(gravida, 10) || 1,
              parseInt(parity, 10) || 0,
              parseInt(living_children, 10) || 0,
              parseInt(abortions, 10) || 0,
              staffUid,
              todayDate,
              actingTenantId,
            );
            const pregnancy = pregnancyRows[0];
            // M-E — a pregnancy episode born at the walk-in counter must look
            // exactly like one born through maternityService.createPregnancy
            // (C2): the same staff-only maternity.pregnancy_created timeline +
            // audit pair, written in this same transaction so a canonical
            // failure aborts the whole walk-in instead of leaving the detail
            // row unrepresented on the patient timeline. Idempotency keys are
            // derived from the source row, so the pair exists at most once per
            // pregnancy no matter how the episode was created.
            await recordCanonicalClinicalEvent({
              tenantId: actingTenantId,
              patientUid: String(patientUid),
              eventType: 'maternity.pregnancy_created',
              eventStatus: 'ongoing',
              sourceTable: 'maternity_pregnancies',
              sourceId: pregnancy.id,
              resourceType: 'pregnancy',
              resourceId: pregnancy.id,
              actorUid: staffUid || null,
              actorRole: role || null,
              occurredAt: pregnancy.created_at,
              visibleToPatient: false,
              summary: 'Pregnancy episode recorded',
              payload: {
                pregnancy_id: pregnancy.id,
                pregnancy_number: pregnancy.pregnancy_number,
                status: pregnancy.status,
              },
              afterState: {
                pregnancy_status: pregnancy.status,
                user_is_pregnant: true,
              },
              timelineIdempotencyKey: `maternity_pregnancies:${pregnancy.id}:created`,
              auditIdempotencyKey: `maternity_pregnancies:${pregnancy.id}:audit:created`,
            }, { db: tx, strict: true });
          }
          await tx.$executeRawUnsafe(
            `UPDATE users
                SET is_pregnant = TRUE,
                    pregnancy_lmp_date = $2::date,
                    updated_at = NOW()
              WHERE id = $1::int`,
            patientId,
            lmp_date,
          );
        }
      }

      // E-3 — Emergency walk-ins also need an emergency_visits row so the
      // ED queue, triage workflow, MLC flow, and bed-allocation queries
      // (which all read from emergency_visits, not appointments) have
      // somewhere to write to. Without this, the receptionist creates an
      // appointment row, the ED nurse can't find a matching visit_id, and
      // the whole ER pipeline goes through paper handover. Finding:
      // 2026-05-08-emergency-walk-in-nurse-emer-walkin-no-ed-visit.
      // D47 — key off visit_type=EMERGENCY too, not only an EMER
      // department prefix, so a specialty-routed emergency (e.g. chest
      // pain to Cardiology) still appears on the ED triage queue.
      let erVisit = null;
      const shouldCreateEmergencyVisit =
        deptPrefix(appointmentDepartment) === 'EMER' || resolvedVisitType === 'EMERGENCY';
      if (shouldCreateEmergencyVisit) {
        // Pull the patient_uid for the FK. Walk-ins create users by
        // phone earlier in this txn, so the lookup is reliable. Explicit
        // `$1::int` cast mirrors the ANC branch defense-in-depth.
        const patientRow = await tx.$queryRawUnsafe(
          'SELECT uid FROM users WHERE id = $1::int LIMIT 1',
          patientId,
        );
        const patientUid = patientRow[0]?.uid ?? null;
        // C4 — was `req.user?.tenantId` (camelCase) which jwtMiddleware never
        // sets, so this always fell to the default tenant. Bind the
        // authenticated tenant instead.
        const tenantId = actingTenantId;
        // Stage-5 — carry the receptionist's MLC flag onto the ED visit.
        // mlc_number / mlc_notes (often not known until the police FIR is
        // filed) ride along in metadata so the full mlc_records workflow
        // can pick them up later without losing what was captured at
        // intake. Finding:
        //   2026-05-09-emergency-walk-in-receptionist-no-mlc-flag-at-registration.
        const erMetadata = JSON.stringify({
          ...(mlcNumber || mlcNotes ? { mlc_number: mlcNumber, mlc_notes: mlcNotes } : {}),
          ...(isUnidentifiedFlag && approximateAge ? { approximate_age: approximateAge } : {}),
        });
        const erRows = await tx.$queryRawUnsafe(
          `INSERT INTO emergency_visits
             (tenant_id, visit_number, patient_uid, arrival_mode,
              chief_complaint, status, is_mlc, metadata, created_by)
           VALUES ($1::uuid, $2, $3::uuid, 'walk_in', $4, 'arriving', $5, $6::jsonb, $7::uuid)
           ON CONFLICT (tenant_id, visit_number) DO NOTHING
           RETURNING id, visit_number, patient_uid, arrival_at, status, is_mlc, metadata`,
          tenantId, visitNo, patientUid,
          chiefComplaint || reason || 'Walk-in registration',
          mlcFlag, erMetadata,
          staffUid,
        );
        erVisit = erRows[0] || null;
      }

      const allergyRows = await tx.$queryRawUnsafe(
        `WITH patient_row AS (
           SELECT id, uid, allergies
             FROM users
            WHERE id = $1::int
            LIMIT 1
         ),
         structured AS (
           SELECT allergy_name, severity
             FROM patient_allergies pa
             JOIN patient_row p ON (pa.patient_id = p.id OR pa.patient_uid = p.uid)
            WHERE COALESCE(pa.is_active, TRUE) = TRUE
         ),
         profile AS (
           SELECT trim(value) AS allergy_name, NULL::text AS severity
             FROM patient_row p,
                  regexp_split_to_table(COALESCE(p.allergies, ''), ',') AS value
            WHERE trim(value) <> ''
         )
         SELECT DISTINCT allergy_name, severity
           FROM (
             SELECT * FROM structured
             UNION ALL
             SELECT * FROM profile
           ) allergies
          ORDER BY allergy_name`,
        patientId,
      );

      return {
        ...appt,
        token_number: tokenNumber,
        visit_no: visitNo,
        er_visit_id: erVisit?.id ?? null,
        er_visit_number: erVisit?.visit_number ?? null,
        er_approximate_age: erVisit?.metadata?.approximate_age ?? (isUnidentifiedFlag ? approximateAge : null),
        // Stage-5 — echo the MLC flag back so the ER admin UI can banner
        // "Medico-legal case" without an extra fetch. Null on non-EMER
        // walk-ins (no emergency_visits row is created).
        er_is_mlc: erVisit?.is_mlc ?? null,
        // Stage-5 — lab panel ordered in the same save — the receptionist's
        // printed slip carries these so the patient reaches the lab
        // counter with the CBC + Lipid order already waiting.
        lab_order_ids: labOrders.map((o) => o.id),
        lab_orders: labOrders,
        returning_patient: returningPatient,
        prior_visit_count: priorVisitCount,
        last_visit_at: lastVisitAt,
        // Wave-3 batch-2 — surface the unidentified flag so the ER admin
        // UI can banner "Unidentified patient — merge identity on family
        // arrival" and the future identity-reconciliation flow has a
        // discoverable target.
        is_unidentified: isUnidentifiedFlag,
        has_allergies: allergyRows.length > 0,
        allergy_flag: allergyRows.length > 0,
        allergies: allergyRows.map((a) => ({
          allergy_name: a.allergy_name,
          severity: a.severity ?? null,
        })),
        // Same-day duplicate signal. Empty array when this is the
        // patient's first visit today. Populated array means the admin
        // UI should banner the receptionist before they hand the slip
        // to the patient (the row is already created — surfacing this
        // post-hoc lets the receptionist immediately cancel + redirect
        // to the existing visit, rather than the duplicate going
        // unnoticed and ending up in the doctor's queue twice).
        same_day_duplicate_count: sameDayDuplicates.length,
        same_day_duplicates: sameDayDuplicates.map((d) => ({
          id: d.id,
          visit_no: d.visit_no,
          status: d.status,
          appointment_time: d.appointment_time,
          created_at: d.created_at,
        })),
      };
    });

    // ANC walk-in — echo gestational age in the response so the
    // receptionist can verbally confirm GA + which ANC visit this is
    // at registration, without a follow-up /maternity call. Finding:
    // 2026-05-09-obstetric-anc-receptionist-walkin-response-missing-ga.
    if (lmp_date && deptPrefix(result.department) === 'ANC') {
      result.gestational_age = computeGestationalAge(lmp_date);
    }

    attachAppointmentPhiContext(req, result);
    await logAudit(req, 'FRONT_OFFICE_WALK_IN_REGISTERED', {
      appointment_id: result.id,
      patient_id: result.patient_id,
      doctor_id: result.doctor_id,
      visit_no: result.visit_no,
      department: result.department,
      visit_type: result.visit_type,
      returning_patient: result.returning_patient,
      same_day_duplicate_count: result.same_day_duplicate_count,
      er_visit_id: result.er_visit_id,
      lab_order_ids: result.lab_order_ids,
    }, {
      resource: 'appointment',
      resourceId: result.id,
    });

    emitAppointmentEvent('walk-in-created', { tenantId: actingTenantId });
    success(res, result, `Walk-in registered. Visit ${result.visit_no}`);
  } catch (err) {
    // Surface a stable error code so dashboards/alerts can group these and
    // pass the requestId so support can correlate to server logs. Body
    // never echoes err.message (per CLAUDE.md security checklist).
    // See finding 2026-05-08-inpatient-admission-receptionist-walkin-generic-error.
    logger.error('Walk-in Registration Error:', {
      requestId: req.id,
      err: err?.message,
      code: err?.code,
      stack: err?.stack,
    });
    if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return error(res, err.message || 'Walk-in rejected', err.statusCode, {
        code: err.code || 'WALK_IN_REJECTED',
      });
    }
    error(res, 'Failed to register walk-in', HTTP_STATUS.INTERNAL_SERVER_ERROR, {
      code: 'WALK_IN_FAILED',
      requestId: req.id,
    });
  } finally {
    // No client to release — Prisma's $transaction handles that itself.
  }
};

/**
 * Advise an appointment for inpatient admission — the OPD→IPD bridge.
 * A doctor flips this on a visit; the admission counter sees it in their
 * queue (`GET /appointments?advised_for_admission=true`). Migration 169
 * added the columns; Wave-4B-3 (commit 37e3458a) added the queue filter
 * on the READ side. Wave-5 batch-3 closes the audit gap: every advise
 * event lands in `audit_logs` so compliance can reconstruct who
 * recommended an admission and when, and only DOCTOR/SUPER_ADMIN roles
 * can record one — admission is a clinical decision, not an
 * administrative one. Findings:
 *   2026-05-08-inpatient-admission-receptionist-no-admission-advice-workflow
 *   2026-05-08-inpatient-admission-receptionist-no-advise-admission-workflow.
 */
export const adviseForAdmission = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return error(res, 'Invalid appointment id', HTTP_STATUS.BAD_REQUEST);
    }
    const tenantId = requireTenantId(req);

    // Clinical-decision gate. The wrapAutoRBAC roster
    // (`appointmentRoutes` in rbacConfig.js) allows DOCTOR / ADMIN /
    // NURSE / RECEPTIONIST / PATIENT through — fine for booking +
    // cancel, too permissive for "patient needs to be admitted". The
    // admission advice is the trigger for an IPD bed allocation, so
    // restricting to consultant-tier clinicians keeps the chain of
    // clinical authority intact. ADMIN/SUPER_ADMIN can also advise
    // (ops-desk override for missed-by-clinician edge cases) but not
    // NURSE or RECEPTIONIST.
    //
    // D37 — JUNIOR_DOCTOR was previously in this allowlist but Indian
    // clinical practice (and the consultant-led admission discipline
    // this hospital runs) does not let a junior independently advise
    // admission — the consultant must sign. Drop JUNIOR_DOCTOR from
    // the allowlist; junior doctors who want to advise must escalate
    // to a CONSULTANT/SENIOR_DOCTOR who records the advice.
    // Finding ee096dc7.
    const role = req.user?.role ?? null;
    const ALLOWED_ROLES = new Set([
      'DOCTOR', 'CONSULTANT', 'SENIOR_DOCTOR',
      'ADMIN', 'SUPER_ADMIN',
    ]);
    if (role && !ALLOWED_ROLES.has(role)) {
      const msg = role === 'JUNIOR_DOCTOR'
        ? 'Only a consultant-tier doctor or admin can advise admission. Junior doctors must escalate to a consultant who records the advice.'
        : 'Only a doctor or admin can advise admission';
      return error(
        res,
        msg,
        HTTP_STATUS.FORBIDDEN,
        { code: 'ADVISE_ADMISSION_ROLE_REQUIRED' },
      );
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : null;
    const advisedBy = req.user?.uid ?? null;

    const appointment = await setTenantTx(tenantId, async (tx) => {
      const current = await lockAppointmentForLifecycleTx(tx, {
        tenantId,
        appointmentId: id,
      });
      const rows = await tx.$queryRawUnsafe(
        `UPDATE appointments
            SET advised_for_admission_at = NOW(),
                advised_for_admission_by = $1::uuid,
                advised_for_admission_note = $2::text,
                updated_by = COALESCE($1::uuid, updated_by),
                updated_at = NOW()
          WHERE id = $3::integer
            AND tenant_id = $4::uuid
          RETURNING id, uid, patient_id, doctor_id, advised_for_admission_at,
                    advised_for_admission_by, advised_for_admission_note,
                    status, tenant_id, updated_at`,
        advisedBy,
        note,
        id,
        tenantId,
      );
      const updated = {
        ...current,
        ...rows[0],
        patient_uid: current.patient_uid,
        doctor_uid: current.doctor_uid,
      };
      await recordAppointmentMutationEvidenceTx(tx, {
        tenantId,
        appointment: updated,
        prior: current,
        eventType: 'appointment.admission_advised',
        source: 'advise_admission',
        actorUid: advisedBy,
        actorRole: req.user?.role || null,
        payload: {
          advised_for_admission_at: updated.advised_for_admission_at,
          advised_for_admission_by: updated.advised_for_admission_by,
          note_present: Boolean(note),
        },
      });
      return updated;
    });

    // Phase 1.5 — best-effort audit row. logAudit is fire-and-forget
    // with its own error trap, so a write failure here cannot 500 the
    // advise event itself.
    logAudit(req, 'appointment-advise-admission', {
      appointment_id: appointment.id,
      appointment_uid: appointment.uid,
      patient_id: appointment.patient_id,
      doctor_id: appointment.doctor_id,
      advised_at: appointment.advised_for_admission_at,
      note,
    }).catch(() => {});

    // ASCII-only message: downstream consumers (PowerShell/curl on Windows
    // terminals, log shippers) routinely re-decode JSON bodies as cp1252
    // and render UTF-8 em-dash bytes as mojibake. Finding:
    // 2026-05-09-inpatient-admission-receptionist-response-mojibake.
    success(res, appointment, 'Patient advised for admission - admission counter notified');
  } catch (err) {
    logger.error('adviseForAdmission error:', { requestId: req.id, err: err?.message, stack: err?.stack });
    return relayAppError(res, err, 'Failed to advise for admission');
  }
};

/**
 * Get appointment status history (audit trail)
 */
export const getAppointmentHistory = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return error(res, 'Invalid appointment id', HTTP_STATUS.BAD_REQUEST);
    }
    const tenantId = requireTenantId(req);
    const result = await prisma.$queryRawUnsafe(`
      SELECT ash.id, ash.appointment_id, ash.from_status, ash.to_status, ash.changed_by, ash.changed_by_role, ash.reason, ash.created_at, u.name as changed_by_name
      FROM appointment_status_history ash
      JOIN appointments a ON a.id = ash.appointment_id AND a.tenant_id = $2::uuid
      LEFT JOIN users u ON ash.changed_by = u.id
      WHERE ash.appointment_id = $1
      ORDER BY ash.created_at ASC
    `, id, tenantId);
    success(res, result, 'History fetched');
  } catch (err) {
    logger.error('getAppointmentHistory error:', err);
    error(res, 'Failed to fetch appointment history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
