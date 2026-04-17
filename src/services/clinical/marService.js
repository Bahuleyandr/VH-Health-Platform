// src/services/clinical/marService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

// ===================================================================
// Medication Administration Record (MAR) Service
// ===================================================================

const VALID_ROUTES = ['oral', 'iv', 'im', 'sc', 'topical', 'inhaled'];

/**
 * Schedule medications for a patient.
 * @param {string} patientUid
 * @param {number|null} prescriptionId
 * @param {Array} medications - [{ medication_name, dose, route, scheduled_time, notes? }]
 * @returns {Array} Created medication_administration records
 */
export async function scheduleMedications(patientUid, prescriptionId, medications) {
  if (!medications || medications.length === 0) {
    throw AppError.badRequest('At least one medication entry is required');
  }

  const results = [];

  for (const med of medications) {
    if (!med.medication_name || !med.dose || !med.route || !med.scheduled_time) {
      throw AppError.badRequest('Each medication must have medication_name, dose, route, and scheduled_time');
    }

    if (!VALID_ROUTES.includes(med.route.toLowerCase())) {
      throw AppError.badRequest(`Invalid route: ${med.route}. Must be one of: ${VALID_ROUTES.join(', ')}`);
    }

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (patient_uid, prescription_id, medication_name, dose, route, scheduled_time, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
       RETURNING id, patient_uid, medication_name, dosage, route, scheduled_time, status, administered_by, notes, created_at`,
      
        patientUid,
        prescriptionId || null,
        med.medication_name,
        med.dose,
        med.route.toLowerCase(),
        med.scheduled_time,
        med.notes || null,
      
    );
    results.push(rows[0]);
  }

  logger.info(`Scheduled ${results.length} medications for patient ${patientUid}`);
  return results;
}

/**
 * Record medication administration.
 * @param {number} id - medication_administrations.id
 * @param {string} administeredBy - Staff UID
 * @param {string|null} notes
 * @param {string|null} witnessUid - For controlled substances
 * @returns {Object} Updated record
 */
export async function recordAdministration(id, administeredBy, notes = null, witnessUid = null) {
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM medication_administrations WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status === 'administered') {
    throw AppError.conflict('Medication has already been administered');
  }

  if (!['scheduled', 'held'].includes(existing[0].status)) {
    throw AppError.invalidTransition(existing[0].status, 'administered', ['scheduled', 'held']);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE medication_administrations
     SET status = 'administered',
         administered_at = NOW(),
         administered_by = $2,
         notes = COALESCE($3, notes),
         witness_uid = $4
     WHERE id = $1
     RETURNING id, patient_uid, medication_name, dosage, route, scheduled_time, status, administered_by, notes, created_at`,
    id, administeredBy, notes, witnessUid
  );

  logger.info(`Medication ${id} administered by ${administeredBy}`);
  return rows[0];
}

/**
 * Record a missed medication dose.
 * @param {number} id
 * @param {string} reason
 * @returns {Object} Updated record
 */
export async function recordMissed(id, reason) {
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM medication_administrations WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status !== 'scheduled') {
    throw AppError.invalidTransition(existing[0].status, 'missed', ['scheduled']);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE medication_administrations
     SET status = 'missed', notes = COALESCE($2, notes)
     WHERE id = $1
     RETURNING id, patient_uid, medication_name, dosage, route, scheduled_time, status, administered_by, notes, created_at`,
    id, reason
  );

  logger.info(`Medication ${id} marked as missed`);
  return rows[0];
}

/**
 * Hold a medication with reason.
 * @param {number} id
 * @param {string} reason
 * @param {string} heldBy - Staff UID
 * @returns {Object} Updated record
 */
export async function holdMedication(id, reason, heldBy) {
  if (!reason) {
    throw AppError.badRequest('Hold reason is required');
  }

  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM medication_administrations WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status !== 'scheduled') {
    throw AppError.invalidTransition(existing[0].status, 'held', ['scheduled']);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE medication_administrations
     SET status = 'held', hold_reason = $2, administered_by = $3::uuid
     WHERE id = $1
     RETURNING id, patient_uid, medication_name, dosage, route, scheduled_time, status, administered_by, notes, created_at`,
    id, reason, heldBy
  );

  logger.info(`Medication ${id} held by ${heldBy}: ${reason}`);
  return rows[0];
}

