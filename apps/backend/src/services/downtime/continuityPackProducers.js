// C3.1 continuity-pack source producers.
//
// This module deliberately has no Prisma singleton import. The caller must
// supply the tenant-scoped Prisma transaction created by setTenantTx with
// RepeatableRead isolation. Every cutoff is derived from that transaction's
// one database watermark, so a published set cannot mix source moments.

import { createHash } from 'node:crypto';

import { mergedPatientUidsSubquery } from '../clinical/mergedPatientReadUnion.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOSED_ED_STATUSES = [
  'discharged',
  'transferred',
  'left_against_advice',
  'lwbs',
  'expired',
  'archived',
];
const ACTIVE_ADMISSION_STATUSES = ['admitted', 'transferred', 'discharge_pending'];
const ACTIVE_ORDER_STATUSES = ['ordered', 'verified', 'in_progress', 'active'];
const DUE_MAR_STATUSES = ['scheduled', 'due', 'held'];
const ACKNOWLEDGED_TASK_STATUSES = ['in_progress', 'completed'];
const PACK_LOCATION_TYPES = Object.freeze({
  WARD: 'ward',
  PAEDS: 'paeds',
  ED: 'ed_board',
  OPD: 'opd_day',
});
const REQUIRED_SAFETY_FIELDS = Object.freeze([
  'identity.name',
  'identity.mrnOrUid',
  'identity.dateOfBirth',
  'allergies',
  'codeStatus',
  'medicationsDue',
  'activeMedicationOrders',
  'recentlyAdministeredMedications',
  'unresolvedCriticalResults',
]);
const REQUIRED_CONTEXT_FIELDS = Object.freeze([
  'bedLocation',
  'attendingDoctor',
  'diagnosisOrChiefComplaint',
  'latestVitals',
  'news2',
  'recentReleasedResults',
  'careTeam',
]);
const ALLERGY_UNKNOWN_TEXT = 'Allergy status UNKNOWN — not recorded';
const CODE_STATUS_UNKNOWN_TEXT = 'Code status NOT RECORDED — confirm per hospital policy';
const BLOOD_GROUP_KEYS = new Set([
  'abo',
  'abogroup',
  'abotype',
  'bloodgroup',
  'bloodtype',
  'rh',
  'rhfactor',
  'rhgroup',
  'rhtype',
  'rhesus',
  'rhesusfactor',
  'rhesusgroup',
  'rhesustype',
]);
const BLOOD_GROUP_DESCRIPTOR_PATTERN = /\b(?:blood[\s_-]*(?:group|type)|abo|rh|rhesus)\b/i;
const BLOOD_GROUP_VALUE_PATTERN =
  /^(?:ab|a|b|o)\s*(?:[+-]|pos(?:itive)?|neg(?:ative)?)$/i;

export class ContinuityPackCoverageError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ContinuityPackCoverageError';
    this.code = 'CONTINUITY_PACK_COVERAGE_FAILED';
    this.details = details;
  }
}

function coverageError(message, details = null) {
  return new ContinuityPackCoverageError(message, details);
}

function requireTx(tx) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw coverageError('A tenant-scoped Prisma transaction is required');
  }
  return tx;
}

function requireTenantId(value) {
  const tenantId = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(tenantId)) {
    throw coverageError('tenantId must be an explicit UUID');
  }
  if (tenantId === DEFAULT_TENANT_ID) {
    throw coverageError('The default tenant is forbidden for continuity-pack generation');
  }
  return tenantId;
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw coverageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeNumber(value, label, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (max != null && parsed > max)) {
    throw coverageError(`${label} is outside the approved policy range`);
  }
  return parsed;
}

function positiveNumber(value, label, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (max != null && parsed > max)) {
    throw coverageError(`${label} is outside the approved policy range`);
  }
  return parsed;
}

function nonBlank(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw coverageError(`${label} is required`);
  return normalized;
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const values = new Set(actual.map((value) => String(value)));
  return values.size === expected.length && expected.every((value) => values.has(value));
}

function iso(value, label = 'timestamp') {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw coverageError(`${label} is invalid`);
  return parsed.toISOString();
}

/**
 * Remove values that JSON cannot encode deterministically. PostgreSQL bigint
 * and Decimal values are represented as decimal strings; dates are UTC ISO.
 */
export function normalizeContinuityDbValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw coverageError('Non-finite database number cannot enter a pack');
    return value;
  }
  if (value instanceof Date) return iso(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw coverageError('Binary database values cannot enter a continuity pack');
  }
  if (Array.isArray(value)) return value.map(normalizeContinuityDbValue);
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype && prototype !== Object.prototype && typeof value.toString === 'function') {
      const decimal = value.toString();
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) return decimal;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeContinuityDbValue(entry)]),
    );
  }
  throw coverageError(`Unsupported database value type: ${typeof value}`);
}

function known(value, recordedAt, source, timestampBasis = 'source_recorded_at') {
  return {
    state: 'known',
    value: normalizeContinuityDbValue(value),
    recorded_at: iso(recordedAt),
    source,
    timestamp_basis: timestampBasis,
  };
}

function knownAtWatermark(value, watermark, source) {
  return known(value, watermark.captured_at, source, 'snapshot_watermark');
}

function knownQueriedList(value, sourceRows, watermark, source) {
  if (!sourceRows.length) return knownAtWatermark(value, watermark, source);
  return known(value, latestTimestamp(sourceRows, watermark.captured_at, source), source);
}

function unknown(reason, source = null) {
  return {
    state: 'unknown',
    value: null,
    recorded_at: null,
    source,
    timestamp_basis: 'not_available',
    reason,
  };
}

function latestTimestamp(rows, fallback, source) {
  if (!rows?.length) return iso(fallback, `${source || 'source'} watermark`);
  let latest = null;
  for (const row of rows) {
    const candidate = row?.recorded_at ?? row?.updated_at ?? row?.created_at ?? null;
    if (!candidate) {
      throw coverageError('A non-empty safety field is missing its source recorded time', {
        affected_item_count: rows.length,
        reason: 'missing_source_recorded_at',
        source,
      });
    }
    const time = new Date(candidate).getTime();
    if (!Number.isFinite(time)) {
      throw coverageError('A non-empty safety field has an invalid source recorded time', {
        affected_item_count: rows.length,
        reason: 'missing_source_recorded_at',
        source,
      });
    }
    if (latest == null || time > latest) latest = time;
  }
  return new Date(latest).toISOString();
}

