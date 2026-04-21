// src/services/emr/clinicalNotesService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { getPatientTimeline as getUnifiedPatientTimeline } from './clinicalTimelineService.js';


// ===================================================================
// Clinical Notes Service — SOAP, Progress, Procedure, Discharge, etc.
// ===================================================================

const VALID_NOTE_TYPES = ['soap', 'progress', 'procedure', 'discharge', 'nursing_assessment', 'consultation_note'];

/**
 * Required content fields per note type.
 * Extra fields are allowed but these must be present.
 */
const REQUIRED_CONTENT_FIELDS = {
  soap: ['subjective', 'objective', 'assessment', 'plan'],
  progress: ['summary', 'current_status', 'plan'],
  procedure: ['procedure_name', 'pre_op_diagnosis', 'post_op_diagnosis', 'findings'],
  discharge: ['hospital_course', 'discharge_diagnosis', 'discharge_condition', 'medications_on_discharge', 'follow_up_instructions'],
  nursing_assessment: ['pain_level', 'mobility', 'plan_of_care'],
  consultation_note: ['summary', 'assessment', 'plan'],
};

/**
 * Validate content structure for a given note_type.
 */
function validateNoteContent(noteType, content) {
  const requiredFields = REQUIRED_CONTENT_FIELDS[noteType];
  if (!requiredFields) {
    throw AppError.badRequest(`Invalid note_type: ${noteType}. Must be one of: ${VALID_NOTE_TYPES.join(', ')}`);
  }

  const missing = requiredFields.filter((field) => content[field] === undefined || content[field] === null);
  if (missing.length > 0) {
    throw AppError.badRequest(
      `Missing required content fields for ${noteType} note: ${missing.join(', ')}`,
      'INVALID_NOTE_CONTENT'
    );
  }
}

// ===================================================================
// createNote
// ===================================================================

/**
 * Create a clinical note.
 * @param {Object} data - { encounter_id?, patient_uid, author_uid, author_role, note_type, content }
 * @returns {Object} Created note row
 */
export async function createNote(data) {
  const { encounter_id, patient_uid, author_uid, author_role, note_type, content } = data;

  if (!patient_uid || !author_uid || !author_role || !note_type || !content) {
    throw AppError.badRequest('patient_uid, author_uid, author_role, note_type, and content are required');
  }

  if (!VALID_NOTE_TYPES.includes(note_type)) {
    throw AppError.badRequest(`Invalid note_type: ${note_type}. Must be one of: ${VALID_NOTE_TYPES.join(', ')}`);
  }

  validateNoteContent(note_type, content);

  // If encounter_id is provided, verify it exists
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
    `INSERT INTO clinical_notes
       (encounter_id, patient_uid, author_uid, author_role, note_type, content, version, is_addendum, is_signed, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, false, false, NOW())
     RETURNING id, encounter_id, patient_uid, author_uid, author_role, note_type, content,
               version, parent_note_id, is_addendum, is_signed, signed_at, signed_by,
               created_at, updated_at`,
    encounter_id || null, patient_uid, author_uid, author_role, note_type, JSON.stringify(content)
  );

  logger.info(`Clinical note created: id=${rows[0].id}, type=${note_type}, patient=${patient_uid}, author=${author_uid}`);
  return rows[0];
}

// ===================================================================
// addAddendum
// ===================================================================

/**
 * Add an addendum to an existing note (creates a new version row).
 * Signed notes cannot be edited — only addenda are allowed.
 * @param {number} noteId - Original note ID
 * @param {Object} addendumContent - The addendum content (free-form JSON)
 * @param {string} authorUid - UID of the addendum author
 * @param {string} authorRole - Role of the addendum author
 * @returns {Object} Created addendum note row
 */
export async function addAddendum(noteId, addendumContent, authorUid, authorRole) {
  if (!addendumContent || Object.keys(addendumContent).length === 0) {
    throw AppError.badRequest('Addendum content is required');
  }
  if (!authorUid || !authorRole) {
    throw AppError.badRequest('Author UID and role are required');
  }

  // Fetch original note
  const original = await prisma.$queryRawUnsafe(
    `SELECT id, encounter_id, patient_uid, note_type, version, parent_note_id
     FROM clinical_notes WHERE id = $1`,
    noteId
  );

  if (original.length === 0) {
    throw AppError.notFound('Clinical note not found');
  }

  const parentNote = original[0];
  // The root note is either this note (if it has no parent) or its parent
  const rootNoteId = parentNote.parent_note_id || parentNote.id;

  // Get the latest version number for this chain
  const versionRows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX(version), 0) AS max_version FROM clinical_notes
     WHERE id = $1 OR parent_note_id = $1`,
    rootNoteId
  );

  const nextVersion = versionRows[0].max_version + 1;

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_notes
       (encounter_id, patient_uid, author_uid, author_role, note_type, content,
        version, parent_note_id, is_addendum, is_signed, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, NOW())
     RETURNING id, encounter_id, patient_uid, author_uid, author_role, note_type, content,
               version, parent_note_id, is_addendum, is_signed, signed_at, signed_by,
               created_at, updated_at`,
    
      parentNote.encounter_id,
      parentNote.patient_uid,
      authorUid,
      authorRole,
      parentNote.note_type,
      JSON.stringify(addendumContent),
      nextVersion,
      rootNoteId,
    
  );

  logger.info(`Addendum added to note ${rootNoteId}: addendum_id=${rows[0].id}, version=${nextVersion}, author=${authorUid}`);
  return rows[0];
}

// ===================================================================
// signNote
// ===================================================================

