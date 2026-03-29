// src/services/clinical/handoverService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

// ===================================================================
// Nurse Handover Service
// ===================================================================

const VALID_SHIFTS = ['morning', 'afternoon', 'night'];

/**
 * Create a nurse handover note.
 * @param {Object} data
 * @returns {Object} Created handover record
 */
export async function createHandover(data) {
  const {
    patient_uid,
    ward,
    bed_number,
    outgoing_nurse,
    incoming_nurse,
    shift,
    patient_summary,
    active_issues = [],
    pending_tasks = [],
    medications_due = [],
    special_instructions,
  } = data;

  if (!patient_uid || !outgoing_nurse || !shift || !patient_summary) {
    throw AppError.badRequest('patient_uid, outgoing_nurse, shift, and patient_summary are required');
  }

  if (!VALID_SHIFTS.includes(shift.toLowerCase())) {
    throw AppError.badRequest(`Invalid shift: ${shift}. Must be one of: ${VALID_SHIFTS.join(', ')}`);
  }

  const { rows } = await db.query(
    `INSERT INTO nurse_handovers
       (patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse, shift,
        patient_summary, active_issues, pending_tasks, medications_due,
        special_instructions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      patient_uid,
      ward || null,
      bed_number || null,
      outgoing_nurse,
      incoming_nurse || null,
      shift.toLowerCase(),
      patient_summary,
      active_issues,
      pending_tasks,
      medications_due,
      special_instructions || null,
    ]
  );

  logger.info(`Handover created by nurse ${outgoing_nurse} for patient ${patient_uid} (${shift} shift)`);
  return rows[0];
}

/**
 * Acknowledge a handover as the incoming nurse.
 * @param {number} id - Handover ID
 * @param {string} nurseUid - Incoming nurse UID
 * @returns {Object} Updated handover record
 */
export async function acknowledgeHandover(id, nurseUid) {
  const { rows: existing } = await db.query(
    'SELECT id, acknowledged, incoming_nurse FROM nurse_handovers WHERE id = $1',
    [id]
  );

  if (existing.length === 0) {
    throw AppError.notFound('Handover record not found');
  }

  if (existing[0].acknowledged) {
    throw AppError.conflict('Handover has already been acknowledged');
  }

  const { rows } = await db.query(
    `UPDATE nurse_handovers
     SET acknowledged = true,
         acknowledged_at = NOW(),
         incoming_nurse = COALESCE(incoming_nurse, $2)
     WHERE id = $1
     RETURNING *`,
    [id, nurseUid]
  );

  logger.info(`Handover ${id} acknowledged by nurse ${nurseUid}`);
  return rows[0];
}

/**
 * Get active (unacknowledged) handovers for an incoming nurse.
 * @param {string} nurseUid
 * @returns {Array} Pending handover records
 */
export async function getActiveHandovers(nurseUid) {
  const { rows } = await db.query(
    `SELECT id, patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse,
            shift, patient_summary, active_issues, pending_tasks,
            medications_due, special_instructions, acknowledged, created_at
     FROM nurse_handovers
     WHERE (incoming_nurse = $1 OR incoming_nurse IS NULL)
       AND acknowledged = false
     ORDER BY created_at DESC`,
    [nurseUid]
  );

  return rows;
}

/**
 * Get handover history for a patient.
 * @param {string} patientUid
 * @param {number} limit
 * @returns {Array} Handover records
 */
export async function getPatientHandoverHistory(patientUid, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse,
            shift, patient_summary, active_issues, pending_tasks,
            medications_due, special_instructions, acknowledged,
            acknowledged_at, created_at
     FROM nurse_handovers
     WHERE patient_uid = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [patientUid, limit]
  );

  return rows;
}

export default {
  createHandover,
  acknowledgeHandover,
  getActiveHandovers,
  getPatientHandoverHistory,
};
