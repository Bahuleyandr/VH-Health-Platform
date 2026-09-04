// src/services/clinical/bloodborneMarkerService.js
//
// Platform-level patient blood-borne marker record. The pure rules (value
// normaliser, reuse resolver, exposure registry) live in
// bloodborneMarkerRules.js and are re-exported here; the persistence functions
// (record, list, void, lab sign-off ingestion) live below.
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §5.1, §7.
//
// Consumers today: cath-lab device reuse (restriction strip, post-use rules,
// late-result quarantine). Named future consumers: OT sign-in, dialysis.
// Writers: the lab sign-off hook and the cath readiness checklist's
// external-result / clinical-declaration paths. There is deliberately no
// general create endpoint.

export * from './bloodborneMarkerRules.js';
export { markerForResult } from '../lab/labAnalyteCodes.js';

import { setTenant, setTenantTx } from '../../lib/prisma.js';
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

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

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

function cleanText(value, max = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function requireDate(value, label) {
  const text = isoDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a date (YYYY-MM-DD)`, 'BLOODBORNE_MARKER_INVALID');
  }
  if (text > clinicalDate(new Date())) {
    throw AppError.badRequest(`${label} cannot be in the future`, 'BLOODBORNE_MARKER_INVALID');
  }
  return text;
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
  const label = cleanText(markerLabel, 120);
  if (safeMarker === 'other' && !label) {
    throw AppError.badRequest('marker_label is required when marker is other', 'BLOODBORNE_MARKER_INVALID');
  }
  if (safeMarker === 'cjd_suspected' && !['reactive', 'non_reactive'].includes(safeResult)) {
    throw AppError.badRequest('cjd_suspected accepts reactive (suspected) or non_reactive (not suspected)', 'BLOODBORNE_MARKER_INVALID');
  }
  // Mirrors patient_bloodborne_markers_lab_link_check: lab_result and
  // external_report rows always carry the lab result id; clinical
  // declarations never do.
  if (safeSource !== 'clinical_declaration' && labResultId == null) {
    throw AppError.badRequest(`lab_result_id is required for ${safeSource} markers`, 'BLOODBORNE_MARKER_INVALID');
  }
  if (safeSource === 'clinical_declaration' && labResultId != null) {
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
    safeMarker === 'other' ? label : null,
    safeResult,
    requireDate(testedOn, 'tested_on'),
    safeSource,
    labResultId == null ? null : Number(labResultId),
    JSON.stringify(evidence && typeof evidence === 'object' ? evidence : {}),
    actor,
    cleanText(notes, 2000),
  );
  return rows[0] ? normalizeMarkerRow(rows[0]) : null;
}

// Record one or more marker rows for a patient in one tenant transaction, then
// notify exposure handlers for every reactive row AFTER commit.
export async function recordMarkers({ tenantId, patientUid, entries = [], actorUid }) {
  const tid = requireTenantId(tenantId);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw AppError.badRequest('At least one marker entry is required', 'BLOODBORNE_MARKER_INVALID');
  }
  const recorded = await setTenantTx(tid, async (tx) => {
    const rows = [];
    for (const entry of entries) {
      const row = await recordMarkerTx(tx, {
        tenantId: tid,
        patientUid,
        marker: entry.marker,
        markerLabel: entry.marker_label ?? entry.markerLabel ?? null,
        result: entry.result,
        testedOn: entry.tested_on ?? entry.testedOn,
        source: entry.source,
        labResultId: entry.lab_result_id ?? entry.labResultId ?? null,
        evidence: entry.evidence ?? {},
        recordedBy: actorUid,
        notes: entry.notes ?? null,
      });
      if (row) rows.push(row);
    }
    return rows;
  });
  await notifyExposureHandlers(recorded.filter((row) => row.result === 'reactive').map(exposureEventFrom));
  return { recorded };
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
} = {}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const rows = await activeMarkerRows(tid, uid, { includeVoided });
  return {
    markers: rows.map(normalizeMarkerRow),
    reuse_status: computeReuseStatus(rows, { validityDays }),
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
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING ${MARKER_SELECT}`,
      tid, id, actor, safeReason,
    );
    return normalizeMarkerRow(updated[0]);
  });
}

// ---------------------------------------------------------------------------
// Lab sign-off hook — called post-commit from labResultsService.signOffResults.
// Verified/corrected/amended HIV, HBSAG and HCV results become marker rows;
// a corrective decision voids the previous row for the same lab result first.
// ---------------------------------------------------------------------------

const CORRECTIVE_DECISIONS = new Set(['corrected', 'amended']);
const SIGNED_STATUSES = new Set(['final', 'corrected', 'amended', 'verified']);

export async function recordMarkersFromSignedResults({ tenantId, resultIds = [], decision = 'verified', actorUid }) {
  const tid = requireTenantId(tenantId);
  const ids = [...new Set((resultIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (ids.length === 0) return { recorded: [], voided: 0 };
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT id, patient_uid, test_code, loinc_code, value_text, status,
            signed_off_at, performed_at, received_at
       FROM lab_results
      WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
    tid, ids,
  ));
  const candidates = rows
    .map((row) => ({ row, marker: markerForResult(row) }))
    .filter(({ row, marker }) => marker
      && row.signed_off_at
      && SIGNED_STATUSES.has(String(row.status || '').toLowerCase()));
  if (candidates.length === 0) return { recorded: [], voided: 0 };

  const normalizedDecision = String(decision || 'verified').toLowerCase();
  const actor = requireUuid(actorUid, 'actorUid');
  const outcome = await setTenantTx(tid, async (tx) => {
    let voided = 0;
    const recorded = [];
    for (const { row, marker } of candidates) {
      if (CORRECTIVE_DECISIONS.has(normalizedDecision)) {
        voided += await tx.$executeRawUnsafe(
          `UPDATE patient_bloodborne_markers
              SET voided_at = NOW(), voided_by = $3::uuid, void_reason = 'lab_result_corrected'
            WHERE tenant_id = $1::uuid AND lab_result_id = $2::int AND voided_at IS NULL`,
          tid, Number(row.id), actor,
        );
      }
      const inserted = await recordMarkerTx(tx, {
        tenantId: tid,
        patientUid: row.patient_uid,
        marker,
        result: normalizeSerologyValue(row.value_text),
        testedOn: clinicalDate(row.performed_at || row.received_at || new Date()),
        source: 'lab_result',
        labResultId: Number(row.id),
        evidence: {
          raw_value: row.value_text,
          test_code: row.test_code,
          loinc_code: row.loinc_code,
          decision: normalizedDecision,
        },
        recordedBy: actor,
      });
      if (inserted) recorded.push(inserted);
    }
    return { recorded, voided };
  });
  await notifyExposureHandlers(outcome.recorded.filter((row) => row.result === 'reactive').map(exposureEventFrom));
  return outcome;
}
