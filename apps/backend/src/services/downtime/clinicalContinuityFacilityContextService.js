import { createHash, createPublicKey, randomUUID } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import {
  assessSigningKey,
  canonicalizeJson,
  hashCanonicalValue,
  SIGNATURE_ALGORITHM,
  verifyCanonicalValue,
} from './continuityPackCanonical.js';
import {
  CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION,
  loadActiveClinicalContinuityPolicyForFacilityTx,
} from './clinicalContinuityPolicyService.js';

export const CLINICAL_CONTINUITY_FACILITY_CONTEXT_FORMAT =
  'vhhealth_continuity_facility_context/v1';
export const CLINICAL_CONTINUITY_FACILITY_PROOF_FORMAT =
  'vhhealth_continuity_facility_proof/v1';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const CONTEXT_ENVELOPE_KEYS = Object.freeze([
  'algorithm',
  'content',
  'contentHash',
  'keyId',
  'signature',
]);
const CONTEXT_CONTENT_KEYS = Object.freeze([
  'captureRevision',
  'contextId',
  'contextRevision',
  'deviceId',
  'effectiveFrom',
  'expiresAt',
  'facilityId',
  'format',
  'grantId',
  'grantPurpose',
  'issuedAt',
  'policyChecksum',
  'policyId',
  'policySigningKeyId',
  'policyVersion',
  'revocationEpoch',
  'sessionJtiSha256',
  'staffUid',
  'tenantId',
]);
const DEVICE_PROOF_KEYS = Object.freeze(['nonce', 'signature', 'signedAt']);

export class ClinicalContinuityFacilityContextError extends Error {
  constructor(code, message = 'Clinical continuity facility context was denied') {
    super(message);
    this.name = 'ClinicalContinuityFacilityContextError';
    this.code = code;
    this.statusCode = 403;
  }
}

function denied(code = 'CONTINUITY_FACILITY_CONTEXT_DENIED') {
  return new ClinicalContinuityFacilityContextError(code);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length
    && actual.every((key, index) => key === keys[index])
  );
}

function uuid(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw denied();
  return normalized;
}

function tenantId(value) {
  const normalized = uuid(value);
  if (normalized === DEFAULT_TENANT_ID) throw denied();
  return normalized;
}

function positiveInteger(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw denied();
  return normalized;
}

function revision(value, { allowZero = false } = {}) {
  const normalized = String(value ?? '');
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(normalized)) throw denied();
  if (!allowZero && normalized === '0') throw denied();
  return normalized;
}

function utcTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw denied();
  return parsed.toISOString();
}

function sessionHash(jti) {
  const value = String(jti || '');
  if (!value) throw denied();
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rawEd25519PublicKey(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (bytes.length !== 32) throw denied();
  try {
    return createPublicKey({
      key: {
        crv: 'Ed25519',
        kty: 'OKP',
        x: bytes.toString('base64url'),
      },
      format: 'jwk',
    });
  } catch {
    throw denied();
  }
}

function capturePurpose(value) {
  const purpose = String(value || '').trim();
  if (!['capture_fixed_device', 'capture_staff_facility'].includes(purpose)) {
    throw denied();
  }
  return purpose;
}

function base64RawEd25519PublicKey(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw denied();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== encoded) throw denied();
  rawEd25519PublicKey(bytes);
  return bytes;
}

function assertDeviceProof({
  proof,
  publicKeyRaw,
  tenant,
  facility,
  actorUid,
  deviceId,
  sessionJtiSha256,
  trustedAt,
}) {
  if (!exactKeys(proof, DEVICE_PROOF_KEYS)) throw denied();
  const signedAt = utcTimestamp(proof.signedAt);
  if (Math.abs(Date.parse(trustedAt) - Date.parse(signedAt)) > 5 * 60_000) {
    throw denied();
  }
  const nonce = uuid(proof.nonce);
  if (!SIGNATURE_PATTERN.test(String(proof.signature || ''))) throw denied();
  const content = {
    actorUid,
    deviceId,
    facilityId: String(facility),
    format: CLINICAL_CONTINUITY_FACILITY_PROOF_FORMAT,
    nonce,
    sessionJtiSha256,
    signedAt,
    tenantId: tenant,
  };
  if (!verifyCanonicalValue(content, proof.signature, rawEd25519PublicKey(publicKeyRaw))) {
    throw denied();
  }
}

