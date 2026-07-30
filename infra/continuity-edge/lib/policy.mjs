import { createHash } from 'node:crypto';
import {
  HASH_PATTERN,
  POLICY_RECEIPT_FORMAT,
  UUID_PATTERN,
  canonicalTimestamp,
  exactKeys,
  normalizeFacilityId,
  normalizeTenantId,
  normalizeVersion,
} from './constants.mjs';
import { readProtectedJson } from './json-files.mjs';

const PAYLOAD_KEYS = [
  'algorithm',
  'audience',
  'canonicalization',
  'currentPackSigningKeyId',
  'currentPackSigningPublicKeySha256',
  'effectiveFrom',
  'effectiveUntil',
  'nextPackSigningKeyId',
  'nextPackSigningPublicKeySha256',
  'policyChecksum',
  'policyDocument',
  'policySchemaVersion',
  'policySigningKeyId',
  'policySigningPublicKeySha256',
  'policyVersion',
  'revocationEpoch',
  'revokedKeyIds',
  'supersedesPolicyId',
];

const POLICY_DOCUMENT_KEYS = [
  'audience',
  'edgeAccess',
  'fieldPolicy',
  'generation',
  'includedAreas',
  'medicationsDueWindow',
  'packSchemaVersion',
  'policySchemaVersion',
  'policyType',
  'recentReleasedResults',
  'requiredCoverage',
  'retention',
];

function pemSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function manifestPolicy(manifestEnvelope) {
  const policy = manifestEnvelope?.content?.policy;
  if (
    !policy ||
    !UUID_PATTERN.test(String(policy.id || '')) ||
    !HASH_PATTERN.test(String(policy.checksum || ''))
  ) {
    throw new Error('MANIFEST_INVALID');
  }
  return {
    id: String(policy.id).toLowerCase(),
    checksum: policy.checksum,
    version: normalizeVersion(policy.version),
    revocationEpoch: normalizeVersion(policy.revocationEpoch, { allowZero: true }),
  };
}

export function verifyPolicyReceipt(
  receipt,
  {
    policyKeys,
    manifestEnvelope,
    scope,
    trustedNow,
    floors,
    canonical,
  },
) {
  if (
    !exactKeys(receipt, ['format', 'payload', 'policyId', 'signature']) ||
    receipt.format !== POLICY_RECEIPT_FORMAT ||
    !UUID_PATTERN.test(String(receipt.policyId || '')) ||
    !/^[A-Za-z0-9+/]{86}==$/.test(String(receipt.signature || '')) ||
    !exactKeys(receipt.payload, PAYLOAD_KEYS)
  ) {
    throw new Error('SIGNED_POLICY_INVALID');
  }
  const payload = receipt.payload;
  const tenantId = normalizeTenantId(scope.tenantId);
  const facilityId = normalizeFacilityId(scope.facilityId);
  if (
    payload.algorithm !== 'Ed25519' ||
    payload.canonicalization !== 'rfc8785-jcs' ||
    payload.policySchemaVersion !== 2 ||
    !exactKeys(payload.audience, ['facilityId', 'tenantId']) ||
    normalizeTenantId(payload.audience.tenantId) !== tenantId ||
    normalizeFacilityId(payload.audience.facilityId) !== facilityId ||
    !exactKeys(payload.policyDocument, POLICY_DOCUMENT_KEYS) ||
    payload.policyDocument.policySchemaVersion !== 2 ||
    payload.policyDocument.policyType !== 'clinical_continuity_pack' ||
    !exactKeys(payload.policyDocument.audience, ['facilityId', 'tenantId']) ||
    normalizeTenantId(payload.policyDocument.audience.tenantId) !== tenantId ||
    normalizeFacilityId(payload.policyDocument.audience.facilityId) !== facilityId
  ) {
    throw new Error('SIGNED_POLICY_AUDIENCE_MISMATCH');
  }

  const key = policyKeys?.[payload.policySigningKeyId];
  if (
    !key ||
    key.keyId !== payload.policySigningKeyId ||
    key.algorithm !== 'Ed25519' ||
    !['active', 'retiring'].includes(key.state) ||
    pemSha256(key.publicKey) !== payload.policySigningPublicKeySha256 ||
    canonical.verifyCanonicalValue(payload, receipt.signature, key.publicKey) !== true
  ) {
    throw new Error('SIGNED_POLICY_SIGNATURE_INVALID');
  }

  const policy = manifestPolicy(manifestEnvelope);
  const policyVersion = normalizeVersion(payload.policyVersion);
  const revocationEpoch = normalizeVersion(payload.revocationEpoch, {
    allowZero: true,
  });
  if (
    receipt.policyId.toLowerCase() !== policy.id ||
    payload.policyChecksum !== policy.checksum ||
    canonical.hashCanonicalValue(payload.policyDocument) !== policy.checksum ||
    policyVersion !== policy.version ||
    revocationEpoch !== policy.revocationEpoch ||
    BigInt(policyVersion) < BigInt(floors.policyVersion) ||
    BigInt(revocationEpoch) < BigInt(floors.revocationEpoch)
  ) {
    throw new Error('SIGNED_POLICY_MISMATCH');
  }

  const now = canonicalTimestamp(trustedNow, 'trustedNow');
  const effectiveFrom = canonicalTimestamp(payload.effectiveFrom, 'effectiveFrom');
  const effectiveUntil =
    payload.effectiveUntil === null
      ? null
      : canonicalTimestamp(payload.effectiveUntil, 'effectiveUntil');
  if (
    Date.parse(now) < Date.parse(effectiveFrom) ||
    (effectiveUntil !== null && Date.parse(now) >= Date.parse(effectiveUntil))
  ) {
    throw new Error('SIGNED_POLICY_NOT_EFFECTIVE');
  }

  const edgeAccess = payload.policyDocument.edgeAccess;
  const retention = payload.policyDocument.retention;
  if (
    !exactKeys(edgeAccess, [
      'authenticationMode',
      'credentialLifetimeMinutes',
      'emergencyReadPosture',
      'maximumOfflineAuthorizationMinutes',
    ]) ||
    edgeAccess.authenticationMode !== 'mtls_client_certificate' ||
    !['disabled', 'read_only'].includes(edgeAccess.emergencyReadPosture) ||
    positiveInteger(
      edgeAccess.maximumOfflineAuthorizationMinutes,
      'maximumOfflineAuthorizationMinutes',
    ) >
      positiveInteger(edgeAccess.credentialLifetimeMinutes, 'credentialLifetimeMinutes') ||
    !exactKeys(retention, [
      'accessLogRetentionHours',
      'edgePackRetentionHours',
      'sourcePackRetentionHours',
    ])
  ) {
    throw new Error('SIGNED_POLICY_DECISIONS_INVALID');
  }
  const decisions = {
    edgeAccess: { ...edgeAccess },
    retention: {
      sourcePackRetentionHours: positiveInteger(
        retention.sourcePackRetentionHours,
        'sourcePackRetentionHours',
      ),
      edgePackRetentionHours: positiveInteger(
        retention.edgePackRetentionHours,
        'edgePackRetentionHours',
      ),
      accessLogRetentionHours: positiveInteger(
        retention.accessLogRetentionHours,
        'accessLogRetentionHours',
      ),
    },
  };
  return {
    ok: true,
    policy,
    payload,
    decisions,
  };
}

export async function loadAndVerifyPolicyReceipt(file, options) {
  return verifyPolicyReceipt(
    await readProtectedJson(file, { label: 'signed schema-v2 policy receipt' }),
    options,
  );
}
