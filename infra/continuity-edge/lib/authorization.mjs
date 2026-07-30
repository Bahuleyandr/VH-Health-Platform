import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  HASH_PATTERN,
  LOCATION_TYPES,
  SAFE_SEGMENT_PATTERN,
  UUID_PATTERN,
  exactKeys,
  normalizeFacilityId,
  normalizeTenantId,
  normalizeVersion,
} from './constants.mjs';

export function parseGatewayPath(pathname) {
  const match =
    /^\/v1\/tenants\/([^/]+)\/facilities\/([1-9][0-9]*)\/locations\/([^/]+)\/([^/]+)\/(pack\.(?:html|json))$/.exec(
      pathname,
    );
  if (!match) return null;
  let tenantId;
  let facilityId;
  try {
    tenantId = normalizeTenantId(match[1]);
    facilityId = normalizeFacilityId(match[2]);
  } catch {
    return null;
  }
  if (
    !LOCATION_TYPES.has(match[3]) ||
    !SAFE_SEGMENT_PATTERN.test(match[4])
  ) {
    return null;
  }
  return {
    tenantId,
    facilityId,
    locationType: match[3],
    locationIdentifier: match[4],
    asset: match[5],
  };
}

export function certificateSha256(socket) {
  if (socket.authorized !== true) throw new Error('CLIENT_CERTIFICATE_REQUIRED');
  const certificate = socket.getPeerCertificate(true);
  if (!certificate?.raw) throw new Error('CLIENT_CERTIFICATE_REQUIRED');
  return new X509Certificate(certificate.raw)
    .fingerprint256.replaceAll(':', '')
    .toLowerCase();
}

function revocationSet(content) {
  return new Set(content.revocations.map((entry) => entry.grantId));
}

function nowInside(grant, nowMs) {
  return (
    nowMs >= Date.parse(grant.validFrom) &&
    nowMs < Date.parse(grant.validUntil)
  );
}

function edgeAccessMatches(left, right) {
  return (
    left.authenticationMode === right.authenticationMode &&
    left.credentialLifetimeMinutes === right.credentialLifetimeMinutes &&
    left.emergencyReadPosture === right.emergencyReadPosture &&
    left.maximumOfflineAuthorizationMinutes ===
      right.maximumOfflineAuthorizationMinutes
  );
}

export function authorizeEdgeRead({
  edgeAccessEnvelope,
  policy,
  floors,
  scope,
  location,
  staffUid,
  deviceId,
  clientCertificateSha256,
  trustedNow,
}) {
  const content = edgeAccessEnvelope?.content;
  if (
    !content ||
    content.audience?.tenantId !== normalizeTenantId(scope.tenantId) ||
    normalizeFacilityId(content.audience?.facilityId) !==
      normalizeFacilityId(scope.facilityId) ||
    !Array.isArray(content.grants) ||
    !Array.isArray(content.revocations) ||
    !exactKeys(content.edgeAccess, [
      'authenticationMode',
      'credentialLifetimeMinutes',
      'emergencyReadPosture',
      'maximumOfflineAuthorizationMinutes',
    ]) ||
    !edgeAccessMatches(content.edgeAccess, policy.decisions.edgeAccess)
  ) {
    throw new Error('EDGE_ACCESS_MISMATCH');
  }
  const staff = String(staffUid || '').toLowerCase();
  const device = String(deviceId || '');
  const fingerprint = String(clientCertificateSha256 || '').toLowerCase();
  if (
    !UUID_PATTERN.test(staff) ||
    device.length < 1 ||
    device.length > 160 ||
    !HASH_PATTERN.test(fingerprint)
  ) {
    throw new Error('AUTHORIZATION_SCOPE_INVALID');
  }
  const nowMs = Date.parse(trustedNow);
  const generatedAtMs = Date.parse(content.generatedAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(generatedAtMs) ||
    nowMs <
      Date.parse(floors.trustedNow) ||
    nowMs - generatedAtMs >
      content.edgeAccess.maximumOfflineAuthorizationMinutes * 60_000
  ) {
    throw new Error('OFFLINE_AUTHORIZATION_WINDOW_EXPIRED');
  }
  const revoked = revocationSet(content);
  const matches = content.grants.filter(
    (grant) =>
      grant.locationType === location.locationType &&
      grant.locationIdentifier === location.locationIdentifier &&
      grant.staffUid === staff &&
      grant.deviceId === device &&
      grant.clientCertificateSha256 === fingerprint &&
      !revoked.has(grant.grantId) &&
      nowInside(grant, nowMs) &&
      BigInt(normalizeVersion(grant.accessRevision)) <=
        BigInt(normalizeVersion(content.accessRevision, { allowZero: true })) &&
      BigInt(normalizeVersion(grant.accessRevision)) >=
        BigInt(normalizeVersion(floors.accessRevision, { allowZero: true })),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'ACCESS_GRANT_NOT_AUTHORIZED'
        : 'ACCESS_GRANT_AMBIGUOUS',
    );
  }
  return matches[0];
}

export async function authorizeLoggingIdentity({
  edgeAccessEnvelope,
  identity,
  trustedNow,
}) {
  const content = edgeAccessEnvelope.content;
  const revoked = revocationSet(content);
  const certificate = new X509Certificate(
    await readFile(identity.certificatePath, 'utf8'),
  );
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const grant = content.grants.find((entry) => entry.grantId === identity.grantId);
  if (
    !grant ||
    revoked.has(grant.grantId) ||
    grant.locationType !== identity.locationType ||
    grant.locationIdentifier !== identity.locationIdentifier ||
    grant.deviceId !== identity.deviceId ||
    grant.clientCertificateSha256 !== fingerprint ||
    String(grant.accessRevision) !== identity.accessRevision ||
    String(content.policy.id).toLowerCase() !== identity.policyVersionId ||
    String(content.policy.version) !== identity.policyVersion ||
    !nowInside(grant, Date.parse(trustedNow))
  ) {
    throw new Error('LOGGING_IDENTITY_NOT_AUTHORIZED');
  }
  return { grant, fingerprint };
}
