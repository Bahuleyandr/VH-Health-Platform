// Clinician EHR Query — chart-grounded answers that separate the CURRENT
// ADMISSION from PRIOR HISTORY.
//
// This file currently hosts two pure-ish helpers (Task 1). The orchestration
// entrypoint `answerEhrQuery` and the route handler arrive in later tasks —
// leave room for them here.
//
// The clinical record is assembled by the existing EMR services
// (`services/emr/clinicalTimelineService.js`), so there is no embedding /
// vector store here — we reuse the canonical timeline.
//
// Timeline event shape (from getPatientTimeline / collectAdmissionClinicalContext):
//   { id, event_type, summary, timestamp, payload, ... }
// Note: real timeline events expose `event_type` (not `type`) and do NOT carry
// a per-event `citation`; citations are derived at the packet level via the
// timeline service's `makeCitation`. serializeEhrContext therefore reads the
// type slot as `event.type ?? event.event_type` and harvests any `event.citation`
// the caller chose to attach (the orchestrator in a later task is responsible
// for wiring real citations onto the events it passes in).

import { prismaReadOnly } from '../../lib/prisma.js';

const CURRENT_ADMISSION_HEADER = '[CURRENT ADMISSION]';
const PRIOR_HISTORY_HEADER = '[PRIOR HISTORY]';

/**
 * Format a single timeline event as one context line:
 *   `- [<timestamp>] <type>: <summary>`
 * Tolerant of both the real event shape (`event_type`) and the lighter test
 * shape (`type`).
 */
function formatEventLine(event) {
  const timestamp = event?.timestamp ?? '';
  const type = event?.type ?? event?.event_type ?? '';
  const summary = event?.summary ?? '';
  return `- [${timestamp}] ${type}: ${summary}`;
}

/**
 * Serialize an assembled EHR context into a single labelled text block plus a
 * flat, ordered citation list.
 *
 * @param {object}   params
 * @param {object|null} params.currentAdmission - packet from
 *   collectAdmissionClinicalContext (has `.timeline`), or null for an
 *   outpatient with no active admission.
 * @param {Array<object>} [params.history] - prior-history timeline events.
 * @param {'both'|'current_admission'|'history'} [params.scope='both'] - which
 *   sections to emit.
 * @returns {{ text: string, citations: Array<object> }}
 */
function serializeEhrContext({ currentAdmission, history, scope = 'both' } = {}) {
  const sections = [];
  const citations = [];

  const admissionEvents = Array.isArray(currentAdmission?.timeline)
    ? currentAdmission.timeline
    : [];
  const historyEvents = Array.isArray(history) ? history : [];

  // CURRENT ADMISSION — emitted unless scope is history-only, and only when an
  // active admission packet is actually present (outpatients have none).
  if (scope !== 'history' && currentAdmission) {
    const lines = admissionEvents.map(formatEventLine);
    sections.push([CURRENT_ADMISSION_HEADER, ...lines].join('\n'));
    for (const event of admissionEvents) {
      if (event?.citation) citations.push(event.citation);
    }
  }

  // PRIOR HISTORY — emitted unless scope is current-admission-only.
  if (scope !== 'current_admission') {
    const lines = historyEvents.map(formatEventLine);
    sections.push([PRIOR_HISTORY_HEADER, ...lines].join('\n'));
    for (const event of historyEvents) {
      if (event?.citation) citations.push(event.citation);
    }
  }

  return { text: sections.join('\n\n'), citations };
}

/**
 * Resolve the patient's currently-active admission id within a tenant, or null
 * when the patient is not currently admitted (outpatient / discharged).
 *
 * Active condition (from src/migrations/000_baseline.sql admissions table):
 *   status = 'admitted' AND discharged_at IS NULL
 * Recency ordering: admitted_at DESC (NULLS LAST) — admitted_at is the
 * semantic admit timestamp; rows missing it fall to the back.
 *
 * @param {string} patientUid - patient uuid.
 * @param {string} tenantId   - tenant uuid.
 * @returns {Promise<number|null>}
 */
async function resolveCurrentAdmission(patientUid, tenantId) {
  const rows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT id FROM admissions
       WHERE patient_uid = $1::uuid
         AND tenant_id = $2::uuid
         AND status = 'admitted'
         AND discharged_at IS NULL
       ORDER BY admitted_at DESC NULLS LAST
       LIMIT 1`,
    patientUid,
    tenantId,
  );
  return rows?.[0]?.id ?? null;
}

export { serializeEhrContext, resolveCurrentAdmission };

export const __testing__ = { serializeEhrContext, resolveCurrentAdmission };
