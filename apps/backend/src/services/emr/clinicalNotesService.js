// src/services/emr/clinicalNotesService.js
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { assertCanWriteAppointmentClinical } from '../../utils/appointment/appointmentHelpers.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { isDoctor } from '../../utils/roleHelpers.js';
import {
  ensureEncounterForAppointment,
  recordCanonicalClinicalEvent,
  readCanonicalPatientTimeline,
  transitionEncounter,
} from '../clinical/canonicalClinicalPlatformService.js';

// ===================================================================
// Clinical Notes Service — SOAP, Progress, Procedure, Discharge, etc.
// ===================================================================

// `admission_note` (admission H&P), `er_note` (ED encounter note), and
// `transfer_note` (ward/unit transfer) are first-class types: an
// admission H&P is a distinct medico-legal document from a daily
// progress SOAP note, and coding/discharge-summary generation keys off
// the typed note rather than inspecting SOAP content. Finding:
// 2026-05-09-emergency-walk-in-doctor-no-admission-note-type.
const VALID_NOTE_TYPES = [
  'soap',
  'progress',
  'procedure',
  'discharge',
  'nursing_assessment',
  'consultation_note',
  'op_consultation',
  'admission_note',
  'er_note',
  'transfer_note'
];

/**
 * Required content fields per note type.
 * Extra fields are allowed but these must be present.
 */
const REQUIRED_CONTENT_FIELDS = {
  soap: ['subjective', 'objective', 'assessment', 'plan'],
  progress: ['summary', 'current_status', 'plan'],
  procedure: ['procedure_name', 'pre_op_diagnosis', 'post_op_diagnosis', 'findings'],
  discharge: [
    'hospital_course',
    'discharge_diagnosis',
    'discharge_condition',
    'medications_on_discharge',
    'follow_up_instructions'
  ],
  nursing_assessment: ['pain_level', 'mobility', 'plan_of_care'],
  consultation_note: ['summary', 'assessment', 'plan'],
  op_consultation: ['chief_complaint', 'history', 'examination', 'diagnosis', 'plan'],
  admission_note: ['chief_complaint', 'history_of_present_illness', 'assessment', 'plan'],
  er_note: ['chief_complaint', 'assessment', 'plan'],
  transfer_note: ['reason_for_transfer', 'clinical_summary', 'plan']
};

const ADMIN_NOTE_EDIT_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const TERMINAL_APPOINTMENT_STATUSES = new Set([
  'COMPLETED',
  'CANCELLED',
  'CANCELED',
  'NO_SHOW',
  'RESCHEDULED'
]);
const OP_APPOINTMENT_NOTE_TYPES = ['op_consultation', 'soap', 'progress', 'consultation_note'];
const HOSPITAL_TIME_ZONE = 'Asia/Kolkata';

function hospitalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: HOSPITAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function assertOpenOpAppointmentSession(appt, action = 'write') {
  const status = String(appt?.status || '').toUpperCase();
  if (TERMINAL_APPOINTMENT_STATUSES.has(status)) {
    throw AppError.conflict(
      `OP consultation note can no longer be ${action} after the appointment is terminal`,
      'OP_NOTE_SESSION_CLOSED'
    );
  }

  const appointmentDate = hospitalDateKey(appt?.appointment_date);
  const today = hospitalDateKey();
  if (appointmentDate && today && appointmentDate !== today) {
    throw AppError.conflict(
      `OP consultation notes can only be ${action} on the appointment date`,
      'OP_NOTE_SESSION_CLOSED',
      { appointment_date: appointmentDate, today }
    );
  }
}

// Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
// every successful note write must persist the detail row + one
// clinical_timeline_events row + one clinical_audit_events row in the SAME
// transaction. The canonical write therefore runs on the transaction client
// (`tx`) and is NOT swallowed — a failure must abort the transaction so the
// note row rolls back rather than leaving the timeline/audit layer out of
// sync. `recordCanonicalClinicalEvent` already tolerates a genuinely-absent
// canonical table (SQLSTATE 42P01) via logCanonicalFailure; every other
// error propagates and aborts the tx.
function recordCanonicalNoteEvent(input, tx) {
  return recordCanonicalClinicalEvent(input, { db: tx });
}

