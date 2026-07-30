import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CONTINUITY_LAYOUT_VERSION,
  HASH_PATTERN,
  POINTER_FORMAT,
  exactKeys,
  normalizeFacilityId,
  normalizeTenantId,
  normalizeVersion,
  safeRelativePath,
} from './constants.mjs';

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function facilityDirectory(root, tenantId, facilityId) {
  return path.join(
    path.resolve(root),
    CONTINUITY_LAYOUT_VERSION,
    'tenants',
    normalizeTenantId(tenantId),
    'facilities',
    String(normalizeFacilityId(facilityId)),
  );
}

export function parsePointer(value, { tenantId, facilityId } = {}) {
  const tenant = normalizeTenantId(tenantId);
  const facility = normalizeFacilityId(facilityId);
  if (
    !exactKeys(value, [
      'facility_id',
      'manifest',
      'manifest_sha256',
      'manifest_version',
      'schema',
      'set',
      'tenant_id',
    ]) ||
    value.schema !== POINTER_FORMAT ||
    value.tenant_id !== tenant ||
    value.facility_id !== facility ||
    !HASH_PATTERN.test(String(value.manifest_sha256 || ''))
  ) {
    throw new Error('POINTER_INVALID');
  }
  const version = normalizeVersion(value.manifest_version);
  const expectedSet = `sets/v${version}`;
  if (
    value.set !== expectedSet ||
    value.manifest !== `${expectedSet}/manifest.json` ||
    !safeRelativePath(value.set) ||
    !safeRelativePath(value.manifest)
  ) {
    throw new Error('POINTER_INVALID');
  }
  return {
    ...value,
    manifest_version: version,
  };
}

export function parsePointerBytes(bytes, scope) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('POINTER_INVALID');
  }
  return parsePointer(value, scope);
}

export async function readCurrentSelection(root, scope) {
  const directory = facilityDirectory(root, scope.tenantId, scope.facilityId);
  const pointerBytes = await readFile(path.join(directory, 'current.json'));
  const pointer = parsePointerBytes(pointerBytes, scope);
  const manifestBytes = await readFile(path.join(directory, ...pointer.manifest.split('/')));
  if (sha256Hex(manifestBytes) !== pointer.manifest_sha256) {
    throw new Error('MANIFEST_HASH_MISMATCH');
  }
  let manifestEnvelope;
  try {
    manifestEnvelope = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('MANIFEST_INVALID');
  }
  return {
    directory,
    pointer,
    pointerBytes,
    manifestBytes,
    manifestEnvelope,
    setDirectory: path.join(directory, ...pointer.set.split('/')),
  };
}
