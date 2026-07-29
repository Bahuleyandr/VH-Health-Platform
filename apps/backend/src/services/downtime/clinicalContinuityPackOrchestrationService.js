import { randomUUID } from 'node:crypto';
import {
  clinicalContinuityPacksEnabled,
  getClinicalContinuityPublicationRoot
} from '../../config/downtimeConfig.js';
import { setTenantTx } from '../../lib/prisma.js';
import {
  DEFAULT_TENANT_ID,
  enumerateActiveClinicalContinuityPolicies,
  loadActiveClinicalContinuityPolicyForFacilityTx
} from './clinicalContinuityPolicyService.js';
import {
  FRESHNESS_STATES,
  KEY_STATES,
  SIGNATURE_ALGORITHM,
  assessSigningKey,
  canonicalizeJson,
  completeSignedPackEnvelope,
  normalizeGovernanceVersion,
  prepareSignedPackEnvelope,
  sha256Hex,
  verifyCanonicalValue,
  verifySignedPackEnvelope
} from './continuityPackCanonical.js';
import { produceFacilityContinuityPacks } from './continuityPackProducers.js';
import {
  normalizeCoverageLocation,
  publishContinuityPackSet
} from './continuityPackPublicationService.js';
import { buildContinuityPackHtml } from './continuityPackRenderer.js';

export const CLINICAL_CONTINUITY_PACK_SCOPE = 'clinical_continuity_pack';
export const CLINICAL_CONTINUITY_MANIFEST_FORMAT = 'vhhealth_clinical_continuity_manifest/v1';
export const CLINICAL_CONTINUITY_SIGNER_PREFLIGHT_FORMAT =
  'vhhealth_clinical_continuity_signer_preflight/v1';

const LOCATION_TYPES = new Set(['ward', 'paeds', 'ed_board', 'opd_day']);
const WARD_LOCATION_TYPES = new Set(['ward', 'paeds']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const FORBIDDEN_BLOOD_GROUP_KEY = /blood.?group|blood.?type|(?:^|[._-])abo(?:$|[._-])|rhesus/iu;
const RESULT_DESCRIPTOR_KEYS = new Set(['item_code', 'item_name', 'test_name']);

export class ClinicalContinuityPackOrchestrationError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'ClinicalContinuityPackOrchestrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function orchestrationError(message, code, details = undefined) {
  return new ClinicalContinuityPackOrchestrationError(message, code, details);
}

function nonBlankString(value, label, maximumLength = 160) {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw orchestrationError(`${label} is invalid`, 'CONTINUITY_PACK_GENERATION_INVALID');
  }
  return value;
}

function canonicalUtcTimestamp(value, label) {
  if (typeof value !== 'string') {
    throw orchestrationError(
      `${label} is not a canonical UTC timestamp`,
      'CONTINUITY_PACK_GENERATION_INVALID'
    );
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw orchestrationError(
      `${label} is not a canonical UTC timestamp`,
      'CONTINUITY_PACK_GENERATION_INVALID'
    );
  }
  return new Date(time).toISOString();
}

function audienceFor(policy) {
  return {
    tenantId: policy.tenantId,
    facilityId: String(policy.facilityId)
  };
}

function normalizePolicyIdentity(policy) {
  const tenantId = String(policy?.tenantId || '').toLowerCase();
  const policyId = String(policy?.id || '').toLowerCase();
  const facilityId = Number(policy?.facilityId);
  if (
    !UUID_PATTERN.test(tenantId) ||
    tenantId === DEFAULT_TENANT_ID ||
    !UUID_PATTERN.test(policyId) ||
    !Number.isSafeInteger(facilityId) ||
    facilityId < 1
  ) {
    throw orchestrationError(
      'A verified non-default-tenant facility policy is required',
      'CONTINUITY_PACK_POLICY_INVALID'
    );
  }
  return {
    tenantId,
    facilityId,
    policyId,
    policyVersion: normalizeGovernanceVersion(policy.policyVersion),
    revocationEpoch: normalizeGovernanceVersion(policy.revocationEpoch, {
      allowZero: true
    }),
    currentPackSigningKeyId: nonBlankString(
      policy.currentPackSigningKeyId,
      'current pack signing key ID',
      64
    )
  };
}

