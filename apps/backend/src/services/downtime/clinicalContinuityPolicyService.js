import { AppError } from '../../utils/AppError.js';
import { setTenantTx } from '../../lib/prisma.js';
import {
  KEY_STATES,
  SIGNATURE_ALGORITHM,
  assessSigningKey,
  canonicalizeJson,
  hashCanonicalValue,
  normalizeGovernanceVersion,
  sha256Hex,
  verifyCanonicalValue
} from './continuityPackCanonical.js';
import { parseClinicalContinuityActionRegistry } from './clinicalContinuityActionRegistryService.js';

export const CLINICAL_CONTINUITY_POLICY_TYPE = 'clinical_continuity_pack';
export const CLINICAL_CONTINUITY_POLICY_CANONICALIZATION = 'rfc8785-jcs';
export const CLINICAL_CONTINUITY_POLICY_SCHEMA_VERSION = 1;
export const CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION = 2;
export const CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION = 3;
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const ALLERGY_UNKNOWN_TEXT = 'Allergy status UNKNOWN — not recorded';
export const CODE_STATUS_UNKNOWN_TEXT = 'Code status NOT RECORDED — confirm per hospital policy';

export const REQUIRED_SAFETY_FIELDS = Object.freeze([
  'identity.name',
  'identity.mrnOrUid',
  'identity.dateOfBirth',
  'allergies',
  'codeStatus',
  'medicationsDue',
  'activeMedicationOrders',
  'recentlyAdministeredMedications',
  'unresolvedCriticalResults'
]);

export const REQUIRED_CONTEXT_FIELDS = Object.freeze([
  'bedLocation',
  'attendingDoctor',
  'diagnosisOrChiefComplaint',
  'latestVitals',
  'news2',
  'recentReleasedResults',
  'careTeam'
]);

const POLICY_KEY_PURPOSE = 'clinical_continuity_policy_signing';
const PACK_KEY_PURPOSE = 'clinical_continuity_pack_signing';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const LOCATION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ITEM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const BLOOD_GROUP_CODES = new Set(['883-9', '882-1', '10331-7', '13001-7', '34530-6']);
const VERIFIED_ACTIVE_POLICIES = new WeakSet();

const POLICY_SELECT_BASE_SQL = `
  SELECT policy.id,
         policy.tenant_id,
         policy.facility_id,
         policy.policy_version,
         policy.policy_schema_version,
         policy.action_registry_schema_version,
         policy.action_registry_version,
         policy.action_registry_checksum,
         policy.lifecycle_state,
         policy.policy_document,
         policy.policy_checksum,
         policy.canonicalization,
         policy.signature_algorithm,
         policy.policy_signing_key_id,
         policy.policy_signing_public_key_sha256,
         policy.current_pack_signing_key_id,
         policy.current_pack_signing_public_key_sha256,
         policy.next_pack_signing_key_id,
         policy.next_pack_signing_public_key_sha256,
         policy.policy_signature,
         policy.revocation_epoch,
         policy.revoked_key_ids,
         policy.approval_id,
         policy.approved_by,
         policy.approved_at,
         policy.effective_from,
         policy.effective_until,
         policy.supersedes_policy_id,
         policy.created_at,
         facility.display_name AS facility_display_name,
         facility.timezone AS facility_timezone,
         facility.status AS facility_status,
         policy_key.algorithm AS policy_key_algorithm,
         policy_key.status AS policy_key_status,
         policy_key.metadata AS policy_key_metadata,
         current_key.algorithm AS current_key_algorithm,
         current_key.status AS current_key_status,
         current_key.metadata AS current_key_metadata,
         next_key.algorithm AS next_key_algorithm,
         next_key.status AS next_key_status,
         next_key.metadata AS next_key_metadata,
         approval.status AS approval_status,
         approval.approval_kind,
         approval.subject_resource_type AS approval_subject_resource_type,
         approval.subject_resource_id AS approval_subject_resource_id,
         approval.required_approvers AS approval_required_approvers,
         approval.approved_by AS approval_approved_by,
         approval.decided_by AS approval_decided_by,
         approval.decided_at AS approval_decided_at,
         approval.metadata AS approval_metadata,
         transaction_timestamp() AS trusted_now,
         (
           SELECT MAX(committed.policy_version)
             FROM clinical_continuity_policy_versions AS committed
            WHERE committed.tenant_id = policy.tenant_id
              AND committed.facility_id = policy.facility_id
              AND committed.lifecycle_state <> 'draft'
         ) AS latest_committed_policy_version,
         (
           SELECT MAX(committed.revocation_epoch)
             FROM clinical_continuity_policy_versions AS committed
            WHERE committed.tenant_id = policy.tenant_id
              AND committed.facility_id = policy.facility_id
              AND committed.lifecycle_state <> 'draft'
         ) AS latest_committed_revocation_epoch
    FROM clinical_continuity_policy_versions AS policy
    JOIN facilities AS facility
      ON facility.tenant_id = policy.tenant_id
     AND facility.id = policy.facility_id
    JOIN encryption_keys AS policy_key
      ON policy_key.tenant_id = policy.tenant_id
     AND policy_key.key_id = policy.policy_signing_key_id
    JOIN encryption_keys AS current_key
      ON current_key.tenant_id = policy.tenant_id
     AND current_key.key_id = policy.current_pack_signing_key_id
    LEFT JOIN encryption_keys AS next_key
      ON next_key.tenant_id = policy.tenant_id
     AND next_key.key_id = policy.next_pack_signing_key_id
    JOIN approvals AS approval
      ON approval.tenant_id = policy.tenant_id
     AND approval.id = policy.approval_id
   WHERE policy.tenant_id = $1::uuid
     AND policy.lifecycle_state = 'active'`;

const POLICY_SELECT_SQL = `${POLICY_SELECT_BASE_SQL}
   ORDER BY policy.facility_id`;

const POLICY_SELECT_FACILITY_SQL = `${POLICY_SELECT_BASE_SQL}
     AND policy.facility_id = $2::integer
   ORDER BY policy.policy_version DESC
   LIMIT 2`;

const POLICY_SELECT_HISTORICAL_SQL = `${POLICY_SELECT_BASE_SQL.replace(
  "WHERE policy.tenant_id = $1::uuid\n     AND policy.lifecycle_state = 'active'",
  `WHERE policy.tenant_id = $1::uuid
     AND policy.facility_id = $2::integer
     AND policy.id = $3::uuid
     AND policy.policy_version = $4::bigint
     AND policy.lifecycle_state IN ('active', 'retired')`
)}
   ORDER BY policy.policy_version DESC
   LIMIT 2`;

function policyConflict(message, code) {
  throw AppError.conflict(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function objectValue(value, label) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      policyConflict(`${label} must be valid JSON`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
    }
  }
  if (!isPlainObject(parsed)) {
    policyConflict(`${label} must be a JSON object`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return parsed;
}

function arrayValue(value, label) {
  if (!Array.isArray(value)) {
    policyConflict(`${label} must be an array`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    policyConflict(`${label} has an unsupported shape`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
}

function normalizedUuid(value, label = 'tenantId') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(normalized)) {
    policyConflict(`${label} must be a UUID`, 'CONTINUITY_POLICY_SCOPE_INVALID');
  }
  return normalized;
}

function normalizedTenantId(value) {
  const tenantId = normalizedUuid(value);
  if (tenantId === DEFAULT_TENANT_ID) {
    policyConflict(
      'The default tenant cannot own clinical continuity policy',
      'CONTINUITY_POLICY_DEFAULT_TENANT_REJECTED'
    );
  }
  return tenantId;
}

function normalizedFacilityId(value) {
  const number = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    policyConflict(
      'facilityId must be a positive database integer',
      'CONTINUITY_POLICY_SCOPE_INVALID'
    );
  }
  return number;
}

function normalizedKeyId(value, label) {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    policyConflict(`${label} is invalid`, 'CONTINUITY_POLICY_KEY_INVALID');
  }
  return value;
}

function normalizedPublicKeySha256(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    policyConflict(
      `${label} must be an exact lowercase SHA-256 digest`,
      'CONTINUITY_POLICY_KEY_BINDING_INVALID'
    );
  }
  return value;
}

