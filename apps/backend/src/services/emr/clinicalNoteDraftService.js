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

function normContent(content) {
  if (content === null || content === undefined) return {};
  if (typeof content === 'object') return content;
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function normAppointmentId(appointmentId) {
  if (appointmentId === undefined || appointmentId === null || appointmentId === '') return null;
  const n = Number.parseInt(appointmentId, 10);
  return Number.isFinite(n) ? n : null;
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
  return setTenantTx(tid, async (tx) => {
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
  return rows.length;
}
