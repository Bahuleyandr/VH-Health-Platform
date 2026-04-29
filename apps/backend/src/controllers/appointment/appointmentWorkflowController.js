// src/controllers/appointment/appointmentWorkflowController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendAppointmentConfirmationSMS } from '../../services/smsService.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * Staff confirms an appointment — assigns token, sets confirmed_at, notifies patient
 */
export const confirmAppointment = async (req, res) => {
  const client = await prisma;
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { confirmation_notes, appointment_date, appointment_time } = req.body;

    await client.query('BEGIN');

    // Lock the row being updated to prevent concurrent modifications
    const appt = await client.query(
      'SELECT id, patient_id, doctor_id, appointment_date, appointment_time, status, department, phone FROM appointments WHERE id=$1 FOR UPDATE',
      [id]
    );
    if (!appt.length) {
      await client.query('ROLLBACK');
      return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
    }
    const a = appt[0];
    if (a.status === 'CANCELLED') {
      await client.query('ROLLBACK');
      return error(res, 'Cannot confirm a cancelled appointment', HTTP_STATUS.BAD_REQUEST);
    }

    // Get next token number atomically using MAX instead of COUNT to avoid gaps
    const targetDate = appointment_date || a.appointment_date;
    const tokenResult = await client.query(
      `SELECT COALESCE(MAX(token_number), 0) + 1 as next_token
       FROM appointments
       WHERE DATE(appointment_date) = DATE($1) AND confirmed_at IS NOT NULL`,
      [targetDate]
    );
    const tokenNumber = parseInt(tokenResult[0].next_token);

    const newDate = appointment_date || a.appointment_date;
    const newTime = appointment_time || a.appointment_time;

    const result = await client.query(`
      UPDATE appointments SET
        status = 'CONFIRMED',
        confirmed_by = $1,
        confirmed_at = NOW(),
        confirmation_notes = $2,
        token_number = $3,
        appointment_date = $4,
        appointment_time = $5,
        sla_target_at = COALESCE(sla_target_at, created_at + INTERVAL '30 minutes'),
        updated_at = NOW()
      WHERE id = $6
      RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, reason, notes, token_number, confirmed_by, confirmed_at, department, created_at, updated_at
    `, [staffId, confirmation_notes || null, tokenNumber, newDate, newTime, id]);

    // Log status change within the same transaction
    await client.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
       VALUES ($1,$2,'CONFIRMED',$3,'staff',$4)`,
      [id, a.status, staffId, confirmation_notes || null]
    );

    await client.query('COMMIT');

    // Notify patient via FCM + SMS (fire-and-forget, outside transaction)
    const patient = await prisma.$queryRawUnsafe('SELECT device_token, name, phone FROM users WHERE id=$1', a.patient_id);
    const patientRow = patient[0];

    // Get doctor name and department for SMS
    const doctorRow = await prisma.$queryRawUnsafe(
      'SELECT u.name, doc.department FROM users u LEFT JOIN doctors doc ON doc.user_id = u.id WHERE u.id=$1',
      a.doctor_id
    );
    const doctorName = doctorRow[0]?.name || 'Doctor';
    const department = doctorRow[0]?.department || a.department || null;

    setImmediate(async () => {
      try {
        // Push notification
        if (patientRow?.device_token) {
          await sendPushNotification({
            tokens: patientRow.device_token,
            title: 'Appointment Confirmed ✓',
            body: `Your appointment on ${new Date(newDate).toLocaleDateString('en-IN')} at ${newTime} is confirmed. Token #${tokenNumber}`,
            data: { type: 'appointment_confirmed', appointment_id: String(id), token: String(tokenNumber) },
            userId: String(a.patient_id),
          });
        }
        // SMS confirmation
        const smsPhone = patientRow?.phone || a.phone;
        await sendAppointmentConfirmationSMS(
          smsPhone,
          patientRow?.name || 'Patient',
          doctorName,
          newDate,
          newTime,
          tokenNumber,
          department
        );
      } catch (e) { logger.warn('Appointment notification/SMS failed:', e.message); }
    });

    success(res, result[0], `Appointment confirmed. Token #${tokenNumber}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackErr => {
      logger.error('Transaction rollback failed:', rollbackErr);
    });
    logger.error('Confirm Appointment Error:', err);
    error(res, 'Failed to confirm appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  } finally {
    client.release();
  }
};

/**
 * Staff marks appointment as no-show
 */
export const markNoShow = async (req, res) => {
  const client = await prisma;
  try {
    const { id } = req.params;
    const staffId = req.user?.id;

    await client.query('BEGIN');

    const appt = await client.query('SELECT id, status FROM appointments WHERE id=$1 FOR UPDATE', [id]);
    if (!appt.length) {
      await client.query('ROLLBACK');
      return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await client.query(
      `UPDATE appointments SET status='NO_SHOW', no_show_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, token_number, updated_at`,
      [id]
    );
    await client.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role) VALUES ($1,$2,'NO_SHOW',$3,'staff')`,
      [id, appt[0].status, staffId]
    );

    await client.query('COMMIT');
    success(res, result[0], 'Marked as no-show');
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackErr => {
      logger.error('Transaction rollback failed:', rollbackErr);
    });
    logger.error('Mark No-Show Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  } finally {
    client.release();
  }
};

/**
 * Staff marks appointment as completed (patient visited)
 */