function policyKey(policy, keyId) {
  const decision = assessSigningKey({
    keyId,
    algorithm: SIGNATURE_ALGORITHM,
    trustedKeys: policy.trustedKeys,
    expectedKeyId: policy.currentPackSigningKeyId,
  });
  if (!decision.ok || decision.state !== 'current') throw denied();
  return decision.publicKey;
}

export async function signClinicalContinuityCanonicalValue({ signer, keyId, content }) {
  if (!signer || typeof signer.sign !== 'function') {
    throw denied('CONTINUITY_FACILITY_CONTEXT_SIGNER_UNAVAILABLE');
  }
  const signature = await signer.sign({
    algorithm: SIGNATURE_ALGORITHM,
    keyId,
    payload: Buffer.from(canonicalizeJson(content), 'utf8'),
  });
  if (!SIGNATURE_PATTERN.test(String(signature || ''))) {
    throw denied('CONTINUITY_FACILITY_CONTEXT_SIGNER_UNAVAILABLE');
  }
  return signature;
}

export function verifyClinicalContinuityCanonicalSignature({ policy, keyId, content, signature }) {
  return verifyCanonicalValue(content, signature, policyKey(policy, keyId));
}

function contextExpiry({ trustedAt, grant, policy, sessionExpiresAt, contextLifetimeMs }) {
  if (!Number.isSafeInteger(contextLifetimeMs) || contextLifetimeMs < 1) {
    throw denied('CONTINUITY_FACILITY_CONTEXT_OWNER_DECISION_REQUIRED');
  }
  const candidates = [
    Date.parse(trustedAt) + contextLifetimeMs,
    Date.parse(grant.valid_until),
    Date.parse(policy.effectiveUntil),
    Date.parse(sessionExpiresAt),
  ];
  if (candidates.some(value => !Number.isFinite(value))) throw denied();
  const expiresAt = Math.min(...candidates);
  if (expiresAt <= Date.parse(trustedAt)) throw denied();
  return new Date(expiresAt).toISOString();
}

function frozenRequestContext(content) {
  // This is the C5.1-owned seam. Additions, aliases, or inferred substitutes
  // are prohibited: downstream replay consumes this exact server-owned shape.
  return Object.freeze({
    contextId: content.contextId,
    contextRevision: content.contextRevision,
    tenantId: content.tenantId,
    facilityId: Number(content.facilityId),
    grantId: content.grantId,
    grantPurpose: content.grantPurpose,
    captureRevision: content.captureRevision,
    actorUid: content.staffUid,
    deviceId: content.deviceId,
    sessionJtiSha256: content.sessionJtiSha256,
    policyId: content.policyId,
    policyVersion: content.policyVersion,
    policyChecksum: content.policyChecksum,
    policySigningKeyId: content.policySigningKeyId,
    revocationEpoch: content.revocationEpoch,
    issuedAt: content.issuedAt,
    effectiveFrom: content.effectiveFrom,
    expiresAt: content.expiresAt,
  });
}

