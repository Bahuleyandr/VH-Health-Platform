// src/services/emr/clinicalNotesService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
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

// Column projection used by every read/write that returns a full note row.
// Mirrors the pre-ORM RETURNING / SELECT lists exactly so the public API
// shape is preserved.
const NOTE_SELECT = {
  id: true,
  encounter_id: true,
  patient_uid: true,
  author_uid: true,
  author_role: true,
  note_type: true,
  content: true,
  version: true,
  parent_note_id: true,
  is_addendum: true,
  is_signed: true,
  signed_at: true,
  signed_by: true,
  created_at: true,
  updated_at: true,
};

// Slimmer projection used by the version-history sub-list inside
// getNoteDetail (matches the pre-ORM SELECT list verbatim).
const VERSION_HISTORY_SELECT = {
  id: true,
  author_uid: true,
  author_role: true,
  content: true,
  version: true,
  is_addendum: true,
  is_signed: true,
  signed_at: true,
  signed_by: true,
  created_at: true,
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

  // If encounter_id is provided, verify it exists. admissions.encounter_id is uuid.
  if (encounter_id) {
    const enc = await prisma.admissions.findFirst({
      where: { encounter_id },
      select: { id: true },
    });
    if (!enc) {
      throw AppError.notFound('Encounter not found');
    }
  }

  // Schema defaults: version=1, is_addendum=false, is_signed=false, created_at=now().
  // We pass them explicitly to mirror the pre-ORM INSERT verbatim.
  const created = await prisma.clinical_notes.create({
    data: {
      encounter_id: encounter_id ?? null,
      patient_uid,
      author_uid,
      author_role,
      note_type,
      content,
      version: 1,
      is_addendum: false,
      is_signed: false,
    },
    select: NOTE_SELECT,
  });

  logger.info(`Clinical note created: id=${created.id}, type=${note_type}, patient=${patient_uid}, author=${author_uid}`);
  return created;
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

  // Fetch original note (just the fields we need to derive the addendum metadata).
  const parentNote = await prisma.clinical_notes.findUnique({
    where: { id: Number(noteId) },
    select: {
      id: true,
      encounter_id: true,
      patient_uid: true,
      note_type: true,
      version: true,
      parent_note_id: true,
    },
  });

  if (!parentNote) {
    throw AppError.notFound('Clinical note not found');
  }

  // The root note is either this note (if it has no parent) or its parent.
  const rootNoteId = parentNote.parent_note_id || parentNote.id;

  // Get the latest version number for this chain — replaces COALESCE(MAX(version), 0)
  // with prisma.aggregate({ _max: { version: true } }) and a `?? 0` fallback when
  // the chain is empty (defensive — the root row itself is always part of the chain).
  const versionAgg = await prisma.clinical_notes.aggregate({
    where: {
      OR: [{ id: rootNoteId }, { parent_note_id: rootNoteId }],
    },
    _max: { version: true },
  });

  const nextVersion = (versionAgg._max.version ?? 0) + 1;

  const created = await prisma.clinical_notes.create({
    data: {
      encounter_id: parentNote.encounter_id,
      patient_uid: parentNote.patient_uid,
      author_uid: authorUid,
      author_role: authorRole,
      note_type: parentNote.note_type,
      content: addendumContent,
      version: nextVersion,
      parent_note_id: rootNoteId,
      is_addendum: true,
      is_signed: false,
    },
    select: NOTE_SELECT,
  });

  logger.info(`Addendum added to note ${rootNoteId}: addendum_id=${created.id}, version=${nextVersion}, author=${authorUid}`);
  return created;
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

  const existing = await prisma.clinical_notes.findUnique({
    where: { id: Number(noteId) },
    select: { id: true, is_signed: true, signed_at: true },
  });

  if (!existing) {
    throw AppError.notFound('Clinical note not found');
  }

  if (existing.is_signed) {
    throw AppError.conflict('Note is already signed and cannot be modified');
  }

  const now = new Date();
  const updated = await prisma.clinical_notes.update({
    where: { id: Number(noteId) },
    data: {
      is_signed: true,
      signed_at: now,
      signed_by: signerUid,
      updated_at: now,
    },
    select: NOTE_SELECT,
  });

  logger.info(`Clinical note signed: id=${noteId}, signed_by=${signerUid}`);
  return updated;
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
  const { note_type, date_from, date_to, author_uid } = filters;
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'created_at'
  });

  // Build the typed where clause — conditional spreads mirror the pre-ORM
  // dynamic-WHERE construction (the same fields, the same comparators).
  const where = { patient_uid: patientUid };
  if (note_type) where.note_type = note_type;
  if (author_uid) where.author_uid = author_uid;
  if (date_from || date_to) {
    where.created_at = {};
    if (date_from) where.created_at.gte = new Date(date_from);
    if (date_to) where.created_at.lte = new Date(date_to);
  }

  const [total, notes] = await Promise.all([
    prisma.clinical_notes.count({ where }),
    prisma.clinical_notes.findMany({
      where,
      select: NOTE_SELECT,
      orderBy: { created_at: 'desc' },
      skip: listQuery.offset,
      take: listQuery.limit,
    }),
  ]);
  const pagination = buildPagination(total, listQuery.page, listQuery.limit);

  return {
    notes,
    pagination: {
      ...pagination,
      total_pages: pagination.totalPages,
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
  return prisma.clinical_notes.findMany({
    where: { encounter_id: encounterId },
    select: NOTE_SELECT,
    orderBy: { created_at: 'asc' },
  });
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
  const id = Number(noteId);
  const note = await prisma.clinical_notes.findUnique({
    where: { id },
    select: NOTE_SELECT,
  });

  if (!note) {
    throw AppError.notFound('Clinical note not found');
  }

  // Get version history (all addenda / versions for the same root note,
  // excluding the note we just fetched). The pre-ORM query was:
  //   WHERE (id = $1 OR parent_note_id = $1) AND id != $2
  const rootId = note.parent_note_id || note.id;
  const versions = await prisma.clinical_notes.findMany({
    where: {
      AND: [
        { OR: [{ id: rootId }, { parent_note_id: rootId }] },
        { id: { not: id } },
      ],
    },
    select: VERSION_HISTORY_SELECT,
    orderBy: { version: 'asc' },
  });

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
