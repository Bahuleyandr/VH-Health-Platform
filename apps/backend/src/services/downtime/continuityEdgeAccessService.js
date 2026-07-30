import { createHash, X509Certificate } from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import {
  loadActiveClinicalContinuityPolicyForFacilityTx,
  requireClinicalContinuityEdgePolicy
} from './clinicalContinuityPolicyService.js';
import {
  canonicalizeJson,
  hashCanonicalValue,
  normalizeGovernanceVersion,
  verifyCanonicalValue
} from './continuityPackCanonical.js';

export const CONTINUITY_EDGE_ACCESS_FORMAT = 'vhhealth_continuity_edge_access/v1';
export const CONTINUITY_EDGE_LOG_BATCH_FORMAT = 'vhhealth_continuity_edge_log_batch/v1';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const LOCATION_TYPES = new Set(['ward', 'paeds', 'ed_board', 'opd_day']);
const DEVICE_PATTERN = /^(?!.*\p{Cc})[\s\S]{1,160}$/u;
const LOCATION_PATTERN = /^(?!.*[/\\])(?!.*\p{Cc})[\s\S]{1,160}$/u;
const BATCH_ID_PATTERN = /^(?!.*\p{Cc})[\s\S]{1,160}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const MAX_LOG_BATCH_EVENTS = 10_000;

export class ContinuityEdgeAccessError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'ContinuityEdgeAccessError';
    this.code = code;
    this.details = details;
  }
}

function accessError(message, code, details = undefined) {
  return new ContinuityEdgeAccessError(message, code, details);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw accessError(`${label} must be an object`, 'CONTINUITY_EDGE_INPUT_INVALID');
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw accessError(`${label} has an unsupported shape`, 'CONTINUITY_EDGE_INPUT_INVALID');
  }
  return value;
}

function uuid(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw accessError(`${label} must be a UUID`, 'CONTINUITY_EDGE_SCOPE_INVALID');
  }
  return normalized;
}

function tenantId(value) {
  const normalized = uuid(value, 'tenantId');
  if (normalized === DEFAULT_TENANT_ID) {
    throw accessError(
      'The default tenant cannot own continuity edge access',
      'CONTINUITY_EDGE_DEFAULT_TENANT_REJECTED'
    );
  }
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw accessError(`${label} must be a positive integer`, 'CONTINUITY_EDGE_SCOPE_INVALID');
  }
  return normalized;
}

function boundedString(value, label, pattern) {
  const normalized = String(value || '').trim();
  if (!pattern.test(normalized)) {
    throw accessError(`${label} is invalid`, 'CONTINUITY_EDGE_SCOPE_INVALID');
  }
  return normalized;
}

function locationType(value) {
  const normalized = String(value || '');
  if (!LOCATION_TYPES.has(normalized)) {
    throw accessError(
      'locationType is unsupported',
      'CONTINUITY_EDGE_SCOPE_INVALID'
    );
  }
  return normalized;
}

function timestamp(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw accessError(`${label} must be a valid timestamp`, 'CONTINUITY_EDGE_TIME_INVALID');
  }
  return parsed.toISOString();
}

function optionalHash(value, label) {
  if (value == null) return null;
  const normalized = String(value).toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw accessError(`${label} must be a SHA-256 hash`, 'CONTINUITY_EDGE_HASH_INVALID');
  }
  return normalized;
}

function requiredHash(value, label) {
  const normalized = optionalHash(value, label);
  if (normalized === null) {
    throw accessError(`${label} is required`, 'CONTINUITY_EDGE_HASH_INVALID');
  }
  return normalized;
}