function attachRequestContext(req, content) {
  if (Object.prototype.hasOwnProperty.call(req, 'continuityFacilityContext')) {
    throw denied();
  }
  const value = frozenRequestContext(content);
  Object.defineProperty(req, 'continuityFacilityContext', {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
  return value;
}

async function loadGrantAndPolicy({
  tx,
  tenant,
  actorUid,
  deviceId,
  requestedFacilityId,
  policyLoader,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT grant_row.id::text,
            grant_row.tenant_id::text,
            grant_row.facility_id,
            grant_row.grant_purpose,
            grant_row.staff_uid::text,
            grant_row.device_id,
            grant_row.device_public_key_raw,
            grant_row.device_credential_sha256,
            grant_row.valid_from,
            grant_row.valid_until,
            grant_row.policy_version_id::text,
            grant_row.policy_version::text,
            grant_row.capture_revision::text
       FROM clinical_continuity_edge_access_grants AS grant_row
       LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
         ON revocation.tenant_id = grant_row.tenant_id
        AND revocation.facility_id = grant_row.facility_id
        AND revocation.grant_id = grant_row.id
        AND revocation.grant_purpose = grant_row.grant_purpose
      WHERE grant_row.tenant_id = $1::uuid
        AND grant_row.device_id = $2
        AND grant_row.grant_purpose IN (
          'capture_fixed_device',
          'capture_staff_facility'
        )
        AND (
          grant_row.grant_purpose = 'capture_fixed_device'
          OR (
            grant_row.grant_purpose = 'capture_staff_facility'
            AND grant_row.staff_uid = $3::uuid
            AND grant_row.facility_id = $4::integer
          )
        )
        AND grant_row.valid_from <= clock_timestamp()
        AND grant_row.valid_until > clock_timestamp()
        AND revocation.id IS NULL
      ORDER BY
        CASE WHEN grant_row.grant_purpose = 'capture_fixed_device' THEN 0 ELSE 1 END,
        grant_row.capture_revision DESC
      LIMIT 2
      FOR SHARE OF grant_row`,
    tenant,
    deviceId,
    actorUid,
    requestedFacilityId,
  );
  if (rows.length !== 1) throw denied();
  const grant = rows[0];
  if (Number(grant.facility_id) !== requestedFacilityId) throw denied();
  const policy = await policyLoader({
    tx,
    tenantId: tenant,
    facilityId: requestedFacilityId,
  });
  if (
    policy.policySchemaVersion !== CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION
    ||
    grant.policy_version_id !== policy.id
    || revision(grant.policy_version) !== policy.policyVersion
  ) {
    throw denied();
  }
  return { grant, policy };
}

export async function issueClinicalContinuityFacilityContext({
  tenantId: rawTenantId,
  actorUid: rawActorUid,
  stableDeviceId: rawDeviceId,
  sessionJti,
  sessionExpiresAt,
  requestedFacilityId,
  deviceProof,
  signer,
  contextLifetimeMs,
  clock = () => new Date(),
  scopeRunner = setTenantTx,
  policyLoader = loadActiveClinicalContinuityPolicyForFacilityTx,
} = {}) {
  const tenant = tenantId(rawTenantId);
  const actorUid = uuid(rawActorUid);
  const deviceId = uuid(rawDeviceId);
  const facility = positiveInteger(requestedFacilityId);
  const jtiHash = sessionHash(sessionJti);
  const trustedAt = utcTimestamp(clock());

  return scopeRunner(
    tenant,
    async tx => {
      const { grant, policy } = await loadGrantAndPolicy({
        tx,
        tenant,
        actorUid,
        deviceId,
        requestedFacilityId: facility,
        policyLoader,
      });
      assertDeviceProof({
        proof: deviceProof,
        publicKeyRaw: grant.device_public_key_raw,
        tenant,
        facility,
        actorUid,
        deviceId,
        sessionJtiSha256: jtiHash,
        trustedAt,
      });
      const revisionRows = await tx.$queryRawUnsafe(
        `SELECT nextval(
           'clinical_continuity_context_revision_seq'
         )::text AS context_revision`,
      );
      const contextRevision = revision(revisionRows[0]?.context_revision);
      const issuedAt = trustedAt;
      const expiresAt = contextExpiry({
        trustedAt,
        grant,
        policy,
        sessionExpiresAt,
        contextLifetimeMs,
      });
      const content = {
        captureRevision: revision(grant.capture_revision),
        contextId: randomUUID(),
        contextRevision,
        deviceId,
        effectiveFrom: new Date(
          Math.max(Date.parse(grant.valid_from), Date.parse(policy.effectiveFrom))
        ).toISOString(),
        expiresAt,
        facilityId: String(facility),
        format: CLINICAL_CONTINUITY_FACILITY_CONTEXT_FORMAT,
        grantId: uuid(grant.id),
        grantPurpose: grant.grant_purpose,
        issuedAt,
        policyChecksum: policy.policyChecksum,
        policyId: policy.id,
        policySigningKeyId: policy.policySigningKeyId,
        policyVersion: policy.policyVersion,
        revocationEpoch: policy.revocationEpoch,
        sessionJtiSha256: jtiHash,
        staffUid: actorUid,
        tenantId: tenant,
      };
      const keyId = policy.currentPackSigningKeyId;
      const signature = await signClinicalContinuityCanonicalValue({ signer, keyId, content });
      if (!verifyClinicalContinuityCanonicalSignature({ policy, keyId, content, signature })) {
        throw denied('CONTINUITY_FACILITY_CONTEXT_SIGNER_UNAVAILABLE');
      }
      const envelope = Object.freeze({
        algorithm: SIGNATURE_ALGORITHM,
        content: Object.freeze(content),
        contentHash: hashCanonicalValue(content),
        keyId,
        signature,
      });

      const projectionCount = await tx.$executeRawUnsafe(
        `UPDATE user_devices
            SET facility_id = $4::integer,
                continuity_grant_id = $5::uuid,
                continuity_grant_purpose = $6,
                continuity_capture_revision = $7::bigint,
                continuity_context_id = $8::uuid,
                continuity_context_revision = $9::bigint,
                continuity_session_jti_sha256 = $10,
                continuity_issued_at = $11::timestamptz,
                continuity_expires_at = $12::timestamptz,
                continuity_validated_at = $11::timestamptz,
                continuity_validation_state = 'active',
                last_active = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND user_uid = $2::uuid
            AND device_id = $3`,
        tenant,
        actorUid,
        deviceId,
        facility,
        content.grantId,
        content.grantPurpose,
        content.captureRevision,
        content.contextId,
        content.contextRevision,
        content.sessionJtiSha256,
        content.issuedAt,
        content.expiresAt,
      );
      if (projectionCount !== 1) throw denied();
      return envelope;
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

export async function enrollClinicalContinuityFacilityGrant({
  tenantId: rawTenantId,
  facilityId: rawFacilityId,
  grantPurpose: rawPurpose,
  staffUid: rawStaffUid = null,
  deviceId: rawDeviceId,
  devicePublicKeyBase64,
  validFrom,
  validUntil,
  createdBy: rawCreatedBy,
  scopeRunner = setTenantTx,
  policyLoader = loadActiveClinicalContinuityPolicyForFacilityTx,
} = {}) {
  const tenant = tenantId(rawTenantId);
  const facility = positiveInteger(rawFacilityId);
  const purpose = capturePurpose(rawPurpose);
  const staffUid = purpose === 'capture_staff_facility'
    ? uuid(rawStaffUid)
    : null;
  if (purpose === 'capture_fixed_device' && rawStaffUid != null) throw denied();
  const deviceId = uuid(rawDeviceId);
  const publicKey = base64RawEd25519PublicKey(devicePublicKeyBase64);
  const createdBy = uuid(rawCreatedBy);
  const from = utcTimestamp(validFrom);
  const until = utcTimestamp(validUntil);
  if (Date.parse(until) <= Date.parse(from)) throw denied();

  return scopeRunner(
    tenant,
    async tx => {
      const policy = await policyLoader({
        tx,
        tenantId: tenant,
        facilityId: facility,
      });
      if (
        policy.policySchemaVersion
          !== CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION
        || Date.parse(from) < Date.parse(policy.effectiveFrom)
        || (
          policy.effectiveUntil !== null
          && Date.parse(until) > Date.parse(policy.effectiveUntil)
        )
      ) {
        throw denied();
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_edge_access_grants (
           tenant_id, facility_id, location_type, location_identifier,
           staff_uid, device_id, client_certificate_sha256,
           valid_from, valid_until, policy_version_id, policy_version,
           access_revision, created_by, grant_purpose, subject_kind,
           device_public_key_raw, device_credential_sha256,
           capture_revision
         )
         VALUES (
           $1::uuid, $2::integer, NULL, NULL,
           $3::uuid, $4::varchar, NULL,
           $5::timestamptz, $6::timestamptz, $7::uuid, $8::bigint,
           NULL, $9::uuid, $10::varchar, $11::varchar,
           $12::bytea, $13::char(64),
           nextval('clinical_continuity_capture_revision_seq')
         )
         RETURNING id::text, tenant_id::text, facility_id,
                   grant_purpose, subject_kind, staff_uid::text,
                   device_id, device_credential_sha256,
                   valid_from, valid_until, policy_version_id::text,
                   policy_version::text, capture_revision::text,
                   created_by::text, created_at`,
        tenant,
        facility,
        staffUid,
        deviceId,
        from,
        until,
        policy.id,
        policy.policyVersion,
        createdBy,
        purpose,
        purpose === 'capture_fixed_device' ? 'device' : 'staff_device',
        publicKey,
        createHash('sha256').update(publicKey).digest('hex'),
      );
      return rows[0];
    },
    { isolationLevel: 'Serializable' },
  );
}

