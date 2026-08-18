import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';

// Synthetic id offset for ANC-supplement reminders projected into the
// medication_reminders shape. medication_reminders.id is a SERIAL; the
// large offset keeps the two id spaces disjoint so the patient app's
// list never collides on a real reminder's id.
const ANC_SUPPLEMENT_ID_OFFSET = 1_000_000_000;

const DEFAULT_REMINDER_TIMES = {
  once_daily: ['09:00'],
  twice_daily: ['09:00', '21:00'],
  thrice_daily: ['08:00', '14:00', '20:00'],
  four_times_daily: ['06:00', '12:00', '18:00', '00:00'],
  at_bedtime: ['21:00'],
};

function normalizePrescriptionFrequency(value, text = '') {
  const joined = `${value || ''} ${text || ''}`.toLowerCase();
  const compact = joined.replace(/\s+/g, '_');
  if (/\b(q6h|qid|qds)\b/.test(joined) || /every[_\s-]*6[_\s-]*hours?/.test(compact)) return 'four_times_daily';
  if (/\b(q8h|tds|tid)\b/.test(joined) || /every[_\s-]*8[_\s-]*hours?/.test(compact)) return 'thrice_daily';
  if (/\b(q12h|bd|bid)\b/.test(joined) || /every[_\s-]*12[_\s-]*hours?/.test(compact)) return 'twice_daily';
  if (/\b(q24h|od|qd)\b/.test(joined) || /once[_\s-]*daily/.test(compact)) return 'once_daily';
  if (/\b(hs|bedtime)\b/.test(joined)) return 'at_bedtime';
  return null;
}

function parseDurationEndDate(duration, startDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const match = String(duration || '').match(/(\d+)\s*(day|days|d)\b/i);
  if (!match) return null;
  const days = Number.parseInt(match[1], 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return end.toISOString().slice(0, 10);
}

function medicationNameOf(med) {
  return med?.name || med?.medication_name || med?.drug_name || null;
}

function dosageOf(med) {
  return med?.dose || med?.dosage || med?.strength || '';
}

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
    (anc.id + ${ANC_SUPPLEMENT_ID_OFFSET}) AS id,
    anc.patient_uid AS patient_uid,
    CASE
      WHEN anc.dose IS NOT NULL AND length(trim(anc.dose)) > 0
        THEN INITCAP(REPLACE(anc.supplement, '_', ' ')) || ' (' || anc.dose || ')'
      ELSE INITCAP(REPLACE(anc.supplement, '_', ' '))
    END AS medication_name,
    COALESCE(anc.dose, '') AS dosage,
    anc.frequency AS frequency,
    CASE LOWER(anc.frequency)
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
    anc.start_date AS start_date,
    anc.end_date   AS end_date,
    TRUE          AS is_active,
    COALESCE(NULLIF(trim(anc.notes), ''), 'ANC supplement — managed by your doctor') AS notes,
    anc.created_at AS created_at,
    'anc_supplement' AS source
  FROM (
    SELECT DISTINCT ON (raw.patient_uid, raw.therapy_key)
      raw.*
    FROM (
      SELECT
        ms.*,
        mp.patient_uid,
        CASE
          WHEN ms.supplement = 'folic_acid' AND EXISTS (
            SELECT 1 FROM maternity_supplements iron
             WHERE iron.pregnancy_id = ms.pregnancy_id
               AND iron.supplement = 'iron'
               AND iron.reminder_enabled = TRUE
               AND iron.start_date <= CURRENT_DATE
               AND (iron.end_date IS NULL OR iron.end_date >= CURRENT_DATE)
          ) THEN 'iron'
          WHEN ms.supplement = 'vitamin_d' AND EXISTS (
            SELECT 1 FROM maternity_supplements calcium
             WHERE calcium.pregnancy_id = ms.pregnancy_id
               AND calcium.supplement = 'calcium'
               AND calcium.reminder_enabled = TRUE
               AND calcium.start_date <= CURRENT_DATE
               AND (calcium.end_date IS NULL OR calcium.end_date >= CURRENT_DATE)
          ) THEN 'calcium'
          ELSE ms.supplement
        END AS therapy_key,
        CASE
          WHEN ms.supplement IN ('iron', 'calcium') THEN 0
          WHEN ms.supplement IN ('folic_acid', 'vitamin_d') THEN 1
          ELSE 2
        END AS therapy_priority
      FROM maternity_supplements ms
      JOIN maternity_pregnancies mp ON mp.id = ms.pregnancy_id
      WHERE mp.patient_uid = $1::uuid
        AND mp.status = 'ongoing'
        AND ms.reminder_enabled = TRUE
        AND ms.start_date <= CURRENT_DATE
        AND (ms.end_date IS NULL OR ms.end_date >= CURRENT_DATE)
    ) raw
    ORDER BY raw.patient_uid, raw.therapy_key, raw.therapy_priority ASC, raw.created_at DESC, raw.id DESC
  ) anc
`;

/**
 * Create a new medication reminder for a patient.
 */
export async function createReminder(patientUid, data) {
  const { medication_name, dosage, frequency, reminder_times, start_date, end_date, notes } = data;

  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO medication_reminders
      (patient_uid, medication_name, dosage, frequency, reminder_times, start_date, end_date, notes)
    VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8)
    RETURNING id, patient_uid, medication_name, dosage, frequency, reminder_times,
              start_date, end_date, is_active, notes, created_at
  `, patientUid, medication_name, dosage, frequency, reminder_times, start_date, end_date || null, notes || null);

  return result[0];
}