function serializeRow(row) {
  if (!row) return null;
  const serialized = {};
  for (const [key, value] of Object.entries(row)) {
    serialized[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return serialized;
}

function certificate(value) {
  let parsed;
  try {
    parsed = value instanceof X509Certificate ? value : new X509Certificate(value);
  } catch {
    throw accessError(
      'A valid public X.509 client certificate is required',
      'CONTINUITY_EDGE_CERTIFICATE_INVALID'
    );
  }
  const fingerprint = parsed.fingerprint256.replaceAll(':', '').toLowerCase();
  if (!HASH_PATTERN.test(fingerprint)) {
    throw accessError(
      'The client certificate fingerprint is invalid',
      'CONTINUITY_EDGE_CERTIFICATE_INVALID'
    );
  }
  if (parsed.publicKey.asymmetricKeyType !== 'ed25519') {
    throw accessError(
      'The client certificate must contain an Ed25519 public key',
      'CONTINUITY_EDGE_CERTIFICATE_ALGORITHM_INVALID'
    );
  }
  return { certificate: parsed, fingerprint };
}

export function fingerprintContinuityEdgeCertificate(certificatePem) {
  return certificate(certificatePem).fingerprint;
}

function coverageLocations(policy) {
  const coverage = policy?.policyDocument?.requiredCoverage || {};
  const values = [];
  for (const entry of coverage.wards || []) {
    values.push(['ward', entry.locationIdentifier || `ward-${entry.wardId}`]);
  }
  for (const entry of coverage.paediatricWards || []) {
    values.push(['paeds', entry.locationIdentifier || `ward-${entry.wardId}`]);
  }
  for (const entry of coverage.edBoards || []) {
    values.push(['ed_board', entry.locationIdentifier]);
  }
  for (const entry of coverage.opdClinicDays || []) {
    values.push(['opd_day', entry.locationIdentifier]);
  }
  return new Set(values.map(([type, identifier]) => `${type}/${identifier}`));
}

function assertLocationCovered(policy, type, identifier) {
  if (!coverageLocations(policy).has(`${type}/${identifier}`)) {
    throw accessError(
      'The requested location is not in the signed policy coverage',
      'CONTINUITY_EDGE_LOCATION_NOT_COVERED'
    );
  }
}

function assertPolicyPin(policy, policyVersionId, policyVersion) {
  const expectedId = uuid(policyVersionId, 'policyVersionId');
  const expectedVersion = normalizeGovernanceVersion(policyVersion);
  if (
    policy.id !== expectedId ||
    policy.policyVersion !== expectedVersion
  ) {
    throw accessError(
      'The operator-supplied policy pin is not the verified active policy',
      'CONTINUITY_EDGE_POLICY_PIN_MISMATCH'
    );
  }
  return { policyVersionId: expectedId, policyVersion: expectedVersion };
}

function normalizeGrantInput(value) {
  const type = locationType(value.locationType);
  const identifier = boundedString(
    value.locationIdentifier,
    'locationIdentifier',
    LOCATION_PATTERN
  );
  const validFrom = timestamp(value.validFrom, 'validFrom');
  const validUntil = timestamp(value.validUntil, 'validUntil');
  if (Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw accessError(
      'validUntil must be later than validFrom',
      'CONTINUITY_EDGE_TIME_INVALID'
    );
  }
  return {
    tenantId: tenantId(value.tenantId),
    facilityId: positiveInteger(value.facilityId, 'facilityId'),
    locationType: type,
    locationIdentifier: identifier,
    staffUid: uuid(value.staffUid, 'staffUid'),
    deviceId: boundedString(value.deviceId, 'deviceId', DEVICE_PATTERN),
    certificatePem: value.certificatePem,
    validFrom,
    validUntil,
    policyVersionId: uuid(value.policyVersionId, 'policyVersionId'),
    policyVersion: normalizeGovernanceVersion(value.policyVersion),
    createdBy: uuid(value.createdBy, 'createdBy')
  };
}

async function activeEdgePolicy({
  tx,
  tenant,
  facility,
  policyLoader,
  edgePolicyRequirement
}) {
  const policy = await policyLoader({
    tx,
    tenantId: tenant,
    facilityId: facility
  });
  const decisions = edgePolicyRequirement(policy);
  return { policy, decisions };
}

export async function createContinuityEdgeGrant(
  input,
  {
    scopeRunner = setTenantTx,
    policyLoader = loadActiveClinicalContinuityPolicyForFacilityTx,
    edgePolicyRequirement = requireClinicalContinuityEdgePolicy
  } = {}
) {
  const normalized = normalizeGrantInput(input);
  const cert = certificate(normalized.certificatePem);
  return scopeRunner(
    normalized.tenantId,
    async tx => {
      const { policy, decisions } = await activeEdgePolicy({
        tx,
        tenant: normalized.tenantId,
        facility: normalized.facilityId,
        policyLoader,
        edgePolicyRequirement
      });
      assertPolicyPin(policy, normalized.policyVersionId, normalized.policyVersion);
      assertLocationCovered(policy, normalized.locationType, normalized.locationIdentifier);

      const lifetimeMinutes =
        (Date.parse(normalized.validUntil) - Date.parse(normalized.validFrom)) / 60_000;
      if (lifetimeMinutes > decisions.edgeAccess.credentialLifetimeMinutes) {
        throw accessError(
          'Grant validity exceeds the signed credential lifetime',
          'CONTINUITY_EDGE_CREDENTIAL_LIFETIME_EXCEEDED'
        );
      }
      const certificateValidFrom = Date.parse(cert.certificate.validFrom);
      const certificateValidUntil = Date.parse(cert.certificate.validTo);
      if (
        !Number.isFinite(certificateValidFrom) ||
        !Number.isFinite(certificateValidUntil) ||
        Date.parse(normalized.validFrom) < certificateValidFrom ||
        Date.parse(normalized.validUntil) > certificateValidUntil
      ) {
        throw accessError(
          'Grant validity is outside the public certificate validity window',
          'CONTINUITY_EDGE_CERTIFICATE_TIME_MISMATCH'
        );
      }
      if (
        Date.parse(normalized.validFrom) < Date.parse(policy.effectiveFrom) ||
        (
          policy.effectiveUntil !== null &&
          Date.parse(normalized.validUntil) > Date.parse(policy.effectiveUntil)
        )
      ) {
        throw accessError(
          'Grant validity is outside the signed policy window',
          'CONTINUITY_EDGE_POLICY_TIME_MISMATCH'
        );
      }

      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_edge_access_grants (
           tenant_id, facility_id, location_type, location_identifier,
           staff_uid, device_id, client_certificate_sha256,
           valid_from, valid_until, policy_version_id, policy_version,
           created_by
         )
         VALUES (
           $1::uuid, $2::integer, $3::varchar, $4::varchar,
           $5::uuid, $6::varchar, $7::char(64),
           $8::timestamptz, $9::timestamptz, $10::uuid, $11::bigint,
           $12::uuid
         )
         RETURNING id::text, tenant_id::text, facility_id,
                   location_type, location_identifier, staff_uid::text,
                   device_id, client_certificate_sha256,
                   valid_from, valid_until, policy_version_id::text,
                   policy_version::text, access_revision::text,
                   created_by::text, created_at`,
        normalized.tenantId,
        normalized.facilityId,
        normalized.locationType,
        normalized.locationIdentifier,
        normalized.staffUid,
        normalized.deviceId,
        cert.fingerprint,
        normalized.validFrom,
        normalized.validUntil,
        normalized.policyVersionId,
        normalized.policyVersion,
        normalized.createdBy
      );
      return serializeRow(rows[0]);
    },
    { isolationLevel: 'RepeatableRead' }
  );
}

export async function revokeContinuityEdgeGrant(
  input,
  { scopeRunner = setTenantTx } = {}
) {
  const normalized = {
    tenantId: tenantId(input.tenantId),
    facilityId: positiveInteger(input.facilityId, 'facilityId'),
    grantId: uuid(input.grantId, 'grantId'),
    revokedBy: uuid(input.revokedBy, 'revokedBy'),
    reason: boundedString(input.reason, 'reason', /^(?!.*\p{Cc})[\s\S]{1,500}$/u)
  };
  return scopeRunner(
    normalized.tenantId,
    async tx => {
      const grants = await tx.$queryRawUnsafe(
        `SELECT id::text
           FROM clinical_continuity_edge_access_grants
          WHERE tenant_id = $1::uuid
            AND facility_id = $2::integer
            AND id = $3::uuid
          FOR SHARE`,
        normalized.tenantId,
        normalized.facilityId,
        normalized.grantId
      );
      if (grants.length !== 1) {
        throw accessError(
          'The exact tenant/facility grant does not exist',
          'CONTINUITY_EDGE_GRANT_NOT_FOUND'
        );
      }

      const existing = await tx.$queryRawUnsafe(
        `SELECT id::text, tenant_id::text, facility_id, grant_id::text,
                access_revision::text, revoked_by::text, revoked_at, reason
           FROM clinical_continuity_edge_access_revocations
          WHERE tenant_id = $1::uuid
            AND facility_id = $2::integer
            AND grant_id = $3::uuid`,
        normalized.tenantId,
        normalized.facilityId,
        normalized.grantId
      );
      if (existing.length === 1) {
        const row = serializeRow(existing[0]);
        if (
          row.revoked_by === normalized.revokedBy &&
          row.reason === normalized.reason
        ) {
          return { ...row, idempotent: true };
        }
        throw accessError(
          'The grant already has different immutable revocation evidence',
          'CONTINUITY_EDGE_GRANT_ALREADY_REVOKED'
        );
      }

      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_edge_access_revocations (
           tenant_id, facility_id, grant_id, revoked_by, reason
         )
         VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, $5::varchar)
         RETURNING id::text, tenant_id::text, facility_id, grant_id::text,
                   access_revision::text, revoked_by::text, revoked_at, reason`,
        normalized.tenantId,
        normalized.facilityId,
        normalized.grantId,
        normalized.revokedBy,
        normalized.reason
      );
      return { ...serializeRow(rows[0]), idempotent: false };
    },
    { isolationLevel: 'RepeatableRead' }
  );
}

function grantSetRow(row) {
  return {
    accessRevision: String(row.access_revision),
    clientCertificateSha256: String(row.client_certificate_sha256),
    deviceId: row.device_id,
    grantId: String(row.id).toLowerCase(),
    locationIdentifier: row.location_identifier,
    locationType: row.location_type,
    staffUid: String(row.staff_uid).toLowerCase(),
    validFrom: new Date(row.valid_from).toISOString(),
    validUntil: new Date(row.valid_until).toISOString()
  };
}

function revocationSetRow(row) {
  return {
    accessRevision: String(row.access_revision),
    grantId: String(row.grant_id).toLowerCase(),
    revokedAt: new Date(row.revoked_at).toISOString()
  };
}

export async function buildContinuityEdgeGrantSet({
  tx,
  policy,
  edgePolicyRequirement = requireClinicalContinuityEdgePolicy
} = {}) {
  const decisions = edgePolicyRequirement(policy);
  const rows = await tx.$queryRawUnsafe(
    `SELECT grant_row.id::text, grant_row.location_type,
            grant_row.location_identifier, grant_row.staff_uid::text,
            grant_row.device_id, grant_row.client_certificate_sha256,
            grant_row.valid_from, grant_row.valid_until,
            grant_row.access_revision::text,
            revocation.access_revision::text AS revocation_access_revision,
            revocation.revoked_at
       FROM clinical_continuity_edge_access_grants AS grant_row
       LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
         ON revocation.tenant_id = grant_row.tenant_id
        AND revocation.facility_id = grant_row.facility_id
        AND revocation.grant_id = grant_row.id
      WHERE grant_row.tenant_id = $1::uuid
        AND grant_row.facility_id = $2::integer
        AND grant_row.policy_version_id = $3::uuid
        AND grant_row.policy_version = $4::bigint
      ORDER BY grant_row.access_revision, grant_row.id`,
    policy.tenantId,
    policy.facilityId,
    policy.id,
    policy.policyVersion
  );
  const revisionRows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(MAX(access_revision), 0)::text AS access_revision
       FROM (
         SELECT access_revision
           FROM clinical_continuity_edge_access_grants
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
         UNION ALL
         SELECT access_revision
           FROM clinical_continuity_edge_access_revocations
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
       ) AS revisions`,
    policy.tenantId,
    policy.facilityId
  );

  const grants = rows.map(grantSetRow);
  const revocations = rows
    .filter(row => row.revocation_access_revision != null)
    .map(row => revocationSetRow({
      access_revision: row.revocation_access_revision,
      grant_id: row.id,
      revoked_at: row.revoked_at
    }));
  const content = {
    accessRevision: String(revisionRows[0]?.access_revision || '0'),
    audience: {
      facilityId: String(policy.facilityId),
      tenantId: policy.tenantId
    },
    edgeAccess: decisions.edgeAccess,
    format: CONTINUITY_EDGE_ACCESS_FORMAT,
    generatedAt: policy.trustedNow,
    grants,
    policy: {
      id: policy.id,
      revocationEpoch: policy.revocationEpoch,
      version: policy.policyVersion
    },
    revocations
  };
  return JSON.parse(canonicalizeJson(content));
}

export async function exportContinuityEdgeGrantSet(
  { tenantId: rawTenantId, facilityId: rawFacilityId },
  {
    scopeRunner = setTenantTx,
    policyLoader = loadActiveClinicalContinuityPolicyForFacilityTx,
    edgePolicyRequirement = requireClinicalContinuityEdgePolicy
  } = {}
) {
  const tenant = tenantId(rawTenantId);
  const facility = positiveInteger(rawFacilityId, 'facilityId');
  return scopeRunner(
    tenant,
    async tx => {
      const { policy } = await activeEdgePolicy({
        tx,
        tenant,
        facility,
        policyLoader,
        edgePolicyRequirement
      });
      return buildContinuityEdgeGrantSet({
        tx,
        policy,
        edgePolicyRequirement
      });
    },
    { readOnly: true, isolationLevel: 'RepeatableRead' }
  );
}

function normalizeAuthorizationInput(input) {
  return {
    tenantId: tenantId(input.tenantId),
    facilityId: positiveInteger(input.facilityId, 'facilityId'),
    locationType: locationType(input.locationType),
    locationIdentifier: boundedString(
      input.locationIdentifier,
      'locationIdentifier',
      LOCATION_PATTERN
    ),
    staffUid: uuid(input.staffUid, 'staffUid'),
    deviceId: boundedString(input.deviceId, 'deviceId', DEVICE_PATTERN),
    clientCertificateSha256: requiredHash(
      input.clientCertificateSha256,
      'clientCertificateSha256'
    ),
    trustedAt: timestamp(input.trustedAt, 'trustedAt'),
    minimumAccessRevision: normalizeGovernanceVersion(
      input.minimumAccessRevision ?? 0,
      { allowZero: true }
    )
  };
}

export async function authorizeContinuityEdgeCredential(
  input,
  { scopeRunner = setTenantTx } = {}
) {
  const normalized = normalizeAuthorizationInput(input);
  return scopeRunner(
    normalized.tenantId,
    async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT grant_row.id::text, grant_row.access_revision::text,
                grant_row.policy_version_id::text, grant_row.policy_version::text,
                grant_row.valid_from, grant_row.valid_until,
                revocation.id::text AS revocation_id,
                revocation.access_revision::text AS revocation_access_revision,
                revocation.revoked_at
           FROM clinical_continuity_edge_access_grants AS grant_row
           LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
             ON revocation.tenant_id = grant_row.tenant_id
            AND revocation.facility_id = grant_row.facility_id
            AND revocation.grant_id = grant_row.id
          WHERE grant_row.tenant_id = $1::uuid
            AND grant_row.facility_id = $2::integer
            AND grant_row.location_type = $3::varchar
            AND grant_row.location_identifier = $4::varchar
            AND grant_row.staff_uid = $5::uuid
            AND grant_row.device_id = $6::varchar
            AND grant_row.client_certificate_sha256 = $7::char(64)
            AND grant_row.valid_from <= $8::timestamptz
            AND grant_row.valid_until > $8::timestamptz
          ORDER BY grant_row.access_revision DESC`,
        normalized.tenantId,
        normalized.facilityId,
        normalized.locationType,
        normalized.locationIdentifier,
        normalized.staffUid,
        normalized.deviceId,
        normalized.clientCertificateSha256,
        normalized.trustedAt
      );
      const usable = rows.find(row =>
        row.revocation_id == null &&
        BigInt(row.access_revision) >= BigInt(normalized.minimumAccessRevision)
      );
      if (!usable) {
        throw accessError(
          'The exact edge credential scope is not authorized',
          'CONTINUITY_EDGE_ACCESS_DENIED'
        );
      }
      return serializeRow(usable);
    },
    { readOnly: true, isolationLevel: 'RepeatableRead' }
  );
}

