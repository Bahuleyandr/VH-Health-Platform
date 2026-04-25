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

const DIAGNOSIS_SELECT = {
  id: true,
  patient_uid: true,
  encounter_id: true,
  icd10_code: true,
  icd10_description: true,
  description: true,
  diagnosis_type: true,
  status: true,
  onset_date: true,
  resolved_date: true,
  severity: true,
  diagnosed_by: true,
  notes: true,
  created_at: true,
  updated_at: true,
};

// Sort comparator matching the pre-ORM SQL `CASE diagnosis_type` ordering:
// primary → admitting → secondary → other.
const DIAGNOSIS_TYPE_RANK = { primary: 1, admitting: 2, secondary: 3 };
const rankDiagnosisType = (t) => DIAGNOSIS_TYPE_RANK[t] ?? 4;

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

  const normalisedIcd10 = icd10_code ? icd10_code.toUpperCase().trim() : null;

  // If ICD-10 code provided, look up the description.
  let icd10Description = null;
  if (normalisedIcd10) {
    const icdRow = await prisma.icd10_codes.findFirst({
      where: { code: normalisedIcd10 },
      select: { description: true },
    });
    icd10Description = icdRow?.description ?? null;
  }

  // Verify encounter exists if provided. admissions.encounter_id is uuid.
  if (encounter_id) {
    const enc = await prisma.admissions.findFirst({
      where: { encounter_id },
      select: { id: true },
    });
    if (!enc) {
      throw AppError.notFound('Encounter not found');
    }
  }

  const created = await prisma.diagnoses.create({
    data: {
      patient_uid,
      encounter_id: encounter_id ?? null,
      icd10_code: normalisedIcd10,
      icd10_description: icd10Description,
      description,
      diagnosis_type: diagnosis_type ?? 'secondary',
      status: status ?? 'active',
      onset_date: onset_date ? new Date(onset_date) : null,
      severity: severity ?? null,
      diagnosed_by,
      notes: notes ?? null,
    },
    select: DIAGNOSIS_SELECT,
  });

  logger.info(`Diagnosis added: id=${created.id}, patient=${patient_uid}, icd10=${normalisedIcd10 ?? 'none'}, type=${created.diagnosis_type}`);
  return created;
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

  const existing = await prisma.diagnoses.findUnique({
    where: { id: Number(id) },
    select: { id: true, status: true },
  });

  if (!existing) {
    throw AppError.notFound('Diagnosis not found');
  }

  const resolvedAt = status === 'resolved'
    ? new Date(resolvedDate ?? new Date().toISOString().slice(0, 10))
    : null;

  const updated = await prisma.diagnoses.update({
    where: { id: Number(id) },
    data: {
      status,
      resolved_date: resolvedAt,
    },
    select: DIAGNOSIS_SELECT,
  });

  logger.info(`Diagnosis status updated: id=${id}, old_status=${existing.status}, new_status=${status}, by=${updatedBy}`);
  return updated;
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

  const rows = await prisma.diagnoses.findMany({
    where: {
      patient_uid: patientUid,
      status: { in: ['active', 'chronic'] },
    },
    select: DIAGNOSIS_SELECT,
  });

  // Match the pre-ORM `CASE diagnosis_type` + `created_at DESC` ordering.
  return rows.sort((a, b) => {
    const rankDiff = rankDiagnosisType(a.diagnosis_type) - rankDiagnosisType(b.diagnosis_type);
    if (rankDiff !== 0) return rankDiff;
    return b.created_at - a.created_at;
  });
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

  const rows = await prisma.diagnoses.findMany({
    where: { encounter_id: encounterId },
    select: DIAGNOSIS_SELECT,
  });

  return rows.sort((a, b) => {
    const rankDiff = rankDiagnosisType(a.diagnosis_type) - rankDiagnosisType(b.diagnosis_type);
    if (rankDiff !== 0) return rankDiff;
    return a.created_at - b.created_at;
  });
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

  return prisma.diagnoses.findMany({
    where: { patient_uid: patientUid },
    select: DIAGNOSIS_SELECT,
    orderBy: { created_at: 'desc' },
  });
}

// ===================================================================
// searchICD10
// ===================================================================

/**
 * Search ICD-10 codes by code or description (case-insensitive substring).
 * @param {string} query - Search term
 * @returns {Array}
 */
export async function searchICD10(query) {
  if (!query || query.trim().length < 2) {
    throw AppError.badRequest('Search query must be at least 2 characters');
  }

  const trimmed = query.trim();
  const rows = await prisma.icd10_codes.findMany({
    where: {
      is_active: true,
      OR: [
        { code: { contains: trimmed, mode: 'insensitive' } },
        { description: { contains: trimmed, mode: 'insensitive' } },
      ],
    },
    select: { id: true, code: true, description: true, category: true, is_active: true },
    take: 50,
  });

  // Mirror the pre-ORM `CASE WHEN code ILIKE 'prefix%' THEN 0 ELSE 1 END, code ASC`
  // — prefix matches sort first, then alphabetical.
  const prefixUpper = trimmed.toUpperCase();
  return rows.sort((a, b) => {
    const aPrefix = a.code?.toUpperCase().startsWith(prefixUpper) ? 0 : 1;
    const bPrefix = b.code?.toUpperCase().startsWith(prefixUpper) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return (a.code ?? '').localeCompare(b.code ?? '');
  });
}

// ===================================================================
// seedCommonICD10Codes
// ===================================================================

/**
 * Seed commonly used ICD-10 codes. Skips codes that already exist.
 * @returns {{ inserted: number, skipped: number }}
 */
export async function seedCommonICD10Codes() {
  // Dynamic import to keep seed data separate.
  const { ICD10_SEED_DATA } = await import('./icd10SeedData.js');

  let inserted = 0;
  let skipped = 0;

  for (const entry of ICD10_SEED_DATA) {
    try {
      const existing = await prisma.icd10_codes.findFirst({
        where: { code: entry.code },
        select: { id: true },
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      await prisma.icd10_codes.create({
        data: { code: entry.code, description: entry.description, category: entry.category },
      });
      inserted += 1;
    } catch (err) {
      // Skip duplicates gracefully (unique constraint race).
      if (err.code === 'P2002' || err.code === '23505') {
        skipped += 1;
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