// The post-sign encounter lifecycle transition is a SEPARATE canonical
// workflow step (it emits its own timeline + audit triple) — not part of the
// note's own detail+timeline+audit triple. It must therefore stay best-effort
// and post-commit: a note that has already been atomically signed (with its
// canonical events) must not be rolled back because the encounter was already
// signed/locked (a benign INVALID_ENCOUNTER_TRANSITION) or because the
// lifecycle update hiccuped. Keeping it in the note's tx would regress the
// prior tolerant behaviour and could abort a clinically-successful sign.
async function bestEffortEncounterTransition(label, encounterId, nextStatus, input = {}) {
  if (!encounterId) return null;
  try {
    return await transitionEncounter(encounterId, nextStatus, input);
  } catch (err) {
    logger.warn(`Canonical encounter transition failed during ${label}: ${err?.message || err}`);
    return null;
  }
}

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
  title: true,
  content: true,
  version: true,
  parent_note_id: true,
  is_addendum: true,
  is_signed: true,
  signed_at: true,
  signed_by: true,
  created_at: true,
  updated_at: true
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
  created_at: true
};

async function attachAuthorNames(notes) {
  const list = Array.isArray(notes) ? notes : [notes];
  const authorUids = [
    ...new Set(
      list.map(note => note?.author_uid).filter(uid => typeof uid === 'string' && uid.length > 0)
    )
  ];
  if (authorUids.length === 0) {
    return Array.isArray(notes) ? list : { ...notes, author_name: null };
  }

  const authors = await prisma.users.findMany({
    where: { uid: { in: authorUids } },
    select: { uid: true, name: true }
  });
  const namesByUid = new Map(authors.map(author => [author.uid, author.name]));
  const enriched = list.map(note => ({
    ...note,
    author_name: namesByUid.get(note.author_uid) ?? null
  }));
  return Array.isArray(notes) ? enriched : enriched[0];
}

/**
 * Validate content structure for a given note_type.
 */
