// src/services/clinical/bloodborneMarkerService.js
//
// Platform-level patient blood-borne marker record. The pure rules (value
// normaliser, reuse resolver, exposure registry) live in
// bloodborneMarkerRules.js and are re-exported here; the persistence functions
// (record, list, void, lab sign-off ingestion) live below.
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §5.1, §7.
//
// Nothing in the tree calls these functions yet. The lab sign-off hook below
// is *intended* to be called post-commit by labResultsService.signOffResults,
// and that wiring lands in a following commit. The intended readers are
// cath-lab device reuse (restriction strip, post-use rules, late-result
// quarantine), OT sign-in and dialysis; none of them is wired here either.
// Writers: the lab sign-off hook and the cath readiness checklist's
// external-result / clinical-declaration paths. There is deliberately no
// general create endpoint.

export * from './bloodborneMarkerRules.js';

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { markerForResult } from '../lab/labAnalyteCodes.js';
import {
  DEFAULT_VALIDITY_DAYS,
  MARKERS,
  RESULTS,
  SOURCES,
  clinicalDate,
  computeReuseStatus,
  isoDate,
  normalizeSerologyValue,
  notifyExposureHandlers,
  requireUuid,
} from './bloodborneMarkerRules.js';

export { markerForResult };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// lab_result_id is an INTEGER column (migration 764); a larger id would reach
// the $8::int cast as a 22003 rather than a validation error.
const POSTGRES_INT4_MAX = 2_147_483_647;

const MARKER_SELECT = `id, tenant_id, patient_uid, marker, marker_label, result, tested_on, source,
  lab_result_id, evidence, recorded_by, recorded_at, voided_at, voided_by, void_reason, notes`;

function normalizeMarkerRow(row) {
  if (!row) return row;
  return {
    ...row,
    id: Number(row.id),
    lab_result_id: row.lab_result_id == null ? null : Number(row.lab_result_id),
    tested_on: isoDate(row.tested_on),
  };
}

function withTenant(tenantId, db, fn) {
  return db ? fn(db) : setTenant(tenantId, fn);
}

// Trim only. Free text (notes, void reason) is trimmed and truncated through
// cleanText; identifying text (marker_label) is trimmed and then rejected when
// it is too long, so a caller never silently stores a shortened label.
function trimText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function cleanText(value, max = 500) {
  const text = trimText(value);
  return text === null ? null : text.slice(0, max);
}

// The single acceptance rule for a tested_on value: a readable YYYY-MM-DD that
// is not after today's clinical-zone date. requireDate throws on it (writer
// path); the sign-off hook reads the problem name directly so it can drop a
// bad candidate before it issues any SQL for it.
function clinicalDateProblem(value) {
  const text = isoDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'not_a_date';
  if (text > clinicalDate(new Date())) return 'future_dated';
  return null;
}

function requireDate(value, label) {
  const problem = clinicalDateProblem(value);
  if (problem === 'not_a_date') {
    throw AppError.badRequest(`${label} must be a date (YYYY-MM-DD)`, 'BLOODBORNE_MARKER_INVALID');
  }
  if (problem === 'future_dated') {
    throw AppError.badRequest(`${label} cannot be in the future`, 'BLOODBORNE_MARKER_INVALID');
  }
  return isoDate(value);
}

// clinicalDate throws on an invalid instant; a lab row carrying one must
// degrade to a skipped candidate, never to a failed batch.
function safeClinicalDate(instant) {
  const at = instant instanceof Date ? instant : new Date(instant);
  return Number.isNaN(at.getTime()) ? '' : clinicalDate(at);
}

