import fs from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalizeJson,
  normalizeGovernanceVersion,
  VERIFICATION_REASONS,
  verifySignedPackEnvelope
} from './continuityPackCanonical.js';
import {
  CONTINUITY_LAYOUT_VERSION,
  normalizePositiveId,
  normalizeTenantId,
  sha256Hex
} from './continuityPackPublicationService.js';
import { CONTINUITY_EDGE_ACCESS_FORMAT } from './continuityEdgeAccessService.js';
import { CLINICAL_CONTINUITY_MANIFEST_FORMAT } from './clinicalContinuityPackOrchestrationService.js';
import { recordContinuityVerificationFailure } from '../../observability/continuityMetrics.js';

export const EDGE_MIRROR_VERIFICATION_REASONS = Object.freeze({
  ...VERIFICATION_REASONS,
  POINTER_INVALID: 'POINTER_INVALID',
  POINTER_HASH_MISMATCH: 'POINTER_HASH_MISMATCH',
  UNSAFE_PATH: 'UNSAFE_PATH',
  SYMLINK_ESCAPE: 'SYMLINK_ESCAPE',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  MANIFEST_HASH_MISMATCH: 'MANIFEST_HASH_MISMATCH',
  ASSET_MISSING: 'ASSET_MISSING',
  ASSET_EXTRA: 'ASSET_EXTRA',
  ASSET_HASH_MISMATCH: 'ASSET_HASH_MISMATCH',
  COVERAGE_MISMATCH: 'COVERAGE_MISMATCH',
  EDGE_ACCESS_INVALID: 'EDGE_ACCESS_INVALID',
  EDGE_ACCESS_MISMATCH: 'EDGE_ACCESS_MISMATCH',
  ACCESS_REVISION_ROLLBACK: 'ACCESS_REVISION_ROLLBACK'
});

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_TYPES = new Set(['ward', 'paeds', 'ed_board', 'opd_day']);

function rejected(reason, details = undefined) {
  return details === undefined ? { ok: false, reason } : { ok: false, reason, details };
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function safeRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(segment =>
    segment !== '.' &&
    segment !== '..' &&
    SAFE_SEGMENT.test(segment)
  );
}

function within(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

async function safeDirectoryChain(io, root, target) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  if (!within(rootPath, targetPath)) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.UNSAFE_PATH);
  }
  const relative = path.relative(rootPath, targetPath);
  const candidates = [rootPath];
  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    candidates.push(current);
  }
  try {
    for (const candidate of candidates) {
      const stat = await io.lstat(candidate);
      if (stat.isSymbolicLink()) {
        return rejected(EDGE_MIRROR_VERIFICATION_REASONS.SYMLINK_ESCAPE);
      }
      if (!stat.isDirectory()) {
        return rejected(EDGE_MIRROR_VERIFICATION_REASONS.UNSAFE_PATH);
      }
    }
    const realRoot = await io.realpath(rootPath);
    const realTarget = await io.realpath(targetPath);
    if (!within(realRoot, realTarget)) {
      return rejected(EDGE_MIRROR_VERIFICATION_REASONS.SYMLINK_ESCAPE);
    }
    return { ok: true };
  } catch {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_MISSING);
  }
}

async function regularFile(io, base, relativePath) {
  if (!safeRelativePath(relativePath)) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.UNSAFE_PATH, { relativePath });
  }
  const target = path.resolve(base, ...relativePath.split('/'));
  if (!within(base, target)) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.UNSAFE_PATH, { relativePath });
  }
  let stat;
  try {
    stat = await io.lstat(target);
  } catch {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_MISSING, { relativePath });
  }
  if (stat.isSymbolicLink()) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.SYMLINK_ESCAPE, { relativePath });
  }
  if (!stat.isFile()) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_MISSING, { relativePath });
  }
  try {
    const realBase = await io.realpath(base);
    const realTarget = await io.realpath(target);
    if (!within(realBase, realTarget)) {
      return rejected(EDGE_MIRROR_VERIFICATION_REASONS.SYMLINK_ESCAPE, { relativePath });
    }
    return { ok: true, bytes: await io.readFile(target), target };
  } catch {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_MISSING, { relativePath });
  }
}