export async function createPrescriptionReminders(patientUid, medications, options = {}) {
  if (!patientUid || !Array.isArray(medications) || medications.length === 0) return [];
  const startDate = options.startDate || new Date().toISOString().slice(0, 10);
  const created = [];

  for (const med of medications) {
    const medicationName = medicationNameOf(med);
    if (!medicationName) continue;
    const sourceText = [med.frequency, med.instructions, med.notes, med.duration, dosageOf(med)]
      .filter(Boolean)
      .join(' ');
    const frequency = normalizePrescriptionFrequency(med.frequency, sourceText);
    const reminderTimes = DEFAULT_REMINDER_TIMES[frequency] || [];
    if (!frequency || reminderTimes.length === 0) continue;
    const dosage = dosageOf(med);
    const endDate = med.end_date || parseDurationEndDate(med.duration, startDate);
    const notes = [
      med.instructions || med.notes || null,
      options.prescriptionNumber ? `Source prescription: ${options.prescriptionNumber}` : null,
      med.max_doses_per_day ? `Max ${med.max_doses_per_day} doses/day` : null,
    ].filter(Boolean).join(' | ') || null;

    const existing = await prisma.$queryRawUnsafe(`
      SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
             start_date, end_date, is_active, notes, created_at,
             'medication_reminder' AS source
      FROM medication_reminders
      WHERE patient_uid = $1::uuid
        AND is_active = true
        AND lower(medication_name) = lower($2)
        AND COALESCE(dosage, '') = COALESCE($3, '')
        AND COALESCE(frequency, '') = $4
        AND start_date <= $5::date
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      LIMIT 1
    `, patientUid, medicationName, dosage || null, frequency, startDate);
    if (existing[0]) {
      created.push(existing[0]);
      continue;
    }

    const row = await createReminder(patientUid, {
      medication_name: medicationName,
      dosage,
      frequency,
      reminder_times: reminderTimes,
      start_date: startDate,
      end_date: endDate,
      notes,
    });
    created.push(row);
  }

  return created;
}

/**
 * Get medication reminders for a patient (active only by default).
 *
 * Returns rows from `medication_reminders` UNION ALL ANC supplements
 * (`maternity_supplements`) projected into the same shape. ANC rows
 * carry `source='anc_supplement'` and a synthetic id offset by
 * ANC_SUPPLEMENT_ID_OFFSET so the patient app can render them read-only
 * without colliding with real reminder ids.
 *
 * Pass `{ includeInactive: true }` to also return deactivated
 * medication_reminders rows so the patient app can show a toggled-off
 * reminder (dimmed) and let the patient re-enable it via PUT
 * `is_active: true`. The default stays active-only so existing callers
 * (cold-start notification resync, older app builds) are unchanged.
 * The ANC projection only ever surfaces currently-active supplements.
 *
 * The supplements UNION is wrapped in a try/catch: tenants that have
 * not yet applied migration 181 (ANC subsystem) hit error code
 * `42P01 — relation does not exist`. Falling back to a
 * medication_reminders-only result keeps the patient screen working
 * on under-migrated environments.
 */
export async function getActiveReminders(patientUid, options = {}) {
  const includeInactive = options.includeInactive === true;
  // Fixed literal chosen by a boolean — never user input.
  const activeFilter = includeInactive ? '' : 'AND is_active = true';
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT id, patient_uid, medication_name, dosage, frequency, reminder_times,
             start_date, end_date, is_active, notes, created_at,
             'medication_reminder' AS source
      FROM medication_reminders
      WHERE patient_uid = $1::uuid ${activeFilter}
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
        WHERE patient_uid = $1::uuid ${activeFilter}
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
 * Only fields actually present in `data` are written:
 * - medication_name / dosage / frequency / reminder_times / start_date
 *   fall back to the stored value when omitted or null (COALESCE);
 * - end_date / notes are only touched when the key is present in the
 *   payload (an explicit null clears them — omitting them must NOT
 *   null a course's end_date, which is what previously made every
 *   partial PUT wipe the stored end date and notes);
 * - is_active (boolean) deactivates/reactivates the reminder, so the
 *   patient app's switch is reversible in both directions.
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
  const { medication_name, dosage, frequency, reminder_times, start_date } = data;

  const hasEndDate = Object.prototype.hasOwnProperty.call(data, 'end_date');
  const hasNotes = Object.prototype.hasOwnProperty.call(data, 'notes');
  let isActive = null;
  if (Object.prototype.hasOwnProperty.call(data, 'is_active')) {
    if (typeof data.is_active !== 'boolean') {
      throw AppError.badRequest('is_active must be a boolean');
    }
    isActive = data.is_active;
  }

  const result = await prisma.$queryRawUnsafe(`
    UPDATE medication_reminders
    SET medication_name = COALESCE($3, medication_name),
        dosage = COALESCE($4, dosage),
        frequency = COALESCE($5, frequency),
        reminder_times = COALESCE($6, reminder_times),
        start_date = COALESCE($7::date, start_date),
        end_date = CASE WHEN $8::boolean THEN $9::date ELSE end_date END,
        notes = CASE WHEN $10::boolean THEN $11::text ELSE notes END,
        is_active = COALESCE($12::boolean, is_active),
        updated_at = NOW()
    WHERE id = $1 AND patient_uid = $2::uuid
    RETURNING id, patient_uid, medication_name, dosage, frequency, reminder_times,
              start_date, end_date, is_active, notes, created_at
  `, id, patientUid,
  medication_name ?? null, dosage ?? null, frequency ?? null,
  reminder_times ?? null, start_date ?? null,
  hasEndDate, hasEndDate ? (data.end_date ?? null) : null,
  hasNotes, hasNotes ? (data.notes ?? null) : null,
  isActive);

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