function requireOneOf(value, allowed, label) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of ${allowed.join(', ')}`, 'BLOODBORNE_MARKER_INVALID');
  }
  return text;
}

function exposureEventFrom(row) {
  return {
    tenantId: row.tenant_id,
    patientUid: row.patient_uid,
    marker: row.marker,
    markerLabel: row.marker_label ?? null,
    result: row.result,
    testedOn: isoDate(row.tested_on),
    source: row.source,
    markerRowId: Number(row.id),
    labResultId: row.lab_result_id == null ? null : Number(row.lab_result_id),
  };
}

// Insert one marker row inside the caller's tenant transaction. Returns the
// row, or null when a lab-result-linked active row already exists (idempotent
// replay through ux_patient_bloodborne_markers_lab_result).
export async function recordMarkerTx(tx, {
  tenantId,
  patientUid,
  marker,
  markerLabel = null,
  result,
  testedOn,
  source,
  labResultId = null,
  evidence = {},
  recordedBy,
  notes = null,
}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const actor = requireUuid(recordedBy, 'recordedBy');
  const safeMarker = requireOneOf(marker, MARKERS, 'marker');
  const safeResult = requireOneOf(result, RESULTS, 'result');
  const safeSource = requireOneOf(source, SOURCES, 'source');
  // marker_label identifies the marker only for 'other'. For a named marker
  // the display name comes from the marker itself, so any label a caller sends
  // is ignored rather than validated or stored — nothing downstream reads it.
  const label = safeMarker === 'other' ? trimText(markerLabel) : null;
  if (safeMarker === 'other') {
    if (!label) {
      throw AppError.badRequest('marker_label is required when marker is other', 'BLOODBORNE_MARKER_INVALID');
    }
    if (label.length > 120) {
      throw AppError.badRequest('marker_label must be 120 characters or fewer', 'BLOODBORNE_MARKER_INVALID');
    }
  }
  if (safeMarker === 'cjd_suspected' && !['reactive', 'non_reactive'].includes(safeResult)) {
    throw AppError.badRequest('cjd_suspected accepts reactive (suspected) or non_reactive (not suspected)', 'BLOODBORNE_MARKER_INVALID');
  }
  // A lab result id, when present, must be a positive integer before it ever
  // reaches the $8::int cast — Number('abc') would otherwise arrive as NaN.
  let safeLabResultId = null;
  if (labResultId !== null && labResultId !== undefined) {
    safeLabResultId = Number(labResultId);
    if (!Number.isSafeInteger(safeLabResultId) || safeLabResultId <= 0 || safeLabResultId > POSTGRES_INT4_MAX) {
      throw AppError.badRequest('lab_result_id must be a positive integer', 'BLOODBORNE_MARKER_INVALID');
    }
  }
  // Mirrors patient_bloodborne_markers_lab_link_check: lab_result and
  // external_report rows always carry the lab result id; clinical
  // declarations never do.
  if (safeSource !== 'clinical_declaration' && safeLabResultId == null) {
    throw AppError.badRequest(`lab_result_id is required for ${safeSource} markers`, 'BLOODBORNE_MARKER_INVALID');
  }
  if (safeSource === 'clinical_declaration' && safeLabResultId != null) {
    throw AppError.badRequest('clinical_declaration markers do not reference a lab result', 'BLOODBORNE_MARKER_INVALID');
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO patient_bloodborne_markers
       (tenant_id, patient_uid, marker, marker_label, result, tested_on, source,
        lab_result_id, evidence, recorded_by, notes)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7,
             $8::int, $9::jsonb, $10::uuid, $11)
     ON CONFLICT (tenant_id, lab_result_id)
       WHERE lab_result_id IS NOT NULL AND voided_at IS NULL
       DO NOTHING
     RETURNING ${MARKER_SELECT}`,
    tid,
    uid,
    safeMarker,
    label,
    safeResult,
    requireDate(testedOn, 'tested_on'),
    safeSource,
    safeLabResultId,
    JSON.stringify(evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {}),
    actor,
    cleanText(notes, 2000),
  );
  return rows[0] ? normalizeMarkerRow(rows[0]) : null;
}