export const completeAppointment = async (req, res) => {
  const client = await prisma;
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { notes } = req.body;

    await client.query('BEGIN');

    const appt = await client.query('SELECT id, patient_id, status FROM appointments WHERE id=$1 FOR UPDATE', [id]);
    if (!appt.length) {
      await client.query('ROLLBACK');
      return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await client.query(
      `UPDATE appointments SET status='COMPLETED', completed_at=NOW(), notes=COALESCE($2, notes), updated_at=NOW() WHERE id=$1 RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, notes, token_number, completed_at, updated_at`,
      [id, notes || null]
    );
    await client.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role) VALUES ($1,$2,'COMPLETED',$3,'staff')`,
      [id, appt[0].status, staffId]
    );

    await client.query('COMMIT');

    // Schedule feedback request 2 hours after visit (fire-and-forget, outside transaction)
    setImmediate(async () => {
      try {
        const a = appt[0];
        await prisma.$queryRawUnsafe(`
          INSERT INTO scheduled_notifications (user_id, type, data, send_at, status)
          VALUES ($1, 'feedback_request', $2, NOW() + INTERVAL '2 hours', 'pending')
        `,
          a.patient_id,
          JSON.stringify({ appointment_id: id, type: 'appointment_feedback' })
        );
        logger.info(`[Feedback] Scheduled feedback request for appointment ${id} in 2h`);
      } catch (e) {
        logger.warn('[Feedback] Failed to schedule feedback notification:', e.message);
      }
    });

    success(res, result[0], 'Appointment completed');
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackErr => {
      logger.error('Transaction rollback failed:', rollbackErr);
    });
    logger.error('Complete Appointment Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  } finally {
    client.release();
  }
};

/**
 * Staff/patient cancels appointment
 */
export const cancelAppointment = async (req, res) => {
  const client = await prisma;
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { cancellation_reason } = req.body;

    await client.query('BEGIN');

    const appt = await client.query('SELECT id, patient_id, status FROM appointments WHERE id=$1 FOR UPDATE', [id]);
    if (!appt.length) {
      await client.query('ROLLBACK');
      return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await client.query(
      `UPDATE appointments SET status='CANCELLED', cancellation_reason=$2, updated_at=NOW() WHERE id=$1 RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, status, cancellation_reason, token_number, updated_at`,
      [id, cancellation_reason || null]
    );
    await client.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason) VALUES ($1,$2,'CANCELLED',$3,'staff',$4)`,
      [id, appt[0].status, staffId, cancellation_reason || null]
    );

    await client.query('COMMIT');

    // Notify patient (fire-and-forget, outside transaction)
    const patient = await prisma.$queryRawUnsafe('SELECT device_token FROM users WHERE id=$1', appt[0].patient_id);
    if (patient[0]?.device_token) {
      setImmediate(async () => {
        try {
          await sendPushNotification({
            tokens: patient[0].device_token,
            title: 'Appointment Cancelled',
            body: `Your appointment has been cancelled. ${cancellation_reason || 'Please rebook.'}`,
            data: { type: 'appointment_cancelled', appointment_id: String(id) },
            userId: String(appt[0].patient_id),
          });
        } catch (e) { logger.warn('Cancel notification failed:', e.message); }
      });
    }

    success(res, result[0], 'Appointment cancelled');
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackErr => {
      logger.error('Transaction rollback failed:', rollbackErr);
    });
    logger.error('Cancel Appointment Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  } finally {
    client.release();
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
    const staffId = req.user?.id;
    const {
      patient_name, patient_phone, patient_id,
      doctor_id, department,
      reason, notes,
      appointment_time
    } = req.body;

    if (!patient_phone && !patient_id) {
      return error(res, 'patient_phone or patient_id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$transaction(async (tx) => {
      // Resolve patient — look up by phone or patient_id, or create minimal record.
      let patientId = patient_id ? parseInt(patient_id) : null;
      if (!patientId && patient_phone) {
        const existing = await tx.$queryRawUnsafe(
          `SELECT id FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
          patient_phone,
          patient_phone.replace(/\D/g, '').slice(-10),
        );
        if (existing.length > 0) {
          patientId = existing[0].id;
        } else {
          const newUser = await tx.$queryRawUnsafe(
            `INSERT INTO users (phone, name, role) VALUES ($1, $2, 'PATIENT') RETURNING id`,
            patient_phone,
            patient_name || 'Walk-in Patient',
          );
          patientId = newUser[0].id;
        }
      }

      // Atomic token number — MAX-based to dodge race conditions inside the txn.
      const tokenResult = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(token_number), 0) + 1 as next_token
         FROM appointments
         WHERE DATE(appointment_date) = CURRENT_DATE AND confirmed_at IS NOT NULL`,
      );
      const tokenNumber = parseInt(tokenResult[0].next_token);

      const apptRows = await tx.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, appointment_date, appointment_time, reason, notes,
            status, confirmed_by, confirmed_at, token_number, department, created_by, phone)
         VALUES ($1, $2, NOW(), $3, $4, $5, 'CONFIRMED', $6, NOW(), $7, $8, $9, $10)
         RETURNING id, patient_id, doctor_id, appointment_date, appointment_time, reason, notes,
                   status, confirmed_by, confirmed_at, token_number, department, phone, created_at`,
        patientId,
        doctor_id || null,
        appointment_time || 'Walk-in',
        reason || 'Walk-in consultation',
        notes || null,
        staffId,
        tokenNumber,
        department || null,
        staffId,
        patient_phone || null,
      );
      const appt = apptRows[0];

      await tx.$executeRawUnsafe(
        `INSERT INTO appointment_status_history
           (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
         VALUES ($1, NULL, 'CONFIRMED', $2, 'staff', 'Walk-in registration')`,
        appt.id,
        staffId,
      );

      return { ...appt, token_number: tokenNumber };
    });

    success(res, result, `Walk-in registered. Token #${result.token_number}`);
  } catch (err) {
    logger.error('Walk-in Registration Error:', err);
    error(res, 'Failed to register walk-in', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  } finally {
    // No client to release — Prisma's $transaction handles that itself.
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