function normalizedDate(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    policyConflict(`${label} must be a valid timestamp`, 'CONTINUITY_POLICY_TIME_INVALID');
  }
  return date.toISOString();
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    policyConflict(`${label} must be a positive integer`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return value;
}

function nonNegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    policyConflict(`${label} must be a non-negative integer`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return value;
}

function boundedString(value, label, pattern, maximumLength) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    !pattern.test(value)
  ) {
    policyConflict(`${label} is invalid`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return value;
}

function optionalLabel(value, label) {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > 160 ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    policyConflict(`${label} is invalid`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return value;
}

function uniqueStrings(values, label, { pattern, maximumLength }) {
  const normalized = arrayValue(values, label).map((value, index) =>
    boundedString(value, `${label}[${index}]`, pattern, maximumLength)
  );
  if (new Set(normalized).size !== normalized.length) {
    policyConflict(`${label} contains duplicates`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return normalized;
}

function normalizeWardCoverage(value, label) {
  const entries = arrayValue(value, label).map((entry, index) => {
    const record = objectValue(entry, `${label}[${index}]`);
    const allowedKeys =
      record.locationIdentifier === undefined
        ? record.label === undefined
          ? ['wardId']
          : ['wardId', 'label']
        : record.label === undefined
          ? ['wardId', 'locationIdentifier']
          : ['wardId', 'locationIdentifier', 'label'];
    exactKeys(record, allowedKeys, `${label}[${index}]`);
    const normalized = {
      wardId: positiveInteger(record.wardId, `${label}[${index}].wardId`, 2_147_483_647)
    };
    if (record.locationIdentifier !== undefined) {
      normalized.locationIdentifier = boundedString(
        record.locationIdentifier,
        `${label}[${index}].locationIdentifier`,
        LOCATION_IDENTIFIER_PATTERN,
        160
      );
    }
    if (record.label !== undefined) {
      normalized.label = optionalLabel(record.label, `${label}[${index}].label`);
    }
    return normalized;
  });
  const wardIds = entries.map(entry => entry.wardId);
  if (new Set(wardIds).size !== wardIds.length) {
    policyConflict(`${label} contains duplicate wards`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return entries;
}

function normalizeLocationCoverage(value, label) {
  const entries = arrayValue(value, label).map((entry, index) => {
    const record = objectValue(entry, `${label}[${index}]`);
    exactKeys(
      record,
      record.label === undefined ? ['locationIdentifier'] : ['locationIdentifier', 'label'],
      `${label}[${index}]`
    );
    const normalized = {
      locationIdentifier: boundedString(
        record.locationIdentifier,
        `${label}[${index}].locationIdentifier`,
        LOCATION_IDENTIFIER_PATTERN,
        160
      )
    };
    if (record.label !== undefined) {
      normalized.label = optionalLabel(record.label, `${label}[${index}].label`);
    }
    return normalized;
  });
  const identifiers = entries.map(entry => entry.locationIdentifier);
  if (new Set(identifiers).size !== identifiers.length) {
    policyConflict(`${label} contains duplicate locations`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return entries;
}

function normalizeOpdCoverage(value) {
  const label = 'requiredCoverage.opdClinicDays';
  const entries = arrayValue(value, label).map((entry, index) => {
    const record = objectValue(entry, `${label}[${index}]`);
    exactKeys(
      record,
      record.label === undefined
        ? ['locationIdentifier', 'queueIds']
        : ['locationIdentifier', 'queueIds', 'label'],
      `${label}[${index}]`
    );
    const queueIds = arrayValue(record.queueIds, `${label}[${index}].queueIds`).map(
      (queueId, queueIndex) =>
        positiveInteger(queueId, `${label}[${index}].queueIds[${queueIndex}]`, 2_147_483_647)
    );
    if (queueIds.length === 0 || new Set(queueIds).size !== queueIds.length) {
      policyConflict(
        `${label}[${index}].queueIds must be non-empty and unique`,
        'CONTINUITY_POLICY_DOCUMENT_INVALID'
      );
    }
    const normalized = {
      locationIdentifier: boundedString(
        record.locationIdentifier,
        `${label}[${index}].locationIdentifier`,
        LOCATION_IDENTIFIER_PATTERN,
        160
      ),
      queueIds
    };
    if (record.label !== undefined) {
      normalized.label = optionalLabel(record.label, `${label}[${index}].label`);
    }
    return normalized;
  });
  const identifiers = entries.map(entry => entry.locationIdentifier);
  if (new Set(identifiers).size !== identifiers.length) {
    policyConflict(`${label} contains duplicate locations`, 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }
  return entries;
}

function normalizeFieldPolicy(value) {
  const fieldPolicy = objectValue(value, 'fieldPolicy');
  exactKeys(
    fieldPolicy,
    [
      'allergyUnknownText',
      'bloodGroupIncluded',
      'codeStatusUnknownText',
      'contextFields',
      'isolationSource',
      'opdDestroyAfterClinicDay',
      'paediatricWeightRequired',
      'recentlyAdministeredLookbackHours',
      'safetyFieldRecordedAtRequired',
      'safetyFields'
    ],
    'fieldPolicy'
  );

  const safetyFields = uniqueStrings(fieldPolicy.safetyFields, 'fieldPolicy.safetyFields', {
    pattern: ITEM_CODE_PATTERN,
    maximumLength: 128
  });
  const contextFields = uniqueStrings(fieldPolicy.contextFields, 'fieldPolicy.contextFields', {
    pattern: ITEM_CODE_PATTERN,
    maximumLength: 128
  });
  for (const required of REQUIRED_SAFETY_FIELDS) {
    if (!safetyFields.includes(required)) {
      policyConflict(
        `fieldPolicy.safetyFields is missing ${required}`,
        'CONTINUITY_POLICY_DATASET_BELOW_FLOOR'
      );
    }
  }
  for (const required of REQUIRED_CONTEXT_FIELDS) {
    if (!contextFields.includes(required)) {
      policyConflict(
        `fieldPolicy.contextFields is missing ${required}`,
        'CONTINUITY_POLICY_DATASET_BELOW_FLOOR'
      );
    }
  }
  if (
    [...safetyFields, ...contextFields].some(field =>
      /blood.?group|blood.?type|(?:^|[._-])abo(?:$|[._-])|rhesus/iu.test(field)
    )
  ) {
    policyConflict(
      'Blood group is excluded from continuity packs',
      'CONTINUITY_POLICY_BLOOD_GROUP_FORBIDDEN'
    );
  }
  if (
    fieldPolicy.allergyUnknownText !== ALLERGY_UNKNOWN_TEXT ||
    fieldPolicy.codeStatusUnknownText !== CODE_STATUS_UNKNOWN_TEXT ||
    fieldPolicy.recentlyAdministeredLookbackHours !== 12 ||
    fieldPolicy.safetyFieldRecordedAtRequired !== true ||
    fieldPolicy.bloodGroupIncluded !== false ||
    fieldPolicy.isolationSource !== 'structured_only' ||
    fieldPolicy.paediatricWeightRequired !== true ||
    fieldPolicy.opdDestroyAfterClinicDay !== true
  ) {
    policyConflict(
      'fieldPolicy does not meet the approved C-D2 floor',
      'CONTINUITY_POLICY_DATASET_BELOW_FLOOR'
    );
  }
  return {
    allergyUnknownText: ALLERGY_UNKNOWN_TEXT,
    bloodGroupIncluded: false,
    codeStatusUnknownText: CODE_STATUS_UNKNOWN_TEXT,
    contextFields,
    isolationSource: 'structured_only',
    opdDestroyAfterClinicDay: true,
    paediatricWeightRequired: true,
    recentlyAdministeredLookbackHours: 12,
    safetyFieldRecordedAtRequired: true,
    safetyFields
  };
}

function normalizeRecentResults(value) {
  const recent = objectValue(value, 'recentReleasedResults');
  exactKeys(
    recent,
    ['itemCodeAllowlist', 'lookbackHours', 'maxPerPatient', 'portalReleaseDelayHours'],
    'recentReleasedResults'
  );
  const itemCodeAllowlist = uniqueStrings(
    recent.itemCodeAllowlist,
    'recentReleasedResults.itemCodeAllowlist',
    { pattern: ITEM_CODE_PATTERN, maximumLength: 128 }
  );
  if (itemCodeAllowlist.length === 0) {
    policyConflict(
      'Recent released-result item codes must be explicitly allowlisted',
      'CONTINUITY_POLICY_RESULT_ALLOWLIST_REQUIRED'
    );
  }
  if (
    itemCodeAllowlist.some(code => {
      const normalized = code.toLowerCase();
      return (
        BLOOD_GROUP_CODES.has(normalized) ||
        /blood.?group|blood.?type|(?:^|[._-])abo(?:$|[._-])|rhesus/iu.test(code)
      );
    })
  ) {
    policyConflict(
      'Blood-group result codes cannot be allowlisted',
      'CONTINUITY_POLICY_BLOOD_GROUP_FORBIDDEN'
    );
  }
  return {
    itemCodeAllowlist,
    lookbackHours: positiveInteger(
      recent.lookbackHours,
      'recentReleasedResults.lookbackHours',
      720
    ),
    maxPerPatient: positiveInteger(
      recent.maxPerPatient,
      'recentReleasedResults.maxPerPatient',
      100
    ),
    portalReleaseDelayHours: nonNegativeInteger(
      recent.portalReleaseDelayHours,
      'recentReleasedResults.portalReleaseDelayHours',
      720
    )
  };
}

function normalizeMedicationsDueWindow(value) {
  const window = objectValue(value, 'medicationsDueWindow');
  exactKeys(window, ['lookaheadHours', 'lookbackHours'], 'medicationsDueWindow');
  return {
    lookaheadHours: positiveInteger(
      window.lookaheadHours,
      'medicationsDueWindow.lookaheadHours',
      48
    ),
    lookbackHours: nonNegativeInteger(
      window.lookbackHours,
      'medicationsDueWindow.lookbackHours',
      24
    )
  };
}

function normalizeEdgeAccess(value) {
  const edgeAccess = objectValue(value, 'policyDocument.edgeAccess');
  exactKeys(
    edgeAccess,
    [
      'authenticationMode',
      'credentialLifetimeMinutes',
      'emergencyReadPosture',
      'maximumOfflineAuthorizationMinutes'
    ],
    'policyDocument.edgeAccess'
  );
  if (edgeAccess.authenticationMode !== 'mtls_client_certificate') {
    policyConflict(
      'Policy edge authentication mode is unsupported',
      'CONTINUITY_POLICY_EDGE_AUTHENTICATION_UNSUPPORTED'
    );
  }
  if (!['disabled', 'read_only'].includes(edgeAccess.emergencyReadPosture)) {
    policyConflict(
      'Policy emergency-read posture is unsupported',
      'CONTINUITY_POLICY_EDGE_EMERGENCY_POSTURE_INVALID'
    );
  }
  const maximumOfflineAuthorizationMinutes = positiveInteger(
    edgeAccess.maximumOfflineAuthorizationMinutes,
    'policyDocument.edgeAccess.maximumOfflineAuthorizationMinutes',
    2_147_483_647
  );
  const credentialLifetimeMinutes = positiveInteger(
    edgeAccess.credentialLifetimeMinutes,
    'policyDocument.edgeAccess.credentialLifetimeMinutes',
    2_147_483_647
  );
  if (credentialLifetimeMinutes < maximumOfflineAuthorizationMinutes) {
    policyConflict(
      'Credential lifetime cannot be shorter than the offline authorization window',
      'CONTINUITY_POLICY_EDGE_CREDENTIAL_LIFETIME_INVALID'
    );
  }
  return {
    authenticationMode: 'mtls_client_certificate',
    credentialLifetimeMinutes,
    emergencyReadPosture: edgeAccess.emergencyReadPosture,
    maximumOfflineAuthorizationMinutes
  };
}

function normalizeRetention(value) {
  const retention = objectValue(value, 'policyDocument.retention');
  exactKeys(
    retention,
    [
      'accessLogRetentionHours',
      'edgePackRetentionHours',
      'sourcePackRetentionHours'
    ],
    'policyDocument.retention'
  );
  return {
    accessLogRetentionHours: positiveInteger(
      retention.accessLogRetentionHours,
      'policyDocument.retention.accessLogRetentionHours',
      2_147_483_647
    ),
    edgePackRetentionHours: positiveInteger(
      retention.edgePackRetentionHours,
      'policyDocument.retention.edgePackRetentionHours',
      2_147_483_647
    ),
    sourcePackRetentionHours: positiveInteger(
      retention.sourcePackRetentionHours,
      'policyDocument.retention.sourcePackRetentionHours',
      2_147_483_647
    )
  };
}

/**
 * Parse and validate the signed continuity policy language. Every version is
 * closed: v1 governs C3.1 packs, v2 adds C3.2 edge access and retention, and
 * v3 adds C4.2 action authority. Later extensions must increment
 * policySchemaVersion rather than being interpreted through a fallback.
 */
export function parseClinicalContinuityPolicyDocument(
  value,
  { tenantId, facilityId, policySchemaVersion, effectiveFrom, effectiveUntil } = {}
) {
  const expectedTenantId = normalizedTenantId(tenantId);
  const expectedFacilityId = normalizedFacilityId(facilityId);
  const expectedSchemaVersion = positiveInteger(
    policySchemaVersion,
    'policySchemaVersion',
    2_147_483_647
  );
  const document = objectValue(value, 'policyDocument');
  const supportedSchema = [
    CLINICAL_CONTINUITY_POLICY_SCHEMA_VERSION,
    CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION,
    CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION
  ].includes(expectedSchemaVersion);
  if (!supportedSchema) {
    policyConflict(
      'The clinical continuity policy schema is unsupported',
      'CONTINUITY_POLICY_SCHEMA_UNSUPPORTED'
    );
  }
  const expectedKeys = [
    'audience',
    'fieldPolicy',
    'generation',
    'includedAreas',
    'medicationsDueWindow',
    'packSchemaVersion',
    'policySchemaVersion',
    'policyType',
    'recentReleasedResults',
    'requiredCoverage'
  ];
  if (expectedSchemaVersion >= CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION) {
    expectedKeys.push('edgeAccess', 'retention');
  }
  if (expectedSchemaVersion === CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION) {
    expectedKeys.push('actionRegistry');
  }
  exactKeys(
    document,
    expectedKeys,
    'policyDocument'
  );

  if (
    document.policyType !== CLINICAL_CONTINUITY_POLICY_TYPE ||
    document.policySchemaVersion !== expectedSchemaVersion
  ) {
    policyConflict(
      'The clinical continuity policy schema is unsupported',
      'CONTINUITY_POLICY_SCHEMA_UNSUPPORTED'
    );
  }

  const audience = objectValue(document.audience, 'policyDocument.audience');
  exactKeys(audience, ['facilityId', 'tenantId'], 'policyDocument.audience');
  if (
    normalizedTenantId(audience.tenantId) !== expectedTenantId ||
    normalizedFacilityId(audience.facilityId) !== expectedFacilityId
  ) {
    policyConflict(
      'Policy audience does not match its tenant and facility row',
      'CONTINUITY_POLICY_AUDIENCE_MISMATCH'
    );
  }

  const generation = objectValue(document.generation, 'policyDocument.generation');
  exactKeys(
    generation,
    ['currentForMinutes', 'hardExpiryHours', 'historicalMode', 'intervalMinutes'],
    'policyDocument.generation'
  );
  if (
    generation.intervalMinutes !== 15 ||
    generation.currentForMinutes !== 15 ||
    generation.hardExpiryHours !== 24 ||
    generation.historicalMode !== false
  ) {
    policyConflict(
      'Generation and expiry do not meet the approved C-D2 policy',
      'CONTINUITY_POLICY_FRESHNESS_INVALID'
    );
  }

  const includedAreas = objectValue(document.includedAreas, 'policyDocument.includedAreas');
  exactKeys(includedAreas, ['ed', 'opd', 'paediatrics', 'wards'], 'includedAreas');
  if (Object.values(includedAreas).some(enabled => typeof enabled !== 'boolean')) {
    policyConflict('includedAreas values must be boolean', 'CONTINUITY_POLICY_DOCUMENT_INVALID');
  }

  const coverage = objectValue(document.requiredCoverage, 'requiredCoverage');
  exactKeys(
    coverage,
    ['edBoards', 'opdClinicDays', 'paediatricWards', 'wards'],
    'requiredCoverage'
  );
  const requiredCoverage = {
    wards: normalizeWardCoverage(coverage.wards, 'requiredCoverage.wards'),
    paediatricWards: normalizeWardCoverage(
      coverage.paediatricWards,
      'requiredCoverage.paediatricWards'
    ),
    edBoards: normalizeLocationCoverage(coverage.edBoards, 'requiredCoverage.edBoards'),
    opdClinicDays: normalizeOpdCoverage(coverage.opdClinicDays)
  };

  const allWardIds = [
    ...requiredCoverage.wards.map(entry => entry.wardId),
    ...requiredCoverage.paediatricWards.map(entry => entry.wardId)
  ];
  if (new Set(allWardIds).size !== allWardIds.length) {
    policyConflict(
      'A ward cannot be both a ward and paediatric coverage target',
      'CONTINUITY_POLICY_DOCUMENT_INVALID'
    );
  }
  const areaCoverage = {
    wards: requiredCoverage.wards.length > 0,
    paediatrics: requiredCoverage.paediatricWards.length > 0,
    ed: requiredCoverage.edBoards.length > 0,
    opd: requiredCoverage.opdClinicDays.length > 0
  };
  if (
    Object.keys(areaCoverage).some(area => includedAreas[area] !== areaCoverage[area]) ||
    !Object.values(areaCoverage).some(Boolean)
  ) {
    policyConflict(
      'includedAreas must exactly match non-empty required coverage',
      'CONTINUITY_POLICY_COVERAGE_INVALID'
    );
  }

  const normalized = {
    ...(expectedSchemaVersion === CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION
      ? {
          actionRegistry: parseClinicalContinuityActionRegistry(document.actionRegistry, {
            effectiveFrom,
            effectiveUntil
          })
        }
      : {}),
    audience: {
      facilityId: String(expectedFacilityId),
      tenantId: expectedTenantId
    },
    ...(expectedSchemaVersion >= CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
      ? { edgeAccess: normalizeEdgeAccess(document.edgeAccess) }
      : {}),
    fieldPolicy: normalizeFieldPolicy(document.fieldPolicy),
    generation: {
      currentForMinutes: 15,
      hardExpiryHours: 24,
      historicalMode: false,
      intervalMinutes: 15
    },
    includedAreas: { ...includedAreas },
    medicationsDueWindow: normalizeMedicationsDueWindow(document.medicationsDueWindow),
    packSchemaVersion: positiveInteger(
      document.packSchemaVersion,
      'packSchemaVersion',
      2_147_483_647
    ),
    policySchemaVersion: expectedSchemaVersion,
    policyType: CLINICAL_CONTINUITY_POLICY_TYPE,
    recentReleasedResults: normalizeRecentResults(document.recentReleasedResults),
    ...(expectedSchemaVersion >= CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
      ? { retention: normalizeRetention(document.retention) }
      : {}),
    requiredCoverage
  };

  const canonical = canonicalizeJson(normalized);
  return deepFreeze(JSON.parse(canonical));
}

export function requireClinicalContinuityEdgePolicy(policy) {
  if (
    !VERIFIED_ACTIVE_POLICIES.has(policy) ||
    policy.policySchemaVersion < CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION ||
    policy.policyDocument?.policySchemaVersion < CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
  ) {
    policyConflict(
      'A verified active policy-schema v2 or later document is required for edge access',
      'CONTINUITY_EDGE_POLICY_V2_REQUIRED'
    );
  }
  return deepFreeze({
    edgeAccess: policy.policyDocument.edgeAccess,
    retention: policy.policyDocument.retention
  });
}

function normalizeRevokedKeyIds(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      policyConflict('revokedKeyIds must be valid JSON', 'CONTINUITY_POLICY_REVOCATION_INVALID');
    }
  }
  const revoked = uniqueStrings(parsed, 'revokedKeyIds', {
    pattern: KEY_ID_PATTERN,
    maximumLength: 64
  }).sort();
  if (revoked.length > 100) {
    policyConflict(
      'revokedKeyIds exceeds the policy limit',
      'CONTINUITY_POLICY_REVOCATION_INVALID'
    );
  }
  return revoked;
}

function rowValue(row, camelCase, snakeCase) {
  return row?.[camelCase] ?? row?.[snakeCase];
}

export function buildClinicalContinuityPolicySigningPayload(value) {
  const tenantId = normalizedTenantId(rowValue(value, 'tenantId', 'tenant_id'));
  const facilityId = normalizedFacilityId(rowValue(value, 'facilityId', 'facility_id'));
  const policySchemaVersion = positiveInteger(
    rowValue(value, 'policySchemaVersion', 'policy_schema_version'),
    'policySchemaVersion',
    2_147_483_647
  );
  const effectiveFrom = normalizedDate(
    rowValue(value, 'effectiveFrom', 'effective_from'),
    'effectiveFrom'
  );
  const effectiveUntil = normalizedDate(
    rowValue(value, 'effectiveUntil', 'effective_until'),
    'effectiveUntil',
    { nullable: true }
  );
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
    policyConflict(
      'Policy effectiveUntil must be later than effectiveFrom',
      'CONTINUITY_POLICY_TIME_INVALID'
    );
  }
  const policyDocument = parseClinicalContinuityPolicyDocument(
    rowValue(value, 'policyDocument', 'policy_document'),
    { tenantId, facilityId, policySchemaVersion, effectiveFrom, effectiveUntil }
  );
  const policyVersion = normalizeGovernanceVersion(
    rowValue(value, 'policyVersion', 'policy_version')
  );
  const revocationEpoch = normalizeGovernanceVersion(
    rowValue(value, 'revocationEpoch', 'revocation_epoch') ?? 0,
    { allowZero: true }
  );
  const policySigningKeyId = normalizedKeyId(
    rowValue(value, 'policySigningKeyId', 'policy_signing_key_id'),
    'policySigningKeyId'
  );
  const policySigningPublicKeySha256 = normalizedPublicKeySha256(
    rowValue(value, 'policySigningPublicKeySha256', 'policy_signing_public_key_sha256'),
    'policySigningPublicKeySha256'
  );
  const currentPackSigningKeyId = normalizedKeyId(
    rowValue(value, 'currentPackSigningKeyId', 'current_pack_signing_key_id'),
    'currentPackSigningKeyId'
  );
  const currentPackSigningPublicKeySha256 = normalizedPublicKeySha256(
    rowValue(value, 'currentPackSigningPublicKeySha256', 'current_pack_signing_public_key_sha256'),
    'currentPackSigningPublicKeySha256'
  );
  const nextKeyValue = rowValue(value, 'nextPackSigningKeyId', 'next_pack_signing_key_id');
  const nextPackSigningKeyId =
    nextKeyValue == null ? null : normalizedKeyId(nextKeyValue, 'nextPackSigningKeyId');
  const nextPackSigningPublicKeySha256 = normalizedPublicKeySha256(
    rowValue(value, 'nextPackSigningPublicKeySha256', 'next_pack_signing_public_key_sha256'),
    'nextPackSigningPublicKeySha256',
    { nullable: true }
  );
  if ((nextPackSigningKeyId === null) !== (nextPackSigningPublicKeySha256 === null)) {
    policyConflict(
      'Next pack signing key ID and public-key hash must be present or absent together',
      'CONTINUITY_POLICY_KEY_BINDING_INVALID'
    );
  }
  if (nextPackSigningKeyId === currentPackSigningKeyId) {
    policyConflict(
      'Current and next pack signing keys must differ',
      'CONTINUITY_POLICY_KEY_INVALID'
    );
  }

  const policyChecksum = rowValue(value, 'policyChecksum', 'policy_checksum');
  if (
    typeof policyChecksum !== 'string' ||
    !CHECKSUM_PATTERN.test(policyChecksum) ||
    policyChecksum !== hashCanonicalValue(policyDocument)
  ) {
    policyConflict(
      'Policy checksum does not match its canonical document',
      'CONTINUITY_POLICY_CHECKSUM_MISMATCH'
    );
  }
  let actionRegistryFields = {};
  if (policySchemaVersion === CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION) {
    const actionRegistrySchemaVersion = positiveInteger(
      rowValue(value, 'actionRegistrySchemaVersion', 'action_registry_schema_version'),
      'actionRegistrySchemaVersion',
      2_147_483_647
    );
    const actionRegistryVersion = normalizeGovernanceVersion(
      rowValue(value, 'actionRegistryVersion', 'action_registry_version')
    );
    const actionRegistryChecksum = normalizedPublicKeySha256(
      rowValue(value, 'actionRegistryChecksum', 'action_registry_checksum'),
      'actionRegistryChecksum'
    );
    if (
      actionRegistrySchemaVersion !== policyDocument.actionRegistry.registrySchemaVersion ||
      actionRegistryVersion !== policyDocument.actionRegistry.registryVersion ||
      actionRegistryChecksum !== policyDocument.actionRegistry.registryChecksum
    ) {
      policyConflict(
        'Action registry row binding does not match the signed policy document',
        'CONTINUITY_ACTION_REGISTRY_ROW_MISMATCH'
      );
    }
    actionRegistryFields = {
      actionRegistryChecksum,
      actionRegistrySchemaVersion,
      actionRegistryVersion
    };
  } else if (
    rowValue(value, 'actionRegistrySchemaVersion', 'action_registry_schema_version') != null ||
    rowValue(value, 'actionRegistryVersion', 'action_registry_version') != null ||
    rowValue(value, 'actionRegistryChecksum', 'action_registry_checksum') != null
  ) {
    policyConflict(
      'Policy schemas v1 and v2 cannot carry an action registry',
      'CONTINUITY_ACTION_POLICY_V3_REQUIRED'
    );
  }

  const supersedesValue = rowValue(value, 'supersedesPolicyId', 'supersedes_policy_id');
  return {
    algorithm: SIGNATURE_ALGORITHM,
    ...actionRegistryFields,
    audience: { tenantId, facilityId: String(facilityId) },
    canonicalization: CLINICAL_CONTINUITY_POLICY_CANONICALIZATION,
    currentPackSigningKeyId,
    currentPackSigningPublicKeySha256,
    effectiveFrom,
    effectiveUntil,
    nextPackSigningKeyId,
    nextPackSigningPublicKeySha256,
    policyChecksum,
    policyDocument,
    policySchemaVersion,
    policySigningKeyId,
    policySigningPublicKeySha256,
    policyVersion,
    revocationEpoch,
    revokedKeyIds: normalizeRevokedKeyIds(
      rowValue(value, 'revokedKeyIds', 'revoked_key_ids') ?? []
    ),
    supersedesPolicyId:
      supersedesValue == null ? null : normalizedUuid(supersedesValue, 'supersedesPolicyId')
  };
}

function signatureBase64(value) {
  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = value;
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof value === 'string') {
    bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) bytes = null;
  }
  if (!bytes || bytes.length !== 64) {
    policyConflict(
      'Policy signature must be a 64-byte Ed25519 signature',
      'CONTINUITY_POLICY_SIGNATURE_INVALID'
    );
  }
  return bytes.toString('base64');
}

function keyMetadata(value, label) {
  const metadata = objectValue(value, label);
  const publicKey = metadata.public_key_spki_pem;
  if (
    typeof publicKey !== 'string' ||
    publicKey.length > 8_192 ||
    !publicKey.startsWith('-----BEGIN PUBLIC KEY-----')
  ) {
    policyConflict(`${label}.public_key_spki_pem is required`, 'CONTINUITY_POLICY_KEY_INVALID');
  }
  return { metadata, publicKey };
}

function assertRegistryKey({
  keyId,
  publicKeySha256,
  algorithm,
  status,
  metadata,
  purpose,
  allowedStatuses,
  revokedKeyIds,
  label
}) {
  if (String(algorithm || '').toLowerCase() !== 'ed25519') {
    policyConflict(`${label} is not Ed25519`, 'CONTINUITY_POLICY_KEY_INVALID');
  }
  if (status === 'compromised') {
    policyConflict(`${label} is compromised`, 'CONTINUITY_POLICY_KEY_COMPROMISED');
  }
  if (!allowedStatuses.includes(status)) {
    policyConflict(`${label} is not usable`, 'CONTINUITY_POLICY_KEY_UNUSABLE');
  }
  if (revokedKeyIds.includes(keyId)) {
    policyConflict(`${label} is revoked`, 'CONTINUITY_POLICY_KEY_REVOKED');
  }
  const parsed = keyMetadata(metadata, `${label}.metadata`);
  if (parsed.metadata.purpose !== purpose) {
    policyConflict(`${label} has the wrong purpose`, 'CONTINUITY_POLICY_KEY_INVALID');
  }
  if (sha256Hex(parsed.publicKey) !== publicKeySha256) {
    policyConflict(
      `${label} public key does not match the approved immutable binding`,
      'CONTINUITY_POLICY_KEY_SUBSTITUTION'
    );
  }
  return {
    publicKey: parsed.publicKey,
    publicKeySha256
  };
}

function approvalObject(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assertApprovalEvidence(row, payload) {
  const metadata = objectValue(row.approval_metadata, 'approval.metadata');
  const receipt = metadata.clinical_continuity_policy_governance;
  const votes = approvalObject(row.approval_approved_by);
  const voteUids = votes.map(vote =>
    typeof vote?.uid === 'string' ? vote.uid.trim().toLowerCase() : ''
  );
  const distinctVotes = new Set(voteUids.filter(uid => UUID_PATTERN.test(uid)));
  const decidingActor =
    typeof row.approval_decided_by === 'string' ? row.approval_decided_by.toLowerCase() : '';
  const approvedBy = typeof row.approved_by === 'string' ? row.approved_by.toLowerCase() : '';
  const decidedAt = Date.parse(row.approval_decided_at);
  const approvedAt = Date.parse(row.approved_at);

  if (
    row.approval_status !== 'approved' ||
    row.approval_kind !== 'clinical_continuity_policy_governance' ||
    row.approval_subject_resource_type !== 'clinical_continuity_policy_version' ||
    String(row.approval_subject_resource_id || '').toLowerCase() !==
      String(row.id || '').toLowerCase() ||
    !UUID_PATTERN.test(decidingActor) ||
    decidingActor !== approvedBy ||
    distinctVotes.size !== votes.length ||
    !distinctVotes.has(decidingActor) ||
    distinctVotes.size < Number(row.approval_required_approvers) ||
    !Number.isFinite(decidedAt) ||
    !Number.isFinite(approvedAt) ||
    approvedAt < decidedAt ||
    !isPlainObject(receipt) ||
    receipt.policy_checksum !== payload.policyChecksum ||
    (payload.policySchemaVersion === CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION &&
      (Number(receipt.action_registry_schema_version) !== payload.actionRegistrySchemaVersion ||
        String(receipt.action_registry_version) !== payload.actionRegistryVersion ||
        receipt.action_registry_checksum !== payload.actionRegistryChecksum ||
        receipt.action_registry_decision_id !== 'C-D3')) ||
    receipt.countersignature_complete !== true
  ) {
    policyConflict(
      'Clinical continuity policy approval evidence is invalid',
      'CONTINUITY_POLICY_APPROVAL_INVALID'
    );
  }
}

function maximumVersion(left, right, { allowZero = false } = {}) {
  const normalizedLeft = normalizeGovernanceVersion(left ?? 0, { allowZero });
  const normalizedRight = normalizeGovernanceVersion(right ?? 0, { allowZero: true });
  return BigInt(normalizedLeft) >= BigInt(normalizedRight) ? normalizedLeft : normalizedRight;
}

function activePolicyFromRow(
  row,
  { minimumPolicyVersion, minimumRevocationEpoch, trustedNow, clockTrusted = false } = {}
) {
  if (row.lifecycle_state !== 'active' || row.facility_status !== 'active') {
    policyConflict(
      'Clinical continuity policy or facility is not active',
      'CONTINUITY_POLICY_NOT_ACTIVE'
    );
  }
  if (
    row.canonicalization !== CLINICAL_CONTINUITY_POLICY_CANONICALIZATION ||
    String(row.signature_algorithm || '').toLowerCase() !== 'ed25519'
  ) {
    policyConflict(
      'Clinical continuity policy signature format is unsupported',
      'CONTINUITY_POLICY_SIGNATURE_INVALID'
    );
  }

  const payload = buildClinicalContinuityPolicySigningPayload(row);
  const rowPolicyFloor = normalizeGovernanceVersion(row.latest_committed_policy_version);
  const rowRevocationFloor = normalizeGovernanceVersion(
    row.latest_committed_revocation_epoch ?? 0,
    { allowZero: true }
  );
  const effectivePolicyFloor = maximumVersion(
    rowPolicyFloor,
    minimumPolicyVersion ?? rowPolicyFloor
  );
  const effectiveRevocationFloor = maximumVersion(
    rowRevocationFloor,
    minimumRevocationEpoch ?? rowRevocationFloor,
    { allowZero: true }
  );
  if (BigInt(payload.policyVersion) < BigInt(effectivePolicyFloor)) {
    policyConflict(
      'Clinical continuity policy version would roll back trusted state',
      'CONTINUITY_POLICY_ROLLBACK'
    );
  }
  if (BigInt(payload.revocationEpoch) < BigInt(effectiveRevocationFloor)) {
    policyConflict(
      'Clinical continuity revocation epoch would roll back trusted state',
      'CONTINUITY_POLICY_REVOCATION_ROLLBACK'
    );
  }

  if (clockTrusted !== true) {
    policyConflict(
      'A trusted clock is required to use clinical continuity policy',
      'CONTINUITY_POLICY_CLOCK_UNCERTAIN'
    );
  }
  const now = normalizedDate(trustedNow, 'trustedNow');
  if (
    Date.parse(now) < Date.parse(payload.effectiveFrom) ||
    (payload.effectiveUntil !== null && Date.parse(now) >= Date.parse(payload.effectiveUntil))
  ) {
    policyConflict(
      'Clinical continuity policy is outside its effective window',
      'CONTINUITY_POLICY_NOT_EFFECTIVE'
    );
  }

  assertApprovalEvidence(row, payload);
  const policyRegistryKey = assertRegistryKey({
    keyId: payload.policySigningKeyId,
    publicKeySha256: payload.policySigningPublicKeySha256,
    algorithm: row.policy_key_algorithm,
    status: row.policy_key_status,
    metadata: row.policy_key_metadata,
    purpose: POLICY_KEY_PURPOSE,
    allowedStatuses: ['active', 'retiring'],
    revokedKeyIds: payload.revokedKeyIds,
    label: 'Policy signing key'
  });
  const currentRegistryKey = assertRegistryKey({
    keyId: payload.currentPackSigningKeyId,
    publicKeySha256: payload.currentPackSigningPublicKeySha256,
    algorithm: row.current_key_algorithm,
    status: row.current_key_status,
    metadata: row.current_key_metadata,
    purpose: PACK_KEY_PURPOSE,
    allowedStatuses: ['active'],
    revokedKeyIds: payload.revokedKeyIds,
    label: 'Current pack signing key'
  });
  const nextRegistryKey =
    payload.nextPackSigningKeyId === null
      ? null
      : assertRegistryKey({
          keyId: payload.nextPackSigningKeyId,
          publicKeySha256: payload.nextPackSigningPublicKeySha256,
          algorithm: row.next_key_algorithm,
          status: row.next_key_status,
          metadata: row.next_key_metadata,
          purpose: PACK_KEY_PURPOSE,
          allowedStatuses: ['active'],
          revokedKeyIds: payload.revokedKeyIds,
          label: 'Next pack signing key'
        });

  if (
    !verifyCanonicalValue(
      payload,
      signatureBase64(row.policy_signature),
      policyRegistryKey.publicKey
    )
  ) {
    policyConflict(
      'Clinical continuity policy signature is invalid',
      'CONTINUITY_POLICY_SIGNATURE_INVALID'
    );
  }

  const trustedKeys = {
    [payload.currentPackSigningKeyId]: {
      algorithm: SIGNATURE_ALGORITHM,
      publicKey: currentRegistryKey.publicKey,
      publicKeySha256: currentRegistryKey.publicKeySha256,
      state: KEY_STATES.CURRENT
    }
  };
  if (payload.nextPackSigningKeyId !== null) {
    trustedKeys[payload.nextPackSigningKeyId] = {
      algorithm: SIGNATURE_ALGORITHM,
      publicKey: nextRegistryKey.publicKey,
      publicKeySha256: nextRegistryKey.publicKeySha256,
      state: KEY_STATES.NEXT
    };
  }
  for (const [keyId, key] of Object.entries(trustedKeys)) {
    const decision = assessSigningKey({
      keyId,
      algorithm: SIGNATURE_ALGORITHM,
      trustedKeys
    });
    if (!decision.ok || key.state !== decision.state) {
      policyConflict(
        'Clinical continuity pack trust key is invalid',
        'CONTINUITY_POLICY_KEY_INVALID'
      );
    }
  }

  const policy = {
    id: String(row.id).toLowerCase(),
    ...(payload.policySchemaVersion === CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION
      ? {
          actionRegistryChecksum: payload.actionRegistryChecksum,
          actionRegistrySchemaVersion: payload.actionRegistrySchemaVersion,
          actionRegistryVersion: payload.actionRegistryVersion
        }
      : {}),
    tenantId: payload.audience.tenantId,
    facilityId: Number(payload.audience.facilityId),
    facilityDisplayName: row.facility_display_name,
    facilityTimezone: row.facility_timezone,
    policyVersion: payload.policyVersion,
    policySchemaVersion: payload.policySchemaVersion,
    packSchemaVersion: payload.policyDocument.packSchemaVersion,
    policyDocument: payload.policyDocument,
    policyChecksum: payload.policyChecksum,
    policySigningKeyId: payload.policySigningKeyId,
    policySigningPublicKeySha256: payload.policySigningPublicKeySha256,
    currentPackSigningKeyId: payload.currentPackSigningKeyId,
    currentPackSigningPublicKeySha256: payload.currentPackSigningPublicKeySha256,
    nextPackSigningKeyId: payload.nextPackSigningKeyId,
    nextPackSigningPublicKeySha256: payload.nextPackSigningPublicKeySha256,
    revocationEpoch: payload.revocationEpoch,
    revokedKeyIds: payload.revokedKeyIds,
    effectiveFrom: payload.effectiveFrom,
    effectiveUntil: payload.effectiveUntil,
    supersedesPolicyId: payload.supersedesPolicyId,
    minimumPolicyVersion: effectivePolicyFloor,
    minimumRevocationEpoch: effectiveRevocationFloor,
    trustedNow: now,
    trustedKeys,
    policyPublicKey: policyRegistryKey.publicKey
  };
  deepFreeze(policy);
  VERIFIED_ACTIVE_POLICIES.add(policy);
  return policy;
}

/**
 * Verify a row already selected with its approval and encryption-key joins.
 * Useful for operator tooling and focused tests; normal generation should use
 * load/enumerate below so the row always comes from a pinned tenant context.
 */
export function verifyActiveClinicalContinuityPolicyRow(row, options = {}) {
  if (!isPlainObject(row)) {
    policyConflict(
      'Clinical continuity policy row is invalid',
      'CONTINUITY_POLICY_DOCUMENT_INVALID'
    );
  }
  return activePolicyFromRow(row, options);
}

/**
 * Pure operator helper for preparing the immutable portion of the next draft.
 * It verifies an externally supplied signature and never generates key
 * material, inserts a row, or changes lifecycle/activation state.
 */
export function prepareClinicalContinuityPolicyDraft(
  value,
  {
    policySigningPublicKey,
    previousPolicyId = null,
    previousPolicyVersion = null,
    previousRevocationEpoch = 0
  } = {}
) {
  const payload = buildClinicalContinuityPolicySigningPayload(value);
  const signature = signatureBase64(rowValue(value, 'policySignature', 'policy_signature'));
  if (!verifyCanonicalValue(payload, signature, policySigningPublicKey)) {
    policyConflict(
      'Clinical continuity policy signature is invalid',
      'CONTINUITY_POLICY_SIGNATURE_INVALID'
    );
  }
  if (previousPolicyVersion === null) {
    if (payload.supersedesPolicyId !== null) {
      policyConflict(
        'The first policy cannot supersede another version',
        'CONTINUITY_POLICY_SUPERSESSION_INVALID'
      );
    }
  } else {
    const priorVersion = normalizeGovernanceVersion(previousPolicyVersion);
    const priorRevocation = normalizeGovernanceVersion(previousRevocationEpoch, {
      allowZero: true
    });
    if (
      BigInt(payload.policyVersion) <= BigInt(priorVersion) ||
      payload.supersedesPolicyId !== normalizedUuid(previousPolicyId, 'previousPolicyId') ||
      BigInt(payload.revocationEpoch) < BigInt(priorRevocation)
    ) {
      policyConflict(
        'Policy version, supersession, or revocation epoch is not monotonic',
        'CONTINUITY_POLICY_SUPERSESSION_INVALID'
      );
    }
  }
  return deepFreeze({
    ...payload,
    lifecycleState: 'draft',
    policySignature: signature
  });
}

async function assertTenantScopeTx(tx, expectedScope, { requireRepeatableRead = false } = {}) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    policyConflict(
      'A caller-supplied tenant transaction is required',
      'CONTINUITY_POLICY_TRANSACTION_REQUIRED'
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant_scope,
            current_setting('transaction_isolation') AS isolation_level`
  );
  const actual = String(rows[0]?.tenant_scope || '').toLowerCase();
  if (actual !== expectedScope) {
    throw AppError.forbidden(
      'Clinical continuity policy transaction is not scoped as requested',
      'CONTINUITY_POLICY_TENANT_SCOPE_MISMATCH'
    );
  }
  if (
    requireRepeatableRead &&
    String(rows[0]?.isolation_level || '').toLowerCase() !== 'repeatable read'
  ) {
    policyConflict(
      'Clinical continuity policy reads require a RepeatableRead transaction',
      'CONTINUITY_POLICY_TX_ISOLATION_INVALID'
    );
  }
}

export async function discoverActiveClinicalContinuityPolicyTenantIds({
  scopeRunner = setTenantTx,
  readOnly = true
} = {}) {
  return scopeRunner(
    null,
    async tx => {
      await assertTenantScopeTx(tx, 'bypass');
      const rows = await tx.$queryRawUnsafe(
        `SELECT id::text AS tenant_id
           FROM tenants
          WHERE status = 'active'
            AND id <> $1::uuid
          ORDER BY id::text`,
        DEFAULT_TENANT_ID
      );
      return rows.map(row => normalizedTenantId(row.tenant_id));
    },
    {
      superAdmin: true,
      readOnly,
      isolationLevel: 'RepeatableRead'
    }
  );
}

function floorForFacility(floors, facilityId) {
  if (floors instanceof Map) return floors.get(facilityId) ?? floors.get(String(facilityId));
  if (isPlainObject(floors)) return floors[facilityId] ?? floors[String(facilityId)];
  return undefined;
}

/**
 * Load one exact active policy inside the caller's already-open clinical-data
 * transaction. Requiring the exact tenant GUC and RepeatableRead isolation
 * keeps the policy, watermark, and producer reads on one coherent snapshot.
 */
export async function loadActiveClinicalContinuityPolicyForFacilityTx({
  tx,
  tenantId,
  facilityId,
  minimumPolicyVersion,
  minimumRevocationEpoch
} = {}) {
  const normalizedTenant = normalizedTenantId(tenantId);
  const normalizedFacility = normalizedFacilityId(facilityId);
  await assertTenantScopeTx(tx, normalizedTenant, { requireRepeatableRead: true });
  const rows = await tx.$queryRawUnsafe(
    POLICY_SELECT_FACILITY_SQL,
    normalizedTenant,
    normalizedFacility
  );
  if (rows.length === 0) {
    policyConflict(
      'No active clinical continuity policy exists for this facility',
      'CONTINUITY_POLICY_NOT_ACTIVE'
    );
  }
  if (rows.length !== 1) {
    policyConflict(
      'Multiple active clinical continuity policies exist for this facility',
      'CONTINUITY_POLICY_ACTIVE_AMBIGUOUS'
    );
  }
  return activePolicyFromRow(rows[0], {
    minimumPolicyVersion,
    minimumRevocationEpoch,
    trustedNow: rows[0].trusted_now,
    clockTrusted: true
  });
}

function historicalActionPolicyFromRow(row, { capturedAt }) {
  const payload = buildClinicalContinuityPolicySigningPayload(row);
  if (payload.policySchemaVersion !== CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION) {
    policyConflict(
      'Only policy-schema v3 can be evaluated as captured action authority',
      'CONTINUITY_ACTION_POLICY_V3_REQUIRED'
    );
  }
  if (!['active', 'retired'].includes(row.lifecycle_state)) {
    policyConflict(
      'Captured action policy was never active',
      'CONTINUITY_ACTION_CAPTURE_POLICY_NOT_ACTIVE'
    );
  }
  assertApprovalEvidence(row, payload);

  const captured = normalizedDate(capturedAt, 'capturedAt');
  if (
    Date.parse(captured) < Date.parse(payload.effectiveFrom) ||
    payload.effectiveUntil === null ||
    Date.parse(captured) >= Date.parse(payload.effectiveUntil)
  ) {
    policyConflict(
      'Captured action policy was outside its finite effective window',
      'CONTINUITY_ACTION_CAPTURE_POLICY_NOT_EFFECTIVE'
    );
  }

  const parsedKey = keyMetadata(row.policy_key_metadata, 'Policy signing key metadata');
  if (
    String(row.policy_key_algorithm || '').toLowerCase() !== 'ed25519' ||
    parsedKey.metadata.purpose !== POLICY_KEY_PURPOSE ||
    sha256Hex(parsedKey.publicKey) !== payload.policySigningPublicKeySha256 ||
    !verifyCanonicalValue(
      payload,
      signatureBase64(row.policy_signature),
      parsedKey.publicKey
    )
  ) {
    policyConflict(
      'Captured action policy signature or key binding is invalid',
      'CONTINUITY_ACTION_CAPTURE_POLICY_INVALID'
    );
  }

  let trustState = 'historical';
  if (row.policy_key_status === 'compromised') {
    trustState = 'compromised';
  } else if (payload.revokedKeyIds.includes(payload.policySigningKeyId)) {
    trustState = 'revoked';
  } else if (!['active', 'retiring', 'retired'].includes(row.policy_key_status)) {
    trustState = 'invalid';
  }

  return deepFreeze({
    id: String(row.id).toLowerCase(),
    tenantId: payload.audience.tenantId,
    facilityId: Number(payload.audience.facilityId),
    policyVersion: payload.policyVersion,
    policySchemaVersion: payload.policySchemaVersion,
    policyChecksum: payload.policyChecksum,
    policySigningKeyId: payload.policySigningKeyId,
    actionRegistryChecksum: payload.actionRegistryChecksum,
    actionRegistrySchemaVersion: payload.actionRegistrySchemaVersion,
    actionRegistryVersion: payload.actionRegistryVersion,
    effectiveFrom: payload.effectiveFrom,
    effectiveUntil: payload.effectiveUntil,
    supersedesPolicyId: payload.supersedesPolicyId,
    revocationEpoch: payload.revocationEpoch,
    revokedKeyIds: payload.revokedKeyIds,
    policyDocument: payload.policyDocument,
    trustState
  });
}

export async function loadHistoricalClinicalContinuityPolicyForActionTx({
  tx,
  tenantId,
  facilityId,
  policyId,
  policyVersion,
  capturedAt
} = {}) {
  const normalizedTenant = normalizedTenantId(tenantId);
  const normalizedFacility = normalizedFacilityId(facilityId);
  const normalizedPolicyId = normalizedUuid(policyId, 'policyId');
  const normalizedPolicyVersion = normalizeGovernanceVersion(policyVersion);
  await assertTenantScopeTx(tx, normalizedTenant, { requireRepeatableRead: true });
  const rows = await tx.$queryRawUnsafe(
    POLICY_SELECT_HISTORICAL_SQL,
    normalizedTenant,
    normalizedFacility,
    normalizedPolicyId,
    normalizedPolicyVersion
  );
  if (rows.length !== 1) {
    policyConflict(
      'Captured action policy is missing or ambiguous',
      'CONTINUITY_ACTION_CAPTURE_POLICY_NOT_FOUND'
    );
  }
  return historicalActionPolicyFromRow(rows[0], { capturedAt });
}

export async function loadActiveClinicalContinuityPoliciesForTenant(
  tenantId,
  {
    scopeRunner = setTenantTx,
    minimumPolicyVersionsByFacility = {},
    minimumRevocationEpochsByFacility = {},
    readOnly = true
  } = {}
) {
  const normalizedTenant = normalizedTenantId(tenantId);
  return scopeRunner(
    normalizedTenant,
    async tx => {
      await assertTenantScopeTx(tx, normalizedTenant);
      const rows = await tx.$queryRawUnsafe(POLICY_SELECT_SQL, normalizedTenant);
      return rows.map(row =>
        activePolicyFromRow(row, {
          minimumPolicyVersion: floorForFacility(minimumPolicyVersionsByFacility, row.facility_id),
          minimumRevocationEpoch: floorForFacility(
            minimumRevocationEpochsByFacility,
            row.facility_id
          ),
          trustedNow: row.trusted_now,
          clockTrusted: true
        })
      );
    },
    {
      readOnly,
      isolationLevel: 'RepeatableRead'
    }
  );
}

export async function enumerateActiveClinicalContinuityPolicies({
  tenantId = null,
  scopeRunner = setTenantTx,
  minimumPolicyVersionsByTenantFacility = {},
  minimumRevocationEpochsByTenantFacility = {},
  readOnly = false
} = {}) {
  const tenantIds =
    tenantId === null
      ? await discoverActiveClinicalContinuityPolicyTenantIds({ scopeRunner, readOnly })
      : [normalizedTenantId(tenantId)];
  const policies = [];
  for (const activeTenantId of tenantIds) {
    const policyFloors = minimumPolicyVersionsByTenantFacility[activeTenantId] ?? {};
    const revocationFloors = minimumRevocationEpochsByTenantFacility[activeTenantId] ?? {};
    policies.push(
      ...(await loadActiveClinicalContinuityPoliciesForTenant(activeTenantId, {
        scopeRunner,
        minimumPolicyVersionsByFacility: policyFloors,
        minimumRevocationEpochsByFacility: revocationFloors,
        readOnly
      }))
    );
  }
  return policies;
}

/**
 * Build the serializable trust-root packet that C3.2/C3.3 must distribute
 * through an operator-provisioned channel independent of the pack/backend.
 */
export function buildOfflineClinicalContinuityTrustRoot(policy) {
  if (!policy || !VERIFIED_ACTIVE_POLICIES.has(policy)) {
    policyConflict(
      'Only a verified active policy can produce an offline trust root',
      'CONTINUITY_POLICY_NOT_VERIFIED'
    );
  }
  const packSigningKeys = Object.entries(policy.trustedKeys)
    .map(([keyId, record]) => ({
      algorithm: SIGNATURE_ALGORITHM,
      keyId,
      publicKeySpkiPem: record.publicKey,
      publicKeySha256: record.publicKeySha256,
      state: record.state
    }))
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
  return deepFreeze({
    algorithm: SIGNATURE_ALGORITHM,
    audience: {
      tenantId: policy.tenantId,
      facilityId: String(policy.facilityId)
    },
    distribution: 'operator_provisioned_out_of_band',
    format: 'vhhealth_clinical_continuity_trust/v1',
    minimumPolicyVersion: policy.minimumPolicyVersion,
    minimumRevocationEpoch: policy.minimumRevocationEpoch,
    packSigningKeys,
    policySigningKey: {
      algorithm: SIGNATURE_ALGORITHM,
      keyId: policy.policySigningKeyId,
      publicKeySpkiPem: policy.policyPublicKey,
      publicKeySha256: policy.policySigningPublicKeySha256
    },
    refusalPolicy: {
      compromisedOrRevokedKey: 'reject_pack_use_paper_and_phone',
      uncertainClock: 'refuse_as_current_use_paper_and_phone',
      versionRollback: 'reject_pack_use_paper_and_phone'
    },
    revocationEpoch: policy.revocationEpoch,
    revokedKeyIds: [...policy.revokedKeyIds]
  });
}