// Record one or more marker rows for a patient in one tenant transaction, then
// notify exposure handlers for every reactive row AFTER commit. An entry whose
// lab-linked slot is already taken by an active row inserts nothing and is
// reported in `skipped` by its lab_result_id, so a caller can tell "written"
// from "already on record" instead of reading a short `recorded` array.
export async function recordMarkers({ tenantId, patientUid, entries = [], actorUid }) {
  const tid = requireTenantId(tenantId);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw AppError.badRequest('At least one marker entry is required', 'BLOODBORNE_MARKER_INVALID');
  }
  // Validated before the transaction opens: a malformed uid must not cost a
  // connection and a BEGIN/ROLLBACK.
  const uid = requireUuid(patientUid, 'patientUid');
  const actor = requireUuid(actorUid, 'actorUid');
  const outcome = await setTenantTx(tid, async (tx) => {
    const recorded = [];
    const skipped = [];
    for (const entry of entries) {
      const labResultId = entry.lab_result_id ?? entry.labResultId ?? null;
      const row = await recordMarkerTx(tx, {
        tenantId: tid,
        patientUid: uid,
        marker: entry.marker,
        markerLabel: entry.marker_label ?? entry.markerLabel ?? null,
        result: entry.result,
        testedOn: entry.tested_on ?? entry.testedOn,
        source: entry.source,
        labResultId,
        evidence: entry.evidence ?? {},
        recordedBy: actor,
        notes: entry.notes ?? null,
      });
      // Only a lab-linked entry can lose the ON CONFLICT race: the unique
      // index is partial on lab_result_id IS NOT NULL, so a clinical
      // declaration always inserts. `skipped` therefore only ever carries
      // lab_result_ids.
      if (row) recorded.push(row);
      else skipped.push(Number(labResultId));
    }
    return { recorded, skipped };
  });
  await notifyExposureHandlers(outcome.recorded.filter((row) => row.result === 'reactive').map(exposureEventFrom));
  return outcome;
}

async function activeMarkerRows(tenantId, patientUid, { db = null, includeVoided = false } = {}) {
  return withTenant(tenantId, db, (client) => client.$queryRawUnsafe(
    `SELECT ${MARKER_SELECT}
       FROM patient_bloodborne_markers
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        ${includeVoided ? '' : 'AND voided_at IS NULL'}
      ORDER BY tested_on DESC, id DESC`,
    tenantId,
    patientUid,
  ));
}

