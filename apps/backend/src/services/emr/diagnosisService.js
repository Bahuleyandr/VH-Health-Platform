// src/services/emr/diagnosisService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';


// ===================================================================
// Diagnosis & Problem List Service
// ===================================================================

const VALID_DIAGNOSIS_TYPES = ['primary', 'secondary', 'admitting', 'discharge'];
const VALID_STATUSES = ['active', 'resolved', 'chronic', 'recurrent'];
const VALID_SEVERITIES = ['mild', 'moderate', 'severe'];

// ===================================================================
// addDiagnosis
// ===================================================================

/**
 * Add a diagnosis with optional ICD-10 code lookup.
 * @param {Object} data - { patient_uid, encounter_id?, icd10_code?, description, diagnosis_type?, status?, onset_date?, severity?, diagnosed_by, notes? }
 * @returns {Object} Created diagnosis row
 */
export async function addDiagnosis(data) {
  const {
    patient_uid, encounter_id, icd10_code, description,
    diagnosis_type, status, onset_date, severity, diagnosed_by, notes,
  } = data;

  if (!patient_uid || !description || !diagnosed_by) {
    throw AppError.badRequest('patient_uid, description, and diagnosed_by are required');
  }

  if (diagnosis_type && !VALID_DIAGNOSIS_TYPES.includes(diagnosis_type)) {
    throw AppError.badRequest(`Invalid diagnosis_type. Must be one of: ${VALID_DIAGNOSIS_TYPES.join(', ')}`);
  }

  if (status && !VALID_STATUSES.includes(status)) {
    throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  if (severity && !VALID_SEVERITIES.includes(severity)) {
    throw AppError.badRequest(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`);
  }

  // If ICD-10 code provided, look up the description
  let icd10Description = null;
  if (icd10_code) {
    const icdRows = await prisma.$queryRawUnsafe(
      `SELECT description FROM icd10_codes WHERE code = $1`,
      icd10_code.toUpperCase().trim()
    );
    if (icdRows.length > 0) {
      icd10Description = icdRows[0].description;
    }
  }

  // Verify encounter exists if provided
  if (encounter_id) {
    const encRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM admissions WHERE encounter_id = $1`,
      encounter_id
    );
    if (encRows.length === 0) {
      throw AppError.notFound('Encounter not found');
    }
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO diagnoses
       (patient_uid, encounter_id, icd10_code, icd10_description, description,
        diagnosis_type, status, onset_date, severity, diagnosed_by, notes, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9, $10::uuid, $11, NOW())
     RETURNING id, patient_uid, encounter_id, icd10_code, icd10_description, description,
               diagnosis_type, status, onset_date, resolved_date, severity, diagnosed_by,
               notes, created_at, updated_at`,
    patient_uid,
    encounter_id || null,
    icd10_code ? icd10_code.toUpperCase().trim() : null,
    icd10Description,
    description,
    diagnosis_type || 'secondary',
    status || 'active',
    onset_date || null,
    severity || null,
    diagnosed_by,
    notes || null,
  );

  logger.info(`Diagnosis added: id=${rows[0].id}, patient=${patient_uid}, icd10=${icd10_code || 'none'}, type=${diagnosis_type || 'secondary'}`);
  return rows[0];
}

// ===================================================================
// updateDiagnosisStatus
// ===================================================================

/**
 * Update a diagnosis status (resolve, reactivate, etc.).
 * @param {number} id - Diagnosis ID
 * @param {string} status - New status
 * @param {string|null} resolvedDate - Date when resolved (ISO string)
 * @param {string} updatedBy - UID of the clinician making the update
 * @returns {Object} Updated diagnosis row
 */
export async function updateDiagnosisStatus(id, status, resolvedDate, updatedBy) {
  if (!id || !status || !updatedBy) {
    throw AppError.badRequest('id, status, and updatedBy are required');
  }

  if (!VALID_STATUSES.includes(status)) {
    throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM diagnoses WHERE id = $1`,
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Diagnosis not found');
  }

  const resolvedAt = status === 'resolved' ? (resolvedDate || new Date().toISOString().slice(0, 10)) : null;

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE diagnoses
     SET status = $2, resolved_date = $3::date, updated_at = NOW()
     WHERE id = $1
     RETURNING id, patient_uid, encounter_id, icd10_code, icd10_description, description,
               diagnosis_type, status, onset_date, resolved_date, severity, diagnosed_by,
               notes, created_at, updated_at`,
    id, status, resolvedAt
  );

  logger.info(`Diagnosis status updated: id=${id}, old_status=${existing[0].status}, new_status=${status}, by=${updatedBy}`);
  return rows[0];
}

// ===================================================================
// getActiveProblemList
// ===================================================================

/**
 * Get the active problem list: active + chronic diagnoses.
 * @param {string} patientUid
 * @returns {Array}
 */
export async function getActiveProblemList(patientUid) {
  if (!patientUid) {
    throw AppError.badRequest('Patient UID is required');
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, icd10_code, icd10_description, description,
            diagnosis_type, status, onset_date, resolved_date, severity, diagnosed_by,
            notes, created_at, updated_at
     FROM diagnoses
     WHERE patient_uid = $1::uuid AND status IN ('active', 'chronic')
     ORDER BY
       CASE diagnosis_type WHEN 'primary' THEN 1 WHEN 'admitting' THEN 2 WHEN 'secondary' THEN 3 ELSE 4 END,
       created_at DESC`,
    patientUid
  );

  return rows;
}