function policyGenerationIdentity(policy) {
  const identity = normalizePolicyIdentity(policy);
  const currentTrustKey = policy?.trustedKeys?.[identity.currentPackSigningKeyId];
  return {
    ...identity,
    policyChecksum: policy.policyChecksum,
    policySchemaVersion: policy.policySchemaVersion,
    packSchemaVersion: policy.packSchemaVersion,
    currentPackSigningPublicKey: currentTrustKey?.publicKey
  };
}

function assertSamePolicy(discoveredPolicy, transactionPolicy) {
  const discovered = policyGenerationIdentity(discoveredPolicy);
  const exact = policyGenerationIdentity(transactionPolicy);
  if (Object.keys(discovered).some(key => discovered[key] !== exact[key])) {
    throw orchestrationError(
      'The active policy changed after discovery; generation must restart',
      'CONTINUITY_PACK_POLICY_CHANGED',
      {
        tenantId: discovered.tenantId,
        facilityId: discovered.facilityId
      }
    );
  }
}

function policyCoverage(policy) {
  const required = policy?.policyDocument?.requiredCoverage;
  if (!required || typeof required !== 'object' || Array.isArray(required)) {
    throw orchestrationError(
      'The verified policy has no required coverage',
      'CONTINUITY_PACK_POLICY_INVALID'
    );
  }
  const locations = [];
  for (const entry of required.wards || []) {
    const wardId = Number(entry.wardId);
    if (!Number.isSafeInteger(wardId) || wardId < 1) {
      throw orchestrationError('Policy ward coverage is invalid', 'CONTINUITY_PACK_POLICY_INVALID');
    }
    locations.push({
      locationType: 'ward',
      locationId: entry.locationIdentifier || `ward-${wardId}`,
      wardId
    });
  }
  for (const entry of required.paediatricWards || []) {
    const wardId = Number(entry.wardId);
    if (!Number.isSafeInteger(wardId) || wardId < 1) {
      throw orchestrationError(
        'Policy paediatric ward coverage is invalid',
        'CONTINUITY_PACK_POLICY_INVALID'
      );
    }
    locations.push({
      locationType: 'paeds',
      locationId: entry.locationIdentifier || `ward-${wardId}`,
      wardId
    });
  }
  for (const entry of required.edBoards || []) {
    locations.push({
      locationType: 'ed_board',
      locationId: entry.locationIdentifier
    });
  }
  for (const entry of required.opdClinicDays || []) {
    locations.push({
      locationType: 'opd_day',
      locationId: entry.locationIdentifier
    });
  }

  const keys = locations.map(
    ({ locationType, locationId }) =>
      `${nonBlankString(locationType, 'location type', 32)}/${nonBlankString(
        locationId,
        'location identifier'
      )}`
  );
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw orchestrationError(
      'Policy coverage must be non-empty and collision-free',
      'CONTINUITY_PACK_COVERAGE_INVALID'
    );
  }
  return locations;
}

function packLocation(pack) {
  const locationType = nonBlankString(pack?.location?.type, 'pack location type', 32);
  const locationId = nonBlankString(
    pack?.location?.identifier ?? pack?.location?.id,
    'pack location identifier'
  );
  if (!LOCATION_TYPES.has(locationType)) {
    throw orchestrationError(
      'Pack location type is unsupported',
      'CONTINUITY_PACK_COVERAGE_INVALID'
    );
  }
  const wardId = WARD_LOCATION_TYPES.has(locationType) ? Number(pack?.location?.ward_id) : null;
  if (
    (WARD_LOCATION_TYPES.has(locationType) && (!Number.isSafeInteger(wardId) || wardId < 1)) ||
    (!WARD_LOCATION_TYPES.has(locationType) && pack?.location?.ward_id != null)
  ) {
    throw orchestrationError('Pack ward coverage is invalid', 'CONTINUITY_PACK_COVERAGE_INVALID');
  }
  return { locationType, locationId, wardId };
}