export async function listClinicalContinuityFacilityGrants({
  tenantId: rawTenantId,
  facilityId: rawFacilityId = null,
  scopeRunner = setTenantTx,
} = {}) {
  const tenant = tenantId(rawTenantId);
  const facility = rawFacilityId == null ? null : positiveInteger(rawFacilityId);
  return scopeRunner(
    tenant,
    tx => tx.$queryRawUnsafe(
      `SELECT grant_row.id::text, grant_row.facility_id,
              grant_row.grant_purpose, grant_row.subject_kind,
              grant_row.staff_uid::text, grant_row.device_id,
              grant_row.device_credential_sha256,
              grant_row.valid_from, grant_row.valid_until,
              grant_row.policy_version_id::text,
              grant_row.policy_version::text,
              grant_row.capture_revision::text,
              grant_row.created_by::text, grant_row.created_at,
              revocation.id::text AS revocation_id,
              revocation.capture_revision::text AS revocation_revision,
              revocation.revoked_at, revocation.reason
         FROM clinical_continuity_edge_access_grants AS grant_row
         LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
           ON revocation.tenant_id = grant_row.tenant_id
          AND revocation.facility_id = grant_row.facility_id
          AND revocation.grant_id = grant_row.id
          AND revocation.grant_purpose = grant_row.grant_purpose
        WHERE grant_row.tenant_id = $1::uuid
          AND (
            $2::integer IS NULL
            OR grant_row.facility_id = $2::integer
          )
          AND grant_row.grant_purpose IN (
            'capture_fixed_device',
            'capture_staff_facility'
          )
        ORDER BY grant_row.capture_revision DESC`,
      tenant,
      facility,
    ),
    { readOnly: true, isolationLevel: 'RepeatableRead' },
  );
}