function validateNoteContent(noteType, content) {
  const requiredFields = REQUIRED_CONTENT_FIELDS[noteType];
  if (!requiredFields) {
    throw AppError.badRequest(
      `Invalid note_type: ${noteType}. Must be one of: ${VALID_NOTE_TYPES.join(', ')}`
    );
  }

  const missing = requiredFields.filter(
    field => content[field] === undefined || content[field] === null
  );
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
 * @param {Object} data - { encounter_id?, appointment_id?, patient_uid, author_uid, author_role, note_type, content, acting_user? }
 *   `acting_user` ({ id?, uid?, role }) is the authenticated caller — used to
 *   enforce that only the assigned doctor (or an authorized supervisor) may
 *   write a note bound to a specific OPD appointment. Defaults to the author
 *   identity when omitted so direct service callers keep working.
 * @returns {Object} Created note row
 */
export async function createNote(data) {
  const {
    encounter_id,
    appointment_id,
    patient_uid,
    author_uid,
    author_role,
    note_type,
    title,
    content
  } = data;
  const actingUser = data.acting_user || { uid: author_uid, role: author_role };

  if (!patient_uid || !author_uid || !author_role || !note_type || !content) {
    throw AppError.badRequest(
      'patient_uid, author_uid, author_role, note_type, and content are required'
    );
  }

  if (!VALID_NOTE_TYPES.includes(note_type)) {
    throw AppError.badRequest(
      `Invalid note_type: ${note_type}. Must be one of: ${VALID_NOTE_TYPES.join(', ')}`
    );
  }

  validateNoteContent(note_type, content);

  // If encounter_id is provided, verify it belongs to an admission OR an
  // emergency visit. IPD notes scope to admissions.encounter_id; ER notes
  // (er_note) scope to emergency_visits.encounter_id (migration 224).
  // Both are UUID keys.
  let resolvedEncounterId = encounter_id || null;
  if (encounter_id) {
    const [admissionEnc, erEnc, canonicalEnc] = await Promise.all([
      prisma.admissions.findFirst({ where: { encounter_id }, select: { id: true } }),
      prisma.emergency_visits.findFirst({ where: { encounter_id }, select: { id: true } }),
      prisma.patient_encounters?.findFirst
        ? prisma.patient_encounters.findFirst({ where: { id: encounter_id }, select: { id: true } }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!admissionEnc && !erEnc && !canonicalEnc) {
      throw AppError.notFound('Encounter not found');
    }
  }

  // OPD visits have no encounter row, so walk-in / scheduled OPD notes
  // bind to the appointment they document via appointment_id (migration
  // 240) so they can be grouped under the visit in the patient timeline.
  let appointmentIdNum = null;
  if (appointment_id !== undefined && appointment_id !== null) {
    appointmentIdNum = Number(appointment_id);
    if (!Number.isFinite(appointmentIdNum)) {
      throw AppError.badRequest('appointment_id must be an integer');
    }
    const appt = await prisma.appointments.findUnique({
      where: { id: appointmentIdNum },
      select: {
        id: true,
        doctor_id: true,
        status: true,
        appointment_date: true
      }
    });
    if (!appt) {
      throw AppError.notFound('Appointment not found');
    }

    // H2 RBAC — a note bound to a specific OPD appointment may only be
    // authored by the appointment's assigned doctor (or an authorized
    // supervisor). Previously any clinician with the /emr role could write a
    // signed note onto another doctor's visit. Resolve the assigned doctor's
    // uid so the guard can match either the caller's int id or uid.
    let assignedDoctorUid = null;
    if (appt.doctor_id !== null && appt.doctor_id !== undefined) {
      const doctor = await prisma.users.findUnique({
        where: { id: appt.doctor_id },
        select: { uid: true }
      });
      assignedDoctorUid = doctor?.uid ?? null;
    }
    assertCanWriteAppointmentClinical(actingUser, {
      doctor_id: appt.doctor_id,
      assigned_doctor_uid: assignedDoctorUid
    });
    assertOpenOpAppointmentSession(appt, 'created');

    if (OP_APPOINTMENT_NOTE_TYPES.includes(note_type)) {
      const existingOpNote = await prisma.clinical_notes.findFirst({
        where: {
          appointment_id: appointmentIdNum,
          note_type: { in: OP_APPOINTMENT_NOTE_TYPES },
          parent_note_id: null,
          is_addendum: false
        },
        select: { id: true }
      });
      if (existingOpNote) {
        throw AppError.conflict(
          'This OP appointment already has a consultation note; edit the existing unsigned note or add an addendum after signing',
          'OP_NOTE_ALREADY_EXISTS',
          { note_id: existingOpNote.id, appointment_id: appointmentIdNum }
        );
      }
    }

    if (!resolvedEncounterId) {
      const encounter = await ensureEncounterForAppointment({
        appointmentId: appointmentIdNum,
        patientUid: patient_uid,
        doctorUid: assignedDoctorUid,
        actorUid: author_uid,
        metadata: {
          note_type,
          source: 'clinical_notes.create',
        },
      }).catch((err) => {
        logger.warn(`Canonical OP encounter ensure failed for appointment=${appointmentIdNum}: ${err?.message || err}`);
        return null;
      });
      resolvedEncounterId = encounter?.id || null;
    }
  }

  // Atomic clinical write (canonical timeline invariant): the note detail
  // row + its canonical timeline/audit events persist together or not at
  // all. Schema defaults: version=1, is_addendum=false, is_signed=false,
  // created_at=now(). We pass them explicitly to mirror the pre-ORM INSERT.
  const created = await setTenantTx((data.tenant_id || data.tenantId) || DEFAULT_TENANT_ID, async (tx) => {
    const row = await tx.clinical_notes.create({
      data: {
        encounter_id: resolvedEncounterId ?? null,
        appointment_id: appointmentIdNum,
        patient_uid,
        author_uid,
        author_role,
        note_type,
        title: title || null,
        content,
        version: 1,
        is_addendum: false,
        is_signed: false
      },
      select: NOTE_SELECT
    });

    await recordCanonicalNoteEvent({
      tenantId: data.tenant_id || data.tenantId,
      patientUid: row.patient_uid,
      encounterId: row.encounter_id,
      eventType: 'note.created',
      eventSubtype: row.note_type,
      eventStatus: row.is_signed ? 'signed' : 'draft',
      sourceTable: 'clinical_notes',
      sourceId: row.id,
      resourceType: 'clinical_note',
      resourceId: row.id,
      actorUid: row.author_uid,
      actorRole: row.author_role,
      summary: row.title || `${row.note_type} note created`,
      payload: {
        title: row.title,
        note_type: row.note_type,
        appointment_id: row.appointment_id,
        version: row.version,
        content: row.content,
      },
      afterState: row,
    }, tx);
    return row;
  });

  logger.info(
    `Clinical note created: id=${created.id}, type=${note_type}, patient=${patient_uid}, author=${author_uid}`
  );
  return attachAuthorNames(created);
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
 * @param {string|null} [tenantId] - Canonical tenant for RLS scoping (threaded
 *   from the caller's req.tenantId); falls back to DEFAULT_TENANT_ID.
 * @returns {Object} Created addendum note row
 */
export async function addAddendum(noteId, addendumContent, authorUid, authorRole, tenantId = null) {
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
      parent_note_id: true
    }
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
      OR: [{ id: rootNoteId }, { parent_note_id: rootNoteId }]
    },
    _max: { version: true }
  });

  const nextVersion = (versionAgg._max.version ?? 0) + 1;

  // Atomic clinical write: addendum detail row + canonical timeline/audit
  // events persist together (canonical timeline invariant). Tenant-scoped so
  // the writes land under the RLS tenant_isolation policy instead of its
  // permissive (GUC-unset) branch.
  const created = await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const row = await tx.clinical_notes.create({
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
        is_signed: false
      },
      select: NOTE_SELECT
    });

    await recordCanonicalNoteEvent({
      tenantId: tenantId || DEFAULT_TENANT_ID,
      patientUid: row.patient_uid,
      encounterId: row.encounter_id,
      eventType: 'note.addendum_created',
      eventSubtype: row.note_type,
      eventStatus: 'draft',
      sourceTable: 'clinical_notes',
      sourceId: row.id,
      resourceType: 'clinical_note',
      resourceId: row.id,
      actorUid: row.author_uid,
      actorRole: row.author_role,
      summary: `${row.note_type} addendum created`,
      payload: {
        parent_note_id: rootNoteId,
        version: row.version,
        content: row.content,
      },
      afterState: row,
    }, tx);
    return row;
  });

  logger.info(
    `Addendum added to note ${rootNoteId}: addendum_id=${created.id}, version=${nextVersion}, author=${authorUid}`
  );
  return attachAuthorNames(created);
}