function assertEnvelopeField(field, label) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw orchestrationError(
      `${label} must carry an explicit known/unknown state`,
      'CONTINUITY_PACK_SAFETY_FIELD_INVALID'
    );
  }
  if (field.state === 'known') {
    canonicalUtcTimestamp(field.recorded_at, `${label}.recorded_at`);
    return;
  }
  if (
    field.state !== 'unknown' ||
    field.recorded_at !== null ||
    typeof field.reason !== 'string' ||
    field.reason.trim().length === 0
  ) {
    throw orchestrationError(
      `${label} must carry an explicit known/unknown state`,
      'CONTINUITY_PACK_SAFETY_FIELD_INVALID'
    );
  }
}

function assertPatientSafetyFields(patient, locationType, patientIndex) {
  const prefix = `patients[${patientIndex}]`;
  assertEnvelopeField(patient.identity, `${prefix}.identity`);
  const identity = patient.identity.value;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw orchestrationError(
      `${prefix}.identity value is invalid`,
      'CONTINUITY_PACK_SAFETY_FIELD_INVALID'
    );
  }
  assertEnvelopeField(identity.name, `${prefix}.identity.name`);
  assertEnvelopeField(identity.mrn, `${prefix}.identity.mrn`);
  assertEnvelopeField(identity.uid, `${prefix}.identity.uid`);
  assertEnvelopeField(identity.dob, `${prefix}.identity.dob`);

  for (const field of [
    'allergies',
    'code_status',
    'isolation',
    'location',
    'attending',
    'diagnosis',
    'latest_vitals',
    'news2',
    'medications_due',
    'active_medication_orders',
    'recently_administered_medications',
    'unresolved_critical_results',
    'recent_released_results',
    'care_team'
  ]) {
    assertEnvelopeField(patient[field], `${prefix}.${field}`);
  }
  if (locationType === 'paeds') {
    assertEnvelopeField(patient.latest_weight, `${prefix}.latest_weight`);
  }
  if (locationType === 'ed_board') {
    for (const field of ['arrival_at', 'triage', 'time_in_department']) {
      assertEnvelopeField(patient[field], `${prefix}.${field}`);
    }
  }
  if (locationType === 'opd_day') {
    for (const field of ['appointment_time', 'appointment_status', 'phone']) {
      assertEnvelopeField(patient[field], `${prefix}.${field}`);
    }
  }
}

function assertBloodGroupExcluded(value) {
  if (Array.isArray(value)) {
    value.forEach(entry => assertBloodGroupExcluded(entry));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (
      FORBIDDEN_BLOOD_GROUP_KEY.test(entryKey) ||
      (RESULT_DESCRIPTOR_KEYS.has(entryKey) &&
        typeof entryValue === 'string' &&
        FORBIDDEN_BLOOD_GROUP_KEY.test(entryValue))
    ) {
      throw orchestrationError(
        'Blood group is excluded from continuity packs',
        'CONTINUITY_PACK_BLOOD_GROUP_FORBIDDEN'
      );
    }
    assertBloodGroupExcluded(entryValue, entryKey);
  }
}

