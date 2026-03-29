import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import AppError from '../../utils/AppError.js';

/**
 * Create a new medication reminder for a patient.
 */
export async function createReminder(patientUid, data) {
  const { medication_name, dosage, frequency, reminder_times, start_date, end_date, notes } = data;

  const result = await db.query(`
    INSERT INTO medication_reminders
      (patient_uid, medication_name, dosage, frequency, reminder_times, start_date, end_date, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, patient_uid, medication_name, dosage, frequency, reminder_times,
              start_date, end_date, is_active, notes, created_at
  `, [patientUid, medication_name, dosage, frequency, reminder_times, start_date, end_date || null, notes || null]);

  return result.rows[0];
}

/**
 * Get all active medication reminders for a patient.
 */
export async function getActiveReminders(patientUid) {
  const result = await db.query(`
    SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
           start_date, end_date, is_active, notes, created_at
    FROM medication_reminders
    WHERE patient_uid = $1 AND is_active = true
    ORDER BY created_at DESC
  `, [patientUid]);

  return result.rows;
}

/**
 * Update an existing medication reminder.
 * Enforces ownership via patient_uid.
 */
export async function updateReminder(id, patientUid, data) {
  const { medication_name, dosage, frequency, reminder_times, start_date, end_date, notes } = data;

  const result = await db.query(`
    UPDATE medication_reminders
    SET medication_name = COALESCE($3, medication_name),
        dosage = COALESCE($4, dosage),
        frequency = COALESCE($5, frequency),
        reminder_times = COALESCE($6, reminder_times),
        start_date = COALESCE($7, start_date),
        end_date = $8,
        notes = $9
    WHERE id = $1 AND patient_uid = $2
    RETURNING id, patient_uid, medication_name, dosage, frequency, reminder_times,
              start_date, end_date, is_active, notes, created_at
  `, [id, patientUid, medication_name, dosage, frequency, reminder_times, start_date, end_date, notes || null]);

  if (result.rows.length === 0) {
    throw AppError.notFound('Medication reminder not found');
  }

  return result.rows[0];
}

/**
 * Soft-deactivate a medication reminder.
 * Enforces ownership via patient_uid.
 */
export async function deactivateReminder(id, patientUid) {
  const result = await db.query(`
    UPDATE medication_reminders
    SET is_active = false
    WHERE id = $1 AND patient_uid = $2
    RETURNING id, patient_uid, medication_name, is_active
  `, [id, patientUid]);

  if (result.rows.length === 0) {
    throw AppError.notFound('Medication reminder not found');
  }

  return result.rows[0];
}

/**
 * Get reminders due in the next hour for a patient.
 * Compares current time (HH:MM) against reminder_times array.
 */
export async function getDueReminders(patientUid) {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const endMinutes = currentMinutes + 60;

  // Format current time and +1 hour time as HH:MM for comparison
  const formatTime = (totalMinutes) => {
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const currentTime = formatTime(currentMinutes);
  const endTime = formatTime(endMinutes);

  let query;
  let params;

  if (endMinutes < 1440) {
    // Normal case: doesn't wrap past midnight
    query = `
      SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
             start_date, end_date, is_active, notes, created_at
      FROM medication_reminders
      WHERE patient_uid = $1
        AND is_active = true
        AND start_date <= CURRENT_DATE
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
        AND EXISTS (
          SELECT 1 FROM unnest(reminder_times) AS t(time_val)
          WHERE t.time_val >= $2 AND t.time_val <= $3
        )
      ORDER BY created_at DESC
    `;
    params = [patientUid, currentTime, endTime];
  } else {
    // Wraps past midnight
    query = `
      SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
             start_date, end_date, is_active, notes, created_at
      FROM medication_reminders
      WHERE patient_uid = $1
        AND is_active = true
        AND start_date <= CURRENT_DATE
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
        AND EXISTS (
          SELECT 1 FROM unnest(reminder_times) AS t(time_val)
          WHERE t.time_val >= $2 OR t.time_val <= $3
        )
      ORDER BY created_at DESC
    `;
    params = [patientUid, currentTime, endTime];
  }

  const result = await db.query(query, params);
  return result.rows;
}