export async function resolveReuseStatus({
  tenantId,
  patientUid,
  validityDays = DEFAULT_VALIDITY_DAYS,
  asOf = new Date(),
  db = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const rows = await activeMarkerRows(tid, uid, { db });
  return computeReuseStatus(rows, { validityDays, asOf });
}

export async function listMarkersForPatient({
  tenantId,
  patientUid,
  validityDays = DEFAULT_VALIDITY_DAYS,
  includeVoided = false,
  asOf = new Date(),
  db = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const rows = await activeMarkerRows(tid, uid, { db, includeVoided });
  return {
    markers: rows.map(normalizeMarkerRow),
    reuse_status: computeReuseStatus(rows, { validityDays, asOf }),
  };
}

export async function voidMarker({ tenantId, patientUid, markerId, actorUid, reason }) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const actor = requireUuid(actorUid, 'actorUid');
  const id = Number(markerId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest('marker id must be a positive integer', 'BLOODBORNE_MARKER_INVALID');
  }
  const safeReason = cleanText(reason, 500);
  if (!safeReason) {
    throw AppError.badRequest('reason is required to void a marker', 'BLOODBORNE_MARKER_INVALID');
  }
  return setTenantTx(tid, async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT ${MARKER_SELECT} FROM patient_bloodborne_markers
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND patient_uid = $3::uuid
        FOR UPDATE`,
      tid, id, uid,
    );
    const row = existing[0];
    if (!row) throw AppError.notFound('Blood-borne marker not found', 'BLOODBORNE_MARKER_NOT_FOUND');
    if (row.voided_at) throw AppError.conflict('Blood-borne marker is already voided', 'BLOODBORNE_MARKER_ALREADY_VOIDED');
    const updated = await tx.$queryRawUnsafe(
      `UPDATE patient_bloodborne_markers
          SET voided_at = NOW(), voided_by = $3::uuid, void_reason = $4
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND patient_uid = $5::uuid
        RETURNING ${MARKER_SELECT}`,
      tid, id, actor, safeReason, uid,
    );
    return normalizeMarkerRow(updated[0]);
  });
}

// ---------------------------------------------------------------------------
// Lab sign-off hook — intended to be called post-commit by
// labResultsService.signOffResults; that wiring lands in a following commit,
// so nothing calls this yet. Signed HIV, HBSAG and HCV results become marker
// rows.
//
// The upsert is content-aware: the active row's own content is the authority,
// not the batch's decision word. For each candidate the active lab-linked row
// is locked and compared with what the lab result now says — same result and
// same tested_on means skip, different means void that row
// ('lab_result_corrected') and insert the new one, absent means insert. So a
// sign-off announced as 'verified' over a changed value still corrects the
// record, and one announced as 'corrected' over an unchanged value writes
// nothing. `decision` is validated and kept only as evidence.decision.
//
// The read-compare-write is serialised per (tenant, lab result) by a
// transaction-scoped advisory lock taken before the row is read, so two
// concurrent sign-offs of the same result cannot both read the same active
// row, both void it and both insert — which would lose one correction.
//
// Return shape:
//   recorded — the marker rows inserted by this call (full rows).
//   voided   — count of superseded marker rows voided by this call.
//   skipped  — lab_result_ids whose active marker already said exactly this.
//   failed   — { lab_result_id, reason } for candidates rejected before any
//              SQL was issued for them (an unusable tested_on).
//
// Voiding frees the lab-linked unique slot (ux_patient_bloodborne_markers_lab_result
// is partial on voided_at IS NULL), so replaying a batch whose row was voided
// and superseded re-inserts. That is intended: the live row is whatever the
// lab result currently says, and the voided rows remain as history.
//
// A void or correction emits no retraction event by design; the intended
// consumers (cath device reuse, OT, dialysis) resolve status pull-style
// through resolveReuseStatus, so a lifted restriction is seen on their next
// read rather than pushed at them.
// ---------------------------------------------------------------------------

const SIGNED_STATUSES = new Set(['final', 'corrected', 'amended', 'verified']);
const SIGN_OFF_DECISIONS = ['verified', 'corrected', 'amended'];

// One read-compare-write pass over a lab result's active marker slot, run
// inside the caller's transaction and under its advisory lock for that lab
// result. Returns { outcome, voided, row }:
//   'skipped'  — the active row already says exactly this; nothing written.
//   'recorded' — any stale active row was voided and the new row inserted.
//   'conflict' — the lab-linked slot was taken between the read and the
//                insert, so nothing was inserted.
async function upsertMarkerForLabResult(tx, {
  tenantId,
  labResultId,
  labRow,
  marker,
  nextResult,
  nextTestedOn,
  decision,
  actor,
}) {
  const activeRows = await tx.$queryRawUnsafe(
    `SELECT id, result, tested_on, patient_uid
       FROM patient_bloodborne_markers
      WHERE tenant_id = $1::uuid AND lab_result_id = $2::int AND voided_at IS NULL
      FOR UPDATE`,
    tenantId, labResultId,
  );
  // patient_uid is read for the comparison's completeness only: the new row
  // must carry the lab result's *current* patient_uid, because the composite
  // FK points at lab_results (tenant_id, id, patient_uid).
  const active = activeRows[0];
  if (active && active.result === nextResult && isoDate(active.tested_on) === nextTestedOn) {
    return { outcome: 'skipped', voided: 0, row: null };
  }
  let voided = 0;
  if (active) {
    voided = await tx.$executeRawUnsafe(
      `UPDATE patient_bloodborne_markers
          SET voided_at = NOW(), voided_by = $3::uuid, void_reason = 'lab_result_corrected'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tenantId, Number(active.id), actor,
    );
  }
  const inserted = await recordMarkerTx(tx, {
    tenantId,
    patientUid: labRow.patient_uid,
    marker,
    result: nextResult,
    testedOn: nextTestedOn,
    source: 'lab_result',
    labResultId,
    evidence: {
      raw_value: labRow.value_text,
      test_code: labRow.test_code,
      loinc_code: labRow.loinc_code,
      decision,
    },
    recordedBy: actor,
  });
  return inserted
    ? { outcome: 'recorded', voided, row: inserted }
    : { outcome: 'conflict', voided, row: null };
}