function validateProducedPack(pack, policy) {
  const policyIdentity = normalizePolicyIdentity(policy);
  const location = packLocation(pack);
  const wardId = WARD_LOCATION_TYPES.has(location.locationType)
    ? Number(pack.location.ward_id)
    : null;
  if (
    String(pack.tenant_id || '').toLowerCase() !== policyIdentity.tenantId ||
    Number(pack.facility?.id) !== policyIdentity.facilityId ||
    pack.facility?.timezone !== policy.facilityTimezone ||
    String(pack.policy?.id || '').toLowerCase() !== policyIdentity.policyId ||
    normalizeGovernanceVersion(pack.policy?.version) !== policyIdentity.policyVersion ||
    normalizeGovernanceVersion(pack.policy?.revocation_epoch, {
      allowZero: true
    }) !== policyIdentity.revocationEpoch ||
    Number(pack.pack_schema_version) !== Number(policy.packSchemaVersion) ||
    pack.historical_mode !== false ||
    (WARD_LOCATION_TYPES.has(location.locationType) &&
      (!Number.isSafeInteger(wardId) || wardId < 1)) ||
    (!WARD_LOCATION_TYPES.has(location.locationType) && pack.location.ward_id != null)
  ) {
    throw orchestrationError(
      'Produced pack does not match the pinned policy audience',
      'CONTINUITY_PACK_GENERATION_INVALID'
    );
  }

  const generatedAt = canonicalUtcTimestamp(pack.generated_at, 'generated_at');
  const freshUntil = canonicalUtcTimestamp(pack.fresh_until, 'fresh_until');
  const expiresAt = canonicalUtcTimestamp(pack.expires_at, 'expires_at');
  const notValidAfter = canonicalUtcTimestamp(pack.not_valid_after, 'not_valid_after');
  if (
    canonicalUtcTimestamp(pack.source_watermark?.captured_at, 'source_watermark.captured_at') !==
      generatedAt ||
    Date.parse(freshUntil) !== Date.parse(generatedAt) + 15 * 60 * 1000 ||
    Date.parse(expiresAt) !== Date.parse(generatedAt) + 24 * 60 * 60 * 1000 ||
    notValidAfter !== expiresAt
  ) {
    throw orchestrationError(
      'Produced pack violates the approved freshness window',
      'CONTINUITY_PACK_FRESHNESS_INVALID'
    );
  }

  if (!Array.isArray(pack.patients)) {
    throw orchestrationError(
      'Produced pack patients must be an array',
      'CONTINUITY_PACK_GENERATION_INVALID'
    );
  }
  pack.patients.forEach((patient, index) => {
    if (!patient || typeof patient !== 'object' || Array.isArray(patient)) {
      throw orchestrationError(
        `patients[${index}] is invalid`,
        'CONTINUITY_PACK_GENERATION_INVALID'
      );
    }
    assertPatientSafetyFields(patient, location.locationType, index);
  });
  if (
    location.locationType === 'opd_day' &&
    String(pack.handling?.printed_sheet || '').toUpperCase() !== 'DESTROY AFTER CLINIC DAY'
  ) {
    throw orchestrationError(
      'OPD packs require the destroy-after-clinic-day handling line',
      'CONTINUITY_PACK_GENERATION_INVALID'
    );
  }
  assertBloodGroupExcluded(pack);
  canonicalizeJson(pack);
  return {
    ...location,
    generatedAt,
    freshUntil,
    expiresAt,
    wardId
  };
}

function assertExactProducedCoverage(requiredCoverage, packs) {
  if (!Array.isArray(packs)) {
    throw orchestrationError(
      'Producer did not return a pack array',
      'CONTINUITY_PACK_COVERAGE_INVALID'
    );
  }
  const requiredByKey = new Map(
    requiredCoverage.map(location => [`${location.locationType}/${location.locationId}`, location])
  );
  const produced = packs.map(pack => packLocation(pack));
  const producedByKey = new Map(
    produced.map(location => [`${location.locationType}/${location.locationId}`, location])
  );
  const requiredKeys = [...requiredByKey.keys()].sort();
  const producedKeys = [...producedByKey.keys()].sort();
  if (
    producedByKey.size !== produced.length ||
    new Set(producedKeys).size !== producedKeys.length ||
    requiredKeys.length !== producedKeys.length ||
    requiredKeys.some(
      (key, index) =>
        key !== producedKeys[index] ||
        (requiredByKey.get(key).wardId ?? null) !== (producedByKey.get(key)?.wardId ?? null)
    )
  ) {
    throw orchestrationError(
      'Produced coverage does not exactly match the active policy',
      'CONTINUITY_PACK_COVERAGE_INCOMPLETE',
      { required: requiredKeys, produced: producedKeys }
    );
  }
  return produced;
}