async function walkRegularFiles(io, base, relative = '') {
  const directory = relative
    ? path.resolve(base, ...relative.split('/'))
    : base;
  const entries = await io.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (!safeRelativePath(childRelative)) {
      return rejected(EDGE_MIRROR_VERIFICATION_REASONS.UNSAFE_PATH, {
        relativePath: childRelative
      });
    }
    if (entry.isSymbolicLink()) {
      return rejected(EDGE_MIRROR_VERIFICATION_REASONS.SYMLINK_ESCAPE, {
        relativePath: childRelative
      });
    }
    if (entry.isDirectory()) {
      const nested = await walkRegularFiles(io, base, childRelative);
      if (!nested.ok) return nested;
      files.push(...nested.files);
    } else if (entry.isFile()) {
      files.push(childRelative);
    } else {
      return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_EXTRA, {
        relativePath: childRelative
      });
    }
  }
  return { ok: true, files };
}

function parseJson(bytes, reason) {
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return rejected(reason);
  }
}

function canonicalRenderedContent(value) {
  try {
    return { ok: true, rendered: canonicalizeJson(value) };
  } catch {
    return rejected(VERIFICATION_REASONS.CANONICALIZATION_FAILED);
  }
}

function coverageKey(location) {
  if (
    !exactKeys(location, [
      'contentHash',
      'expiresAt',
      'generatedAt',
      'keyId',
      'locationId',
      'locationType',
      'packHtmlSha256',
      'packJsonSha256',
      'renderHash'
    ]) ||
    !SAFE_SEGMENT.test(String(location.locationType || '')) ||
    !SAFE_SEGMENT.test(String(location.locationId || '')) ||
    !HASH_PATTERN.test(String(location.packHtmlSha256 || '')) ||
    !HASH_PATTERN.test(String(location.packJsonSha256 || ''))
  ) {
    return null;
  }
  return `${location.locationType}/${location.locationId}`;
}

function normalizeFloor(value, { allowZero = false } = {}) {
  return normalizeGovernanceVersion(value, { allowZero });
}