/**
 * Get a patient's MAR for a specific date.
 * @param {string} patientUid
 * @param {string} date - ISO date string (YYYY-MM-DD), defaults to today
 * @returns {Array} Medication records for the day
 */
export async function getPatientMAR(patientUid, date) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, prescription_id, medication_name, dose, route,
            scheduled_time, administered_at, administered_by, status,
            hold_reason, refusal_reason, notes, witness_uid, created_at
     FROM medication_administrations
     WHERE patient_uid = $1
       AND scheduled_time >= $2::date
       AND scheduled_time < ($2::date + INTERVAL '1 day')
     ORDER BY scheduled_time ASC`,
    patientUid, targetDate
  );

  return rows;
}

/**
 * Get overdue medications (scheduled but past their scheduled_time).
 * Optionally filter by ward via a join with bed assignments.
 * @param {string|null} wardId
 * @returns {Array} Overdue medication records
 */
export async function getOverdueMedications(wardId) {
  let query = `
    SELECT ma.id, ma.patient_uid, ma.medication_name, ma.dose, ma.route,
           ma.scheduled_time, ma.status, ma.notes
    FROM medication_administrations ma
    WHERE ma.status = 'scheduled'
      AND ma.scheduled_time < NOW()
  `;
  const params = [];

  if (wardId) {
    params.push(wardId);
    query += `
      AND ma.patient_uid IN (
        SELECT b.patient_uid FROM beds b
        WHERE b.ward_id = $${params.length} AND b.patient_uid IS NOT NULL
      )
    `;
  }

  query += ' ORDER BY ma.scheduled_time ASC';

  const rows = await prisma.$queryRawUnsafe(query, params);
  return rows;
}

/**
 * Get the nurse "due meds" list — scheduled/held medications within a
 * rolling window around now. Joins patient name + bed/ward so the client
 * can render a single list without extra round-trips.
 *
 * @param {Object} opts
 * @param {number|null} opts.wardId - Optional ward filter
 * @param {number} opts.pastMinutes - How far back to look (default 120)
 * @param {number} opts.futureMinutes - How far forward (default 60)
 * @returns {Array} Medication rows with patient_name, bed_number, ward_name
 */
export async function getDueMedications({ wardId = null, pastMinutes = 120, futureMinutes = 60 } = {}) {
  const params = [pastMinutes, futureMinutes];
  let wardClause = '';
  if (wardId) {
    params.push(wardId);
    wardClause = `AND b.ward_id = $${params.length}`;
  }

  const query = `
    SELECT ma.id,
           ma.patient_uid,
           ma.medication_name,
           ma.dose,
           ma.dosage,
           ma.route,
           ma.scheduled_time,
           ma.status,
           ma.notes,
           u.name AS patient_name,
           b.bed_number,
           b.ward_id,
           w.name AS ward_name
      FROM medication_administrations ma
      LEFT JOIN users u ON u.uid = ma.patient_uid
      LEFT JOIN beds  b ON b.patient_id = u.id
      LEFT JOIN wards w ON w.id = b.ward_id
     WHERE ma.status IN ('scheduled', 'held')
       AND ma.scheduled_time BETWEEN (NOW() - ($1 || ' minutes')::interval)
                                 AND (NOW() + ($2 || ' minutes')::interval)
       ${wardClause}
     ORDER BY ma.scheduled_time ASC
  `;

  return prisma.$queryRawUnsafe(query, ...params);
}

export default {
  scheduleMedications,
  recordAdministration,
  recordMissed,
  holdMedication,
  getPatientMAR,
  getOverdueMedications,
  getDueMedications,
};