async function requestExternalSignature({ signer, policy, payload }) {
  if (!signer || typeof signer.sign !== 'function') {
    throw orchestrationError(
      'No operator-injected clinical continuity signer is available',
      'CONTINUITY_PACK_SIGNER_NOT_CONFIGURED'
    );
  }
  const signature = await signer.sign({
    algorithm: SIGNATURE_ALGORITHM,
    keyId: policy.currentPackSigningKeyId,
    payload
  });
  if (
    typeof signature !== 'string' ||
    !SIGNATURE_BASE64_PATTERN.test(signature) ||
    Buffer.from(signature, 'base64').length !== 64
  ) {
    throw orchestrationError(
      'The external signer returned an invalid Ed25519 signature',
      'CONTINUITY_PACK_SIGNATURE_INVALID'
    );
  }
  return signature;
}

async function preflightSigner(signer, policy) {
  const identity = normalizePolicyIdentity(policy);
  const keyDecision = assessSigningKey({
    keyId: identity.currentPackSigningKeyId,
    algorithm: SIGNATURE_ALGORITHM,
    trustedKeys: policy.trustedKeys,
    expectedKeyId: identity.currentPackSigningKeyId
  });
  if (!keyDecision.ok || keyDecision.state !== KEY_STATES.CURRENT) {
    throw orchestrationError(
      'The policy current signing key is not usable',
      'CONTINUITY_PACK_SIGNING_KEY_UNUSABLE',
      { reason: keyDecision.reason }
    );
  }

  const challenge = {
    algorithm: SIGNATURE_ALGORITHM,
    audience: audienceFor(policy),
    format: CLINICAL_CONTINUITY_SIGNER_PREFLIGHT_FORMAT,
    keyId: identity.currentPackSigningKeyId,
    nonce: randomUUID(),
    policyVersion: identity.policyVersion,
    purpose: 'signer_preflight',
    revocationEpoch: identity.revocationEpoch,
    trustedAt: canonicalUtcTimestamp(policy.trustedNow, 'policy trustedNow')
  };
  const signature = await requestExternalSignature({
    signer,
    policy,
    payload: Buffer.from(canonicalizeJson(challenge), 'utf8')
  });
  if (!verifyCanonicalValue(challenge, signature, keyDecision.publicKey)) {
    throw orchestrationError(
      'The external signer does not match the active policy trust root',
      'CONTINUITY_PACK_SIGNATURE_INVALID'
    );
  }
}

async function createExternallySignedEnvelope({
  signer,
  policy,
  content,
  rendered,
  manifestVersion,
  issuedAt,
  expiresAt
}) {
  const prepared = prepareSignedPackEnvelope({
    audience: audienceFor(policy),
    content,
    expiresAt,
    issuedAt,
    keyId: policy.currentPackSigningKeyId,
    manifestVersion,
    policyVersion: policy.policyVersion,
    rendered,
    revocationEpoch: policy.revocationEpoch
  });
  const signature = await requestExternalSignature({
    signer,
    policy,
    payload: prepared.signingBytes
  });
  const envelope = completeSignedPackEnvelope(prepared, signature);
  if (
    !verifyCanonicalValue(
      prepared.unsignedEnvelope,
      signature,
      policy.trustedKeys[policy.currentPackSigningKeyId]?.publicKey
    )
  ) {
    throw orchestrationError(
      'The external signer returned a signature that failed local verification',
      'CONTINUITY_PACK_SIGNATURE_INVALID'
    );
  }
  return envelope;
}

function assertSelfVerified({ envelope, rendered, policy, manifestVersion, trustedNow }) {
  const verification = verifySignedPackEnvelope(envelope, {
    rendered,
    trustedKeys: policy.trustedKeys,
    expectedKeyId: policy.currentPackSigningKeyId,
    expectedAudience: audienceFor(policy),
    minimumManifestVersion: manifestVersion,
    minimumPolicyVersion: policy.policyVersion,
    minimumRevocationEpoch: policy.revocationEpoch,
    trustedNow,
    minimumTrustedNow: policy.trustedNow,
    clockTrusted: true
  });
  if (!verification.ok) {
    throw orchestrationError(
      'Signed continuity content failed local verification',
      'CONTINUITY_PACK_SIGNATURE_INVALID',
      { reason: verification.reason }
    );
  }
  return verification;
}