export async function recordMarkersFromSignedResults({ tenantId, resultIds = [], decision = 'verified', actorUid }) {
  const tid = requireTenantId(tenantId);
  const ids = [...new Set((resultIds || [])
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0 && n <= POSTGRES_INT4_MAX))];
  if (ids.length === 0) return { recorded: [], voided: 0, skipped: [], failed: [] };
  // Validated before any database access: a bad actor uid must not cost a read.
  const actor = requireUuid(actorUid, 'actorUid');
  const normalizedDecision = requireOneOf(decision, SIGN_OFF_DECISIONS, 'decision');
  // One transaction for the whole hook: the lab_results read and the marker
  // writes share a snapshot, so a result cannot be corrected between the two.
  // A candidate carrying an unusable date is dropped before any SQL is issued
  // for it; a database error is still all-or-nothing for the whole batch.
  const outcome = await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, test_code, loinc_code, value_text, status,
              signed_off_at, performed_at, received_at
         FROM lab_results
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])
        ORDER BY id`,
      tid, ids,
    );
    const candidates = rows
      .map((row) => ({ row, marker: markerForResult(row) }))
      .filter(({ row, marker }) => marker
        && row.signed_off_at
        && SIGNED_STATUSES.has(String(row.status || '').toLowerCase()));
    if (candidates.length === 0) return { recorded: [], voided: 0, skipped: [], failed: [] };
    let voided = 0;
    const recorded = [];
    const skipped = [];
    const failed = [];
    // Candidates are walked in lab_result_id order (the select above is
    // ORDER BY id), so two overlapping batches take the per-result advisory
    // locks below in the same order and cannot deadlock against each other.
    for (const { row, marker } of candidates) {
      const labResultId = Number(row.id);
      // Serialise the whole read-compare-write for this lab result. The lock
      // is transaction-scoped, so it is held to COMMIT: a second sign-off of
      // the same result waits here instead of racing the compare, reading the
      // same active row and voiding it twice.
      //
      // $executeRawUnsafe, not $queryRawUnsafe: pg_advisory_xact_lock returns
      // void and Prisma's query path cannot deserialise a void column
      // ('Failed to deserialize column of type void').
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
        tid, String(labResultId),
      );
      const nextResult = normalizeSerologyValue(row.value_text);
      const nextTestedOn = safeClinicalDate(row.performed_at || row.received_at || new Date());
      const problem = clinicalDateProblem(nextTestedOn);
      if (problem) {
        logger.warn(
          `Blood-borne marker skipped for lab result ${labResultId}: tested_on ${problem}`,
          { tenantId: tid, labResultId, testedOn: nextTestedOn || null, reason: problem },
        );
        failed.push({ lab_result_id: labResultId, reason: problem });
        continue;
      }
      const passArgs = {
        tenantId: tid,
        labResultId,
        labRow: row,
        marker,
        nextResult,
        nextTestedOn,
        decision: normalizedDecision,
        actor,
      };
      let pass = await upsertMarkerForLabResult(tx, passArgs);
      voided += pass.voided;
      if (pass.outcome === 'conflict') {
        // Defensive; unreachable while the advisory lock is held — only a
        // writer that does not take this lock could take the lab-linked slot
        // between the read and the insert. Re-read and re-decide once rather
        // than silently dropping a correction.
        pass = await upsertMarkerForLabResult(tx, passArgs);
        voided += pass.voided;
      }
      if (pass.outcome === 'recorded') recorded.push(pass.row);
      else skipped.push(labResultId);
    }
    return { recorded, voided, skipped, failed };
  });
  await notifyExposureHandlers(outcome.recorded.filter((row) => row.result === 'reactive').map(exposureEventFrom));
  return outcome;
}
