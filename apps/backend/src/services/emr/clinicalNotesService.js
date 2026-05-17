// src/services/emr/clinicalNotesService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { getPatientTimeline as getUnifiedPatientTimeline } from './clinicalTimelineService.js';


// ===================================================================
// Clinical Notes Service — SOAP, Progress, Procedure, Discharge, etc.
// ===================================================================

// `admission_note` (admission H&P), `er_note` (ED encounter note), and
// `transfer_note` (ward/unit transfer) are first-class types: an
// admission H&P is a distinct medico-legal document from a daily
// progress SOAP note, and coding/discharge-summary generation keys off
// the typed note rather than inspecting SOAP content. Finding:
// 2026-05-09-emergency-walk-in-doctor-no-admission-note-type.
const VALID_NOTE_TYPES = ['soap', 'progress', 'procedure', 'discharge', 'nursing_assessment', 'consultation_note', 'admission_note', 'er_note', 'transfer_note'];

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
  admission_note: ['chief_complaint', 'history_of_present_illness', 'assessment', 'plan'],
  er_note: ['chief_complaint', 'assessment', 'plan'],
  transfer_note: ['reason_for_transfer', 'clinical_summary', 'plan'],
};

// Column projection used by every read/write that returns a full note row.
// Mirrors the pre-ORM RETURNING / SELECT lists exactly so the public API
// shape is preserved.
const NOTE_SELECT = {
  id: true,
  encounter_id: true,
  appointment_id: true,
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
  const { encounter_id, appointment_id, patient_uid, author_uid, author_role, note_type, content } = data;

  if (!patient_uid || !author_uid || !author_role || !note_type || !content) {
    throw AppError.badRequest('patient_uid, author_uid, author_role, note_type, and content are required');
  }

  if (!VALID_NOTE_TYPES.includes(note_type)) {
    throw AppError.badRequest(`Invalid note_type: ${note_type}. Must be one of: ${VALID_NOTE_TYPES.join(', ')}`);
  }

  validateNoteContent(note_type, content);

  // If encounter_id is provided, verify it belongs to an admission OR an
  // emergency visit. IPD notes scope to admissions.encounter_id; ER notes
  // (er_note) scope to emergency_visits.encounter_id (migration 224).
  // Both are UUID keys.
  if (encounter_id) {
    const [admissionEnc, erEnc] = await Promise.all([
      prisma.admissions.findFirst({ where: { encounter_id }, select: { id: true } }),
      prisma.emergency_visits.findFirst({ where: { encounter_id }, select: { id: true } }),
    ]);
    if (!admissionEnc && !erEnc) {
      throw AppError.notFound('Encounter not found');
    }
  }

  // OPD visits have no encounter row, so walk-in / scheduled OPD notes
  // bind to the appointment they document via appointment_id (migration
  // 234) so they can be grouped under the visit in the patient timeline.
  let appointmentIdNum = null;
  if (appointment_id !== undefined && appointment_id !== null) {
    appointmentIdNum = Number(appointment_id);
    if (!Number.isFinite(appointmentIdNum)) {
      throw AppError.badRequest('appointment_id must be an integer');
    }
    const appt = await prisma.appointments.findUnique({
      where: { id: appointmentIdNum },
      select: { id: true },
    });
    if (!appt) {
      throw AppError.notFound('Appointment not found');
    }
  }

  // Schema defaults: version=1, is_addendum=false, is_signed=false, created_at=now().
  // We pass them explicitly to mirror the pre-ORM INSERT verbatim.
  const created = await prisma.clinical_notes.create({
    data: {
      encounter_id: encounter_id ?? null,
      appointment_id: appointmentIdNum,
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
// updateNote (admin override)
// ===================================================================

/**
 * Overwrite the content of an existing clinical note. Restricted to admin
 * roles — every other path is append-only via createNote / addAddendum.
 * The original author_uid / author_role / note_type / created_at are
 * preserved; only `content` and `updated_at` change, plus the row's
 * `version` is bumped so downstream readers can detect the rewrite.
 *
 * Callers MUST audit the action separately (logPhiAccess with
 * action='UPDATE') so the legal record of "who rewrote what when" is
 * retained even though the original content is gone from the row.
 *
 * @param {number} noteId
 * @param {Object} content - New note content (validated against note_type)
 * @param {string} editorUid - UID of the admin performing the rewrite
 * @param {string} editorRole - Role of the editor (must be ADMIN)
 * @returns {Object} Updated note row
 */
export async function updateNote(noteId, content, editorUid, editorRole) {
  if (!editorUid || !editorRole) {
    throw AppError.badRequest('editorUid and editorRole are required');
  }

  if (editorRole !== 'ADMIN') {
    throw AppError.forbidden(
      'Only ADMIN may overwrite a prior clinical note; clinical roles must use the addendum path',
      'ADMIN_ONLY_NOTE_EDIT',
    );
  }

  if (!content || typeof content !== 'object' || Object.keys(content).length === 0) {
    throw AppError.badRequest('content is required');
  }

  const existing = await prisma.clinical_notes.findUnique({
    where: { id: Number(noteId) },
    select: { id: true, note_type: true, version: true, content: true, author_uid: true, author_role: true },
  });

  if (!existing) {
    throw AppError.notFound('Clinical note not found');
  }

  // Re-validate the new content against the same note_type the note was
  // created with. Admin can rewrite the prose, not flip the type.
  validateNoteContent(existing.note_type, content);

  const now = new Date();
  const updated = await prisma.clinical_notes.update({
    where: { id: Number(noteId) },
    data: {
      content,
      version: existing.version + 1,
      updated_at: now,
    },
    select: NOTE_SELECT,
  });

  logger.info(
    `Clinical note admin-edited: id=${noteId}, editor=${editorUid}, original_author=${existing.author_uid}, version=${existing.version}->${updated.version}`,
  );
  return updated;
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
    pagination,
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