function expectedAudience(tenantId, facilityId) {
  return { tenantId, facilityId: String(facilityId) };
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function edgeAccessContentRevision(
  content,
  tenantId,
  facilityId,
  { coverage = null } = {}
) {
  if (
    !exactKeys(content, [
      'accessRevision',
      'audience',
      'edgeAccess',
      'format',
      'generatedAt',
      'grants',
      'policy',
      'revocations'
    ]) ||
    content.format !== CONTINUITY_EDGE_ACCESS_FORMAT ||
    !exactKeys(content.audience, ['facilityId', 'tenantId']) ||
    content.audience.tenantId !== tenantId ||
    content.audience.facilityId !== String(facilityId) ||
    !exactKeys(content.edgeAccess, [
      'authenticationMode',
      'credentialLifetimeMinutes',
      'emergencyReadPosture',
      'maximumOfflineAuthorizationMinutes'
    ]) ||
    content.edgeAccess.authenticationMode !== 'mtls_client_certificate' ||
    !['disabled', 'read_only'].includes(content.edgeAccess.emergencyReadPosture) ||
    !Number.isSafeInteger(content.edgeAccess.credentialLifetimeMinutes) ||
    content.edgeAccess.credentialLifetimeMinutes < 1 ||
    !Number.isSafeInteger(content.edgeAccess.maximumOfflineAuthorizationMinutes) ||
    content.edgeAccess.maximumOfflineAuthorizationMinutes < 1 ||
    content.edgeAccess.credentialLifetimeMinutes <
      content.edgeAccess.maximumOfflineAuthorizationMinutes ||
    !canonicalTimestamp(content.generatedAt) ||
    !exactKeys(content.policy, ['id', 'revocationEpoch', 'version']) ||
    !UUID_PATTERN.test(String(content.policy.id || '')) ||
    !Array.isArray(content.grants) ||
    !Array.isArray(content.revocations)
  ) {
    return null;
  }

  let accessRevision;
  let policyVersion;
  let revocationEpoch;
  try {
    accessRevision = normalizeFloor(content.accessRevision, { allowZero: true });
    policyVersion = normalizeFloor(content.policy.version);
    revocationEpoch = normalizeFloor(content.policy.revocationEpoch, { allowZero: true });
  } catch {
    return null;
  }
  if (
    policyVersion !== String(content.policy.version) ||
    revocationEpoch !== String(content.policy.revocationEpoch)
  ) {
    return null;
  }

  const grantIds = new Set();
  for (const grant of content.grants) {
    if (
      !exactKeys(grant, [
        'accessRevision',
        'clientCertificateSha256',
        'deviceId',
        'grantId',
        'locationIdentifier',
        'locationType',
        'staffUid',
        'validFrom',
        'validUntil'
      ]) ||
      !UUID_PATTERN.test(String(grant.grantId || '')) ||
      !UUID_PATTERN.test(String(grant.staffUid || '')) ||
      !HASH_PATTERN.test(String(grant.clientCertificateSha256 || '')) ||
      !LOCATION_TYPES.has(grant.locationType) ||
      !SAFE_SEGMENT.test(String(grant.locationIdentifier || '')) ||
      typeof grant.deviceId !== 'string' ||
      grant.deviceId.trim() !== grant.deviceId ||
      grant.deviceId.length < 1 ||
      grant.deviceId.length > 160 ||
      !canonicalTimestamp(grant.validFrom) ||
      !canonicalTimestamp(grant.validUntil) ||
      Date.parse(grant.validUntil) <= Date.parse(grant.validFrom) ||
      Date.parse(grant.validUntil) - Date.parse(grant.validFrom) >
        content.edgeAccess.credentialLifetimeMinutes * 60_000 ||
      (
        coverage !== null &&
        !coverage.has(`${grant.locationType}/${grant.locationIdentifier}`)
      ) ||
      grantIds.has(grant.grantId)
    ) {
      return null;
    }
    let revision;
    try {
      revision = normalizeFloor(grant.accessRevision);
    } catch {
      return null;
    }
    if (BigInt(revision) > BigInt(accessRevision)) return null;
    grantIds.add(grant.grantId);
  }

  const revokedGrantIds = new Set();
  for (const revocation of content.revocations) {
    if (
      !exactKeys(revocation, ['accessRevision', 'grantId', 'revokedAt']) ||
      !grantIds.has(revocation.grantId) ||
      revokedGrantIds.has(revocation.grantId) ||
      !canonicalTimestamp(revocation.revokedAt)
    ) {
      return null;
    }
    let revision;
    try {
      revision = normalizeFloor(revocation.accessRevision);
    } catch {
      return null;
    }
    if (BigInt(revision) > BigInt(accessRevision)) return null;
    revokedGrantIds.add(revocation.grantId);
  }
  return accessRevision;
}

async function verifyPackAsset({
  io,
  setDir,
  entry,
  trustedKeys,
  audience,
  floors,
  trustedNow,
  clockTrusted
}) {
  const key = coverageKey(entry);
  if (key === null) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.COVERAGE_MISMATCH);
  }
  const jsonPath = `locations/${key}/pack.json`;
  const htmlPath = `locations/${key}/pack.html`;
  const packJson = await regularFile(io, setDir, jsonPath);
  if (!packJson.ok) return packJson;
  const packHtml = await regularFile(io, setDir, htmlPath);
  if (!packHtml.ok) return packHtml;
  if (
    sha256Hex(packJson.bytes) !== entry.packJsonSha256 ||
    sha256Hex(packHtml.bytes) !== entry.packHtmlSha256
  ) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_HASH_MISMATCH, { key });
  }
  const parsed = parseJson(packJson.bytes, VERIFICATION_REASONS.INVALID_ENVELOPE);
  if (!parsed.ok) return parsed;
  const verification = verifySignedPackEnvelope(parsed.value, {
    rendered: packHtml.bytes,
    trustedKeys,
    expectedAudience: audience,
    minimumManifestVersion: floors.manifestVersion,
    minimumPolicyVersion: floors.policyVersion,
    minimumRevocationEpoch: floors.revocationEpoch,
    trustedNow,
    minimumTrustedNow: floors.trustedNow,
    clockTrusted
  });
  if (!verification.ok) return verification;
  if (
    parsed.value.contentHash !== entry.contentHash ||
    parsed.value.renderHash !== entry.renderHash ||
    parsed.value.keyId !== entry.keyId ||
    parsed.value.issuedAt !== entry.generatedAt ||
    parsed.value.expiresAt !== entry.expiresAt
  ) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_HASH_MISMATCH, { key });
  }
  return { ok: true, key, jsonPath, htmlPath };
}

