// src/controllers/appointment/appointmentWorkflowController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendAppointmentConfirmationSMS } from '../../services/smsService.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { logAudit } from '../../utils/logAudit.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

// All four handlers below were originally written against a raw pg.Pool
// client (await pool.connect → client.query → client.release) and ported
// poorly when the codebase moved to Prisma — every call crashed with
// `client.release is not a function`. Ported to prisma.$transaction here
// and stripped column references that don't exist in the live schema:
// no confirmed_by, no confirmation_notes, no no_show_at, no completed_at,
// no cancellation_reason. Status transitions live on the appointments
// row plus an immutable appointment_status_history audit row.

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
    const staffId = req.user?.id;
    const { confirmation_notes, appointment_date, appointment_time } = req.body;

    const { result, a, tokenNumber, newDate, newTime } = await prisma.$transaction(async (tx) => {
      const apptRows = await tx.$queryRawUnsafe(
        'SELECT id, patient_id, doctor_id, appointment_date, appointment_time, status, department, phone FROM appointments WHERE id=$1 FOR UPDATE',
        Number(id),
      );
      if (!apptRows.length) {
        const err = new Error('Appointment not found');
        err.statusCode = HTTP_STATUS.NOT_FOUND;
        throw err;
      }
      const a = apptRows[0];
      if (a.status === 'CANCELLED') {
        const err = new Error('Cannot confirm a cancelled appointment');
        err.statusCode = HTTP_STATUS.BAD_REQUEST;
        throw err;
      }

      const targetDate = appointment_date || a.appointment_date;
      const tokenResult = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(NULLIF(token_number, '')::int), 0) + 1 AS next_token
         FROM appointments
         WHERE DATE(appointment_date) = DATE($1) AND confirmed_at IS NOT NULL
           AND token_number ~ '^[0-9]+$'`,
        targetDate,
      );
      const tokenNumber = String(parseInt(tokenResult[0].next_token));

      const newDate = appointment_date || a.appointment_date;
      const newTime = appointment_time || a.appointment_time;

      const result = await tx.$queryRawUnsafe(`
        UPDATE appointments SET
          status = 'CONFIRMED',
          confirmed_at = NOW(),
          token_number = $1,
          appointment_date = $2,
          appointment_time = $3,
          sla_target_at = COALESCE(sla_target_at, created_at + INTERVAL '30 minutes'),
          updated_at = NOW()
        WHERE id = $4
        RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, reason, notes,
                  token_number, confirmed_at, department, created_at, updated_at
      `,
        tokenNumber, newDate, newTime, Number(id),
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
         VALUES ($1,$2,'CONFIRMED',$3,'staff',$4)`,
        Number(id), a.status, staffId, confirmation_notes || null,
      );

      return { result, a, tokenNumber, newDate, newTime };
    });

    // Notify patient via FCM + SMS (fire-and-forget, outside transaction).
    const patient = await prisma.$queryRawUnsafe('SELECT device_token, name, phone FROM users WHERE id=$1', a.patient_id);
    const patientRow = patient[0];
    const doctorRow = await prisma.$queryRawUnsafe(
      'SELECT u.name, doc.department FROM users u LEFT JOIN doctors doc ON doc.user_id = u.id WHERE u.id=$1',
      a.doctor_id,
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
        await sendAppointmentConfirmationSMS(
          smsPhone,
          patientRow?.name || 'Patient',
          doctorName,
          newDate,
          newTime,
          tokenNumber,
          department,
        );
      } catch (e) { logger.warn('Appointment notification/SMS failed:', e.message); }
    });

    success(res, result[0], `Appointment confirmed. Token #${tokenNumber}`);
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Confirm Appointment Error:', err);
    error(res, 'Failed to confirm appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff marks appointment as no-show
 */
export const markNoShow = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;

    const result = await prisma.$transaction(async (tx) => {
      const appt = await tx.$queryRawUnsafe(
        'SELECT id, status FROM appointments WHERE id=$1 FOR UPDATE',
        Number(id),
      );
      if (!appt.length) {
        const err = new Error('Not found'); err.statusCode = HTTP_STATUS.NOT_FOUND; throw err;
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE appointments SET status='NO_SHOW', updated_at=NOW() WHERE id=$1
         RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, token_number, updated_at`,
        Number(id),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role)
         VALUES ($1,$2,'NO_SHOW',$3,'staff')`,
        Number(id), appt[0].status, staffId,
      );
      return updated[0];
    });
    success(res, result, 'Marked as no-show');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Mark No-Show Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff marks appointment as completed (patient visited)
 */
export const completeAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { notes } = req.body;

    const { result, prevStatus, patientId } = await prisma.$transaction(async (tx) => {
      const appt = await tx.$queryRawUnsafe(
        'SELECT id, patient_id, status FROM appointments WHERE id=$1 FOR UPDATE',
        Number(id),
      );
      if (!appt.length) {
        const err = new Error('Not found'); err.statusCode = HTTP_STATUS.NOT_FOUND; throw err;
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE appointments SET status='COMPLETED', notes=COALESCE($2, notes), updated_at=NOW() WHERE id=$1
         RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, notes, token_number, updated_at`,
        Number(id), notes || null,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role)
         VALUES ($1,$2,'COMPLETED',$3,'staff')`,
        Number(id), appt[0].status, staffId,
      );
      return { result: updated[0], prevStatus: appt[0].status, patientId: appt[0].patient_id };
    });

    // Schedule feedback request 2 hours after visit (fire-and-forget, outside transaction)
    void prevStatus;
    setImmediate(async () => {
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO scheduled_notifications (user_id, type, data, send_at, status)
           VALUES ($1, 'feedback_request', $2, NOW() + INTERVAL '2 hours', 'pending')`,
          patientId,
          JSON.stringify({ appointment_id: id, type: 'appointment_feedback' }),
        );
        logger.info(`[Feedback] Scheduled feedback request for appointment ${id} in 2h`);
      } catch (e) {
        logger.warn('[Feedback] Failed to schedule feedback notification:', e.message);
      }
    });

    success(res, result, 'Appointment completed');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Complete Appointment Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff/patient cancels appointment
 */
export const cancelAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { cancellation_reason } = req.body;

    const { result, patientId } = await prisma.$transaction(async (tx) => {
      const appt = await tx.$queryRawUnsafe(
        'SELECT id, patient_id, status FROM appointments WHERE id=$1 FOR UPDATE',
        Number(id),
      );
      if (!appt.length) {
        const err = new Error('Not found'); err.statusCode = HTTP_STATUS.NOT_FOUND; throw err;
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE appointments SET status='CANCELLED', updated_at=NOW() WHERE id=$1
         RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, token_number, updated_at`,
        Number(id),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
         VALUES ($1,$2,'CANCELLED',$3,'staff',$4)`,
        Number(id), appt[0].status, staffId, cancellation_reason || null,
      );
      return { result: updated[0], patientId: appt[0].patient_id };
    });

    // Notify patient (fire-and-forget, outside transaction)
    const patient = await prisma.$queryRawUnsafe('SELECT device_token FROM users WHERE id=$1', patientId);
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

    success(res, result, 'Appointment cancelled');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Cancel Appointment Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
    // doctor_id source order: explicit query param -> JWT (mine alias).
    // parseInt the param so raw SQL doesn't bind a string against an
    // integer column. Finding:
    // 2026-05-08-follow-up-opd-receptionist-queue-today-doctor-filter-500.
    let doctorId = null;
    if (req.params?.scope === 'mine') {
      doctorId = req.user?.id ?? null;
    } else if (req.query.doctor_id !== undefined && req.query.doctor_id !== '') {
      const parsed = Number.parseInt(req.query.doctor_id, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return error(res, 'doctor_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
      }
      doctorId = parsed;
    }

    let where = `WHERE DATE(a.appointment_date) = CURRENT_DATE AND a.status NOT IN ('CANCELLED')`;
    const params = [];
    if (doctorId !== null) { params.push(doctorId); where += ` AND a.doctor_id=$${params.length}`; }
    if (department) { params.push(department); where += ` AND a.department=$${params.length}`; }

    // Surface ESI-1/ESI-2 ER triage on the doctor's appointment queue.
    // emergency_visits has no FK back to appointments; the canonical
    // link is patient_uid + same-day arrival. The doctor's UI needs:
    //   * triage_priority — esi_1..esi_5 (lower number = more urgent)
    //   * emergency_visit_id — so the row can deep-link into the ED chart
    //   * acuity_rank — a small integer for client-side sort hints
    //   * is_emergent — boolean banner flag
    // Sort rule: emergent acuity (esi_1, esi_2) first, then existing
    // token + scheduled-time order. ESI-3..5 (or no ED row) fall back to
    // the original order. Finding
    // 2026-05-10-emergency-walk-in-nurse-doctor-queue-missing-acuity.
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
        WHERE DATE(arrival_at) = CURRENT_DATE
          AND COALESCE(disposition, '') NOT IN ('discharged', 'lama', 'expired')
        ORDER BY patient_uid, arrival_at DESC
      )
      SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.appointment_time,
        a.status, a.reason, a.notes, a.token_number, a.department, a.confirmed_at, a.created_at, a.updated_at,
        p.name as patient_name, p.phone as patient_phone, p.blood_group, p.uid as patient_uid,
        d.name as doctor_display_name, doc.specialty AS specialization,
        doc.department as doctor_department,
        ed.emergency_visit_id,
        ed.triage_priority,
        ed.ed_status,
        ed.ed_chief_complaint,
        CASE LOWER(COALESCE(ed.triage_priority, ''))
          WHEN 'esi_1' THEN 1
          WHEN 'esi_2' THEN 2
          WHEN 'esi_3' THEN 3
          WHEN 'esi_4' THEN 4
          WHEN 'esi_5' THEN 5
          ELSE NULL
        END AS acuity_rank,
        CASE
          WHEN LOWER(COALESCE(ed.triage_priority, '')) IN ('esi_1', 'esi_2') THEN TRUE
          ELSE FALSE
        END AS is_emergent
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
      LEFT JOIN ed_today ed ON ed.patient_uid = p.uid
      ${where}
      ORDER BY
        CASE
          WHEN LOWER(COALESCE(ed.triage_priority, '')) IN ('esi_1', 'esi_2') THEN 0
          ELSE 1
        END,
        CASE LOWER(COALESCE(ed.triage_priority, ''))
          WHEN 'esi_1' THEN 1
          WHEN 'esi_2' THEN 2
          ELSE 9
        END,
        a.token_number NULLS LAST,
        a.appointment_time
    `, ...params);

    success(res, result, "Today's queue fetched");
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
        AND status NOT IN ('CANCELLED', 'NO_SHOW')
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
  // Loose substring fallback so unseeded departments still get a sensible prefix.
  for (const [k, v] of Object.entries(DEPT_PREFIX_MAP)) {
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
    // appointments.created_by is uuid; appointment_status_history.changed_by is int.
    const staffUid = req.user?.uid;
    const staffId = req.user?.id;
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
      mode, unidentified,
      // E-12 — ANC fields captured at walk-in. When department routes
      // to ANC, lmp_date / edd_date / gravida / parity / blood_group
      // are written into a maternity_pregnancies row alongside the
      // appointment. Finding:
      // 2026-05-08-obstetric-anc-receptionist-walkin-drops-anc-fields.
      lmp_date, edd_date, gravida, parity, living_children, abortions,
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
    const VALID_VISIT_TYPES = new Set([
      'NEW', 'FOLLOW_UP', 'EMERGENCY', 'TELE', 'LAB_ONLY',
    ]);
    const resolvedVisitType = visit_type && VALID_VISIT_TYPES.has(String(visit_type).toUpperCase())
      ? String(visit_type).toUpperCase()
      : null;

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
    const unidentifiedSignal =
      String(mode || '').toLowerCase() === 'unidentified' ||
      unidentified === true ||
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
    let isUnidentifiedFlag = false;
    if (isUnidentifiedMode && !patient_phone && !patient_id) {
      // 13 chars: "UNIDENT-EMER-" prefix + 13-digit ms timestamp would
      // overflow VARCHAR(15). Use a 6-char base36 timestamp suffix
      // ("UNIDENT-EMER-XXXXXX") — fits in 15 chars, collision-resistant
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
    if (doctor_id !== undefined && doctor_id !== null && doctor_id !== '') {
      const doctorIdInt = parseInt(doctor_id, 10);
      if (!Number.isFinite(doctorIdInt) || doctorIdInt <= 0) {
        return error(res, 'doctor_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
      }
      // UNION ALL accepts either users.id (preferred — the
      // assignable-mode dropdown surfaces this) or doctors.id (legacy
      // booking surfaces) and confirms the underlying user is an
      // active DOCTOR. The doctors-side branch goes through
      // d.is_active=true so a deactivated doctor row also gets
      // rejected.
      const ok = await prisma.$queryRawUnsafe(
        `SELECT 1 AS ok FROM (
           SELECT 1 FROM users
            WHERE id = $1::int
              AND role = 'DOCTOR'
              AND is_active = true
           UNION ALL
           SELECT 1 FROM doctors d
             JOIN users u ON u.id = d.user_id
            WHERE d.id = $1::int
              AND d.is_active = true
              AND u.role = 'DOCTOR'
              AND u.is_active = true
         ) candidates
         LIMIT 1`,
        doctorIdInt,
      );
      if (!ok.length) {
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

    const result = await prisma.$transaction(async (tx) => {
      const appointmentDepartment = await resolveWalkInDepartment(tx, {
        department,
        departmentId: department_id ?? departmentId,
        doctorId: doctor_id,
      });

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
        const existing = isUnidentifiedFlag
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
          const gender = ['male', 'female', 'other', 'M', 'F', 'O'].includes(String(patient_gender ?? ''))
            ? String(patient_gender).toLowerCase().slice(0, 1) === 'm' ? 'male'
            : String(patient_gender).toLowerCase().slice(0, 1) === 'f' ? 'female'
            : String(patient_gender).toLowerCase().startsWith('o') ? 'other'
            : null
            : null;
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
          const guardianUserIdInt = (() => {
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
          const newUser = await tx.$queryRawUnsafe(
            `INSERT INTO users (phone, name, birthday, gender, address, role,
                                guardian_name, guardian_phone, guardian_relationship,
                                guardian_id_type, guardian_id_reference, guardian_user_id,
                                weight_kg, is_minor, is_unidentified,
                                updated_at)
             VALUES ($1, $2, $3::date, $4, $5, 'PATIENT',
                     $6, $7, $8,
                     $9, $10, $11,
                     $12, $13, $14,
                     NOW())
             RETURNING id`,
            resolvedPhone,
            patient_name || (isUnidentifiedFlag ? 'Unidentified Patient' : 'Walk-in Patient'),
            birthday,
            gender,
            address,
            guardian_name ? String(guardian_name).trim().slice(0, 160) : null,
            guardian_phone ? String(guardian_phone).trim().slice(0, 20) : null,
            guardianRel,
            guardianIdType,
            guardianIdRef,
            guardianUserIdInt,
            weightKg,
            isMinor,
            isUnidentifiedFlag,
          );
          patientId = newUser[0].id;
          returningPatient = false;
        }
      }

      // Atomic token number — scoped by (date, department). A global-per-day
      // counter would mean the EMER walk-in and the OPD walk-in compete for
      // the same #8, but the receptionist on the ER counter expects
      // EMER-prefix tokens. E-2 fix. Findings:
      //   2026-05-08-emergency-walk-in-receptionist-token-not-dept-scoped
      //   2026-05-08-emergency-walk-in-receptionist-visit-no-format
      //   2026-05-08-lab-walk-in-receptionist-no-dept-scoped-visit-no
      //   2026-05-08-dynamic-acute-abdomen-receptionist-walkin-token-not-dept-scoped
      const tokenResult = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(NULLIF(token_number, '')::int), 0) + 1 AS next_token
         FROM appointments
         WHERE DATE(appointment_date) = CURRENT_DATE
           AND confirmed_at IS NOT NULL
           AND token_number IS NOT NULL
           AND token_number ~ '^[0-9]+$'
           AND COALESCE(department, '') = COALESCE($1::text, '')`,
        appointmentDepartment || null,
      );
      const tokenNumber = String(parseInt(tokenResult[0].next_token));

      // Compose the human-readable visit_no BEFORE the INSERT so we can
      // persist it on the row. Previously this was computed post-INSERT
      // and only echoed in the response, so search-by-visit_no found
      // nothing. Migration 217 added the column. Finding:
      // 2026-05-10-inpatient-admission-receptionist-visit-no-not-persisted.
      const visitNo = composeVisitNo({
        department: appointmentDepartment,
        date: new Date(),
        tokenNumber,
      });

      // appointments has no `confirmed_by` column. created_by is uuid.
      // phone, appointment_date, appointment_time, updated_at are NOT NULL.
      // E-10 — visit_type + parent_appointment_id captured at walk-in time
      // (migration 190).
      const apptRows = await tx.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
            status, confirmed_at, token_number, visit_no, department, created_by, updated_at,
            visit_type, parent_appointment_id)
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, 'CONFIRMED', NOW(), $7, $8, $9, $10::uuid, NOW(),
                 $11, $12)
         RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
                   status, confirmed_at, token_number, visit_no, department, created_at,
                   visit_type, parent_appointment_id`,
        patientId,
        doctor_id || null,
        resolvedTime,
        // Wave-3 batch-2 — use the resolved phone so an unidentified-ER
        // walk-in's appointment row carries the UNIDENT-* synthetic
        // identifier instead of the empty-string default; downstream
        // ED queue / nurse worklist join on phone to locate the patient.
        resolvedPhone || '',
        reason || 'Walk-in consultation',
        notes || null,
        tokenNumber,
        visitNo,
        appointmentDepartment,
        staffUid,
        resolvedVisitType,
        parent_appointment_id ? parseInt(parent_appointment_id, 10) || null : null,
      );
      const appt = apptRows[0];

      // changed_by on this table is int, NOT uuid (different from appointments.created_by).
      await tx.$executeRawUnsafe(
        `INSERT INTO appointment_status_history
           (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
         VALUES ($1, NULL, 'CONFIRMED', $2, 'staff', 'Walk-in registration')`,
        appt.id,
        staffId,
      );

      // visit_no was computed pre-INSERT and persisted on the appointments
      // row (migration 217). Use it for the ER visit_number FK below.

      // E-12 — ANC walk-ins also need a maternity_pregnancies row so
      // the OB doctor's chart open + the new prior-orders endpoint
      // have a pregnancy_id to attach to. Skipped if lmp_date is
      // missing (walk-in might just be a routine OBGYN consult).
      if (deptPrefix(appointmentDepartment) === 'ANC' && lmp_date) {
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
            await tx.$queryRawUnsafe(
              `INSERT INTO maternity_pregnancies
                 (patient_uid, lmp_date, edd_date, edd_method,
                  gravida, parity, living_children, abortions,
                  booking_status, booking_visit_date, status, created_by)
               VALUES ($1::uuid, $2::date, $3::date, 'lmp',
                       $4, $5, $6, $7, 'booked', CURRENT_DATE, 'ongoing', $8::uuid)`,
              patientUid, lmp_date, computedEdd,
              parseInt(gravida, 10) || 1,
              parseInt(parity, 10) || 0,
              parseInt(living_children, 10) || 0,
              parseInt(abortions, 10) || 0,
              staffUid,
            );
          }
        }
      }

      // E-3 — Emergency walk-ins also need an emergency_visits row so the
      // ED queue, triage workflow, MLC flow, and bed-allocation queries
      // (which all read from emergency_visits, not appointments) have
      // somewhere to write to. Without this, the receptionist creates an
      // appointment row, the ED nurse can't find a matching visit_id, and
      // the whole ER pipeline goes through paper handover. Finding:
      // 2026-05-08-emergency-walk-in-nurse-emer-walkin-no-ed-visit.
      let erVisit = null;
      if (deptPrefix(appointmentDepartment) === 'EMER') {
        // Pull the patient_uid for the FK. Walk-ins create users by
        // phone earlier in this txn, so the lookup is reliable. Explicit
        // `$1::int` cast mirrors the ANC branch defense-in-depth.
        const patientRow = await tx.$queryRawUnsafe(
          'SELECT uid FROM users WHERE id = $1::int LIMIT 1',
          patientId,
        );
        const patientUid = patientRow[0]?.uid ?? null;
        const tenantId = req.user?.tenantId ?? '00000000-0000-4000-8000-000000000001';
        const erRows = await tx.$queryRawUnsafe(
          `INSERT INTO emergency_visits
             (tenant_id, visit_number, patient_uid, arrival_mode,
              chief_complaint, status, created_by)
           VALUES ($1::uuid, $2, $3::uuid, 'walk_in', $4, 'arriving', $5::uuid)
           ON CONFLICT (tenant_id, visit_number) DO NOTHING
           RETURNING id, visit_number, patient_uid, arrival_at, status`,
          tenantId, visitNo, patientUid,
          reason || 'Walk-in registration',
          staffUid,
        );
        erVisit = erRows[0] || null;
      }

      return {
        ...appt,
        token_number: tokenNumber,
        visit_no: visitNo,
        er_visit_id: erVisit?.id ?? null,
        er_visit_number: erVisit?.visit_number ?? null,
        returning_patient: returningPatient,
        prior_visit_count: priorVisitCount,
        last_visit_at: lastVisitAt,
        // Wave-3 batch-2 — surface the unidentified flag so the ER admin
        // UI can banner "Unidentified patient — merge identity on family
        // arrival" and the future identity-reconciliation flow has a
        // discoverable target.
        is_unidentified: isUnidentifiedFlag,
      };
    });

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

    // Clinical-decision gate. The wrapAutoRBAC roster
    // (`appointmentRoutes` in rbacConfig.js) allows DOCTOR / ADMIN /
    // NURSE / RECEPTIONIST / PATIENT through — fine for booking +
    // cancel, too permissive for "patient needs to be admitted". The
    // admission advice is the trigger for an IPD bed allocation, so
    // restricting to DOCTOR + SUPER_ADMIN keeps the chain of clinical
    // authority intact. ADMIN can also advise (super-admin override
    // for ops desk edge cases) but not NURSE or RECEPTIONIST.
    const role = req.user?.role ?? null;
    const ALLOWED_ROLES = new Set(['DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'ADMIN', 'SUPER_ADMIN']);
    if (role && !ALLOWED_ROLES.has(role)) {
      return error(
        res,
        'Only a doctor or admin can advise admission',
        HTTP_STATUS.FORBIDDEN,
        { code: 'ADVISE_ADMISSION_ROLE_REQUIRED' },
      );
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : null;
    const advisedBy = req.user?.uid ?? null;

    const rows = await prisma.$queryRawUnsafe(
      `UPDATE appointments
          SET advised_for_admission_at = NOW(),
              advised_for_admission_by = $1::uuid,
              advised_for_admission_note = $2,
              updated_at = NOW()
        WHERE id = $3
        RETURNING id, uid, patient_id, doctor_id, advised_for_admission_at,
                  advised_for_admission_by, advised_for_admission_note, status`,
      advisedBy, note, id,
    );
    if (!rows.length) {
      return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
    }

    // Phase 1.5 — best-effort audit row. logAudit is fire-and-forget
    // with its own error trap, so a write failure here cannot 500 the
    // advise event itself.
    logAudit(req, 'appointment-advise-admission', {
      appointment_id: rows[0].id,
      appointment_uid: rows[0].uid,
      patient_id: rows[0].patient_id,
      doctor_id: rows[0].doctor_id,
      advised_at: rows[0].advised_for_admission_at,
      note,
    }).catch(() => {});

    success(res, rows[0], 'Patient advised for admission — admission counter notified');
  } catch (err) {
    logger.error('adviseForAdmission error:', { requestId: req.id, err: err?.message, stack: err?.stack });
    error(res, 'Failed to advise for admission', HTTP_STATUS.INTERNAL_SERVER_ERROR, {
      code: 'ADVISE_ADMISSION_FAILED',
      requestId: req.id,
    });
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
    const result = await prisma.$queryRawUnsafe(`
      SELECT ash.id, ash.appointment_id, ash.from_status, ash.to_status, ash.changed_by, ash.changed_by_role, ash.reason, ash.created_at, u.name as changed_by_name
      FROM appointment_status_history ash
      LEFT JOIN users u ON ash.changed_by = u.id
      WHERE ash.appointment_id = $1
      ORDER BY ash.created_at ASC
    `, id);
    success(res, result, 'History fetched');
  } catch (err) {
    logger.error('getAppointmentHistory error:', err);
    error(res, 'Failed to fetch appointment history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
