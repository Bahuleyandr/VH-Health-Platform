// src/controllers/appointment/appointmentWorkflowController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendAppointmentConfirmationSMS } from '../../services/smsService.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
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
      maxLimit: 100,
      defaultSortBy: 'name',
      defaultSortOrder: 'ASC',
    });
    const params = [];
    const where = ['d.is_active = true'];

    if (listQuery.search) {
      params.push(`%${listQuery.search}%`);
      where.push(
        `(COALESCE(u.name, d.name) ILIKE $${params.length}
          OR COALESCE(d.department, '') ILIKE $${params.length}
          OR COALESCE(d.specialty, '') ILIKE $${params.length})`,
      );
    }

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total
         FROM doctors d
         LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
        WHERE ${where.join(' AND ')}`,
      ...params,
    );

    const total = countRows[0]?.total ?? 0;
    params.push(listQuery.limit, listQuery.offset);
    const doctors = await prisma.$queryRawUnsafe(
      `SELECT
          d.id,
          COALESCE(u.id, d.user_id) AS user_id,
          COALESCE(u.name, d.name) AS name,
          COALESCE(d.department, '') AS department,
          COALESCE(d.specialty, '') AS specialization,
          d.is_available
         FROM doctors d
         LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
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
 * Get today's appointment queue for staff (sorted by token then time)
 */
export const getTodayQueue = async (req, res) => {
  try {
    const { doctor_id, department } = req.query;
    let where = `WHERE DATE(a.appointment_date) = CURRENT_DATE AND a.status NOT IN ('CANCELLED')`;
    const params = [];
    if (doctor_id) { params.push(doctor_id); where += ` AND a.doctor_id=$${params.length}`; }
    if (department) { params.push(department); where += ` AND a.department=$${params.length}`; }

    const result = await prisma.$queryRawUnsafe(`
      SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.appointment_time,
        a.status, a.reason, a.notes, a.token_number, a.department, a.confirmed_at, a.created_at, a.updated_at,
        p.name as patient_name, p.phone as patient_phone, p.blood_group,
        d.name as doctor_display_name, doc.specialty AS specialization,
        doc.department as doctor_department
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
      ${where}
      ORDER BY a.token_number NULLS LAST, a.appointment_time
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
    if (doctor_id) { params.push(doctor_id); where += ` AND a.doctor_id=$${params.length}`; }

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
export const registerWalkIn = async (req, res) => {
  try {
    // appointments.created_by is uuid; appointment_status_history.changed_by is int.
    const staffUid = req.user?.uid;
    const staffId = req.user?.id;
    const {
      patient_name, patient_phone, patient_id,
      patient_birthday, patient_gender, patient_address,
      doctor_id, department,
      reason, notes,
      appointment_time
    } = req.body;

    if (!patient_phone && !patient_id) {
      return error(res, 'patient_phone or patient_id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$transaction(async (tx) => {
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
      } else if (!patientId && patient_phone) {
        const existing = await tx.$queryRawUnsafe(
          `SELECT id FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
          patient_phone,
          patient_phone.replace(/\D/g, '').slice(-10),
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
          const newUser = await tx.$queryRawUnsafe(
            `INSERT INTO users (phone, name, birthday, gender, address, role, updated_at)
             VALUES ($1, $2, $3::date, $4, $5, 'PATIENT', NOW()) RETURNING id`,
            patient_phone,
            patient_name || 'Walk-in Patient',
            birthday,
            gender,
            address,
          );
          patientId = newUser[0].id;
          returningPatient = false;
        }
      }

      // Atomic token number — MAX-based to dodge race conditions inside the txn.
      // `appointments.token_number` is `integer` per the live schema; the
      // previous comment + NULLIF/regex guard treated it as varchar and the
      // `NULLIF(integer_col, '')` cast errored every walk-in with
      // `invalid input syntax for type integer: ""`. See finding
      // 2026-05-08-inpatient-admission-receptionist-walkin-token-cast-500.
      const tokenResult = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(token_number), 0) + 1 AS next_token
         FROM appointments
         WHERE DATE(appointment_date) = CURRENT_DATE
           AND confirmed_at IS NOT NULL
           AND token_number IS NOT NULL`,
      );
      const tokenNumber = String(parseInt(tokenResult[0].next_token));

      // appointments has no `confirmed_by` column. created_by is uuid.
      // phone, appointment_date, appointment_time, updated_at are NOT NULL.
      const apptRows = await tx.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
            status, confirmed_at, token_number, department, created_by, updated_at)
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, 'CONFIRMED', NOW(), $7, $8, $9::uuid, NOW())
         RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
                   status, confirmed_at, token_number, department, created_at`,
        patientId,
        doctor_id || null,
        appointment_time || 'Walk-in',
        patient_phone || '',
        reason || 'Walk-in consultation',
        notes || null,
        tokenNumber,
        department || null,
        staffUid,
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

      return {
        ...appt,
        token_number: tokenNumber,
        returning_patient: returningPatient,
        prior_visit_count: priorVisitCount,
        last_visit_at: lastVisitAt,
      };
    });

    success(res, result, `Walk-in registered. Token #${result.token_number}`);
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
 * added the columns. See finding
 * 2026-05-08-inpatient-admission-receptionist-no-advise-admission-workflow.
 */
export const adviseForAdmission = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return error(res, 'Invalid appointment id', HTTP_STATUS.BAD_REQUEST);
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