function packAssetRecord(location, relativePath, content) {
  return {
    ...location,
    relativePath,
    content
  };
}

function manifestEntry(record) {
  return {
    contentHash: record.envelope.contentHash,
    expiresAt: record.envelope.expiresAt,
    generatedAt: record.envelope.issuedAt,
    keyId: record.envelope.keyId,
    locationId: record.location.locationId,
    locationType: record.location.locationType,
    packHtmlSha256: sha256Hex(record.html),
    packJsonSha256: sha256Hex(record.json),
    renderHash: record.envelope.renderHash
  };
}

function evidenceSourceWatermark(pack, receipt, location) {
  const normalizedLocation = normalizeCoverageLocation(location);
  const assetHashes = Object.fromEntries(
    receipt.assets
      .filter(
        asset =>
          asset.locationType === normalizedLocation.locationType &&
          asset.locationId === normalizedLocation.locationId
      )
      .map(asset => [asset.relativePath.split('/').at(-1), asset.sha256])
  );
  if (
    typeof assetHashes['pack.json'] !== 'string' ||
    typeof assetHashes['pack.html'] !== 'string'
  ) {
    throw orchestrationError(
      'Publication evidence receipt is missing signed pack assets',
      'CONTINUITY_PACK_PUBLICATION_RECEIPT_INVALID'
    );
  }
  return {
    ...pack.source_watermark,
    publication: {
      asset_sha256: assetHashes,
      manifest_sha256: receipt.manifestSha256,
      set_name: receipt.setName
    }
  };
}

async function insertPublicationEvidence({
  tenantId,
  facilityId,
  policy,
  manifestVersion,
  publicationSetId,
  signedPacks,
  receipt
}) {
  return setTenantTx(tenantId, async tx => {
    const publishedRows = await tx.$queryRawUnsafe(`SELECT clock_timestamp() AS published_at`);
    const databasePublishedAt = publishedRows[0]?.published_at;
    const publishedAt = canonicalUtcTimestamp(
      databasePublishedAt instanceof Date ? databasePublishedAt.toISOString() : databasePublishedAt,
      'publication time'
    );
    for (const record of signedPacks) {
      if (Date.parse(publishedAt) >= Date.parse(record.location.expiresAt)) {
        throw orchestrationError(
          'A continuity pack expired before publication evidence could be committed',
          'CONTINUITY_PACK_EXPIRED_BEFORE_PUBLICATION'
        );
      }
      if (Date.parse(publishedAt) > Date.parse(record.location.freshUntil)) {
        throw orchestrationError(
          'A continuity pack aged before publication evidence could be committed',
          'CONTINUITY_PACK_AGED_BEFORE_PUBLICATION'
        );
      }
    }
    for (const record of signedPacks) {
      const label = String(
        record.pack.location?.label ||
          `${record.location.locationType} ${record.location.locationId}`
      ).slice(0, 160);
      const freshnessMetadata = {
        current_for_minutes: 15,
        facility_timezone: record.pack.facility.timezone,
        hard_expiry_hours: 24,
        historical_mode: false,
        state_at_publication: FRESHNESS_STATES.CURRENT
      };
      await tx.$executeRawUnsafe(
        `INSERT INTO downtime_snapshots (
           tenant_id, facility_id, ward_id, label, scope, generated_by,
           payload, expires_at, location_type, location_identifier,
           pack_schema_version, policy_version_id, policy_version,
           publication_set_id, manifest_version, source_watermark,
           content_hash, rendered_content_hash, signature_algorithm,
           signing_key_id, signature, generated_at, published_at, fresh_until,
           freshness_metadata, retention_until
         )
         VALUES (
           $1::uuid, $2::int, $3::int, $4, 'clinical_continuity_pack', NULL,
           $5::jsonb, $6::timestamptz, $7, $8,
           $9::int, $10::uuid, $11::bigint,
           $12::uuid, $13::bigint, $14::jsonb,
           $15, $16, $17,
           $18, $19::bytea, $20::timestamptz, $21::timestamptz, $22::timestamptz,
           $23::jsonb, $24::timestamptz
         )`,
        tenantId,
        facilityId,
        record.location.wardId,
        label,
        JSON.stringify(record.envelope),
        record.location.expiresAt,
        record.location.locationType,
        record.location.locationId,
        Number(policy.packSchemaVersion),
        policy.id,
        policy.policyVersion,
        publicationSetId,
        manifestVersion,
        JSON.stringify(evidenceSourceWatermark(record.pack, receipt, record.location)),
        record.envelope.contentHash,
        record.envelope.renderHash,
        SIGNATURE_ALGORITHM.toLowerCase(),
        record.envelope.keyId,
        Buffer.from(record.envelope.signature, 'base64'),
        record.location.generatedAt,
        publishedAt,
        record.location.freshUntil,
        JSON.stringify(freshnessMetadata),
        record.location.expiresAt
      );
    }
    return publishedAt;
  });
}

