// src/services/emr/clinicalNoteDraftService.js
//
// Server-side autosave store for in-progress clinical notes (the `note_drafts`
// table, migration 314). A draft is the composing clinician's private,
// recoverable scratchpad.
//
// LOAD-BEARING INVARIANT: this service NEVER records a canonical clinical
// event — no clinical_timeline_events, no clinical_audit_events. Autosave must
// not touch the patient's legal record. The real note (and its canonical
// events) is written only on the finalize path
// (clinicalNotesService.createNote / sign), which also clears the matching
// draft via clearDraftForFinalizedNote().
//
// Design: docs/superpowers/specs/2026-06-17-clinical-notes-autosave-design.md

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import {
  recordNoteDraftJanitorDeletions,
  recordNoteDraftSaveError,
} from '../../observability/reliabilityMetrics.js';

// Serialized-size cap for a draft's content. 256 KB is ample for a text note
// and sits well under the ~1 MB global JSON body limit (express.json). Enforced
// BEFORE the DB upsert so an oversize blob never touches Postgres.
const MAX_DRAFT_CONTENT_BYTES = 256 * 1024;

// Require a draft's content to be a plain JSON object — matching the canonical
// note path's stricter object requirement. A string is parsed as JSON first;
// arrays and scalars are rejected (typeof [] === 'object', so they must be
// excluded explicitly).
function normContent(content) {
  if (content === null || content === undefined) return {};
  let value = content;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw AppError.badRequest('content must be a JSON object', 'NOTE_DRAFT_CONTENT_INVALID');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw AppError.badRequest('content must be a JSON object', 'NOTE_DRAFT_CONTENT_INVALID');
  }
  return value;
}

// Distinguish ABSENT (legitimately no appointment) from PRESENT-BUT-INVALID.
// A malformed appointment_id used to silently collapse into the null-appointment
// context (confusing + wrong); now it is rejected. Shared by upsert/get/delete,
// so GET/DELETE reject a malformed id too. 0 is rejected: it is the COALESCE
// sentinel for "no appointment" in the uniqueness/lookup predicates.
function normAppointmentId(appointmentId) {
  if (appointmentId === undefined || appointmentId === null || appointmentId === '') return null;
  const n = Number.parseInt(appointmentId, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(appointmentId).trim()) {
    throw AppError.badRequest('appointment_id must be an integer', 'NOTE_DRAFT_APPOINTMENT_INVALID');
  }
  return n;
}

function requireContext({ authorUid, patientUid, noteType }) {
  if (!authorUid) throw AppError.badRequest('author is required', 'NOTE_DRAFT_AUTHOR_REQUIRED');
  if (!patientUid) throw AppError.badRequest('patient_uid is required', 'NOTE_DRAFT_PATIENT_REQUIRED');
  if (!noteType) throw AppError.badRequest('note_type is required', 'NOTE_DRAFT_TYPE_REQUIRED');
}

/**
 * Upsert the author's draft for a (patient, encounter, note_type) context.
 * One row per context (uq_note_drafts_context); re-saving overwrites content
 * and refreshes updated_at + expires_at. Emits NO canonical events.
 */