function normalizeLogBatchEnvelope(value, certificatePem) {
  const envelope = exactKeys(
    value,
    ['algorithm', 'content', 'contentHash', 'keyFingerprint', 'signature'],
    'logBatchEnvelope'
  );
  if (envelope.algorithm !== 'Ed25519' || !SIGNATURE_PATTERN.test(envelope.signature)) {
    throw accessError(
      'The recovered log signature format is invalid',
      'CONTINUITY_EDGE_LOG_SIGNATURE_INVALID'
    );
  }
  const cert = certificate(certificatePem);
  if (
    requiredHash(envelope.keyFingerprint, 'keyFingerprint') !== cert.fingerprint
  ) {
    throw accessError(
      'The recovered log certificate fingerprint does not match',
      'CONTINUITY_EDGE_LOG_CERTIFICATE_MISMATCH'
    );
  }
  const content = exactKeys(
    envelope.content,
    [
      'accessRevision',
      'batchId',
      'deviceId',
      'events',
      'facilityId',
      'firstEventAt',
      'firstEventSequence',
      'format',
      'grantId',
      'lastEventAt',
      'lastEventSequence',
      'policyVersion',
      'policyVersionId',
      'previousBatchSha256',
      'tenantId'
    ],
    'logBatchEnvelope.content'
  );
  if (content.format !== CONTINUITY_EDGE_LOG_BATCH_FORMAT || !Array.isArray(content.events)) {
    throw accessError(
      'The recovered log batch format is invalid',
      'CONTINUITY_EDGE_LOG_FORMAT_INVALID'
    );
  }
  const canonicalHash = hashCanonicalValue(content);
  if (
    requiredHash(envelope.contentHash, 'contentHash') !== canonicalHash ||
    !verifyCanonicalValue(content, envelope.signature, cert.certificate.publicKey)
  ) {
    throw accessError(
      'The recovered log hash or signature is invalid',
      'CONTINUITY_EDGE_LOG_SIGNATURE_INVALID'
    );
  }
  const firstEventSequence = Number(content.firstEventSequence);
  const lastEventSequence = Number(content.lastEventSequence);
  if (
    !Number.isSafeInteger(firstEventSequence) ||
    firstEventSequence < 1 ||
    !Number.isSafeInteger(lastEventSequence) ||
    lastEventSequence < firstEventSequence ||
    content.events.length !== lastEventSequence - firstEventSequence + 1 ||
    content.events.length > MAX_LOG_BATCH_EVENTS ||
    content.events.some(
      (event, index) =>
        !event ||
        typeof event !== 'object' ||
        Array.isArray(event) ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence !== firstEventSequence + index
    )
  ) {
    throw accessError(
      'The recovered log event range is invalid',
      'CONTINUITY_EDGE_LOG_SEQUENCE_INVALID'
    );
  }
  const firstEventAt = timestamp(content.firstEventAt, 'firstEventAt');
  const lastEventAt = timestamp(content.lastEventAt, 'lastEventAt');
  if (Date.parse(lastEventAt) < Date.parse(firstEventAt)) {
    throw accessError(
      'The recovered log event time range is invalid',
      'CONTINUITY_EDGE_LOG_TIME_INVALID'
    );
  }
  return {
    envelope,
    certificateSha256: cert.fingerprint,
    signatureSha256: createHash('sha256')
      .update(Buffer.from(envelope.signature, 'base64'))
      .digest('hex'),
    batchSha256: canonicalHash,
    tenantId: tenantId(content.tenantId),
    facilityId: positiveInteger(content.facilityId, 'facilityId'),
    deviceId: boundedString(content.deviceId, 'deviceId', DEVICE_PATTERN),
    grantId: uuid(content.grantId, 'grantId'),
    policyVersionId: uuid(content.policyVersionId, 'policyVersionId'),
    policyVersion: normalizeGovernanceVersion(content.policyVersion),
    accessRevision: normalizeGovernanceVersion(content.accessRevision),
    batchId: boundedString(content.batchId, 'batchId', BATCH_ID_PATTERN),
    previousBatchSha256: optionalHash(
      content.previousBatchSha256,
      'previousBatchSha256'
    ),
    eventCount: content.events.length,
    firstEventSequence,
    lastEventSequence,
    firstEventAt,
    lastEventAt
  };
}