async function produceFacilitySet({ discoveredPolicy }) {
  const identity = normalizePolicyIdentity(discoveredPolicy);
  return setTenantTx(
    identity.tenantId,
    async tx => {
      const policy = await loadActiveClinicalContinuityPolicyForFacilityTx({
        tx,
        tenantId: identity.tenantId,
        facilityId: identity.facilityId,
        minimumPolicyVersion: discoveredPolicy.minimumPolicyVersion,
        minimumRevocationEpoch: discoveredPolicy.minimumRevocationEpoch
      });
      assertSamePolicy(discoveredPolicy, policy);
      const versionRows = await tx.$queryRawUnsafe(
        `SELECT nextval('clinical_continuity_manifest_version_seq')::text
                AS manifest_version`
      );
      const manifestVersion = normalizeGovernanceVersion(versionRows[0]?.manifest_version);
      const produced = await produceFacilityContinuityPacks({
        tx,
        tenantId: identity.tenantId,
        facilityId: identity.facilityId,
        policy
      });
      return { manifestVersion, policy, produced };
    },
    { isolationLevel: 'RepeatableRead', readOnly: false }
  );
}

async function signAndPublishFacilitySet({ root, signer, manifestVersion, policy, produced }) {
  const requiredCoverage = policyCoverage(policy);
  assertExactProducedCoverage(requiredCoverage, produced.packs);
  if (
    !produced.source_watermark ||
    typeof produced.source_watermark !== 'object' ||
    Array.isArray(produced.source_watermark)
  ) {
    throw orchestrationError(
      'Facility producer result has no source watermark',
      'CONTINUITY_PACK_GENERATION_INVALID'
    );
  }
  if (
    String(produced.tenant_id || '').toLowerCase() !== policy.tenantId ||
    Number(produced.facility?.id) !== policy.facilityId ||
    String(produced.policy_version_id || '').toLowerCase() !== policy.id ||
    normalizeGovernanceVersion(produced.policy_version) !== policy.policyVersion
  ) {
    throw orchestrationError(
      'Facility producer result does not match the pinned policy',
      'CONTINUITY_PACK_GENERATION_INVALID'
    );
  }

  const signedPacks = [];
  for (const pack of produced.packs) {
    const location = validateProducedPack(pack, policy);
    if (canonicalizeJson(pack.source_watermark) !== canonicalizeJson(produced.source_watermark)) {
      throw orchestrationError(
        'Produced pack does not share the facility source watermark',
        'CONTINUITY_PACK_GENERATION_INVALID'
      );
    }
    const freshness = {
      ageMs: 0,
      fallback: { paper: false, phone: false },
      packAccess: { display: true, print: true },
      reason: null,
      state: FRESHNESS_STATES.CURRENT
    };
    const html = buildContinuityPackHtml(pack, {
      clockTrusted: true,
      freshness,
      trustedNow: location.generatedAt
    });
    const envelope = await createExternallySignedEnvelope({
      signer,
      policy,
      content: pack,
      rendered: html,
      manifestVersion,
      issuedAt: location.generatedAt,
      expiresAt: location.expiresAt
    });
    assertSelfVerified({
      envelope,
      rendered: html,
      policy,
      manifestVersion,
      trustedNow: location.generatedAt
    });
    signedPacks.push({
      envelope,
      html,
      json: `${canonicalizeJson(envelope)}\n`,
      location,
      pack
    });
  }

  const manifestIssuedAt = signedPacks[0].location.generatedAt;
  const manifestExpiresAt = signedPacks.map(record => record.location.expiresAt).sort()[0];
  const publicationSetId = randomUUID();
  const manifest = {
    facility: {
      id: String(policy.facilityId),
      name: produced.facility.name,
      timezone: produced.facility.timezone
    },
    format: CLINICAL_CONTINUITY_MANIFEST_FORMAT,
    generatedAt: manifestIssuedAt,
    locations: signedPacks.map(manifestEntry),
    manifestVersion,
    publicationSetId,
    policy: {
      checksum: policy.policyChecksum,
      id: policy.id,
      revocationEpoch: policy.revocationEpoch,
      version: policy.policyVersion
    },
    sourceWatermark: produced.source_watermark,
    tenantId: policy.tenantId
  };
  const manifestRendered = canonicalizeJson(manifest);
  const manifestEnvelope = await createExternallySignedEnvelope({
    signer,
    policy,
    content: manifest,
    rendered: manifestRendered,
    manifestVersion,
    issuedAt: manifestIssuedAt,
    expiresAt: manifestExpiresAt
  });
  assertSelfVerified({
    envelope: manifestEnvelope,
    rendered: manifestRendered,
    policy,
    manifestVersion,
    trustedNow: manifestIssuedAt
  });

  const assets = signedPacks.flatMap(record => [
    packAssetRecord(record.location, 'pack.json', record.json),
    packAssetRecord(record.location, 'pack.html', record.html)
  ]);
  return publishContinuityPackSet({
    root,
    tenantId: policy.tenantId,
    facilityId: policy.facilityId,
    manifestVersion,
    requiredCoverage,
    assets,
    manifestContent: `${canonicalizeJson(manifestEnvelope)}\n`,
    commitEvidence: receipt =>
      insertPublicationEvidence({
        tenantId: policy.tenantId,
        facilityId: policy.facilityId,
        policy,
        manifestVersion,
        publicationSetId,
        signedPacks,
        receipt
      })
  });
}

