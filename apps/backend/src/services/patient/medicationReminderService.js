import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';

// Synthetic id offset for ANC-supplement reminders projected into the
// medication_reminders shape. medication_reminders.id is a SERIAL; the
// large offset keeps the two id spaces disjoint so the patient app's
// list never collides on a real reminder's id.
const ANC_SUPPLEMENT_ID_OFFSET = 1_000_000_000;

// SQL fragment that synthesises medication_reminders-shaped rows from
// `maternity_supplements`. The Flutter app posts/deletes against
// `/reminders/medication/:id`; rows with `source='anc_supplement'`
// carry the synthetic offset id so the staff-managed supplement row
// stays untouched. The patient app surfaces them as read-only.
//
// Frequency → reminder_times mapping picks a sensible default time of
// day: 09:00 for OD, 09:00 + 21:00 for BD, 08:00/14:00/20:00 for TDS,
// 06:00/12:00/18:00/00:00 for QID. `as_needed` rows still surface (so
// the patient sees the supplement is prescribed) but with an empty
// reminder_times array so no daily local notification is scheduled.
const ANC_SUPPLEMENT_PROJECTION = `
  SELECT
    (ms.id + ${ANC_SUPPLEMENT_ID_OFFSET}) AS id,
    mp.patient_uid AS patient_uid,
    CASE
      WHEN ms.dose IS NOT NULL AND length(trim(ms.dose)) > 0
        THEN INITCAP(REPLACE(ms.supplement, '_', ' ')) || ' (' || ms.dose || ')'
      ELSE INITCAP(REPLACE(ms.supplement, '_', ' '))
    END AS medication_name,
    COALESCE(ms.dose, '') AS dosage,
    ms.frequency AS frequency,
    CASE LOWER(ms.frequency)
      WHEN 'once_daily'   THEN ARRAY['09:00']
      WHEN 'twice_daily'  THEN ARRAY['09:00','21:00']
      WHEN 'thrice_daily' THEN ARRAY['08:00','14:00','20:00']
      WHEN 'four_times_daily' THEN ARRAY['06:00','12:00','18:00','00:00']
      WHEN 'qid'          THEN ARRAY['06:00','12:00','18:00','00:00']
      WHEN 'bd'           THEN ARRAY['09:00','21:00']
      WHEN 'tds'          THEN ARRAY['08:00','14:00','20:00']
      WHEN 'od'           THEN ARRAY['09:00']
      WHEN 'weekly'       THEN ARRAY['09:00']
      ELSE ARRAY[]::text[]
    END AS reminder_times,
    ms.start_date AS start_date,
    ms.end_date   AS end_date,
    TRUE          AS is_active,
    COALESCE(NULLIF(trim(ms.notes), ''), 'ANC supplement — managed by your doctor') AS notes,
    ms.created_at AS created_at,
    'anc_supplement' AS source
  FROM maternity_supplements ms
  JOIN maternity_pregnancies mp ON mp.id = ms.pregnancy_id
  WHERE mp.patient_uid = $1::uuid
    AND mp.status = 'ongoing'
    AND ms.reminder_enabled = TRUE
    AND ms.start_date <= CURRENT_DATE
    AND (ms.end_date IS NULL OR ms.end_date >= CURRENT_DATE)
`;

/**
 * Create a new medication reminder for a patient.
 */
export async function createReminder(patientUid, data) {
  const { medication_name, dosage, frequency, reminder_times, start_date, end_date, notes } = data;

  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO medication_reminders
      (patient_uid, medication_name, dosage, frequency, reminder_times, start_date, end_date, notes)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, patient_uid, medication_name, dosage, frequency, reminder_times,
              start_date, end_date, is_active, notes, created_at
  `, patientUid, medication_name, dosage, frequency, reminder_times, start_date, end_date || null, notes || null);

  return result[0];
}

/**
 * Get all active medication reminders for a patient.
 *
 * Returns rows from `medication_reminders` UNION ALL ANC supplements
 * (`maternity_supplements`) projected into the same shape. ANC rows
 * carry `source='anc_supplement'` and a synthetic id offset by
 * ANC_SUPPLEMENT_ID_OFFSET so the patient app can render them read-only
 * without colliding with real reminder ids.
 *
 * The supplements UNION is wrapped in a try/catch: tenants that have
 * not yet applied migration 181 (ANC subsystem) hit error code
 * `42P01 — relation does not exist`. Falling back to a
 * medication_reminders-only result keeps the patient screen working
 * on under-migrated environments.
 */
export async function getActiveReminders(patientUid) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
             start_date, end_date, is_active, notes, created_at,
             'medication_reminder' AS source
      FROM medication_reminders
      WHERE patient_uid = $1::uuid AND is_active = true
      UNION ALL
      ${ANC_SUPPLEMENT_PROJECTION}
      ORDER BY created_at DESC
    `, patientUid);
    return result;
  } catch (err) {
    if (err?.meta?.code === '42P01' || /maternity_supplements/i.test(err?.message || '')) {
      logger.warn('ANC supplements union skipped (table missing): falling back to medication_reminders only');
      const fallback = await prisma.$queryRawUnsafe(`
        SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
               start_date, end_date, is_active, notes, created_at,
               'medication_reminder' AS source
        FROM medication_reminders
        WHERE patient_uid = $1::uuid AND is_active = true
        ORDER BY created_at DESC
      `, patientUid);
      return fallback;
    }
    throw err;
  }
}