export async function revokeClinicalContinuityFacilityGrant({
  tenantId: rawTenantId,
  facilityId: rawFacilityId,
  grantId: rawGrantId,
  revokedBy: rawRevokedBy,
  reason: rawReason,
  scopeRunner = setTenantTx,
} = {}) {
  const tenant = tenantId(rawTenantId);
  const facility = positiveInteger(rawFacilityId);
  const grantId = uuid(rawGrantId);
  const revokedBy = uuid(rawRevokedBy);
  const reason = String(rawReason || '').trim();
  const hasControlCharacter = [...reason].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!reason || reason.length > 500 || hasControlCharacter) {
    throw denied();
  }
  return scopeRunner(
    tenant,
    async tx => {
      const grants = await tx.$queryRawUnsafe(
        `SELECT grant_row.grant_purpose
           FROM clinical_continuity_edge_access_grants AS grant_row
           LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
             ON revocation.tenant_id = grant_row.tenant_id
            AND revocation.facility_id = grant_row.facility_id
            AND revocation.grant_id = grant_row.id
            AND revocation.grant_purpose = grant_row.grant_purpose
          WHERE grant_row.tenant_id = $1::uuid
            AND grant_row.facility_id = $2::integer
            AND grant_row.id = $3::uuid
            AND grant_row.grant_purpose IN (
              'capture_fixed_device',
              'capture_staff_facility'
            )
            AND revocation.id IS NULL
          FOR UPDATE OF grant_row`,
        tenant,
        facility,
        grantId,
      );
      if (grants.length !== 1) throw denied();
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_edge_access_revocations (
           tenant_id, facility_id, grant_id, access_revision,
           revoked_by, reason, grant_purpose, capture_revision
         )
         VALUES (
           $1::uuid, $2::integer, $3::uuid, NULL,
           $4::uuid, $5::varchar, $6::varchar,
           nextval('clinical_continuity_capture_revision_seq')
         )
         RETURNING id::text, grant_id::text, grant_purpose,
                   capture_revision::text, revoked_by::text,
                   revoked_at, reason`,
        tenant,
        facility,
        grantId,
        revokedBy,
        reason,
        grants[0].grant_purpose,
      );
      return rows[0];
    },
    { isolationLevel: 'Serializable' },
  );
}

function normalizedEnvelope(value) {
  if (!exactKeys(value, CONTEXT_ENVELOPE_KEYS)) throw denied();
  if (value.algorithm !== SIGNATURE_ALGORITHM) throw denied();
  if (!exactKeys(value.content, CONTEXT_CONTENT_KEYS)) throw denied();
  if (!HASH_PATTERN.test(String(value.contentHash || ''))) throw denied();
  if (hashCanonicalValue(value.content) !== value.contentHash) throw denied();
  if (!SIGNATURE_PATTERN.test(String(value.signature || ''))) throw denied();
  return value;
}

export async function resolveClinicalContinuityFacilityContext({
  req,
  envelope: rawEnvelope,
  clientFacilityId = null,
  clock = () => new Date(),
  scopeRunner = setTenantTx,
  policyLoader = loadActiveClinicalContinuityPolicyForFacilityTx,
} = {}) {
  const envelope = normalizedEnvelope(rawEnvelope);
  const content = envelope.content;
  const tenant = tenantId(req?.tenantId || req?.user?.tenant_id);
  const actorUid = uuid(req?.user?.uid);
  const deviceId = uuid(req?.user?.stableDeviceId);
  const jtiHash = sessionHash(req?.user?.jti);
  const facility = positiveInteger(content.facilityId);
  const trustedAt = utcTimestamp(clock());
  if (
    content.format !== CLINICAL_CONTINUITY_FACILITY_CONTEXT_FORMAT
    || tenantId(content.tenantId) !== tenant
    || uuid(content.staffUid) !== actorUid
    || uuid(content.deviceId) !== deviceId
    || content.sessionJtiSha256 !== jtiHash
    || (clientFacilityId !== null && positiveInteger(clientFacilityId) !== facility)
    || Date.parse(utcTimestamp(content.effectiveFrom)) > Date.parse(trustedAt)
    || Date.parse(utcTimestamp(content.expiresAt)) <= Date.parse(trustedAt)
    || Date.parse(utcTimestamp(content.issuedAt)) > Date.parse(trustedAt)
  ) {
    throw denied();
  }

  await scopeRunner(
    tenant,
    async tx => {
      const { grant, policy } = await loadGrantAndPolicy({
        tx,
        tenant,
        actorUid,
        deviceId,
        requestedFacilityId: facility,
        policyLoader,
      });
      if (
        uuid(content.grantId) !== uuid(grant.id)
        || content.grantPurpose !== grant.grant_purpose
        || revision(content.captureRevision) !== revision(grant.capture_revision)
        || uuid(content.policyId) !== policy.id
        || revision(content.policyVersion) !== policy.policyVersion
        || content.policyChecksum !== policy.policyChecksum
        || content.policySigningKeyId !== policy.policySigningKeyId
        || revision(content.revocationEpoch, { allowZero: true })
          !== policy.revocationEpoch
        || !verifyCanonicalValue(
          content,
          envelope.signature,
          policyKey(policy, envelope.keyId),
        )
      ) {
        throw denied();
      }
      const projections = await tx.$queryRawUnsafe(
        `SELECT 1
           FROM user_devices
          WHERE tenant_id = $1::uuid
            AND user_uid = $2::uuid
            AND device_id = $3
            AND facility_id = $4::integer
            AND continuity_grant_id = $5::uuid
            AND continuity_grant_purpose = $6
            AND continuity_capture_revision = $7::bigint
            AND continuity_context_id = $8::uuid
            AND continuity_context_revision = $9::bigint
            AND continuity_session_jti_sha256 = $10
            AND continuity_validation_state = 'active'
            AND continuity_expires_at > clock_timestamp()
          LIMIT 1`,
        tenant,
        actorUid,
        deviceId,
        facility,
        content.grantId,
        content.grantPurpose,
        content.captureRevision,
        content.contextId,
        content.contextRevision,
        content.sessionJtiSha256,
      );
      if (projections.length !== 1) throw denied();
    },
    { readOnly: true, isolationLevel: 'RepeatableRead' },
  );

  return attachRequestContext(req, content);
}

export function decodeClinicalContinuityFacilityContextHeader(value) {
  try {
    const encoded = String(value || '').trim();
    if (!encoded || encoded.length > 16_384) throw denied();
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (
      Buffer.from(canonicalizeJson(parsed), 'utf8').toString('base64url')
      !== encoded
    ) {
      throw denied();
    }
    return parsed;
  } catch (error) {
    if (error instanceof ClinicalContinuityFacilityContextError) throw error;
    throw denied();
  }
}

export function encodeClinicalContinuityFacilityContextHeader(envelope) {
  return Buffer.from(canonicalizeJson(normalizedEnvelope(envelope)), 'utf8')
    .toString('base64url');
}

export const __facilityContextContractForTests = Object.freeze({
  contentKeys: CONTEXT_CONTENT_KEYS,
  envelopeKeys: CONTEXT_ENVELOPE_KEYS,
  requestPropertyKeys: Object.freeze(Object.keys(frozenRequestContext({
    captureRevision: '1',
    contextId: '00000000-0000-4000-8000-000000000001',
    contextRevision: '1',
    deviceId: '00000000-0000-4000-8000-000000000002',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:01:00.000Z',
    facilityId: '1',
    grantId: '00000000-0000-4000-8000-000000000003',
    grantPurpose: 'capture_staff_facility',
    issuedAt: '2026-01-01T00:00:00.000Z',
    policyChecksum: 'a'.repeat(64),
    policyId: '00000000-0000-4000-8000-000000000004',
    policySigningKeyId: 'test',
    policyVersion: '1',
    revocationEpoch: '0',
    sessionJtiSha256: 'b'.repeat(64),
    staffUid: '00000000-0000-4000-8000-000000000005',
    tenantId: '00000000-0000-4000-8000-000000000006',
  })).sort()),
});