async function verifyContinuityEdgeMirrorUnchecked({
  root,
  tenantId: rawTenantId,
  facilityId: rawFacilityId,
  trustedKeys,
  persistedFloors,
  trustedNow,
  clockTrusted = false,
  fsOps = fs
} = {}) {
  let tenantId;
  let facilityId;
  let floors;
  try {
    if (
      typeof root !== 'string' ||
      root.trim() !== root ||
      root.length === 0 ||
      !path.isAbsolute(root)
    ) {
      return rejected(EDGE_MIRROR_VERIFICATION_REASONS.UNSAFE_PATH);
    }
    tenantId = normalizeTenantId(rawTenantId);
    facilityId = normalizePositiveId(rawFacilityId, 'facilityId');
    if (
      !persistedFloors ||
      persistedFloors.manifestVersion == null ||
      persistedFloors.policyVersion == null ||
      persistedFloors.revocationEpoch == null ||
      persistedFloors.accessRevision == null ||
      persistedFloors.trustedNow == null
    ) {
      return rejected(VERIFICATION_REASONS.ROLLBACK_STATE_REQUIRED);
    }
    floors = {
      manifestVersion: normalizeFloor(persistedFloors.manifestVersion),
      policyVersion: normalizeFloor(persistedFloors.policyVersion),
      revocationEpoch: normalizeFloor(persistedFloors.revocationEpoch, { allowZero: true }),
      accessRevision: normalizeFloor(persistedFloors.accessRevision, { allowZero: true }),
      trustedNow: new Date(persistedFloors.trustedNow).toISOString()
    };
  } catch {
    return rejected(VERIFICATION_REASONS.INVALID_ENVELOPE);
  }

  const facilityDir = path.resolve(
    root,
    CONTINUITY_LAYOUT_VERSION,
    'tenants',
    tenantId,
    'facilities',
    String(facilityId)
  );
  const facilityChain = await safeDirectoryChain(fsOps, path.resolve(root), facilityDir);
  if (!facilityChain.ok) return facilityChain;
  const pointerFile = await regularFile(fsOps, facilityDir, 'current.json');
  if (!pointerFile.ok) {
    return rejected(
      pointerFile.reason === EDGE_MIRROR_VERIFICATION_REASONS.ASSET_MISSING
        ? EDGE_MIRROR_VERIFICATION_REASONS.POINTER_INVALID
        : pointerFile.reason,
      pointerFile.details
    );
  }
  const pointerParsed = parseJson(
    pointerFile.bytes,
    EDGE_MIRROR_VERIFICATION_REASONS.POINTER_INVALID
  );
  if (!pointerParsed.ok) return pointerParsed;
  const pointer = pointerParsed.value;
  if (
    !exactKeys(pointer, [
      'facility_id',
      'manifest',
      'manifest_sha256',
      'manifest_version',
      'schema',
      'set',
      'tenant_id'
    ]) ||
    pointer.schema !== 'continuity-current-v1' ||
    pointer.tenant_id !== tenantId ||
    pointer.facility_id !== facilityId ||
    !HASH_PATTERN.test(String(pointer.manifest_sha256 || ''))
  ) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.POINTER_INVALID);
  }

  let manifestVersion;
  try {
    manifestVersion = normalizeFloor(pointer.manifest_version);
  } catch {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.POINTER_INVALID);
  }
  const expectedSet = `sets/v${manifestVersion}`;
  if (
    pointer.set !== expectedSet ||
    pointer.manifest !== `${expectedSet}/manifest.json` ||
    !safeRelativePath(pointer.set) ||
    !safeRelativePath(pointer.manifest)
  ) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.POINTER_INVALID);
  }
  if (BigInt(manifestVersion) < BigInt(floors.manifestVersion)) {
    return rejected(VERIFICATION_REASONS.MANIFEST_ROLLBACK);
  }

  const setDir = path.resolve(facilityDir, ...pointer.set.split('/'));
  if (!within(facilityDir, setDir)) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.UNSAFE_PATH);
  }
  const setChain = await safeDirectoryChain(fsOps, facilityDir, setDir);
  if (!setChain.ok) return setChain;
  const manifestFile = await regularFile(fsOps, facilityDir, pointer.manifest);
  if (!manifestFile.ok) return manifestFile;
  if (sha256Hex(manifestFile.bytes) !== pointer.manifest_sha256) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.MANIFEST_HASH_MISMATCH);
  }
  const parsedManifest = parseJson(
    manifestFile.bytes,
    EDGE_MIRROR_VERIFICATION_REASONS.MANIFEST_INVALID
  );
  if (!parsedManifest.ok) return parsedManifest;
  const manifestEnvelope = parsedManifest.value;
  const manifestContent = manifestEnvelope?.content;
  const audience = expectedAudience(tenantId, facilityId);
  const manifestRendered = canonicalRenderedContent(manifestContent);
  if (!manifestRendered.ok) return manifestRendered;
  const manifestVerification = verifySignedPackEnvelope(manifestEnvelope, {
    rendered: manifestRendered.rendered,
    trustedKeys,
    expectedAudience: audience,
    minimumManifestVersion: floors.manifestVersion,
    minimumPolicyVersion: floors.policyVersion,
    minimumRevocationEpoch: floors.revocationEpoch,
    trustedNow,
    minimumTrustedNow: floors.trustedNow,
    clockTrusted
  });
  if (!manifestVerification.ok) return manifestVerification;

  if (
    !exactKeys(manifestContent, [
      'edgeAccess',
      'facility',
      'format',
      'generatedAt',
      'locations',
      'manifestVersion',
      'policy',
      'publicationSetId',
      'sourceWatermark',
      'tenantId'
    ]) ||
    manifestContent?.format !== CLINICAL_CONTINUITY_MANIFEST_FORMAT ||
    manifestContent.tenantId !== tenantId ||
    !exactKeys(manifestContent.facility, ['id', 'name', 'timezone']) ||
    String(manifestContent.facility?.id) !== String(facilityId) ||
    String(manifestContent.manifestVersion) !== manifestVersion ||
    String(manifestEnvelope.manifestVersion) !== manifestVersion ||
    manifestContent.generatedAt !== manifestEnvelope.issuedAt ||
    !UUID_PATTERN.test(String(manifestContent.publicationSetId || '')) ||
    !exactKeys(manifestContent.policy, [
      'checksum',
      'id',
      'revocationEpoch',
      'version'
    ]) ||
    !HASH_PATTERN.test(String(manifestContent.policy.checksum || '')) ||
    !UUID_PATTERN.test(String(manifestContent.policy.id || '')) ||
    String(manifestContent.policy.version) !==
      String(manifestEnvelope.policyVersion) ||
    String(manifestContent.policy.revocationEpoch) !==
      String(manifestEnvelope.revocationEpoch) ||
    !Array.isArray(manifestContent.locations) ||
    manifestContent.locations.length === 0 ||
    !exactKeys(manifestContent.edgeAccess, [
      'accessRevision',
      'path',
      'sha256'
    ])
  ) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.MANIFEST_INVALID);
  }

  let accessRevision;
  try {
    accessRevision = normalizeFloor(manifestContent.edgeAccess.accessRevision, {
      allowZero: true
    });
  } catch {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.EDGE_ACCESS_INVALID);
  }
  if (BigInt(accessRevision) < BigInt(floors.accessRevision)) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ACCESS_REVISION_ROLLBACK);
  }
  if (
    manifestContent.edgeAccess.path !== 'edge-access.json' ||
    !HASH_PATTERN.test(String(manifestContent.edgeAccess.sha256 || ''))
  ) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.EDGE_ACCESS_INVALID);
  }

  const coverage = new Set();
  const expectedFiles = new Set(['manifest.json', 'edge-access.json']);
  for (const entry of manifestContent.locations) {
    const verified = await verifyPackAsset({
      io: fsOps,
      setDir,
      entry,
      trustedKeys,
      audience,
      floors,
      trustedNow,
      clockTrusted
    });
    if (!verified.ok) return verified;
    if (coverage.has(verified.key)) {
      return rejected(EDGE_MIRROR_VERIFICATION_REASONS.COVERAGE_MISMATCH);
    }
    coverage.add(verified.key);
    expectedFiles.add(verified.jsonPath);
    expectedFiles.add(verified.htmlPath);
  }

  const edgeAccessFile = await regularFile(fsOps, setDir, 'edge-access.json');
  if (!edgeAccessFile.ok) return edgeAccessFile;
  if (sha256Hex(edgeAccessFile.bytes) !== manifestContent.edgeAccess.sha256) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_HASH_MISMATCH, {
      relativePath: 'edge-access.json'
    });
  }
  const parsedEdgeAccess = parseJson(
    edgeAccessFile.bytes,
    EDGE_MIRROR_VERIFICATION_REASONS.EDGE_ACCESS_INVALID
  );
  if (!parsedEdgeAccess.ok) return parsedEdgeAccess;
  const edgeEnvelope = parsedEdgeAccess.value;
  const edgeRendered = canonicalRenderedContent(edgeEnvelope?.content);
  if (!edgeRendered.ok) return edgeRendered;
  const edgeVerification = verifySignedPackEnvelope(edgeEnvelope, {
    rendered: edgeRendered.rendered,
    trustedKeys,
    expectedAudience: audience,
    minimumManifestVersion: floors.manifestVersion,
    minimumPolicyVersion: floors.policyVersion,
    minimumRevocationEpoch: floors.revocationEpoch,
    trustedNow,
    minimumTrustedNow: floors.trustedNow,
    clockTrusted
  });
  if (!edgeVerification.ok) return edgeVerification;
  const verifiedEdgeRevision = edgeAccessContentRevision(
    edgeEnvelope.content,
    tenantId,
    facilityId,
    { coverage }
  );
  if (
    verifiedEdgeRevision === null ||
    verifiedEdgeRevision !== accessRevision ||
    String(edgeEnvelope.manifestVersion) !== manifestVersion ||
    edgeEnvelope.issuedAt !== edgeEnvelope.content?.generatedAt ||
    String(edgeEnvelope.policyVersion) !==
      String(edgeEnvelope.content?.policy?.version) ||
    String(edgeEnvelope.revocationEpoch) !==
      String(edgeEnvelope.content?.policy?.revocationEpoch) ||
    String(edgeEnvelope.content?.policy?.id) !== String(manifestContent.policy?.id) ||
    String(edgeEnvelope.content?.policy?.version) !== String(manifestContent.policy?.version) ||
    String(edgeEnvelope.content?.policy?.revocationEpoch) !==
      String(manifestContent.policy?.revocationEpoch)
  ) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.EDGE_ACCESS_MISMATCH);
  }

  let walked;
  try {
    walked = await walkRegularFiles(fsOps, setDir);
  } catch {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_MISSING);
  }
  if (!walked.ok) return walked;
  const actualFiles = new Set(walked.files);
  const missing = [...expectedFiles].filter(file => !actualFiles.has(file));
  const extra = [...actualFiles].filter(file => !expectedFiles.has(file));
  if (missing.length > 0) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_MISSING, { missing });
  }
  if (extra.length > 0) {
    return rejected(EDGE_MIRROR_VERIFICATION_REASONS.ASSET_EXTRA, { extra });
  }

  return {
    ok: true,
    reason: null,
    tenantId,
    facilityId,
    manifestVersion,
    policyVersion: String(manifestContent.policy.version),
    revocationEpoch: String(manifestContent.policy.revocationEpoch),
    accessRevision,
    trustedNow: manifestVerification.freshness?.trustedNow || trustedNow,
    coverage: [...coverage].sort()
  };
}

export async function verifyContinuityEdgeMirror(options = {}) {
  let result;
  try {
    result = await verifyContinuityEdgeMirrorUnchecked(options);
  } catch {
    result = rejected(VERIFICATION_REASONS.INVALID_ENVELOPE);
  }
  // A rejection carries no normalized identity, so the caller-supplied
  // facilityId is the only one available; an unusable value is labelled
  // 'unknown' rather than dropped so the failure still reaches a
  // `by (facility_id)` rule.
  if (!result.ok) {
    recordContinuityVerificationFailure({
      facilityId: options.facilityId,
      reason: result.reason
    });
  }
  return result;
}

export const __testing__ = Object.freeze({
  coverageKey,
  canonicalRenderedContent,
  exactKeys,
  edgeAccessContentRevision,
  safeRelativePath,
  safeDirectoryChain,
  walkRegularFiles
});

export default {
  EDGE_MIRROR_VERIFICATION_REASONS,
  verifyContinuityEdgeMirror
};