// ===================================================================
// updateNote (admin override / unsigned OP session edit)
// ===================================================================

/**
 * Overwrite the content of an existing clinical note.
 *
 * Allowed paths:
 *   - ADMIN / SUPER_ADMIN correction override.
 *   - Original assigned doctor revising their own unsigned OP appointment note
 *     before the appointment reaches a terminal state.
 *
 * The original author_uid / author_role / note_type / created_at are preserved;
 * only `content` and `updated_at` change, plus the row's `version` is bumped so
 * downstream readers can detect the rewrite.
 *
 * Callers MUST audit the action separately (logPhiAccess with
 * action='UPDATE') so the legal record of "who rewrote what when" is
 * retained even though the original content is gone from the row.
 *
 * @param {number} noteId
 * @param {Object} content - New note content (validated against note_type)
 * @param {string} editorUid - UID of the user performing the rewrite
 * @param {string} editorRole - Role of the editor
 * @param {{ id?: number|string, uid?: string, role: string }} [actingUser]
 * @param {string|null} [tenantId] - Canonical tenant for RLS scoping (threaded
 *   from the caller's req.tenantId); falls back to DEFAULT_TENANT_ID.
 * @returns {Object} Updated note row
 */
export async function updateNote(noteId, content, editorUid, editorRole, actingUser = null, tenantId = null) {
  if (!editorUid || !editorRole) {
    throw AppError.badRequest('editorUid and editorRole are required');
  }

  if (!content || typeof content !== 'object' || Object.keys(content).length === 0) {
    throw AppError.badRequest('content is required');
  }

  const existing = await prisma.clinical_notes.findUnique({
    where: { id: Number(noteId) },
    select: {
      id: true,
      note_type: true,
      version: true,
      content: true,
      patient_uid: true,
      encounter_id: true,
      author_uid: true,
      author_role: true,
      is_signed: true,
      appointment_id: true
    }
  });

  if (!existing) {
    throw AppError.notFound('Clinical note not found');
  }

  // Re-validate the new content against the same note_type the note was
  // created with. Admin can rewrite the prose, not flip the type.
  validateNoteContent(existing.note_type, content);

  const adminOverride = ADMIN_NOTE_EDIT_ROLES.has(editorRole);
  if (!adminOverride) {
    if (existing.is_signed) {
      throw AppError.conflict(
        'Signed clinical notes are immutable; add an addendum for corrections',
        'SIGNED_NOTE_IMMUTABLE'
      );
    }

    if (!existing.appointment_id) {
      throw AppError.forbidden(
        'Only unsigned OP appointment notes may be revised by their original doctor; use addendum for other notes',
        'CLINICAL_NOTE_ADDENDUM_REQUIRED'
      );
    }

    if (String(existing.author_uid) !== String(editorUid)) {
      throw AppError.forbidden(
        'Only the original note author may revise an unsigned OP consultation note',
        'NOTE_AUTHOR_ONLY_EDIT'
      );
    }

    if (!isDoctor(editorRole)) {
      throw AppError.forbidden(
        'Only the original doctor may revise an unsigned OP consultation note',
        'DOCTOR_ONLY_OP_NOTE_EDIT'
      );
    }

    const appt = await prisma.appointments.findUnique({
      where: { id: Number(existing.appointment_id) },
      select: {
        id: true,
        doctor_id: true,
        status: true,
        appointment_date: true
      }
    });
    if (!appt) {
      throw AppError.notFound('Appointment not found');
    }

    assertOpenOpAppointmentSession(appt, 'edited');

    let assignedDoctorUid = null;
    if (appt.doctor_id !== null && appt.doctor_id !== undefined) {
      const doctor = await prisma.users.findUnique({
        where: { id: appt.doctor_id },
        select: { uid: true }
      });
      assignedDoctorUid = doctor?.uid ?? null;
    }
    assertCanWriteAppointmentClinical(actingUser || { uid: editorUid, role: editorRole }, {
      doctor_id: appt.doctor_id,
      assigned_doctor_uid: assignedDoctorUid
    });
  }

  const now = new Date();
  // Atomic clinical write: note rewrite + canonical timeline/audit events
  // persist together (canonical timeline invariant). Tenant-scoped so the
  // writes land under the RLS tenant_isolation policy instead of its
  // permissive (GUC-unset) branch.
  const updated = await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const row = await tx.clinical_notes.update({
      where: { id: Number(noteId) },
      data: {
        content,
        version: existing.version + 1,
        updated_at: now
      },
      select: NOTE_SELECT
    });

    await recordCanonicalNoteEvent({
      tenantId: tenantId || DEFAULT_TENANT_ID,
      patientUid: row.patient_uid,
      encounterId: row.encounter_id,
      eventType: 'note.edited',
      eventSubtype: row.note_type,
      eventStatus: row.is_signed ? 'signed' : 'draft',
      sourceTable: 'clinical_notes',
      sourceId: row.id,
      resourceType: 'clinical_note',
      resourceId: row.id,
      actorUid: editorUid,
      actorRole: editorRole,
      summary: `${row.note_type} note edited`,
      payload: {
        version: row.version,
        appointment_id: row.appointment_id,
        admin_override: adminOverride,
      },
      beforeState: {
        version: existing.version,
        content: existing.content,
      },
      afterState: {
        version: row.version,
        content: row.content,
      },
      timelineIdempotencyKey: `clinical_notes:${row.id}:edited:v${row.version}`,
      auditIdempotencyKey: `clinical_notes:${row.id}:audit:edited:v${row.version}`,
    }, tx);
    return row;
  });

  logger.info(
    `Clinical note edited: id=${noteId}, editor=${editorUid}, original_author=${existing.author_uid}, version=${existing.version}->${updated.version}, admin_override=${adminOverride}`
  );
  return attachAuthorNames(updated);
}