function receiptMatchesBatch(row, batch) {
  return (
    String(row.device_id) === batch.deviceId &&
    String(row.client_certificate_sha256) === batch.certificateSha256 &&
    String(row.batch_sha256) === batch.batchSha256 &&
    String(row.previous_batch_sha256 || '') === String(batch.previousBatchSha256 || '') &&
    String(row.grant_id).toLowerCase() === batch.grantId &&
    String(row.policy_version_id).toLowerCase() === batch.policyVersionId &&
    String(row.policy_version) === batch.policyVersion &&
    String(row.access_revision) === batch.accessRevision &&
    Number(row.event_count) === batch.eventCount &&
    Number(row.first_event_sequence) === batch.firstEventSequence &&
    Number(row.last_event_sequence) === batch.lastEventSequence &&
    new Date(row.first_event_at).toISOString() === batch.firstEventAt &&
    new Date(row.last_event_at).toISOString() === batch.lastEventAt &&
    String(row.signature_algorithm).toLowerCase() === 'ed25519' &&
    String(row.signature_sha256) === batch.signatureSha256
  );
}

export async function ingestContinuityEdgeLogBatch(
  { envelope, certificatePem, importedBy },
  { scopeRunner = setTenantTx } = {}
) {
  const batch = normalizeLogBatchEnvelope(envelope, certificatePem);
  const actor = uuid(importedBy, 'importedBy');
  return scopeRunner(
    batch.tenantId,
    async tx => {
      const duplicate = await tx.$queryRawUnsafe(
        `SELECT id::text, tenant_id::text, facility_id, device_id,
                grant_id::text, client_certificate_sha256,
                policy_version_id::text, policy_version::text,
                access_revision::text, batch_id, previous_batch_sha256,
                batch_sha256, event_count, first_event_sequence::text,
                last_event_sequence::text, first_event_at, last_event_at,
                signature_algorithm, signature_sha256,
                imported_by::text, received_at
           FROM clinical_continuity_edge_log_receipts
          WHERE tenant_id = $1::uuid
            AND facility_id = $2::integer
            AND device_id = $3::varchar
            AND batch_id = $4::varchar`,
        batch.tenantId,
        batch.facilityId,
        batch.deviceId,
        batch.batchId
      );
      if (duplicate.length === 1) {
        if (!receiptMatchesBatch(duplicate[0], batch)) {
          throw accessError(
            'The batch ID was already used for different immutable evidence',
            'CONTINUITY_EDGE_LOG_REPLAY_CONFLICT'
          );
        }
        return { ...serializeRow(duplicate[0]), idempotent: true };
      }

      const grants = await tx.$queryRawUnsafe(
        `SELECT grant_row.id::text, grant_row.device_id,
                grant_row.client_certificate_sha256,
                grant_row.policy_version_id::text,
                grant_row.policy_version::text,
                grant_row.access_revision::text,
                grant_row.valid_from, grant_row.valid_until,
                revocation.access_revision::text AS revocation_access_revision,
                revocation.revoked_at
           FROM clinical_continuity_edge_access_grants AS grant_row
           LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
             ON revocation.tenant_id = grant_row.tenant_id
            AND revocation.facility_id = grant_row.facility_id
            AND revocation.grant_id = grant_row.id
          WHERE grant_row.tenant_id = $1::uuid
            AND grant_row.facility_id = $2::integer
            AND grant_row.id = $3::uuid
          FOR SHARE OF grant_row`,
        batch.tenantId,
        batch.facilityId,
        batch.grantId
      );
      const grant = grants[0];
      if (
        grants.length !== 1 ||
        grant.device_id !== batch.deviceId ||
        grant.client_certificate_sha256 !== batch.certificateSha256 ||
        String(grant.policy_version_id).toLowerCase() !== batch.policyVersionId ||
        String(grant.policy_version) !== batch.policyVersion ||
        BigInt(grant.access_revision) > BigInt(batch.accessRevision) ||
        Date.parse(batch.firstEventAt) < new Date(grant.valid_from).getTime() ||
        Date.parse(batch.lastEventAt) >= new Date(grant.valid_until).getTime() ||
        (
          grant.revoked_at != null &&
          Date.parse(batch.lastEventAt) >= new Date(grant.revoked_at).getTime()
        )
      ) {
        throw accessError(
          'The recovered log batch was not authorized by the exact grant',
          'CONTINUITY_EDGE_LOG_GRANT_INVALID'
        );
      }

      const revisionRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(access_revision), 0)::text AS access_revision
           FROM (
             SELECT access_revision
               FROM clinical_continuity_edge_access_grants
              WHERE tenant_id = $1::uuid AND facility_id = $2::integer
             UNION ALL
             SELECT access_revision
               FROM clinical_continuity_edge_access_revocations
              WHERE tenant_id = $1::uuid AND facility_id = $2::integer
           ) AS revisions`,
        batch.tenantId,
        batch.facilityId
      );
      const currentAccessRevision = String(
        revisionRows[0]?.access_revision || '0'
      );
      if (BigInt(batch.accessRevision) > BigInt(currentAccessRevision)) {
        throw accessError(
          'The recovered log references an access revision not issued by this facility',
          'CONTINUITY_EDGE_LOG_ACCESS_REVISION_INVALID'
        );
      }

      const priorRows = await tx.$queryRawUnsafe(
        `SELECT batch_sha256, last_event_sequence::text
           FROM clinical_continuity_edge_log_receipts
          WHERE tenant_id = $1::uuid
            AND facility_id = $2::integer
            AND device_id = $3::varchar
          ORDER BY last_event_sequence DESC, received_at DESC
          LIMIT 1
          FOR SHARE`,
        batch.tenantId,
        batch.facilityId,
        batch.deviceId
      );
      const prior = priorRows[0];
      if (
        (
          prior == null &&
          (
            batch.previousBatchSha256 !== null ||
            batch.firstEventSequence !== 1
          )
        ) ||
        (
          prior != null &&
          (
            batch.previousBatchSha256 !== prior.batch_sha256 ||
            batch.firstEventSequence !== Number(prior.last_event_sequence) + 1
          )
        )
      ) {
        throw accessError(
          'The recovered log batch does not continue the device hash chain',
          'CONTINUITY_EDGE_LOG_CHAIN_GAP'
        );
      }

      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_edge_log_receipts (
           tenant_id, facility_id, device_id, grant_id,
           client_certificate_sha256, policy_version_id, policy_version,
           access_revision, batch_id, previous_batch_sha256, batch_sha256,
           event_count, first_event_sequence, last_event_sequence,
           first_event_at, last_event_at, signature_algorithm,
           signature_sha256, imported_by
         )
         VALUES (
           $1::uuid, $2::integer, $3::varchar, $4::uuid,
           $5::char(64), $6::uuid, $7::bigint,
           $8::bigint, $9::varchar, $10::char(64), $11::char(64),
           $12::integer, $13::bigint, $14::bigint,
           $15::timestamptz, $16::timestamptz, 'ed25519',
           $17::char(64), $18::uuid
         )
         RETURNING id::text, tenant_id::text, facility_id, device_id,
                   grant_id::text, client_certificate_sha256,
                   policy_version_id::text, policy_version::text,
                   access_revision::text, batch_id, previous_batch_sha256,
                   batch_sha256, event_count, first_event_sequence::text,
                   last_event_sequence::text, first_event_at, last_event_at,
                   signature_algorithm, signature_sha256,
                   imported_by::text, received_at`,
        batch.tenantId,
        batch.facilityId,
        batch.deviceId,
        batch.grantId,
        batch.certificateSha256,
        batch.policyVersionId,
        batch.policyVersion,
        batch.accessRevision,
        batch.batchId,
        batch.previousBatchSha256,
        batch.batchSha256,
        batch.eventCount,
        batch.firstEventSequence,
        batch.lastEventSequence,
        batch.firstEventAt,
        batch.lastEventAt,
        batch.signatureSha256,
        actor
      );
      return { ...serializeRow(rows[0]), idempotent: false };
    },
    { isolationLevel: 'Serializable' }
  );
}

export const __testing__ = Object.freeze({
  normalizeAuthorizationInput,
  normalizeGrantInput,
  normalizeLogBatchEnvelope,
  receiptMatchesBatch
});

export default {
  authorizeContinuityEdgeCredential,
  buildContinuityEdgeGrantSet,
  createContinuityEdgeGrant,
  exportContinuityEdgeGrantSet,
  fingerprintContinuityEdgeCertificate,
  ingestContinuityEdgeLogBatch,
  revokeContinuityEdgeGrant
};