/**
 * Sign a clinical note, making it immutable.
 * @param {number} noteId
 * @param {string} signerUid
 * @returns {Object} Updated note row
 */
export async function signNote(noteId, signerUid) {
  if (!signerUid) {
    throw AppError.badRequest('Signer UID is required');
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, is_signed, signed_at FROM clinical_notes WHERE id = $1`,
    noteId
  );

  if (existing.length === 0) {
    throw AppError.notFound('Clinical note not found');
  }

  if (existing[0].is_signed) {
    throw AppError.conflict('Note is already signed and cannot be modified');
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_notes
     SET is_signed = true, signed_at = NOW(), signed_by = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, encounter_id, patient_uid, author_uid, author_role, note_type, content,
               version, parent_note_id, is_addendum, is_signed, signed_at, signed_by,
               created_at, updated_at`,
    noteId, signerUid
  );

  logger.info(`Clinical note signed: id=${noteId}, signed_by=${signerUid}`);
  return rows[0];
}

// ===================================================================
// getPatientNotes
// ===================================================================

/**
 * Get a patient's clinical notes with filters and pagination.
 * @param {string} patientUid
 * @param {Object} filters - { note_type?, date_from?, date_to?, author_uid?, page?, limit? }
 * @returns {Object} { notes, pagination }
 */
export async function getPatientNotes(patientUid, filters = {}) {
  const { note_type, date_from, date_to, author_uid, page = 1, limit = 20 } = filters;

  const conditions = ['cn.patient_uid = $1'];
  const params = [patientUid];
  let paramIdx = 2;

  if (note_type) {
    conditions.push(`cn.note_type = $${paramIdx}`);
    params.push(note_type);
    paramIdx++;
  }

  if (date_from) {
    conditions.push(`cn.created_at >= $${paramIdx}`);
    params.push(date_from);
    paramIdx++;
  }

  if (date_to) {
    conditions.push(`cn.created_at <= $${paramIdx}`);
    params.push(date_to);
    paramIdx++;
  }

  if (author_uid) {
    conditions.push(`cn.author_uid = $${paramIdx}`);
    params.push(author_uid);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10)), 100);

  // Count total
  const countRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS total FROM clinical_notes cn WHERE ${whereClause}`,
    ...params
  );
  const total = parseInt(countRows[0].total, 10);

  // Fetch paginated
  const rows = await prisma.$queryRawUnsafe(
    `SELECT cn.id, cn.encounter_id, cn.patient_uid, cn.author_uid, cn.author_role,
            cn.note_type, cn.content, cn.version, cn.parent_note_id, cn.is_addendum,
            cn.is_signed, cn.signed_at, cn.signed_by, cn.created_at, cn.updated_at
     FROM clinical_notes cn
     WHERE ${whereClause}
     ORDER BY cn.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    ...params, safeLimit, offset
  );

  return {
    notes: rows,
    pagination: {
      page: parseInt(page, 10),
      limit: safeLimit,
      total,
      total_pages: Math.ceil(total / safeLimit),
    },
  };
}

// ===================================================================
// getEncounterNotes
// ===================================================================

/**
 * Get all clinical notes for an admission encounter.
 * @param {string} encounterId - UUID
 * @returns {Array} Notes sorted by created_at
 */
export async function getEncounterNotes(encounterId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT cn.id, cn.encounter_id, cn.patient_uid, cn.author_uid, cn.author_role,
            cn.note_type, cn.content, cn.version, cn.parent_note_id, cn.is_addendum,
            cn.is_signed, cn.signed_at, cn.signed_by, cn.created_at, cn.updated_at
     FROM clinical_notes cn
     WHERE cn.encounter_id = $1
     ORDER BY cn.created_at ASC`,
    encounterId
  );
  return rows;
}

// ===================================================================
// getNoteDetail
// ===================================================================

/**
 * Get full note detail including version history.
 * @param {number} noteId
 * @returns {Object} Note with version_history array
 */
export async function getNoteDetail(noteId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT cn.id, cn.encounter_id, cn.patient_uid, cn.author_uid, cn.author_role,
            cn.note_type, cn.content, cn.version, cn.parent_note_id, cn.is_addendum,
            cn.is_signed, cn.signed_at, cn.signed_by, cn.created_at, cn.updated_at
     FROM clinical_notes cn
     WHERE cn.id = $1`,
    noteId
  );

  if (rows.length === 0) {
    throw AppError.notFound('Clinical note not found');
  }

  const note = rows[0];

  // Get version history (all addenda / versions for the same root note)
  const rootId = note.parent_note_id || note.id;
  const versions = await prisma.$queryRawUnsafe(
    `SELECT id, author_uid, author_role, content, version, is_addendum,
            is_signed, signed_at, signed_by, created_at
     FROM clinical_notes
     WHERE (id = $1 OR parent_note_id = $1) AND id != $2
     ORDER BY version ASC`,
    rootId, noteId
  );

  return {
    ...note,
    version_history: versions,
  };
}

// ===================================================================
// getPatientTimeline
// ===================================================================

/**
 * Unified patient clinical timeline combining notes, vitals, MAR, investigations, and ADT events.
 * This is the KEY EMR feature.
 * @param {string} patientUid
 * @param {string|null} dateFrom - ISO date string
 * @param {string|null} dateTo - ISO date string
 * @returns {Array} Chronologically sorted timeline events
 */
export async function getPatientTimeline(patientUid, dateFrom, dateTo) {
  return getUnifiedPatientTimeline(patientUid, { dateFrom, dateTo });
}

export default {
  createNote,
  addAddendum,
  signNote,
  getPatientNotes,
  getEncounterNotes,
  getNoteDetail,
  getPatientTimeline,
};