/**
 * Generate the feature-gated C3.1 facility sweep.
 *
 * `signer.sign(...)` is deliberately the only signing integration point. It
 * receives canonical bytes and must return a canonical base64 Ed25519
 * signature; this module never loads, generates, or stores a private key.
 */
export async function generateClinicalContinuityPackSets({ signer, env = process.env } = {}) {
  if (!clinicalContinuityPacksEnabled(env)) return [];
  const root = getClinicalContinuityPublicationRoot(env);
  const policies = await enumerateActiveClinicalContinuityPolicies({
    readOnly: false
  });
  if (policies.length === 0) return [];

  const facilityKeys = policies.map(policy => {
    const identity = normalizePolicyIdentity(policy);
    return `${identity.tenantId}/${identity.facilityId}`;
  });
  if (new Set(facilityKeys).size !== facilityKeys.length) {
    throw orchestrationError(
      'Policy enumeration returned duplicate tenant/facility targets',
      'CONTINUITY_PACK_POLICY_AMBIGUOUS'
    );
  }

  for (const policy of policies) {
    await preflightSigner(signer, policy);
  }

  const results = [];
  for (const discoveredPolicy of policies) {
    const generated = await produceFacilitySet({ discoveredPolicy });
    results.push(
      await signAndPublishFacilitySet({
        root,
        signer,
        ...generated
      })
    );
  }
  return results;
}

export default {
  generateClinicalContinuityPackSets,
  CLINICAL_CONTINUITY_PACK_SCOPE,
  CLINICAL_CONTINUITY_MANIFEST_FORMAT,
  CLINICAL_CONTINUITY_SIGNER_PREFLIGHT_FORMAT,
  ClinicalContinuityPackOrchestrationError
};