/**
 * Update an existing medication reminder.
 * Enforces ownership via patient_uid.
 *
 * ANC-supplement projections (id >= ANC_SUPPLEMENT_ID_OFFSET) are
 * doctor-managed and cannot be edited from the patient app — return
 * a 403-style AppError so the UI shows a sensible message instead of
 * silently rewriting an unrelated medication_reminders row.
 */
export async function updateReminder(id, patientUid, data) {
  if (Number.isFinite(id) && id >= ANC_SUPPLEMENT_ID_OFFSET) {
    throw AppError.forbidden(
      'ANC supplement reminders are managed by your doctor and cannot be edited here',
    );
  }
  const { medication_name, dosage, frequency, reminder_times, start_date, end_date, notes } = data;

  const result = await prisma.$queryRawUnsafe(`
    UPDATE medication_reminders
    SET medication_name = COALESCE($3, medication_name),
        dosage = COALESCE($4, dosage),
        frequency = COALESCE($5, frequency),
        reminder_times = COALESCE($6, reminder_times),
        start_date = COALESCE($7, start_date),
        end_date = $8,
        notes = $9,
        updated_at = NOW()
    WHERE id = $1 AND patient_uid = $2::uuid
    RETURNING id, patient_uid, medication_name, dosage, frequency, reminder_times,
              start_date, end_date, is_active, notes, created_at
  `, id, patientUid, medication_name, dosage, frequency, reminder_times, start_date, end_date, notes || null);

  if (result.length === 0) {
    throw AppError.notFound('Medication reminder not found');
  }

  return result[0];
}

/**
 * Soft-deactivate a medication reminder.
 * Enforces ownership via patient_uid.
 *
 * ANC-supplement projections (id >= ANC_SUPPLEMENT_ID_OFFSET) are
 * doctor-managed — refuse the deactivation rather than no-op.
 */
export async function deactivateReminder(id, patientUid) {
  if (Number.isFinite(id) && id >= ANC_SUPPLEMENT_ID_OFFSET) {
    throw AppError.forbidden(
      'ANC supplement reminders are managed by your doctor and cannot be removed here',
    );
  }
  const result = await prisma.$queryRawUnsafe(`
    UPDATE medication_reminders
    SET is_active = false,
        updated_at = NOW()
    WHERE id = $1 AND patient_uid = $2::uuid
    RETURNING id, patient_uid, medication_name, is_active
  `, id, patientUid);

  if (result.length === 0) {
    throw AppError.notFound('Medication reminder not found');
  }

  return result[0];
}

/**
 * Get reminders due in the next hour for a patient.
 *
 * Compares current time (HH:MM) against reminder_times array on both
 * `medication_reminders` and ANC-supplement projections.
 */
export async function getDueReminders(patientUid) {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const endMinutes = currentMinutes + 60;

  const formatTime = (totalMinutes) => {
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const currentTime = formatTime(currentMinutes);
  const endTime = formatTime(endMinutes);

  // Across-midnight wrap uses OR; otherwise BETWEEN-style AND.
  const timeCondition = endMinutes < 1440
    ? 't.time_val >= $2 AND t.time_val <= $3'
    : 't.time_val >= $2 OR t.time_val <= $3';

  const dueQuery = `
    WITH all_reminders AS (
      SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
             start_date, end_date, is_active, notes, created_at,
             'medication_reminder' AS source
      FROM medication_reminders
      WHERE patient_uid = $1::uuid AND is_active = TRUE
        AND start_date <= CURRENT_DATE
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      UNION ALL
      ${ANC_SUPPLEMENT_PROJECTION}
    )
    SELECT * FROM all_reminders
    WHERE EXISTS (
      SELECT 1 FROM unnest(reminder_times) AS t(time_val)
      WHERE ${timeCondition}
    )
    ORDER BY created_at DESC
  `;

  try {
    return await prisma.$queryRawUnsafe(dueQuery, patientUid, currentTime, endTime);
  } catch (err) {
    if (err?.meta?.code === '42P01' || /maternity_supplements/i.test(err?.message || '')) {
      logger.warn('ANC supplements union skipped in due-reminders (table missing): falling back');
      const fallback = await prisma.$queryRawUnsafe(`
        SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
               start_date, end_date, is_active, notes, created_at,
               'medication_reminder' AS source
        FROM medication_reminders
        WHERE patient_uid = $1::uuid
          AND is_active = TRUE
          AND start_date <= CURRENT_DATE
          AND (end_date IS NULL OR end_date >= CURRENT_DATE)
          AND EXISTS (
            SELECT 1 FROM unnest(reminder_times) AS t(time_val)
            WHERE ${timeCondition}
          )
        ORDER BY created_at DESC
      `, patientUid, currentTime, endTime);
      return fallback;
    }
    throw err;
  }
}
