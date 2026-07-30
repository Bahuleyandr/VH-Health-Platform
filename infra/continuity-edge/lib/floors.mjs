import { access } from 'node:fs/promises';
import {
  FLOOR_BOOTSTRAP_FORMAT,
  FLOORS_FORMAT,
  HASH_PATTERN,
  canonicalTimestamp,
  exactKeys,
  normalizeFacilityId,
  normalizeTenantId,
  normalizeVersion,
} from './constants.mjs';
import { atomicWriteFile } from './atomic-files.mjs';
import { readProtectedJson } from './json-files.mjs';

const FLOOR_KEYS = [
  'accessRevision',
  'facilityId',
  'format',
  'manifestVersion',
  'policyVersion',
  'revocationEpoch',
  'tenantId',
  'trustedNow',
];

function normalizeFloorValues(value, scope) {
  const tenantId = normalizeTenantId(value.tenantId);
  const facilityId = normalizeFacilityId(value.facilityId);
  if (
    tenantId !== normalizeTenantId(scope.tenantId) ||
    facilityId !== normalizeFacilityId(scope.facilityId)
  ) {
    throw new Error('floor receipt audience does not match the configured facility');
  }
  return {
    tenantId,
    facilityId,
    manifestVersion: normalizeVersion(value.manifestVersion),
    policyVersion: normalizeVersion(value.policyVersion),
    revocationEpoch: normalizeVersion(value.revocationEpoch, { allowZero: true }),
    accessRevision: normalizeVersion(value.accessRevision, { allowZero: true }),
    trustedNow: canonicalTimestamp(value.trustedNow, 'trustedNow'),
  };
}

export function parseBootstrapFloors(value, scope) {
  if (
    !exactKeys(value, [
      ...FLOOR_KEYS,
      'approvedAt',
      'approvedBy',
    ]) ||
    value.format !== FLOOR_BOOTSTRAP_FORMAT ||
    typeof value.approvedBy !== 'string' ||
    value.approvedBy.trim().length < 3
  ) {
    throw new Error('bootstrap floor receipt is invalid');
  }
  canonicalTimestamp(value.approvedAt, 'approvedAt');
  return normalizeFloorValues(value, scope);
}

export function parsePersistedFloors(value, scope) {
  if (
    !exactKeys(value, [
      ...FLOOR_KEYS,
      'currentManifestSha256',
      'updatedAt',
    ]) ||
    value.format !== FLOORS_FORMAT ||
    !HASH_PATTERN.test(String(value.currentManifestSha256 || ''))
  ) {
    throw new Error('persisted floor state is invalid');
  }
  canonicalTimestamp(value.updatedAt, 'updatedAt');
  return {
    ...normalizeFloorValues(value, scope),
    currentManifestSha256: value.currentManifestSha256,
  };
}

export async function loadFloors({ statePath, bootstrapPath, scope }) {
  try {
    await access(statePath);
    return {
      source: 'persisted',
      values: parsePersistedFloors(
        await readProtectedJson(statePath, { label: 'persisted floor state' }),
        scope,
      ),
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!bootstrapPath) {
    throw new Error('ROLLBACK_STATE_REQUIRED');
  }
  return {
    source: 'bootstrap',
    values: parseBootstrapFloors(
      await readProtectedJson(bootstrapPath, { label: 'bootstrap floor receipt' }),
      scope,
    ),
  };
}

export function advanceFloors(current, verified, manifestSha256, now = new Date()) {
  const next = {
    manifestVersion: normalizeVersion(verified.manifestVersion),
    policyVersion: normalizeVersion(verified.policyVersion),
    revocationEpoch: normalizeVersion(verified.revocationEpoch, { allowZero: true }),
    accessRevision: normalizeVersion(verified.accessRevision, { allowZero: true }),
    trustedNow: canonicalTimestamp(verified.trustedNow, 'verified.trustedNow'),
  };
  for (const key of [
    'manifestVersion',
    'policyVersion',
    'revocationEpoch',
    'accessRevision',
  ]) {
    if (BigInt(next[key]) < BigInt(current[key])) {
      throw new Error(`${key.toUpperCase()}_ROLLBACK`);
    }
  }
  if (Date.parse(next.trustedNow) < Date.parse(current.trustedNow)) {
    throw new Error('TRUSTED_TIME_ROLLBACK');
  }
  if (!HASH_PATTERN.test(manifestSha256)) throw new Error('manifest SHA-256 is invalid');
  return {
    format: FLOORS_FORMAT,
    tenantId: current.tenantId,
    facilityId: current.facilityId,
    ...next,
    currentManifestSha256: manifestSha256,
    updatedAt: now.toISOString(),
  };
}

export async function persistFloors(statePath, value) {
  await atomicWriteFile(statePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}