// ===================================================================
// getEncounterDiagnoses
// ===================================================================

/**
 * Get diagnoses for a specific encounter/admission.
 * @param {string} encounterId - UUID
 * @returns {Array}
 */
export async function getEncounterDiagnoses(encounterId) {
  if (!encounterId) {
    throw AppError.badRequest('Encounter ID is required');
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, icd10_code, icd10_description, description,
            diagnosis_type, status, onset_date, resolved_date, severity, diagnosed_by,
            notes, created_at, updated_at
     FROM diagnoses
     WHERE encounter_id = $1
     ORDER BY
       CASE diagnosis_type WHEN 'primary' THEN 1 WHEN 'admitting' THEN 2 WHEN 'secondary' THEN 3 ELSE 4 END,
       created_at ASC`,
    encounterId
  );

  return rows;
}

// ===================================================================
// getPatientDiagnosisHistory
// ===================================================================

/**
 * Full diagnosis history for a patient.
 * @param {string} patientUid
 * @returns {Array}
 */
export async function getPatientDiagnosisHistory(patientUid) {
  if (!patientUid) {
    throw AppError.badRequest('Patient UID is required');
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, icd10_code, icd10_description, description,
            diagnosis_type, status, onset_date, resolved_date, severity, diagnosed_by,
            notes, created_at, updated_at
     FROM diagnoses
     WHERE patient_uid = $1::uuid
     ORDER BY created_at DESC`,
    patientUid
  );

  return rows;
}

// ===================================================================
// searchICD10
// ===================================================================

/**
 * Search ICD-10 codes by code or description (ILIKE).
 * @param {string} query - Search term
 * @returns {Array}
 */
export async function searchICD10(query) {
  if (!query || query.trim().length < 2) {
    throw AppError.badRequest('Search query must be at least 2 characters');
  }

  const searchTerm = `%${query.trim()}%`;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, code, description, category, is_active
     FROM icd10_codes
     WHERE is_active = true AND (code ILIKE $1 OR description ILIKE $1)
     ORDER BY
       CASE WHEN code ILIKE $2 THEN 0 ELSE 1 END,
       code ASC
     LIMIT 50`,
    searchTerm, `${query.trim()}%`
  );

  return rows;
}

// ===================================================================
// seedCommonICD10Codes
// ===================================================================

/**
 * Seed commonly used ICD-10 codes. Skips codes that already exist.
 * @returns {{ inserted: number, skipped: number }}
 */
export async function seedCommonICD10Codes() {
  // Dynamic import to keep seed data separate
  const { ICD10_SEED_DATA } = await import('./icd10SeedData.js');

  let inserted = 0;
  let skipped = 0;

  for (const entry of ICD10_SEED_DATA) {
    try {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id FROM icd10_codes WHERE code = $1`,
        entry.code
      );

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await prisma.$queryRawUnsafe(
        `INSERT INTO icd10_codes (code, description, category)
         VALUES ($1, $2, $3)`,
        entry.code, entry.description, entry.category
      );
      inserted++;
    } catch (err) {
      // Skip duplicates gracefully (unique constraint)
      if (err.code === '23505') {
        skipped++;
      } else {
        logger.error(`Failed to seed ICD-10 code ${entry.code}: ${err.message}`);
      }
    }
  }

  logger.info(`ICD-10 seed complete: ${inserted} inserted, ${skipped} skipped`);
  return { inserted, skipped };
}

export default {
  addDiagnosis,
  updateDiagnosisStatus,
  getActiveProblemList,
  getEncounterDiagnoses,
  getPatientDiagnosisHistory,
  searchICD10,
  seedCommonICD10Codes,
};