// ===================================================================
// signNote
// ===================================================================

/**
 * Sign a clinical note, making it immutable.
 * @param {number} noteId
 * @param {string} signerUid
 * @param {{ id?: number|string, uid?: string, role: string }} [actingUser] - the
 *   authenticated caller, used to enforce that only the assigned doctor (or an
 *   authorized supervisor) may sign a note bound to a specific OPD appointment.
 *   Defaults to the signer uid (role unknown) when omitted; an unbound note
 *   (no appointment) is unaffected by the guard.
 * @param {string|null} [tenantId] - Canonical tenant for RLS scoping (threaded
 *   from the caller's req.tenantId); falls back to DEFAULT_TENANT_ID.
 * @returns {Object} Updated note row
 */
export async function signNote(noteId, signerUid, actingUser = null, tenantId = null) {
  if (!signerUid) {
    throw AppError.badRequest('Signer UID is required');
  }

  const existing = await prisma.clinical_notes.findUnique({
    where: { id: Number(noteId) },
    select: {
      id: true,
      patient_uid: true,
      encounter_id: true,
      note_type: true,
      is_signed: true,
      signed_at: true,
      appointment_id: true,
    }
  });

  if (!existing) {
    throw AppError.notFound('Clinical note not found');
  }

  // H2 RBAC — signing a note bound to a specific OPD appointment is gated to
  // the appointment's assigned doctor (or an authorized supervisor), mirroring
  // the create-note guard. Notes not bound to an appointment (IPD/ER encounter
  // notes) are unaffected — those follow the care-team model.
  if (existing.appointment_id !== null && existing.appointment_id !== undefined) {
    const appt = await prisma.appointments.findUnique({
      where: { id: existing.appointment_id },
      select: { doctor_id: true }
    });
    if (appt) {
      let assignedDoctorUid = null;
      if (appt.doctor_id !== null && appt.doctor_id !== undefined) {
        const doctor = await prisma.users.findUnique({
          where: { id: appt.doctor_id },
          select: { uid: true }
        });
        assignedDoctorUid = doctor?.uid ?? null;
      }
      assertCanWriteAppointmentClinical(actingUser || { uid: signerUid, role: undefined }, {
        doctor_id: appt.doctor_id,
        assigned_doctor_uid: assignedDoctorUid
      });
    }
  }

  if (existing.is_signed) {
    throw AppError.conflict('Note is already signed and cannot be modified');
  }

  const now = new Date();
  // Atomic clinical write: signing the note, its canonical timeline/audit
  // events, and the OP encounter sign-transition all persist together
  // (canonical timeline invariant). A canonical/transition failure aborts
  // the tx so the note does not silently flip to signed without a traceable
  // timeline + audit row. Tenant-scoped so the writes land under the RLS
  // tenant_isolation policy instead of its permissive (GUC-unset) branch.
  const updated = await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const row = await tx.clinical_notes.update({
      where: { id: Number(noteId) },
      data: {
        is_signed: true,
        signed_at: now,
        signed_by: signerUid,
        updated_at: now
      },
      select: NOTE_SELECT
    });

    await recordCanonicalNoteEvent({
      tenantId: tenantId || DEFAULT_TENANT_ID,
      patientUid: row.patient_uid,
      encounterId: row.encounter_id,
      eventType: 'note.signed',
      eventSubtype: row.note_type,
      eventStatus: 'signed',
      sourceTable: 'clinical_notes',
      sourceId: row.id,
      resourceType: 'clinical_note',
      resourceId: row.id,
      actorUid: signerUid,
      actorRole: actingUser?.role,
      summary: `${row.note_type} note signed`,
      payload: {
        appointment_id: row.appointment_id,
        version: row.version,
        signed_at: row.signed_at,
      },
      beforeState: {
        is_signed: existing.is_signed,
        signed_at: existing.signed_at,
      },
      afterState: {
        is_signed: row.is_signed,
        signed_at: row.signed_at,
      },
      timelineIdempotencyKey: `clinical_notes:${row.id}:signed:${row.signed_at?.toISOString?.() || 'now'}`,
      auditIdempotencyKey: `clinical_notes:${row.id}:audit:signed:${row.signed_at?.toISOString?.() || 'now'}`,
    }, tx);
    return row;
  });

  logger.info(`Clinical note signed: id=${noteId}, signed_by=${signerUid}`);
  // Encounter lifecycle transition is a separate canonical step (own
  // timeline+audit) and stays best-effort/post-commit — see helper comment.
  if (updated.encounter_id && updated.appointment_id) {
    await bestEffortEncounterTransition('note sign', updated.encounter_id, 'signed', {
      actorUid: signerUid,
      actorRole: actingUser?.role,
      reason: 'OP consultation note signed',
      metadata: { note_id: updated.id, appointment_id: updated.appointment_id },
    });
  }
  return attachAuthorNames(updated);
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
      take: listQuery.limit
    })
  ]);
  const pagination = buildPagination(total, listQuery.page, listQuery.limit);

  return {
    notes: await attachAuthorNames(notes),
    pagination
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
  const notes = await prisma.clinical_notes.findMany({
    where: { encounter_id: encounterId },
    select: NOTE_SELECT,
    orderBy: { created_at: 'asc' }
  });
  return attachAuthorNames(notes);
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
    select: NOTE_SELECT
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
      AND: [{ OR: [{ id: rootId }, { parent_note_id: rootId }] }, { id: { not: id } }]
    },
    select: VERSION_HISTORY_SELECT,
    orderBy: { version: 'asc' }
  });

  const [enrichedNote, enrichedVersions] = await Promise.all([
    attachAuthorNames(note),
    attachAuthorNames(versions)
  ]);

  return {
    ...enrichedNote,
    version_history: enrichedVersions
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
export async function getPatientTimeline(patientUid, dateFrom, dateTo, options = {}) {
  const timeline = await readCanonicalPatientTimeline(patientUid, {
    tenantId: options.tenantId || options.tenant_id,
    date_from: dateFrom || null,
    date_to: dateTo || null,
    limit: options.limit,
    includeLegacy: options.includeLegacy === true || options.include_legacy === true,
  });
  return options.envelope ? timeline : timeline.events;
}

export default {
  createNote,
  addAddendum,
  signNote,
  getPatientNotes,
  getEncounterNotes,
  getNoteDetail,
  getPatientTimeline
};