export async function upsertNoteDraft({
  tenantId,
  authorUid,
  patientUid,
  appointmentId = null,
  noteType,
  content,
}) {
  requireContext({ authorUid, patientUid, noteType });
  const tid = requireTenantId(tenantId);
  const apptId = normAppointmentId(appointmentId);
  const json = JSON.stringify(normContent(content));
  if (Buffer.byteLength(json, 'utf8') > MAX_DRAFT_CONTENT_BYTES) {
    throw AppError.badRequest('draft content too large', 'NOTE_DRAFT_CONTENT_TOO_LARGE');
  }
  // Everything above this line is deliberate 400 validation (client fault) and
  // is NOT a save error. Only an UNEXPECTED failure of the DB write below counts
  // toward note_draft_save_errors_total — a validation AppError is re-thrown
  // uncounted; any other error increments the counter, then re-throws (never
  // swallowed).
  try {
    return await setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO note_drafts
           (tenant_id, author_uid, patient_uid, appointment_id, note_type, content, updated_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6::jsonb, NOW(), NOW() + INTERVAL '14 days')
         ON CONFLICT (tenant_id, author_uid, patient_uid, COALESCE(appointment_id, 0), note_type)
         DO UPDATE SET content = EXCLUDED.content, updated_at = NOW(), expires_at = NOW() + INTERVAL '14 days'
         RETURNING id, updated_at`,
        tid,
        authorUid,
        patientUid,
        apptId,
        String(noteType),
        json,
      );
      return rows[0] || null;
    });
  } catch (err) {
    if (!(err instanceof AppError)) recordNoteDraftSaveError();
    throw err;
  }
}

/**
 * Load the author's OWN draft for a context (author-scoped — a clinician can
 * only ever see their own in-progress draft). Returns null if none.
 */
export async function getNoteDraft({
  tenantId,
  authorUid,
  patientUid,
  appointmentId = null,
  noteType,
}) {
  requireContext({ authorUid, patientUid, noteType });
  const tid = requireTenantId(tenantId);
  const apptId = normAppointmentId(appointmentId);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, content, updated_at, expires_at
         FROM note_drafts
        WHERE tenant_id = $1::uuid AND author_uid = $2::uuid AND patient_uid = $3::uuid
          AND COALESCE(appointment_id, 0) = COALESCE($4::int, 0) AND note_type = $5
        LIMIT 1`,
      tid,
      authorUid,
      patientUid,
      apptId,
      String(noteType),
    );
    return rows[0] || null;
  });
}

/**
 * Delete the author's draft for a context (explicit discard). Returns the
 * number of rows removed. Idempotent.
 */
export async function deleteNoteDraft({
  tenantId,
  authorUid,
  patientUid,
  appointmentId = null,
  noteType,
}) {
  requireContext({ authorUid, patientUid, noteType });
  const tid = requireTenantId(tenantId);
  const apptId = normAppointmentId(appointmentId);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `DELETE FROM note_drafts
        WHERE tenant_id = $1::uuid AND author_uid = $2::uuid AND patient_uid = $3::uuid
          AND COALESCE(appointment_id, 0) = COALESCE($4::int, 0) AND note_type = $5
        RETURNING id`,
      tid,
      authorUid,
      patientUid,
      apptId,
      String(noteType),
    );
    return rows.length;
  });
}

/**
 * Best-effort: clear the matching draft after a note is finalized. NEVER throws
 * (the finalize path is authoritative; a leftover draft is harmless — the
 * expiry janitor + the client's prefer-committed restore rule cover it). Called
 * post-commit by clinicalNotesService.createNote.
 */
export async function clearDraftForFinalizedNote({
  tenantId,
  authorUid,
  patientUid,
  appointmentId = null,
  noteType,
}) {
  if (!authorUid || !patientUid || !noteType) return;
  try {
    await deleteNoteDraft({ tenantId, authorUid, patientUid, appointmentId, noteType });
  } catch (err) {
    logger.warn('clinicalNoteDraftService: failed to clear draft after finalize (non-fatal)', {
      patientUid,
      noteType,
      error: err?.message || String(err),
    });
  }
}

/**
 * Janitor: delete drafts past their TTL. Returns the count removed. Runs on
 * plain prisma — a global cleanup of expired rows; with the GUC unset the
 * tenant_isolation policy is permissive (its `current_setting(...) IS NULL`
 * branch), so all tenants' expired drafts are purged in one pass.
 */
export async function purgeExpiredNoteDrafts() {
  const rows = await prisma.$queryRawUnsafe(
    'DELETE FROM note_drafts WHERE expires_at < NOW() RETURNING id',
  );
  recordNoteDraftJanitorDeletions(rows.length);
  return rows.length;
}