function containsBloodGroupData(value, seen = new Set(), depth = 0) {
  if (depth > 32) {
    throw coverageError('Clinical result nesting exceeds the blood-group screening limit', {
      affected_item_count: 1,
      reason: 'blood_group_screening_depth_exceeded',
    });
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return false;
  if (typeof value === 'string') {
    return BLOOD_GROUP_DESCRIPTOR_PATTERN.test(value) || BLOOD_GROUP_VALUE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsBloodGroupData(entry, seen, depth + 1));
  }
  if (typeof value !== 'object' || value instanceof Date) {
    if (value instanceof Date) return false;
    throw coverageError('Clinical result cannot be evaluated for blood-group exclusion', {
      affected_item_count: 1,
      reason: 'unsupported_blood_group_screening_value',
    });
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw coverageError('Clinical result cannot be evaluated for blood-group exclusion', {
      affected_item_count: 1,
      reason: 'binary_blood_group_screening_value',
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw coverageError('Clinical result cannot be evaluated for blood-group exclusion', {
      affected_item_count: 1,
      reason: 'unsupported_blood_group_screening_object',
    });
  }
  if (seen.has(value)) {
    throw coverageError('Clinical result cannot be evaluated for blood-group exclusion', {
      affected_item_count: 1,
      reason: 'cyclic_blood_group_screening_value',
    });
  }
  seen.add(value);
  try {
    return Object.entries(value).some(([key, entry]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      return (
        BLOOD_GROUP_KEYS.has(normalizedKey)
        || BLOOD_GROUP_DESCRIPTOR_PATTERN.test(key)
        || containsBloodGroupData(entry, seen, depth + 1)
      );
    });
  } finally {
    seen.delete(value);
  }
}

function excludeBloodGroupClinicalItems(rows) {
  return rows.filter((row) => !containsBloodGroupData({
    item_code: row.item_code,
    item_name: row.item_name,
    value_snapshot: row.value_snapshot,
  }));
}

function addHours(timestamp, hours) {
  return new Date(new Date(timestamp).getTime() + (hours * 60 * 60 * 1000)).toISOString();
}

function addMinutes(timestamp, minutes) {
  return new Date(new Date(timestamp).getTime() + (minutes * 60 * 1000)).toISOString();
}

function normalizeCoverageEntry(raw, kind, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw coverageError(`requiredCoverage.${kind}[${index}] must be an object`);
  }
  const locationIdentifier = String(
    raw.locationIdentifier ?? raw.location_identifier ?? '',
  ).trim();
  const label = String(raw.label ?? raw.locationLabel ?? raw.location_label ?? '').trim() || null;

  if (kind === 'wards' || kind === 'paediatricWards') {
    const wardId = positiveInt(raw.wardId ?? raw.ward_id, `${kind}[${index}].wardId`);
    return {
      wardId,
      locationIdentifier: locationIdentifier || `ward-${wardId}`,
      label,
    };
  }
  if (kind === 'edBoards') {
    return {
      locationIdentifier: nonBlank(locationIdentifier, `edBoards[${index}].locationIdentifier`),
      label,
    };
  }
  if (kind === 'opdClinicDays') {
    const queueIdsRaw = raw.queueIds ?? raw.queue_ids ?? [];
    if (!Array.isArray(queueIdsRaw)) {
      throw coverageError(`opdClinicDays[${index}].queueIds must be an array`);
    }
    const queueIds = queueIdsRaw.map((id, queueIndex) => (
      positiveInt(id, `opdClinicDays[${index}].queueIds[${queueIndex}]`)
    ));
    if (new Set(queueIds).size !== queueIds.length) {
      throw coverageError(`opdClinicDays[${index}].queueIds contains duplicates`);
    }
    return {
      locationIdentifier: nonBlank(
        locationIdentifier,
        `opdClinicDays[${index}].locationIdentifier`,
      ),
      queueIds,
      label,
    };
  }
  throw coverageError(`Unsupported continuity coverage kind: ${kind}`);
}

function normalizePolicy(policy, tenantId, facilityId) {
  const document = policy?.policyDocument ?? policy?.policy_document ?? policy;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw coverageError('A normalized signed continuity policy document is required');
  }
  if (
    document.policyType !== 'clinical_continuity_pack' ||
    ![1, 2, 3].includes(document.policySchemaVersion)
  ) {
    throw coverageError('Unsupported continuity policy type or schema version');
  }
  const packSchemaVersion = positiveInt(document.packSchemaVersion, 'packSchemaVersion');
  if (![1, 2].includes(packSchemaVersion)) {
    throw coverageError('Unsupported continuity pack schema version');
  }
  if (packSchemaVersion === 2 && document.policySchemaVersion !== 3) {
    throw coverageError('Continuity pack schema v2 requires action-policy schema v3');
  }
  if (
    String(document.audience?.tenantId || '').toLowerCase() !== tenantId
    || Number(document.audience?.facilityId) !== facilityId
  ) {
    throw coverageError('Continuity policy audience does not match the requested tenant/facility');
  }

  const generation = document.generation || {};
  if (
    Number(generation.intervalMinutes) !== 15
    || Number(generation.hardExpiryHours) !== 24
    || generation.historicalMode !== false
  ) {
    throw coverageError('Continuity policy does not preserve the C-D2 freshness contract');
  }
  const recentLookback = Number(document.fieldPolicy?.recentlyAdministeredLookbackHours);
  if (recentLookback !== 12) {
    throw coverageError('Recently administered medication lookback must be exactly 12 hours');
  }
  const fieldPolicy = document.fieldPolicy || {};
  if (
    fieldPolicy.allergyUnknownText !== ALLERGY_UNKNOWN_TEXT
    || fieldPolicy.codeStatusUnknownText !== CODE_STATUS_UNKNOWN_TEXT
    || !sameStringSet(fieldPolicy.safetyFields, REQUIRED_SAFETY_FIELDS)
    || !sameStringSet(fieldPolicy.contextFields, REQUIRED_CONTEXT_FIELDS)
    || fieldPolicy.safetyFieldRecordedAtRequired !== true
    || fieldPolicy.bloodGroupIncluded !== false
    || fieldPolicy.isolationSource !== 'structured_only'
    || fieldPolicy.paediatricWeightRequired !== true
    || fieldPolicy.opdDestroyAfterClinicDay !== true
  ) {
    throw coverageError('Continuity field policy does not preserve the C-D2 dataset floor');
  }

  const dueWindow = document.medicationsDueWindow || {};
  const dueLookbackHours = nonNegativeNumber(
    dueWindow.lookbackHours,
    'medicationsDueWindow.lookbackHours',
    24,
  );
  const dueLookaheadHours = positiveNumber(
    dueWindow.lookaheadHours,
    'medicationsDueWindow.lookaheadHours',
    48,
  );
  const released = document.recentReleasedResults || {};
  const resultLookbackHours = positiveNumber(
    released.lookbackHours,
    'recentReleasedResults.lookbackHours',
    720,
  );
  const resultLimit = positiveInt(released.maxPerPatient, 'recentReleasedResults.maxPerPatient');
  if (resultLimit > 100) {
    throw coverageError('recentReleasedResults.maxPerPatient exceeds 100');
  }
  const releaseDelayHours = nonNegativeNumber(
    released.portalReleaseDelayHours,
    'recentReleasedResults.portalReleaseDelayHours',
    720,
  );
  if (!Array.isArray(released.itemCodeAllowlist) || !released.itemCodeAllowlist.length) {
    throw coverageError('recentReleasedResults.itemCodeAllowlist must be non-empty');
  }
  const resultItemCodeAllowlist = released.itemCodeAllowlist.map((code, index) => (
    nonBlank(code, `recentReleasedResults.itemCodeAllowlist[${index}]`)
  ));
  if (new Set(resultItemCodeAllowlist).size !== resultItemCodeAllowlist.length) {
    throw coverageError('recentReleasedResults.itemCodeAllowlist contains duplicates');
  }

  const coverage = document.requiredCoverage || {};
  const allowedCoverageKeys = new Set([
    'wards',
    'paediatricWards',
    'edBoards',
    'opdClinicDays',
  ]);
  for (const [key, value] of Object.entries(coverage)) {
    if (!allowedCoverageKeys.has(key) && Array.isArray(value) && value.length) {
      throw coverageError(`Unsupported required coverage area: ${key}`);
    }
  }
  const requiredCoverage = {};
  for (const key of allowedCoverageKeys) {
    if (!Array.isArray(coverage[key])) {
      throw coverageError(`requiredCoverage.${key} must be an array`);
    }
    requiredCoverage[key] = coverage[key].map((entry, index) => (
      normalizeCoverageEntry(entry, key, index)
    ));
  }

  const included = document.includedAreas || {};
  const inclusionMap = {
    wards: 'wards',
    paediatrics: 'paediatricWards',
    ed: 'edBoards',
    opd: 'opdClinicDays',
  };
  for (const [flag, coverageKey] of Object.entries(inclusionMap)) {
    if (typeof included[flag] !== 'boolean') {
      throw coverageError(`includedAreas.${flag} must be boolean`);
    }
    if (included[flag] !== (requiredCoverage[coverageKey].length > 0)) {
      throw coverageError(
        `includedAreas.${flag} does not match requiredCoverage.${coverageKey}`,
      );
    }
  }
  if (requiredCoverage.edBoards.length > 1) {
    throw coverageError('The current ED source supports one complete facility board only');
  }

  const policyVersion = String(policy?.policyVersion ?? policy?.policy_version ?? '');
  if (!/^[1-9]\d*$/.test(policyVersion)) {
    throw coverageError('A positive decimal policy version is required');
  }
  const policyVersionId = String(policy?.id ?? policy?.policyVersionId ?? '');
  if (!UUID_PATTERN.test(policyVersionId)) {
    throw coverageError('A policy version UUID is required');
  }
  const revocationEpoch = String(policy?.revocationEpoch ?? policy?.revocation_epoch ?? '');
  if (!/^(?:0|[1-9]\d*)$/.test(revocationEpoch)) {
    throw coverageError('A non-negative decimal revocation epoch is required');
  }
  const policyChecksum = String(policy?.policyChecksum ?? policy?.policy_checksum ?? '');
  let policyDelivery = null;
  if (packSchemaVersion === 2) {
    const delivery = policy?.policyDelivery;
    const computedEnvelopeSha256 = typeof delivery?.canonicalBody === 'string'
      ? createHash('sha256').update(delivery.canonicalBody, 'utf8').digest('hex')
      : null;
    if (
      !/^[a-f0-9]{64}$/.test(policyChecksum) ||
      !delivery ||
      delivery.envelopeFormat !== 'vhhealth_clinical_continuity_policy_delivery/v1' ||
      delivery.mediaType !== 'application/vnd.vhhealth.clinical-continuity-policy+json' ||
      !/^[a-f0-9]{64}$/.test(String(delivery.envelopeSha256 || '')) ||
      delivery.envelopeSha256 !== computedEnvelopeSha256 ||
      typeof delivery.canonicalBody !== 'string' ||
      Buffer.byteLength(delivery.canonicalBody, 'utf8') > 256 * 1024
    ) {
      throw coverageError('Continuity pack schema v2 requires verified policy delivery bytes');
    }
    policyDelivery = Object.freeze({
      envelope_base64: Buffer.from(delivery.canonicalBody, 'utf8').toString('base64'),
      envelope_format: delivery.envelopeFormat,
      envelope_sha256: delivery.envelopeSha256,
      media_type: delivery.mediaType,
    });
  }

  return Object.freeze({
    document,
    packSchemaVersion,
    policyChecksum,
    policyDelivery,
    policyVersion,
    policyVersionId,
    revocationEpoch,
    requiredCoverage,
    dueLookbackHours,
    dueLookaheadHours,
    recentlyAdministeredLookbackHours: recentLookback,
    resultLookbackHours,
    resultLimit,
    releaseDelayHours,
    resultItemCodeAllowlist,
  });
}

