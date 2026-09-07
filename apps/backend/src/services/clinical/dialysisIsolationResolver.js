import { AppError } from '../../utils/AppError.js';

export const CONTRACT_VERSION = 2;

const CORE_MARKERS = Object.freeze(['hbsag', 'hcv', 'hiv']);
const REACTIVE = 'reactive';
const NON_REACTIVE = 'non_reactive';
const REASON_BY_MARKER = Object.freeze({
  hbsag: 'DIALYSIS_HBSAG_POSITIVE',
  hcv: 'DIALYSIS_HCV_POSITIVE',
  hiv: 'DIALYSIS_HIV_POSITIVE',
});
const RESULT_PRECEDENCE = Object.freeze({
  reactive: 4,
  indeterminate: 3,
  pending: 2,
  non_reactive: 1,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOLVER_SQL = `
WITH requested AS (
  SELECT DISTINCT UNNEST($2::uuid[]) AS patient_uid
),
roster AS (
  SELECT patient_uid,
         BOOL_OR(hbsag_status = 'positive') AS hbsag_positive,
         BOOL_OR(hcv_status = 'positive') AS hcv_positive,
         BOOL_OR(hiv_status = 'positive') AS hiv_positive
    FROM dialysis_patients
   WHERE tenant_id = $1::uuid
     AND patient_uid = ANY($2::uuid[])
   GROUP BY patient_uid
),
marker_evidence AS (
  SELECT patient_uid,
         id::text AS marker_row_id,
         marker,
         result,
         tested_on,
         source
    FROM patient_bloodborne_markers
   WHERE tenant_id = $1::uuid
     AND patient_uid = ANY($2::uuid[])
     AND marker = ANY($3::text[])
     AND voided_at IS NULL
),
serology_evidence AS (
  SELECT patient.patient_uid,
         NULL::text AS marker_row_id,
         observation.marker,
         CASE
           WHEN observation.value IN ('positive', 'reactive') THEN 'reactive'
           WHEN observation.value = 'negative' THEN 'non_reactive'
           WHEN observation.value = 'pending' THEN 'pending'
           ELSE 'indeterminate'
         END AS result,
         serology.test_date AS tested_on,
         'dialysis_serology'::text AS source
    FROM dialysis_serology AS serology
    JOIN dialysis_patients AS patient
      ON patient.tenant_id = serology.tenant_id
     AND patient.id = serology.dialysis_patient_id
    CROSS JOIN LATERAL (VALUES
      ('hbsag'::text, serology.hbsag),
      ('hcv'::text, serology.anti_hcv),
      ('hiv'::text, serology.hiv)
    ) AS observation(marker, value)
   WHERE serology.tenant_id = $1::uuid
     AND patient.patient_uid = ANY($2::uuid[])
     AND observation.value IS NOT NULL
     AND observation.value <> 'na'
),
evidence AS (
  SELECT * FROM marker_evidence
  UNION ALL
  SELECT * FROM serology_evidence
)
SELECT requested.patient_uid::text AS patient_uid,
       CURRENT_TIMESTAMP AS as_of,
       COALESCE(roster.hbsag_positive, false) AS hbsag_positive,
       COALESCE(roster.hcv_positive, false) AS hcv_positive,
       COALESCE(roster.hiv_positive, false) AS hiv_positive,
       evidence.marker_row_id,
       evidence.marker,
       evidence.result,
       evidence.tested_on,
       evidence.source
  FROM requested
  LEFT JOIN roster USING (patient_uid)
  LEFT JOIN evidence USING (patient_uid)
 ORDER BY requested.patient_uid, evidence.tested_on DESC NULLS LAST,
          evidence.marker, evidence.marker_row_id DESC NULLS LAST`;

function requestError(message) {
  return AppError.badRequest(message, 'DIALYSIS_ISOLATION_REQUEST_INVALID');
}

function unsupportedVersion() {
  return AppError.serviceUnavailable(
    'Dialysis isolation resolver contract version is unsupported',
    'RPD_ISOLATION_CONTRACT_VERSION_UNSUPPORTED',
  );
}

function requireUuid(value, label) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw requestError(`${label} must be a UUID`);
  return text;
}

function isoDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function isoInstant(value) {
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function positiveLegacyMarkers(row) {
  return CORE_MARKERS.filter((marker) => row[`${marker}_positive`] === true);
}

function markerDetail(row) {
  return {
    marker: row.marker,
    result: row.result,
    tested_on: isoDate(row.tested_on),
    marker_row_id: row.marker_row_id == null ? null : Number(row.marker_row_id),
    source: row.source,
  };
}

function latestEvidencePerMarker(rows) {
  const latest = new Map();
  for (const row of rows) {
    const current = latest.get(row.marker);
    if (!current) {
      latest.set(row.marker, row);
      continue;
    }
    const rowDate = isoDate(row.tested_on) ?? '';
    const currentDate = isoDate(current.tested_on) ?? '';
    if (rowDate > currentDate
      || (rowDate === currentDate
        && (RESULT_PRECEDENCE[row.result] ?? 0) > (RESULT_PRECEDENCE[current.result] ?? 0))) {
      latest.set(row.marker, row);
    }
  }
  return latest;
}

function computeDecision(rows, { includeMarkers, includeIsolationClass }) {
  const first = rows[0];
  const evidenceRows = rows.filter((row) => CORE_MARKERS.includes(row.marker));
  const reactiveMarkers = new Set(
    evidenceRows.filter((row) => row.result === REACTIVE).map((row) => row.marker),
  );
  const legacyMarkers = positiveLegacyMarkers(first);
  const restrictingMarkers = new Set([...reactiveMarkers, ...legacyMarkers]);
  const latestEvidence = latestEvidencePerMarker(evidenceRows);

  let status;
  if (restrictingMarkers.size > 0) {
    status = 'restricted';
  } else {
    status = CORE_MARKERS.every((marker) => latestEvidence.get(marker)?.result === NON_REACTIVE)
      ? 'clear'
      : 'unknown';
  }

  const datedEvidence = evidenceRows
    .map((row) => isoDate(row.tested_on))
    .filter(Boolean)
    .sort();
  const decision = {
    contract_version: CONTRACT_VERSION,
    status,
    asOf: isoInstant(first.as_of),
    reasons: [...restrictingMarkers].sort().map((marker) => REASON_BY_MARKER[marker]),
    evidence: reactiveMarkers.size > 0 || (status !== 'restricted' && evidenceRows.length > 0)
      ? 'marker'
      : (legacyMarkers.length > 0 ? 'legacy_declaration' : 'none'),
    evidence_dated_on: datedEvidence.at(-1) ?? null,
  };

  if (includeMarkers) decision.markers = evidenceRows.map(markerDetail);
  if (includeIsolationClass) {
    decision.isolation_class = status !== 'restricted'
      ? null
      : (restrictingMarkers.size === 1 ? [...restrictingMarkers][0] : 'isolation_mixed');
  }
  return decision;
}

export async function resolveDialysisIsolation({
  tenantId,
  patientUids,
  db,
  contractVersion,
  includeMarkers = false,
  includeIsolationClass = false,
} = {}) {
  if (contractVersion !== CONTRACT_VERSION) throw unsupportedVersion();
  const tid = requireUuid(tenantId, 'tenantId');
  if (!Array.isArray(patientUids)) throw requestError('patientUids must be an array');
  if (!db || typeof db.$queryRawUnsafe !== 'function') throw requestError('db must be injected');

  const uids = [...new Set(patientUids.map((uid, index) => requireUuid(uid, `patientUids[${index}]`)))];
  if (uids.length === 0) return new Map();

  const rows = await db.$queryRawUnsafe(RESOLVER_SQL, tid, uids, CORE_MARKERS);
  const grouped = new Map(uids.map((uid) => [uid, []]));
  for (const row of rows) {
    const uid = String(row.patient_uid).toLowerCase();
    if (grouped.has(uid)) grouped.get(uid).push(row);
  }

  const decisions = new Map();
  for (const uid of uids) {
    const patientRows = grouped.get(uid);
    if (patientRows.length === 0) {
      throw AppError.internal(
        'Dialysis isolation resolver returned an incomplete population',
        'RPD_ISOLATION_DECISION_INVALID',
      );
    }
    decisions.set(uid, computeDecision(patientRows, { includeMarkers, includeIsolationClass }));
  }
  return decisions;
}

export const _internal = Object.freeze({
  CORE_MARKERS,
  RESOLVER_SQL,
  computeDecision,
  latestEvidencePerMarker,
});