/**
 * Capture one database-authored source watermark from the caller's existing
 * transaction. Read Committed is rejected because later statements could
 * observe a different source snapshot.
 */
export async function captureContinuitySourceWatermark(tx) {
  requireTx(tx);
  const rows = await tx.$queryRawUnsafe(
    `/* continuity:watermark */
     SELECT transaction_timestamp() AS captured_at,
            txid_current_snapshot()::text AS txid_snapshot,
            txid_current()::text AS transaction_id,
            current_setting('transaction_isolation') AS transaction_isolation`,
  );
  const row = rows[0];
  if (!row?.captured_at || !row?.txid_snapshot) {
    throw coverageError('Database source watermark is unavailable');
  }
  const isolation = String(row.transaction_isolation || '').trim().toLowerCase();
  if (!['repeatable read', 'serializable'].includes(isolation)) {
    throw coverageError('Continuity generation requires RepeatableRead isolation');
  }
  return Object.freeze({
    captured_at: iso(row.captured_at, 'source watermark'),
    txid_snapshot: String(row.txid_snapshot),
    transaction_id: String(row.transaction_id),
    transaction_isolation: isolation,
  });
}

async function loadFacility(tx, tenantId, facilityId) {
  const rows = await tx.$queryRawUnsafe(
    `/* continuity:facility */
     SELECT id, tenant_id, facility_code, display_name, timezone, status
       FROM facilities
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tenantId,
    facilityId,
  );
  const row = rows[0];
  if (!row) throw coverageError('Policy facility does not belong to the tenant');
  if (String(row.status).toLowerCase() !== 'active') {
    throw coverageError('Continuity generation refuses an inactive facility');
  }
  const timeZone = nonBlank(row.timezone, 'facility timezone');
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(new Date(0));
  } catch {
    throw coverageError('Facility timezone is not a valid IANA zone');
  }
  return Object.freeze({
    id: String(row.id),
    code: row.facility_code,
    name: row.display_name,
    timezone: timeZone,
  });
}

function rowsBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const value = row?.[key];
    if (value == null) continue;
    const normalized = String(value);
    const bucket = map.get(normalized) || [];
    bucket.push(row);
    map.set(normalized, bucket);
  }
  return map;
}

function firstBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    if (row?.[key] == null) continue;
    const normalized = String(row[key]);
    if (!map.has(normalized)) map.set(normalized, row);
  }
  return map;
}

function emptyClinicalFields(watermark) {
  return {
    allergies: unknown('Allergy status is not recorded', 'allergy_sources'),
    code_status: unknown('Code status is not recorded', 'code_status_sources'),
    isolation: knownAtWatermark(
      { required: false, status: 'none' },
      watermark,
      'isolation_orders',
    ),
    latest_vitals: unknown('No vitals are recorded', 'vitals_chart'),
    news2: unknown('No NEWS2 score is recorded', 'news2_scores'),
    medications_due: knownAtWatermark([], watermark, 'medication_administrations'),
    active_medication_orders: knownAtWatermark([], watermark, 'clinical_orders'),
    recently_administered_medications: knownAtWatermark(
      [],
      watermark,
      'medication_administrations',
    ),
    unresolved_critical_results: knownAtWatermark([], watermark, 'critical_result_rails'),
    recent_released_results: knownAtWatermark([], watermark, 'diagnostic_release_rails'),
    care_team: knownAtWatermark([], watermark, 'care_team_members'),
  };
}

async function loadPatientClinicalFields({
  tx,
  tenantId,
  patientRefs,
  policy,
  watermark,
}) {
  const patientUids = [
    ...new Set(patientRefs.map((ref) => ref.patientUid).filter(Boolean).map(String)),
  ];
  const fields = new Map();
  for (const uid of patientUids) fields.set(uid, emptyClinicalFields(watermark));
  if (!patientUids.length) return fields;

  const identities = await tx.$queryRawUnsafe(
    `/* continuity:patient-identities */
     SELECT u.id AS patient_id, u.uid AS patient_uid, u.name, u.birthday,
            u.phone, u.is_unidentified, u.identity_source, u.updated_at,
            identifier.identifier_value AS mrn,
            identifier.updated_at AS mrn_recorded_at
       FROM users AS u
       LEFT JOIN LATERAL (
         SELECT pi.identifier_value, pi.updated_at
           FROM patient_identifiers AS pi
          WHERE pi.tenant_id = u.tenant_id
            AND pi.patient_uid = u.uid
            AND pi.status = 'active'
            AND LOWER(pi.identifier_type) IN ('mrn', 'medical_record_number')
          ORDER BY pi.is_primary DESC, pi.assigned_at DESC NULLS LAST, pi.id DESC
          LIMIT 1
      ) AS identifier ON TRUE
      WHERE u.tenant_id = $1::uuid
        AND u.uid = ANY($2::uuid[])
        AND UPPER(COALESCE(u.role, '')) = 'PATIENT'`,
    tenantId,
    patientUids,
  );
  const identityByUid = firstBy(identities, 'patient_uid');
  for (const uid of patientUids) {
    if (!identityByUid.has(uid)) {
      throw coverageError('A referenced patient cannot be resolved in the pinned tenant', {
        affected_patient_count: 1,
        reason: 'patient_identity_not_found',
      });
    }
  }

  const ambiguousAdmissions = await tx.$queryRawUnsafe(
    `/* continuity:active-admission-ambiguity */
     SELECT patient_uid, COUNT(*)::int AS active_admission_count
       FROM admissions
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND COALESCE(status, 'admitted') = ANY($3::text[])
      GROUP BY patient_uid
     HAVING COUNT(*) > 1
      ORDER BY patient_uid
      LIMIT 20`,
    tenantId,
    patientUids,
    ACTIVE_ADMISSION_STATUSES,
  );
  if (ambiguousAdmissions.length) {
    throw coverageError('Patient has multiple active admissions; safety context is ambiguous', {
      affected_patient_count: ambiguousAdmissions.length,
      reason: 'multiple_active_admissions',
    });
  }

  // One statement covers all four existing allergy stores. Any source/schema
  // failure aborts generation; an empty result is UNKNOWN, never NKDA.
  const allergyRows = await tx.$queryRawUnsafe(
    `/* continuity:allergies */
     WITH target AS (
       SELECT id, uid, allergies, updated_at
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = ANY($2::uuid[])
     ),
     allergy_rows AS (
       SELECT t.uid AS patient_uid, pa.allergy_name AS allergen,
              pa.severity, pa.reaction, 'patient_allergies'::text AS source,
              pa.created_at AS recorded_at
         FROM target AS t
         JOIN patient_allergies AS pa
           ON pa.tenant_id = $1::uuid
          AND (pa.patient_uid = t.uid OR pa.patient_id = t.id)
        WHERE COALESCE(pa.is_active, TRUE)
       UNION ALL
       SELECT t.uid, COALESCE(NULLIF(a.allergen, ''), a.name), a.severity,
              a.reaction, 'allergies', COALESCE(a.recorded_at, a.created_at)
         FROM target AS t
         JOIN allergies AS a
           ON a.tenant_id = $1::uuid
          AND a.patient_uid = t.uid
        WHERE COALESCE(a.status, 'active') NOT IN
              ('inactive', 'resolved', 'entered-in-error')
       UNION ALL
       SELECT t.uid, BTRIM(profile.value), NULL, NULL, 'users.allergies',
              t.updated_at
         FROM target AS t
         CROSS JOIN LATERAL regexp_split_to_table(
           COALESCE(t.allergies, ''),
           ','
         ) AS profile(value)
        WHERE BTRIM(profile.value) <> ''
       UNION ALL
       SELECT t.uid, BTRIM(intake.value), NULL, NULL, 'admission_intake',
              intake.updated_at
         FROM target AS t
         CROSS JOIN LATERAL (
           SELECT value, latest.updated_at
             FROM (
               SELECT a.allergies, a.updated_at
                 FROM admissions AS a
                WHERE a.tenant_id = $1::uuid
                  AND a.patient_uid = t.uid
                  AND COALESCE(a.status, 'admitted') = ANY($3::text[])
                ORDER BY a.created_at DESC
                LIMIT 1
             ) AS latest
             CROSS JOIN LATERAL unnest(
               COALESCE(latest.allergies, ARRAY[]::text[])
             ) AS value
         ) AS intake
        WHERE BTRIM(intake.value) <> ''
     )
     SELECT patient_uid, allergen, severity, reaction, source, recorded_at
       FROM allergy_rows
      WHERE NULLIF(BTRIM(allergen), '') IS NOT NULL
      ORDER BY patient_uid, LOWER(allergen), recorded_at DESC NULLS LAST`,
    tenantId,
    patientUids,
    ACTIVE_ADMISSION_STATUSES,
  );

  const codeRows = await tx.$queryRawUnsafe(
    `/* continuity:code-status */
     WITH active_admission AS (
       SELECT DISTINCT ON (a.patient_uid)
              a.id, a.patient_uid, a.code_status, a.created_at, a.updated_at
         FROM admissions AS a
        WHERE a.tenant_id = $1::uuid
          AND a.patient_uid = ANY($2::uuid[])
          AND COALESCE(a.status, 'admitted') = ANY($3::text[])
        ORDER BY a.patient_uid, a.created_at DESC, a.id DESC
     ),
     candidates AS (
       SELECT icu.patient_uid, icu.code_status, icu.code_status_set_at AS recorded_at,
              'icu_admissions'::text AS source, 1 AS source_rank
         FROM icu_admissions AS icu
        WHERE icu.tenant_id = $1::uuid
          AND icu.patient_uid = ANY($2::uuid[])
          AND icu.status = 'active'
          AND icu.code_status_set_at IS NOT NULL
       UNION ALL
       SELECT a.patient_uid,
              COALESCE(
                event.payload->>'new',
                event.event_subtype,
                a.code_status
              ) AS code_status,
              event.occurred_at,
              'clinical_timeline_events'::text,
              2
         FROM active_admission AS a
         JOIN LATERAL (
           -- Merged-uid union: the code-status event may predate a patient
           -- merge and stay recorded under a uid merged into this patient
           -- (append-only timeline is never re-pointed).
           SELECT timeline.payload, timeline.event_subtype, timeline.occurred_at
             FROM clinical_timeline_events AS timeline
            WHERE timeline.tenant_id = $1::uuid
              AND timeline.patient_uid IN (
                ${mergedPatientUidsSubquery('$1::uuid', 'a.patient_uid')}
              )
              AND timeline.source_table = 'admissions'
              AND timeline.source_id = a.id::text
              AND timeline.event_type = 'admission.code_status_updated'
            ORDER BY timeline.occurred_at DESC, timeline.created_at DESC
            LIMIT 1
         ) AS event ON TRUE
       UNION ALL
       SELECT a.patient_uid, a.code_status, a.created_at,
              'admissions.explicit_nondefault'::text, 3
         FROM active_admission AS a
        WHERE LOWER(COALESCE(a.code_status, '')) <> 'full_code'
     )
     SELECT DISTINCT ON (patient_uid)
            patient_uid, code_status, recorded_at, source
       FROM candidates
      WHERE NULLIF(BTRIM(code_status), '') IS NOT NULL
      ORDER BY patient_uid, source_rank, recorded_at DESC`,
    tenantId,
    patientUids,
    ACTIVE_ADMISSION_STATUSES,
  );

  const isolationRows = await tx.$queryRawUnsafe(
    `/* continuity:isolation */
     SELECT patient_uid, precaution_type, status, ordered_at AS recorded_at
       FROM isolation_orders
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND status = 'active'
      ORDER BY patient_uid, ordered_at DESC, id DESC`,
    tenantId,
    patientUids,
  );

  const vitalRows = await tx.$queryRawUnsafe(
    `/* continuity:vitals */
     SELECT DISTINCT ON (patient_uid)
            patient_uid, systolic_bp, diastolic_bp, heart_rate,
            respiratory_rate, spo2, temperature, weight_kg, recorded_at
      FROM vitals_chart
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND recorded_at <= $3::timestamptz
      ORDER BY patient_uid, recorded_at DESC NULLS LAST, id DESC`,
    tenantId,
    patientUids,
    watermark.captured_at,
  );

  const weightRows = await tx.$queryRawUnsafe(
    `/* continuity:weights */
     SELECT DISTINCT ON (patient_uid)
            patient_uid, weight_kg, recorded_at
       FROM vitals_chart
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND weight_kg IS NOT NULL
        AND recorded_at <= $3::timestamptz
      ORDER BY patient_uid, recorded_at DESC NULLS LAST, id DESC`,
    tenantId,
    patientUids,
    watermark.captured_at,
  );

  const newsRows = await tx.$queryRawUnsafe(
    `/* continuity:news2 */
     SELECT DISTINCT ON (patient_uid)
            patient_uid, total_score, clinical_risk, escalation_action,
            partial_score, missing_params, recorded_at
      FROM news2_scores
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND superseded_at IS NULL
        AND recorded_at <= $3::timestamptz
      ORDER BY patient_uid, recorded_at DESC, id DESC`,
    tenantId,
    patientUids,
    watermark.captured_at,
  );

  const marRows = await tx.$queryRawUnsafe(
    `/* continuity:mar */
     SELECT patient_uid, medication_name, dose, dosage, route,
            scheduled_time, administered_at, status, updated_at
       FROM medication_administrations
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND (
          (
            LOWER(COALESCE(status, 'scheduled')) = ANY($4::text[])
            AND scheduled_time >= $3::timestamptz
                - ($5::numeric * INTERVAL '1 hour')
            AND scheduled_time <= $3::timestamptz
                + ($6::numeric * INTERVAL '1 hour')
          )
          OR
          (
            LOWER(COALESCE(status, '')) = 'administered'
            AND administered_at > $3::timestamptz
                - ($7::numeric * INTERVAL '1 hour')
            AND administered_at <= $3::timestamptz
          )
        )
      ORDER BY patient_uid, COALESCE(scheduled_time, administered_at), id`,
    tenantId,
    patientUids,
    watermark.captured_at,
    DUE_MAR_STATUSES,
    policy.dueLookbackHours,
    policy.dueLookaheadHours,
    policy.recentlyAdministeredLookbackHours,
  );

  const orderRows = await tx.$queryRawUnsafe(
    `/* continuity:active-medication-orders */
     SELECT patient_uid, order_number,
            COALESCE(
              details->>'medication_name',
              details->>'name',
              details->>'drug_name'
            ) AS medication_name,
            COALESCE(details->>'dose', details->>'dosage') AS dose,
            COALESCE(details->>'route', route) AS route,
            status, created_at AS recorded_at
       FROM clinical_orders
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND LOWER(order_type) = 'medication'
        AND LOWER(status) = ANY($3::text[])
        AND (start_date IS NULL OR start_date <= $4::timestamptz)
        AND (end_date IS NULL OR end_date >= $4::timestamptz)
      ORDER BY patient_uid, created_at DESC, id DESC`,
    tenantId,
    patientUids,
    ACTIVE_ORDER_STATUSES,
    watermark.captured_at,
  );

  const criticalRows = await tx.$queryRawUnsafe(
    `/* continuity:unresolved-critical-results */
     WITH task_rails AS (
       SELECT task.patient_uid, task.related_resource_type AS source_kind,
              task.related_resource_id AS source_id, task.title AS item_name,
              NULL::text AS item_code,
              jsonb_build_object(
                'summary', task.title,
                'priority', task.priority,
                'status', task.status
              ) AS value_snapshot,
              task.created_at AS recorded_at
         FROM tasks AS task
         LEFT JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.patient_uid = ANY($2::uuid[])
          AND (
            task.metadata->>'sla_key' = 'critical_result_ack'
            OR sla.rule_code = 'critical_result_ack'
          )
          AND NOT (
            task.status = ANY($3::text[])
            AND NULLIF(task.metadata->>'acknowledged_at', '') IS NOT NULL
            AND NULLIF(task.metadata->>'acknowledged_by', '') IS NOT NULL
            AND CASE
              WHEN pg_input_is_valid(
                task.metadata->>'acknowledged_at',
                'timestamptz'
              )
              THEN (task.metadata->>'acknowledged_at')::timestamptz
                   <= $4::timestamptz
              ELSE FALSE
            END
            AND task.metadata->>'acknowledged_by'
                ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
       ),
       lab_rails AS (
         SELECT alert.patient_uid, 'lab_critical_alert'::text,
                alert.id::text, alert.test_name,
                COALESCE(result.loinc_code, result.test_code),
                jsonb_build_object(
                  'test_name', alert.test_name,
                  'result_value', COALESCE(
                    alert.value_text,
                    alert.value_numeric::text
                  ),
                  'unit', alert.unit,
                  'severity', 'critical'
                ),
                alert.fired_at
           FROM lab_critical_alerts AS alert
           JOIN lab_results AS result
             ON result.tenant_id = alert.tenant_id
            AND result.id = alert.result_id
            AND result.patient_uid = alert.patient_uid
          WHERE alert.tenant_id = $1::uuid
            AND alert.patient_uid = ANY($2::uuid[])
            AND alert.acknowledged_at IS NULL
            AND alert.superseded_at IS NULL
       ),
       vital_rails AS (
         SELECT patient.uid, 'clinical_alert'::text, alert.id::text,
                COALESCE(alert.vital_name, alert.alert_type, 'Clinical alert'),
                NULL::text,
                jsonb_build_object(
                  'name', COALESCE(
                    alert.vital_name,
                    alert.alert_type,
                    'Clinical alert'
                  ),
                  'result_value', alert.vital_value,
                  'severity', alert.severity
                ),
                alert.created_at
           FROM clinical_alerts AS alert
           JOIN users AS patient
             ON patient.tenant_id = alert.tenant_id
            AND patient.id = alert.patient_id
          WHERE alert.tenant_id = $1::uuid
            AND patient.uid = ANY($2::uuid[])
            AND UPPER(COALESCE(alert.severity, '')) = 'CRITICAL'
            AND COALESCE(alert.acknowledged, FALSE) = FALSE
            AND alert.acknowledged_at IS NULL
       )
     SELECT DISTINCT ON (patient_uid, source_kind, source_id)
            patient_uid, source_kind, source_id, item_name, item_code,
            value_snapshot, recorded_at
       FROM (
         SELECT * FROM task_rails
         UNION ALL SELECT * FROM lab_rails
         UNION ALL SELECT * FROM vital_rails
       ) AS unresolved
      WHERE LOWER(COALESCE(item_name, '')) !~ '(blood[ _-]*(group|type)|\\mabo\\M|\\mrh\\M)'
      ORDER BY patient_uid, source_kind, source_id, recorded_at DESC`,
    tenantId,
    patientUids,
    ACKNOWLEDGED_TASK_STATUSES,
    watermark.captured_at,
  );

  const releasedRows = await tx.$queryRawUnsafe(
    `/* continuity:recent-released-results */
     WITH current_generation AS (
       SELECT generation.*
         FROM diagnostic_result_generations AS generation
        WHERE generation.tenant_id = $1::uuid
          AND generation.patient_uid = ANY($2::uuid[])
          AND generation.signed_at > $3::timestamptz
              - ($4::numeric * INTERVAL '1 hour')
          AND generation.signed_at <= $3::timestamptz
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_generations AS successor
             WHERE successor.tenant_id = generation.tenant_id
               AND successor.predecessor_generation_id = generation.id
          )
     ),
     visible_generation AS (
       SELECT generation.id, generation.patient_uid, generation.source_kind,
              generation.signed_at
         FROM current_generation AS generation
         LEFT JOIN diagnostic_result_release_states AS release_state
           ON release_state.tenant_id = generation.tenant_id
          AND release_state.generation_id = generation.id
          AND release_state.patient_uid = generation.patient_uid
        WHERE (
          generation.source_kind = 'lab_panel'
          AND EXISTS (
            SELECT 1
              FROM diagnostic_result_generation_items AS lab_item
              JOIN lab_results AS result
                ON result.tenant_id = lab_item.tenant_id
               AND result.id::text = lab_item.source_row_id
             WHERE lab_item.tenant_id = generation.tenant_id
               AND lab_item.generation_id = generation.id
               AND lab_item.source_table = 'lab_results'
            HAVING COUNT(*) = generation.item_count
               AND COUNT(*) > 0
               AND BOOL_AND(
                 LOWER(COALESCE(result.status, '')) IN
                   ('final', 'corrected', 'verified', 'amended')
                 AND result.signed_off_at IS NOT NULL
                 AND result.release_hold = FALSE
                 AND (
                   (
                     result.released_to_patient_at IS NOT NULL
                     AND result.released_to_patient_at <= $3::timestamptz
                   )
                   OR result.signed_off_at <= $3::timestamptz
                      - ($5::numeric * INTERVAL '1 hour')
                 )
               )
          )
        )
        OR (
          generation.source_kind IN
            ('radiology_report', 'anatomical_pathology_report')
          AND release_state.generation_id IS NOT NULL
          AND release_state.release_hold = FALSE
          AND (
            generation.classification = 'normal'
            OR EXISTS (
              SELECT 1
                FROM diagnostic_result_actions AS action
               WHERE action.tenant_id = generation.tenant_id
                 AND action.generation_id = generation.id
                 AND action.action_kind = 'doctor_disposition'
            )
          )
          AND (
            (
              release_state.released_to_patient_at IS NOT NULL
              AND release_state.released_to_patient_at <= $3::timestamptz
            )
            OR generation.signed_at <= $3::timestamptz
               - ($5::numeric * INTERVAL '1 hour')
          )
        )
     ),
     ranked AS (
       SELECT visible.patient_uid, visible.id AS generation_id,
              visible.source_kind, visible.signed_at,
              item.item_code, item.item_name, item.value_snapshot,
              ROW_NUMBER() OVER (
                PARTITION BY visible.patient_uid
                ORDER BY visible.signed_at DESC, visible.id, item.source_ordinal
              ) AS result_rank
         FROM visible_generation AS visible
         JOIN diagnostic_result_generation_items AS item
           ON item.tenant_id = $1::uuid
          AND item.generation_id = visible.id
          AND item.patient_uid = visible.patient_uid
        WHERE item.item_code = ANY($6::text[])
          AND LOWER(item.item_name) !~ '(blood[ _-]*(group|type)|\\mabo\\M|\\mrh\\M)'
     )
     SELECT patient_uid, generation_id, source_kind, signed_at AS recorded_at,
            item_code, item_name, value_snapshot
       FROM ranked
      WHERE result_rank <= $7::int
      ORDER BY patient_uid, recorded_at DESC, generation_id, item_code`,
    tenantId,
    patientUids,
    watermark.captured_at,
    policy.resultLookbackHours,
    policy.releaseDelayHours,
    policy.resultItemCodeAllowlist,
    policy.resultLimit,
  );

  const careTeamRows = await tx.$queryRawUnsafe(
    `/* continuity:care-team */
     SELECT member.patient_uid, member.staff_uid,
            COALESCE(staff.name, member.member_name) AS member_name,
            member.staff_role AS role,
            member.relationship_kind AS relationship,
            member.active_from AS recorded_at
       FROM care_team_members AS member
       JOIN care_teams AS team
         ON team.tenant_id = member.tenant_id
        AND team.id = member.care_team_id
        AND team.patient_uid = member.patient_uid
       LEFT JOIN users AS staff
         ON staff.tenant_id = member.tenant_id
        AND staff.uid = member.staff_uid
      WHERE member.tenant_id = $1::uuid
        AND member.patient_uid = ANY($2::uuid[])
        AND member.status = 'active'
        AND team.status = 'active'
        AND member.active_from <= $3::timestamptz
        AND (
          member.active_until IS NULL
          OR member.active_until > $3::timestamptz
        )
      ORDER BY member.patient_uid, member.relationship_kind, member.id`,
    tenantId,
    patientUids,
    watermark.captured_at,
  );

  const eligibleCriticalRows = excludeBloodGroupClinicalItems(criticalRows);
  const eligibleReleasedRows = excludeBloodGroupClinicalItems(releasedRows);
  const allergiesByUid = rowsBy(allergyRows, 'patient_uid');
  const codeByUid = firstBy(codeRows, 'patient_uid');
  const isolationByUid = rowsBy(isolationRows, 'patient_uid');
  const vitalByUid = firstBy(vitalRows, 'patient_uid');
  const weightByUid = firstBy(weightRows, 'patient_uid');
  const newsByUid = firstBy(newsRows, 'patient_uid');
  const marByUid = rowsBy(marRows, 'patient_uid');
  const ordersByUid = rowsBy(orderRows, 'patient_uid');
  const criticalByUid = rowsBy(eligibleCriticalRows, 'patient_uid');
  const releasedByUid = rowsBy(eligibleReleasedRows, 'patient_uid');
  const careTeamByUid = rowsBy(careTeamRows, 'patient_uid');

  for (const uid of patientUids) {
    const target = fields.get(uid);
    const allergy = allergiesByUid.get(uid) || [];
    if (allergy.length) {
      const seen = new Map();
      for (const row of allergy) {
        const key = String(row.allergen).trim().toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, {
            allergen: row.allergen,
            severity: row.severity,
            reaction: row.reaction,
            sources: [row.source],
          });
        } else if (!seen.get(key).sources.includes(row.source)) {
          seen.get(key).sources.push(row.source);
        }
      }
      target.allergies = known(
        [...seen.values()],
        latestTimestamp(allergy, watermark.captured_at, 'allergy_sources'),
        'allergy_sources',
      );
    }

    const code = codeByUid.get(uid);
    if (code) {
      target.code_status = known(
        { status: code.code_status },
        code.recorded_at,
        code.source,
      );
    }

    const isolation = isolationByUid.get(uid) || [];
    if (isolation.length) {
      target.isolation = known(
        {
          required: true,
          status: 'active',
          precautions: isolation.map((row) => ({
            precaution_type: row.precaution_type,
            status: row.status,
          })),
          precaution_type: isolation.map((row) => row.precaution_type).join(', '),
        },
        latestTimestamp(isolation, watermark.captured_at, 'isolation_orders'),
        'isolation_orders',
      );
    }

    const vital = vitalByUid.get(uid);
    if (vital) {
      target.latest_vitals = known({
        systolic_bp: vital.systolic_bp,
        diastolic_bp: vital.diastolic_bp,
        heart_rate: vital.heart_rate,
        respiratory_rate: vital.respiratory_rate,
        spo2: vital.spo2,
        temperature: vital.temperature,
      }, vital.recorded_at, 'vitals_chart');
    }
    const weight = weightByUid.get(uid);
    target.latest_weight = weight
      ? known({ weight_kg: weight.weight_kg, unit: 'kg' }, weight.recorded_at, 'vitals_chart')
      : unknown('No weight is recorded', 'vitals_chart');

    const news = newsByUid.get(uid);
    if (news) {
      const partial = news.partial_score === true;
      target.news2 = known({
        score: news.total_score,
        clinical_risk: partial ? null : news.clinical_risk,
        escalation_action: partial ? null : news.escalation_action,
        partial_score: partial,
        missing_params: Array.isArray(news.missing_params) ? news.missing_params : [],
        risk_band_available: !partial,
        display: partial
          ? `NEWS2 ${news.total_score} (partial; risk band unavailable)`
          : `NEWS2 ${news.total_score}${news.clinical_risk ? ` (${String(news.clinical_risk).replace(/_/g, ' ')})` : ''}`,
      }, news.recorded_at, 'news2_scores');
    }

    const mar = marByUid.get(uid) || [];
    const due = mar.filter((row) => DUE_MAR_STATUSES.includes(
      String(row.status || 'scheduled').toLowerCase(),
    ));
    const recentlyAdministered = mar.filter((row) => (
      String(row.status || '').toLowerCase() === 'administered' && row.administered_at
    ));
    target.medications_due = knownQueriedList(
      due.map((row) => ({
        medication_name: row.medication_name,
        dose: row.dose ?? row.dosage,
        route: row.route,
        scheduled_time: row.scheduled_time,
        status: row.status,
        recorded_at: row.updated_at,
      })),
      due,
      watermark,
      'medication_administrations',
    );
    target.recently_administered_medications = knownQueriedList(
      recentlyAdministered.map((row) => ({
        medication_name: row.medication_name,
        dose: row.dose ?? row.dosage,
        route: row.route,
        administered_at: row.administered_at,
        status: row.status,
        recorded_at: row.administered_at,
      })),
      recentlyAdministered.map((row) => ({
        ...row,
        recorded_at: row.administered_at,
      })),
      watermark,
      'medication_administrations',
    );

    const orders = ordersByUid.get(uid) || [];
    target.active_medication_orders = knownQueriedList(
      orders.map((row) => ({
        order_number: row.order_number,
        medication_name: row.medication_name || 'Medication name unavailable',
        dose: row.dose,
        route: row.route,
        status: row.status,
        recorded_at: row.recorded_at,
      })),
      orders,
      watermark,
      'clinical_orders',
    );

    const critical = criticalByUid.get(uid) || [];
    target.unresolved_critical_results = knownQueriedList(
      critical.map((row) => ({
        source_kind: row.source_kind,
        source_id: String(row.source_id),
        item_code: row.item_code,
        item_name: row.item_name,
        ...normalizeContinuityDbValue(row.value_snapshot || {}),
        recorded_at: row.recorded_at,
      })),
      critical,
      watermark,
      'critical_result_rails',
    );

    const releasedResults = releasedByUid.get(uid) || [];
    target.recent_released_results = knownQueriedList(
      releasedResults.map((row) => ({
        generation_id: String(row.generation_id),
        source_kind: row.source_kind,
        item_code: row.item_code,
        item_name: row.item_name,
        value_snapshot: normalizeContinuityDbValue(row.value_snapshot),
        recorded_at: row.recorded_at,
      })),
      releasedResults,
      watermark,
      'diagnostic_release_rails',
    );

    const careTeam = careTeamByUid.get(uid) || [];
    target.care_team = knownQueriedList(
      careTeam.map((row) => ({
        staff_uid: row.staff_uid,
        member_name: row.member_name || 'Name unavailable',
        role: row.role,
        relationship: row.relationship,
        recorded_at: row.recorded_at,
      })),
      careTeam,
      watermark,
      'care_team_members',
    );
  }

  return fields;
}

function identityFor(ref, identity, watermark) {
  if (!identity && ref.patientUid) {
    throw coverageError('Patient identity row is missing', {
      affected_patient_count: 1,
      reason: 'patient_identity_row_missing',
    });
  }
  const unidentified = identity?.is_unidentified === true || !ref.patientUid;
  const sourceRecordedAt = identity?.updated_at || ref.recordedAt || watermark.captured_at;
  const displayName = identity?.name || ref.fallbackName || null;
  return known({
    name: displayName
      ? known(
        unidentified ? `TEMPORARY / UNIDENTIFIED — ${displayName}` : displayName,
        sourceRecordedAt,
        identity ? 'users.name' : ref.source,
      )
      : unknown('Patient name is unavailable', ref.source),
    mrn: identity?.mrn
      ? known(identity.mrn, identity.mrn_recorded_at || sourceRecordedAt, 'patient_identifiers')
      : unknown('MRN is unavailable', 'patient_identifiers'),
    uid: ref.patientUid
      ? known(ref.patientUid, sourceRecordedAt, 'users.uid')
      : unknown('Permanent patient UID is unavailable', ref.source),
    dob: identity?.birthday
      ? known(identity.birthday, sourceRecordedAt, 'users.birthday')
      : unknown('Date of birth is unavailable', identity ? 'users.birthday' : ref.source),
    identity_status: unidentified ? 'temporary_or_unidentified' : 'identified',
  }, sourceRecordedAt, identity ? 'users' : ref.source);
}

async function resolveAttendingNames(tx, tenantId, patientRefs) {
  const uids = [
    ...new Set(patientRefs.map((ref) => ref.attendingUid).filter(Boolean).map(String)),
  ];
  if (!uids.length) return new Map();
  const rows = await tx.$queryRawUnsafe(
    `/* continuity:attending-names */
     SELECT uid, name, updated_at
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = ANY($2::uuid[])`,
    tenantId,
    uids,
  );
  return firstBy(rows, 'uid');
}

function buildPatient({
  ref,
  identity,
  clinical,
  attending,
  watermark,
  location,
  areaType,
}) {
  const unresolvedPatient = !clinical;
  const patient = {
    identity: identityFor(ref, identity, watermark),
    allergies: clinical?.allergies ?? unknown('Allergy status is not recorded'),
    code_status: clinical?.code_status ?? unknown('Code status is not recorded'),
    isolation: clinical?.isolation
      ?? unknown('Isolation status cannot be resolved without a patient identity', 'isolation_orders'),
    location: known(location, ref.locationRecordedAt || watermark.captured_at, ref.source),
    attending: attending?.name
      ? known(
        { name: attending.name, display: attending.name },
        ref.attendingRecordedAt || attending.updated_at || watermark.captured_at,
        ref.attendingSource || ref.source,
      )
      : unknown('Attending clinician is unavailable', ref.attendingSource || ref.source),
    diagnosis: ref.diagnosis
      ? known(ref.diagnosis, ref.diagnosisRecordedAt || ref.recordedAt, ref.source)
      : unknown('Diagnosis or chief complaint is unavailable', ref.source),
    latest_vitals: clinical?.latest_vitals ?? unknown('No vitals are recorded'),
    news2: clinical?.news2 ?? unknown('No NEWS2 score is recorded'),
    medications_due: clinical?.medications_due
      ?? unknown(
        'Medication due list cannot be resolved without a patient identity',
        'medication_administrations',
      ),
    active_medication_orders: clinical?.active_medication_orders
      ?? unknown(
        'Active medication orders cannot be resolved without a patient identity',
        'clinical_orders',
      ),
    recently_administered_medications:
      clinical?.recently_administered_medications
      ?? unknown(
        'Recent administrations cannot be resolved without a patient identity',
        'medication_administrations',
      ),
    unresolved_critical_results: clinical?.unresolved_critical_results
      ?? unknown(
        'Critical-result status cannot be resolved without a patient identity',
        'critical_result_rails',
      ),
    recent_released_results: clinical?.recent_released_results
      ?? unknown(
        'Released results cannot be resolved without a patient identity',
        'diagnostic_release_rails',
      ),
    care_team: clinical?.care_team
      ?? unknown(
        'Care team cannot be resolved without a patient identity',
        'care_team_members',
      ),
  };
  if (areaType === PACK_LOCATION_TYPES.PAEDS) {
    patient.latest_weight = clinical?.latest_weight ?? unknown(
      'No weight is recorded',
      'vitals_chart',
    );
  }
  if (unresolvedPatient) patient.patient_sources_resolved = false;
  return patient;
}

function basePack({
  tenantId,
  facility,
  policy,
  watermark,
  location,
  patients,
}) {
  return Object.freeze({
    pack_schema_version: policy.packSchemaVersion,
    tenant_id: tenantId,
    facility,
    location,
    policy: policy.packSchemaVersion === 2
      ? {
          checksum: policy.policyChecksum,
          delivery: policy.policyDelivery,
          id: policy.policyVersionId,
          revocation_epoch: policy.revocationEpoch,
          version: policy.policyVersion,
        }
      : {
          id: policy.policyVersionId,
          version: policy.policyVersion,
          revocation_epoch: policy.revocationEpoch,
        },
    source_watermark: watermark,
    generated_at: watermark.captured_at,
    fresh_until: addMinutes(watermark.captured_at, 15),
    expires_at: addHours(watermark.captured_at, 24),
    not_valid_after: addHours(watermark.captured_at, 24),
    historical_mode: false,
    patients,
  });
}

async function buildPatientsForRefs({
  tx,
  tenantId,
  refs,
  policy,
  watermark,
  areaType,
}) {
  const clinicalByUid = await loadPatientClinicalFields({
    tx,
    tenantId,
    patientRefs: refs,
    policy,
    watermark,
  });
  const identityUids = refs.map((ref) => ref.patientUid).filter(Boolean).map(String);
  let identities = [];
  if (identityUids.length) {
    identities = await tx.$queryRawUnsafe(
      `/* continuity:patient-identity-render */
       SELECT u.uid AS patient_uid, u.name, u.birthday, u.is_unidentified,
              u.identity_source, u.updated_at,
              identifier.identifier_value AS mrn,
              identifier.updated_at AS mrn_recorded_at
         FROM users AS u
         LEFT JOIN LATERAL (
           SELECT pi.identifier_value, pi.updated_at
             FROM patient_identifiers AS pi
            WHERE pi.tenant_id = u.tenant_id
              AND pi.patient_uid = u.uid
              AND pi.status = 'active'
              AND LOWER(pi.identifier_type) IN ('mrn', 'medical_record_number')
            ORDER BY pi.is_primary DESC, pi.assigned_at DESC NULLS LAST, pi.id DESC
            LIMIT 1
         ) AS identifier ON TRUE
        WHERE u.tenant_id = $1::uuid
          AND u.uid = ANY($2::uuid[])
          AND UPPER(COALESCE(u.role, '')) = 'PATIENT'`,
      tenantId,
      [...new Set(identityUids)],
    );
  }
  const identityByUid = firstBy(identities, 'patient_uid');
  const attendingByUid = await resolveAttendingNames(tx, tenantId, refs);
  return refs.map((ref) => {
    const identity = ref.patientUid ? identityByUid.get(String(ref.patientUid)) : null;
    if (ref.patientUid && !identity) {
      throw coverageError('A referenced patient cannot be resolved for identity rendering', {
        affected_patient_count: 1,
        reason: 'patient_identity_render_not_found',
        area_type: areaType,
      });
    }
    const attending = ref.attendingUid
      ? attendingByUid.get(String(ref.attendingUid))
      : ref.attendingName
        ? { name: ref.attendingName, updated_at: ref.attendingRecordedAt }
        : null;
    return buildPatient({
      ref,
      identity,
      clinical: ref.patientUid ? clinicalByUid.get(String(ref.patientUid)) : null,
      attending,
      watermark,
      location: ref.location,
      areaType,
    });
  });
}

export async function produceWardPack({
  tx,
  tenantId,
  facility,
  policy,
  watermark,
  coverage,
  paediatric = false,
}) {
  requireTx(tx);
  const rows = await tx.$queryRawUnsafe(
    `/* continuity:ward-definition */
     SELECT ward.id, ward.name, ward.floor, ward.facility_id,
            ward.updated_at, department.name AS department_name
       FROM wards AS ward
       LEFT JOIN departments AS department
         ON department.tenant_id = ward.tenant_id
        AND department.id = ward.department_id
      WHERE ward.tenant_id = $1::uuid
        AND ward.facility_id = $2::int
        AND ward.id = $3::int
      LIMIT 1`,
    tenantId,
    Number(facility.id),
    coverage.wardId,
  );
  const ward = rows[0];
  if (!ward) {
    throw coverageError('A policy-required ward is missing or mapped to another facility', {
      ward_id: coverage.wardId,
    });
  }

  const census = await tx.$queryRawUnsafe(
    `/* continuity:ward-census */
     SELECT bed.id AS bed_id, bed.bed_number, bed.patient_id,
            bed.patient_uid, bed.patient_name, bed.admission_id,
            bed.assigned_at, bed.updated_at AS bed_updated_at,
            admission.id AS resolved_admission_id,
            admission.status AS admission_status,
            admission.chief_complaint,
            admission.admitting_diagnosis,
            admission.attending_doctor,
            admission.updated_at AS admission_updated_at
       FROM beds AS bed
       LEFT JOIN admissions AS admission
         ON admission.tenant_id = bed.tenant_id
        AND admission.id = bed.admission_id
        AND admission.patient_uid = bed.patient_uid
      WHERE bed.tenant_id = $1::uuid
        AND bed.ward_id = $2::int
        AND LOWER(COALESCE(bed.status, '')) = 'occupied'
      ORDER BY bed.bed_number, bed.id`,
    tenantId,
    ward.id,
  );

  const invalid = census.find((bed) => (
    !bed.patient_uid
    || !bed.admission_id
    || !bed.resolved_admission_id
    || !ACTIVE_ADMISSION_STATUSES.includes(String(bed.admission_status || '').toLowerCase())
  ));
  if (invalid) {
    throw coverageError('Occupied ward census contains an unresolvable patient/admission', {
      ward_id: ward.id,
      bed_id: invalid.bed_id,
    });
  }

  const refs = census.map((bed) => ({
    patientUid: String(bed.patient_uid),
    fallbackName: bed.patient_name,
    recordedAt: bed.admission_updated_at || bed.bed_updated_at,
    source: 'beds/admissions',
    location: {
      ward_id: String(ward.id),
      ward_name: ward.name,
      bed_id: String(bed.bed_id),
      bed_number: bed.bed_number,
    },
    locationRecordedAt: bed.assigned_at || bed.bed_updated_at,
    diagnosis: bed.admitting_diagnosis || bed.chief_complaint,
    diagnosisRecordedAt: bed.admission_updated_at,
    attendingUid: bed.attending_doctor ? String(bed.attending_doctor) : null,
    attendingRecordedAt: bed.admission_updated_at,
    attendingSource: 'admissions.attending_doctor',
  }));
  const locationType = paediatric ? PACK_LOCATION_TYPES.PAEDS : PACK_LOCATION_TYPES.WARD;
  const patients = await buildPatientsForRefs({
    tx,
    tenantId,
    refs,
    policy,
    watermark,
    areaType: locationType,
  });
  return basePack({
    tenantId,
    facility,
    policy,
    watermark,
    location: {
      type: locationType,
      id: coverage.locationIdentifier,
      identifier: coverage.locationIdentifier,
      label: coverage.label || ward.name,
      ward_id: String(ward.id),
      area_profile: paediatric ? 'paeds' : 'ward',
    },
    patients,
  });
}

export async function produceEdPack({
  tx,
  tenantId,
  facility,
  policy,
  watermark,
  coverage,
}) {
  requireTx(tx);
  const ambiguous = await tx.$queryRawUnsafe(
    `/* continuity:ed-unmapped-preflight */
     SELECT id, visit_number
       FROM emergency_visits
      WHERE tenant_id = $1::uuid
        AND facility_id IS NULL
        AND status <> ALL($2::text[])
      ORDER BY arrival_at
      LIMIT 20`,
    tenantId,
    CLOSED_ED_STATUSES,
  );
  if (ambiguous.length) {
    throw coverageError('Open ED visits without facility mapping block coverage', {
      visit_ids: ambiguous.map((row) => String(row.id)),
    });
  }

  const visits = await tx.$queryRawUnsafe(
    `/* continuity:ed-board */
     SELECT visit.id, visit.visit_number, visit.patient_uid, visit.arrival_at,
            visit.chief_complaint, visit.attending_doctor_uid,
            visit.triage_priority, visit.status, visit.metadata,
            visit.updated_at,
            triage.level AS triage_level,
            triage.assessment_kind,
            triage.assessed_at
       FROM emergency_visits AS visit
       LEFT JOIN LATERAL (
         SELECT assessment.level, assessment.assessment_kind,
                assessment.assessed_at
           FROM triage_assessments AS assessment
          WHERE assessment.tenant_id = visit.tenant_id
            AND assessment.emergency_visit_id = visit.id
          ORDER BY assessment.assessed_at DESC, assessment.id DESC
          LIMIT 1
       ) AS triage ON TRUE
      WHERE visit.tenant_id = $1::uuid
        AND visit.facility_id = $2::int
        AND visit.status <> ALL($3::text[])
        AND visit.arrival_at <= $4::timestamptz
      ORDER BY
        COALESCE(triage.level, visit.triage_priority, 'unassigned'),
        visit.arrival_at,
        visit.id`,
    tenantId,
    Number(facility.id),
    CLOSED_ED_STATUSES,
    watermark.captured_at,
  );
  const refs = visits.map((visit) => {
    const metadata = visit.metadata && typeof visit.metadata === 'object' ? visit.metadata : {};
    return {
      patientUid: visit.patient_uid ? String(visit.patient_uid) : null,
      fallbackName: metadata.patient_name || `ED visit ${visit.visit_number}`,
      recordedAt: visit.updated_at,
      source: 'emergency_visits',
      location: {
        board: coverage.locationIdentifier,
        visit_number: visit.visit_number,
        status: visit.status,
      },
      locationRecordedAt: visit.updated_at,
      diagnosis: visit.chief_complaint,
      diagnosisRecordedAt: visit.updated_at,
      attendingUid: visit.attending_doctor_uid ? String(visit.attending_doctor_uid) : null,
      attendingRecordedAt: visit.updated_at,
      attendingSource: 'emergency_visits.attending_doctor_uid',
      areaFields: {
        arrival_at: known(visit.arrival_at, visit.arrival_at, 'emergency_visits.arrival_at'),
        triage: (visit.triage_level || visit.triage_priority)
          ? known(
            {
              display: visit.triage_level || visit.triage_priority,
              level: visit.triage_level,
              priority: visit.triage_priority,
              assessment_kind: visit.assessment_kind,
            },
            visit.assessed_at || visit.updated_at,
            visit.triage_level ? 'triage_assessments' : 'emergency_visits.triage_priority',
          )
          : unknown('Triage category is not recorded', 'triage_assessments'),
        time_in_department: knownAtWatermark({
          minutes: Math.max(
            0,
            Math.floor(
              (new Date(watermark.captured_at).getTime() - new Date(visit.arrival_at).getTime())
              / 60000,
            ),
          ),
        }, watermark, 'emergency_visits.arrival_at'),
      },
    };
  });
  const patients = await buildPatientsForRefs({
    tx,
    tenantId,
    refs,
    policy,
    watermark,
    areaType: PACK_LOCATION_TYPES.ED,
  });
  refs.forEach((ref, index) => Object.assign(patients[index], ref.areaFields));
  return basePack({
    tenantId,
    facility,
    policy,
    watermark,
    location: {
      type: PACK_LOCATION_TYPES.ED,
      id: coverage.locationIdentifier,
      identifier: coverage.locationIdentifier,
      label: coverage.label || 'Emergency department',
    },
    patients,
  });
}

export async function produceOpdPack({
  tx,
  tenantId,
  facility,
  policy,
  watermark,
  coverage,
}) {
  requireTx(tx);
  const ambiguous = await tx.$queryRawUnsafe(
    `/* continuity:opd-unmapped-preflight */
     SELECT appointment.id
       FROM appointments AS appointment
       LEFT JOIN appointment_queues AS queue
         ON queue.tenant_id = appointment.tenant_id
        AND queue.id = appointment.queue_id
      WHERE appointment.tenant_id = $1::uuid
        AND appointment.appointment_date =
            ($2::timestamptz AT TIME ZONE $3::text)::date
        AND (
          appointment.queue_id IS NULL
          OR queue.id IS NULL
          OR queue.facility_id IS NULL
        )
      ORDER BY appointment.id
      LIMIT 20`,
    tenantId,
    watermark.captured_at,
    facility.timezone,
  );
  if (ambiguous.length) {
    throw coverageError('Today’s OPD appointments without facility mapping block coverage', {
      appointment_ids: ambiguous.map((row) => String(row.id)),
    });
  }

  const queueRows = await tx.$queryRawUnsafe(
    `/* continuity:opd-queues */
     SELECT id, queue_label, department_name, doctor_uid, updated_at
       FROM appointment_queues
      WHERE tenant_id = $1::uuid
        AND facility_id = $2::int
        AND queue_date = ($3::timestamptz AT TIME ZONE $4::text)::date
        AND (
          COALESCE(array_length($5::int[], 1), 0) = 0
          OR id = ANY($5::int[])
        )
      ORDER BY id`,
    tenantId,
    Number(facility.id),
    watermark.captured_at,
    facility.timezone,
    coverage.queueIds,
  );
  if (coverage.queueIds.length) {
    const found = new Set(queueRows.map((row) => Number(row.id)));
    const missing = coverage.queueIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw coverageError('A policy-required OPD queue is missing or mapped elsewhere', {
        queue_ids: missing,
      });
    }
  }
  const selectedQueueIds = queueRows.map((row) => Number(row.id));
  const appointments = selectedQueueIds.length
    ? await tx.$queryRawUnsafe(
      `/* continuity:opd-appointments */
       SELECT appointment.id, appointment.patient_id,
              patient.uid AS patient_uid,
              COALESCE(appointment.patient_name, patient.name) AS patient_name,
              COALESCE(appointment.phone, patient.phone) AS phone,
              appointment.doctor_id, doctor.uid AS doctor_uid,
              appointment.doctor_name, appointment.reason,
              appointment.appointment_date, appointment.appointment_time,
              appointment.status, appointment.queue_id,
              appointment.updated_at,
              CASE
                WHEN appointment.appointment_time ~
                     '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                THEN (
                  appointment.appointment_date
                  + appointment.appointment_time::time
                ) AT TIME ZONE $4::text
                ELSE NULL
              END AS appointment_at
         FROM appointments AS appointment
         LEFT JOIN users AS patient
           ON patient.tenant_id = appointment.tenant_id
          AND patient.id = appointment.patient_id
         LEFT JOIN users AS doctor
           ON doctor.tenant_id = appointment.tenant_id
          AND doctor.id = appointment.doctor_id
        WHERE appointment.tenant_id = $1::uuid
          AND appointment.queue_id = ANY($2::int[])
          AND appointment.appointment_date =
              ($3::timestamptz AT TIME ZONE $4::text)::date
        ORDER BY appointment.appointment_time, appointment.id`,
      tenantId,
      selectedQueueIds,
      watermark.captured_at,
      facility.timezone,
    )
    : [];

  const queueById = firstBy(queueRows, 'id');
  const refs = appointments.map((appointment) => {
    const queue = queueById.get(String(appointment.queue_id));
    return {
      patientUid: appointment.patient_uid ? String(appointment.patient_uid) : null,
      fallbackName: appointment.patient_name || `Appointment ${appointment.id}`,
      recordedAt: appointment.updated_at,
      source: 'appointments',
      location: {
        clinic_day: coverage.locationIdentifier,
        queue_id: String(appointment.queue_id),
        queue_label: queue?.queue_label,
        department_name: queue?.department_name,
        appointment_id: String(appointment.id),
      },
      locationRecordedAt: queue?.updated_at || appointment.updated_at,
      diagnosis: appointment.reason,
      diagnosisRecordedAt: appointment.updated_at,
      attendingUid: appointment.doctor_uid ? String(appointment.doctor_uid) : null,
      attendingName: appointment.doctor_name,
      attendingRecordedAt: appointment.updated_at,
      attendingSource: 'appointments.doctor',
      areaFields: {
        appointment_time: appointment.appointment_at
          ? known(
            appointment.appointment_at,
            appointment.updated_at,
            'appointments.appointment_time',
          )
          : unknown('Appointment time is not a clock time', 'appointments.appointment_time'),
        appointment_status: known(
          appointment.status,
          appointment.updated_at,
          'appointments.status',
        ),
        phone: appointment.phone
          ? known(appointment.phone, appointment.updated_at, 'appointments.phone')
          : unknown('Outage contact phone is unavailable', 'appointments.phone'),
      },
    };
  });
  const patients = await buildPatientsForRefs({
    tx,
    tenantId,
    refs,
    policy,
    watermark,
    areaType: PACK_LOCATION_TYPES.OPD,
  });
  refs.forEach((ref, index) => Object.assign(patients[index], ref.areaFields));
  return Object.freeze({
    ...basePack({
      tenantId,
      facility,
      policy,
      watermark,
      location: {
        type: PACK_LOCATION_TYPES.OPD,
        id: coverage.locationIdentifier,
        identifier: coverage.locationIdentifier,
        label: coverage.label || 'OPD clinic day',
      },
      patients,
    }),
    handling: {
      printed_sheet: 'DESTROY AFTER CLINIC DAY',
    },
  });
}

/**
 * Produce every location required by one active, pinned policy. Callers must
 * persist/sign/publish the returned complete set atomically; partial output is
 * never returned.
 */
export async function produceFacilityContinuityPacks({
  tx,
  tenantId,
  facilityId,
  policy: rawPolicy,
}) {
  requireTx(tx);
  const tid = requireTenantId(tenantId);
  const fid = positiveInt(facilityId, 'facilityId');
  const policy = normalizePolicy(rawPolicy, tid, fid);
  const watermark = await captureContinuitySourceWatermark(tx);
  const facility = await loadFacility(tx, tid, fid);
  const packs = [];

  for (const coverage of policy.requiredCoverage.wards) {
    packs.push(await produceWardPack({
      tx,
      tenantId: tid,
      facility,
      policy,
      watermark,
      coverage,
      paediatric: false,
    }));
  }
  for (const coverage of policy.requiredCoverage.paediatricWards) {
    packs.push(await produceWardPack({
      tx,
      tenantId: tid,
      facility,
      policy,
      watermark,
      coverage,
      paediatric: true,
    }));
  }
  for (const coverage of policy.requiredCoverage.edBoards) {
    packs.push(await produceEdPack({
      tx,
      tenantId: tid,
      facility,
      policy,
      watermark,
      coverage,
    }));
  }
  for (const coverage of policy.requiredCoverage.opdClinicDays) {
    packs.push(await produceOpdPack({
      tx,
      tenantId: tid,
      facility,
      policy,
      watermark,
      coverage,
    }));
  }

  const expected = Object.values(policy.requiredCoverage).reduce(
    (total, entries) => total + entries.length,
    0,
  );
  if (packs.length !== expected) {
    throw coverageError('Required continuity-pack coverage is incomplete', {
      expected,
      produced: packs.length,
    });
  }
  const locationKeys = packs.map((pack) => `${pack.location.type}:${pack.location.identifier}`);
  if (new Set(locationKeys).size !== locationKeys.length) {
    throw coverageError('Continuity policy contains colliding location identifiers');
  }

  return Object.freeze({
    tenant_id: tid,
    facility,
    policy_version: policy.policyVersion,
    policy_version_id: policy.policyVersionId,
    source_watermark: watermark,
    expected_coverage: locationKeys,
    packs: Object.freeze(packs),
  });
}

export default {
  captureContinuitySourceWatermark,
  normalizeContinuityDbValue,
  produceWardPack,
  produceEdPack,
  produceOpdPack,
  produceFacilityContinuityPacks,
  ContinuityPackCoverageError,
};
