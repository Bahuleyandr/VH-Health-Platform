import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalizeJson,
  normalizeGovernanceVersion,
  sha256Hex as hashBytesSha256,
} from './continuityPackCanonical.js';

export const CONTINUITY_LAYOUT_VERSION = 'continuity-v1';
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EBADF',
  'EISDIR',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EPERM',
]);

const NATIVE_FS_OPS = Object.freeze({
  lstat: (...args) => fs.lstat(...args),
  mkdir: (...args) => fs.mkdir(...args),
  open: (...args) => fs.open(...args),
  readFile: (...args) => fs.readFile(...args),
  rename: (...args) => fs.rename(...args),
  rm: (...args) => fs.rm(...args),
  unlink: (...args) => fs.unlink(...args),
  writeFile: (...args) => fs.writeFile(...args),
});

function validationError(message) {
  const error = new TypeError(message);
  error.code = 'CONTINUITY_PACK_PUBLICATION_INVALID';
  return error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function aliasedValue(object, names, label, { required = true } = {}) {
  const entries = names
    .filter((name) => hasOwn(object, name) && object[name] !== undefined)
    .map((name) => [name, object[name]]);

  if (!entries.length) {
    if (!required) return undefined;
    throw validationError(`${label} is required`);
  }

  const [, firstValue] = entries[0];
  for (const [name, value] of entries.slice(1)) {
    if (String(value) !== String(firstValue)) {
      throw validationError(`${label} aliases disagree (${entries[0][0]} and ${name})`);
    }
  }
  return firstValue;
}

export function contentBytes(content, label = 'signed content') {
  if (Buffer.isBuffer(content)) return Buffer.from(content);
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (content instanceof ArrayBuffer) return Buffer.from(new Uint8Array(content));
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content !== undefined && content !== null && typeof content === 'object') {
    return Buffer.from(canonicalizeJson(content), 'utf8');
  }
  throw validationError(`${label} must be a string, byte array, ArrayBuffer, or plain JSON value`);
}

export function sha256Hex(content) {
  return hashBytesSha256(contentBytes(content));
}

export function normalizeTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
    throw validationError('tenantId must be a UUID');
  }
  const normalized = tenantId.toLowerCase();
  if (normalized === DEFAULT_TENANT_ID) {
    throw validationError('the default tenant is not permitted for continuity publication');
  }
  if (normalized === NIL_UUID) {
    throw validationError('tenantId must not be the nil UUID');
  }
  return normalized;
}

export function normalizePositiveId(value, label = 'id') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw validationError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function normalizeManifestVersion(value) {
  try {
    return normalizeGovernanceVersion(value);
  } catch {
    throw validationError('manifestVersion must be a positive canonical BIGINT value');
  }
}

function normalizeRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.trim() !== root) {
    throw validationError('root must be an explicit non-empty absolute path');
  }
  if (!path.isAbsolute(root)) {
    throw validationError('root must be an explicit absolute path');
  }
  return path.resolve(root);
}

export function sanitizeLocationSegment(value, label = 'location segment') {
  if (Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw validationError(`${label} must be a non-empty path-safe identifier`);
  }
  if (value === '.' || value === '..' || !LOCATION_SEGMENT_PATTERN.test(value)) {
    throw validationError(`${label} contains unsafe path characters`);
  }
  const normalized = value.toLowerCase();
  if (WINDOWS_RESERVED_STEM.test(normalized.split('.')[0])) {
    throw validationError(`${label} is a reserved filesystem name`);
  }
  return normalized;
}

export function sanitizeAssetRelativePath(value = 'pack.json') {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw validationError('asset relative path must be a non-empty string');
  }
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw validationError('asset relative path must stay within its location directory');
  }

  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw validationError('asset relative path must not contain empty or traversal segments');
  }
  return segments
    .map((segment) => sanitizeLocationSegment(segment, 'asset path segment'))
    .join('/');
}

export function normalizeCoverageLocation(location, label = 'coverage location') {
  if (!location || typeof location !== 'object' || Array.isArray(location)) {
    throw validationError(`${label} must be an object`);
  }
  const locationType = sanitizeLocationSegment(
    aliasedValue(location, ['locationType', 'location_type', 'type'], `${label}.locationType`),
    `${label}.locationType`,
  );
  const locationId = sanitizeLocationSegment(
    aliasedValue(
      location,
      ['locationId', 'location_id', 'locationIdentifier', 'location_identifier', 'identifier'],
      `${label}.locationId`,
    ),
    `${label}.locationId`,
  );
  return { locationType, locationId };
}

export function coverageKey(location) {
  const normalized = normalizeCoverageLocation(location);
  return `${normalized.locationType}/${normalized.locationId}`;
}

export function normalizeCoverageLocations(locations, label = 'requiredCoverage') {
  if (!Array.isArray(locations)) {
    throw validationError(`${label} must be an array`);
  }
  const seen = new Set();
  const normalized = locations.map((location, index) => {
    const item = normalizeCoverageLocation(location, `${label}[${index}]`);
    const key = `${item.locationType}/${item.locationId}`;
    if (seen.has(key)) {
      throw validationError(`${label} contains duplicate coverage for ${key}`);
    }
    seen.add(key);
    return item;
  });
  return normalized.sort((left, right) =>
    coverageKey(left).localeCompare(coverageKey(right)));
}

function prepareAssets(assets) {
  if (!Array.isArray(assets)) {
    throw validationError('assets must be an array');
  }
  const seenPaths = new Set();
  return assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw validationError(`assets[${index}] must be an object`);
    }
    const location = normalizeCoverageLocation(asset, `assets[${index}]`);
    const rawRelativePath = aliasedValue(
      asset,
      ['relativePath', 'relative_path', 'fileName', 'file_name', 'filename', 'name'],
      `assets[${index}].relativePath`,
      { required: false },
    );
    const relativePath = sanitizeAssetRelativePath(rawRelativePath ?? 'pack.json');
    const content = aliasedValue(
      asset,
      ['content', 'signedContent', 'signed_content', 'bytes'],
      `assets[${index}].content`,
    );
    const bytes = contentBytes(content, `assets[${index}].content`);
    const assetKey = `${location.locationType}/${location.locationId}/${relativePath}`;
    if (seenPaths.has(assetKey)) {
      throw validationError(`assets contains duplicate relative path ${assetKey}`);
    }
    seenPaths.add(assetKey);
    return {
      ...location,
      relativePath,
      bytes,
      sha256: sha256Hex(bytes),
    };
  }).sort((left, right) => {
    const leftKey = `${left.locationType}/${left.locationId}/${left.relativePath}`;
    const rightKey = `${right.locationType}/${right.locationId}/${right.relativePath}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function assertExactCoverage(requiredCoverage, producedLocations) {
  const required = normalizeCoverageLocations(requiredCoverage, 'requiredCoverage');
  if (!Array.isArray(producedLocations)) {
    throw validationError('producedLocations must be an array');
  }

  const producedByKey = new Map();
  producedLocations.forEach((location, index) => {
    const normalized = normalizeCoverageLocation(location, `producedLocations[${index}]`);
    producedByKey.set(`${normalized.locationType}/${normalized.locationId}`, normalized);
  });
  const produced = [...producedByKey.values()].sort((left, right) =>
    coverageKey(left).localeCompare(coverageKey(right)));

  const requiredKeys = new Set(required.map((location) => coverageKey(location)));
  const producedKeys = new Set(produced.map((location) => coverageKey(location)));
  const missing = [...requiredKeys].filter((key) => !producedKeys.has(key)).sort();
  const unexpected = [...producedKeys].filter((key) => !requiredKeys.has(key)).sort();
  if (missing.length || unexpected.length) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : null,
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    throw validationError(`continuity pack coverage mismatch (${details})`);
  }
  return { required, produced };
}

export function buildContinuityPackPaths(options, tenantIdArg, facilityIdArg, manifestVersionArg) {
  const input = typeof options === 'string'
    ? {
        root: options,
        tenantId: tenantIdArg,
        facilityId: facilityIdArg,
        manifestVersion: manifestVersionArg,
      }
    : (options || {});
  const root = normalizeRoot(input.root);
  const tenantId = normalizeTenantId(input.tenantId);
  const facilityId = normalizePositiveId(input.facilityId, 'facilityId');
  const manifestVersion = normalizeManifestVersion(input.manifestVersion);
  const continuityRoot = path.join(root, CONTINUITY_LAYOUT_VERSION);
  const tenantsDir = path.join(continuityRoot, 'tenants');
  const tenantDir = path.join(tenantsDir, tenantId);
  const facilityDir = path.join(tenantDir, 'facilities', String(facilityId));
  const setsDir = path.join(facilityDir, 'sets');
  const setName = `v${manifestVersion}`;
  const setDir = path.join(setsDir, setName);

  return {
    root,
    tenantId,
    facilityId,
    manifestVersion,
    continuityRoot,
    tenantsDir,
    tenantDir,
    facilityDir,
    setsDir,
    setName,
    setDir,
    locationsDir: path.join(setDir, 'locations'),
    manifestPath: path.join(setDir, 'manifest.json'),
    currentPath: path.join(facilityDir, 'current.json'),
    publicationLockPath: path.join(facilityDir, '.publication.lock'),
  };
}

export const getContinuityPackPublicationPaths = buildContinuityPackPaths;

export function buildContinuityAssetRelativePath(location, relativePath = 'pack.json') {
  const normalized = normalizeCoverageLocation(location);
  const safeRelativePath = sanitizeAssetRelativePath(relativePath);
  return path.posix.join(
    'locations',
    normalized.locationType,
    normalized.locationId,
    safeRelativePath,
  );
}

function resolveFsOps(overrides) {
  if (overrides === undefined || overrides === null) return NATIVE_FS_OPS;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw validationError('fsOps must be an object');
  }
  const resolved = { ...NATIVE_FS_OPS };
  for (const operation of Object.keys(NATIVE_FS_OPS)) {
    if (hasOwn(overrides, operation)) {
      if (typeof overrides[operation] !== 'function') {
        throw validationError(`fsOps.${operation} must be a function`);
      }
      resolved[operation] = overrides[operation];
    }
  }
  return resolved;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function pathExists(io, target) {
  try {
    await io.lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readOptionalFile(io, target) {
  try {
    return { exists: true, bytes: await io.readFile(target) };
  } catch (error) {
    if (isMissing(error)) return { exists: false, bytes: null };
    throw error;
  }
}

async function closeHandle(handle, priorError = null) {
  try {
    await handle.close();
  } catch (closeError) {
    if (priorError) {
      throw new AggregateError(
        [priorError, closeError],
        priorError.message,
        { cause: priorError },
      );
    }
    throw closeError;
  }
  if (priorError) throw priorError;
}

async function syncFile(io, target) {
  // Windows requires a writable handle for FlushFileBuffers; opening a file
  // read-only makes FileHandle.sync() fail with EPERM even on a writable volume.
  const handle = await io.open(target, 'r+');
  let syncError = null;
  try {
    await handle.sync();
  } catch (error) {
    syncError = error;
  }
  await closeHandle(handle, syncError);
}

async function syncDirectory(io, target) {
  let handle;
  try {
    handle = await io.open(target, 'r');
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) return false;
    throw error;
  }

  let syncError = null;
  try {
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) syncError = error;
  }
  await closeHandle(handle, syncError);
  return syncError === null;
}

async function writeExclusiveAndSync(io, target, bytes) {
  await io.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  await syncFile(io, target);
}

function addDirectoryChain(directories, directory, stopAt) {
  let current = directory;
  while (current.startsWith(stopAt)) {
    directories.add(current);
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function removeTreeIfPresent(io, target) {
  try {
    await io.rm(target, { recursive: true, force: false });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function unlinkIfPresent(io, target) {
  try {
    await io.unlink(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function bufferStatesEqual(left, right) {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

function publicationStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function currentManifestVersion(paths, previousPointer) {
  if (!previousPointer.exists) return null;

  let pointer;
  try {
    pointer = JSON.parse(Buffer.from(previousPointer.bytes).toString('utf8'));
  } catch {
    throw publicationStateError(
      'CONTINUITY_PACK_CURRENT_POINTER_INVALID',
      'the existing continuity current pointer is not valid JSON',
    );
  }

  if (
    !pointer
    || typeof pointer !== 'object'
    || Array.isArray(pointer)
    || pointer.schema !== 'continuity-current-v1'
    || pointer.tenant_id !== paths.tenantId
    || pointer.facility_id !== paths.facilityId
  ) {
    throw publicationStateError(
      'CONTINUITY_PACK_CURRENT_POINTER_INVALID',
      'the existing continuity current pointer does not match the facility',
    );
  }

  let manifestVersion;
  try {
    manifestVersion = normalizeManifestVersion(pointer.manifest_version);
  } catch {
    throw publicationStateError(
      'CONTINUITY_PACK_CURRENT_POINTER_INVALID',
      'the existing continuity current pointer has an invalid manifest version',
    );
  }

  const expectedSet = path.posix.join('sets', `v${manifestVersion}`);
  if (
    pointer.set !== expectedSet
    || pointer.manifest !== path.posix.join(expectedSet, 'manifest.json')
    || typeof pointer.manifest_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(pointer.manifest_sha256)
  ) {
    throw publicationStateError(
      'CONTINUITY_PACK_CURRENT_POINTER_INVALID',
      'the existing continuity current pointer has invalid immutable-set metadata',
    );
  }

  return manifestVersion;
}

async function acquirePublicationLock(io, paths) {
  await io.mkdir(paths.facilityDir, { recursive: true, mode: 0o700 });
  try {
    await io.writeFile(
      paths.publicationLockPath,
      Buffer.from(`${randomUUID()}\n`, 'utf8'),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // A crash can leave this lock stale; only operator reconciliation may
      // determine that no live writer still owns it.
      throw publicationStateError(
        'CONTINUITY_PACK_PUBLICATION_LOCKED',
        `continuity publication is already in progress for tenant ${paths.tenantId} facility ${paths.facilityId}`,
      );
    }
    throw error;
  }
}

async function restorePreviousPointer(io, paths, previousPointer) {
  const currentPointer = await readOptionalFile(io, paths.currentPath);
  if (bufferStatesEqual(currentPointer, previousPointer)) return;

  if (!previousPointer.exists) {
    await unlinkIfPresent(io, paths.currentPath);
    await syncDirectory(io, paths.facilityDir);
    return;
  }

  const restorePath = path.join(paths.facilityDir, `.current.restore-${randomUUID()}.tmp`);
  try {
    await writeExclusiveAndSync(io, restorePath, previousPointer.bytes);
    await io.rename(restorePath, paths.currentPath);
    await syncDirectory(io, paths.facilityDir);
  } finally {
    await unlinkIfPresent(io, restorePath);
  }
}

function withCleanupErrors(originalError, cleanupErrors) {
  if (!cleanupErrors.length) return originalError;
  return new AggregateError(
    [originalError, ...cleanupErrors],
    originalError.message,
    { cause: originalError },
  );
}

function currentPointerRecord(paths, manifestSha256) {
  return {
    schema: 'continuity-current-v1',
    tenant_id: paths.tenantId,
    facility_id: paths.facilityId,
    manifest_version: paths.manifestVersion,
    set: path.posix.join('sets', paths.setName),
    manifest: path.posix.join('sets', paths.setName, 'manifest.json'),
    manifest_sha256: manifestSha256,
  };
}

function pointerBytes(paths, manifestSha256) {
  return Buffer.from(
    `${JSON.stringify(currentPointerRecord(paths, manifestSha256))}\n`,
    'utf8',
  );
}

function buildEvidenceReceipt(paths, manifestSha256, coverage, assets) {
  return Object.freeze({
    tenantId: paths.tenantId,
    facilityId: paths.facilityId,
    manifestVersion: paths.manifestVersion,
    manifestSha256,
    setName: paths.setName,
    setPath: paths.setDir,
    manifestPath: paths.manifestPath,
    currentPath: paths.currentPath,
    currentPointer: Object.freeze(currentPointerRecord(paths, manifestSha256)),
    coverage: Object.freeze(coverage.map((location) => Object.freeze({ ...location }))),
    assets: Object.freeze(assets.map((asset) => Object.freeze({
      locationType: asset.locationType,
      locationId: asset.locationId,
      relativePath: buildContinuityAssetRelativePath(asset, asset.relativePath),
      sha256: asset.sha256,
    }))),
  });
}

/**
 * Publish a complete, already-signed continuity pack set to local storage.
 *
 * Readers discover the immutable set only through the facility-scoped
 * current.json pointer. Files are staged beside the final set directory,
 * read back and SHA-256 checked, then made visible with a directory rename.
 */
export async function publishContinuityPackSet(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw validationError('publication options must be an object');
  }

  const paths = buildContinuityPackPaths({
    root: options.root ?? options.publicationRoot,
    tenantId: options.tenantId,
    facilityId: options.facilityId,
    manifestVersion: options.manifestVersion,
  });
  const assets = prepareAssets(options.assets);
  const requiredCoverage = options.requiredCoverage ?? options.requiredLocations;
  const coverage = assertExactCoverage(requiredCoverage, assets);
  const manifestContent = aliasedValue(
    options,
    ['manifestContent', 'signedManifestContent', 'signed_manifest_content'],
    'manifestContent',
  );
  const manifestBytes = contentBytes(manifestContent, 'manifestContent');
  const manifestSha256 = sha256Hex(manifestBytes);
  const io = resolveFsOps(options.fsOps ?? options.fileSystem ?? options.fs);
  const commitEvidence = options.commitEvidence;
  if (commitEvidence !== undefined && typeof commitEvidence !== 'function') {
    throw validationError('commitEvidence must be a function when provided');
  }
  const evidenceReceipt = buildEvidenceReceipt(
    paths,
    manifestSha256,
    coverage.produced,
    assets,
  );

  const stagingDir = path.join(
    paths.setsDir,
    `.${paths.setName}.staging-${randomUUID()}`,
  );
  const currentTempPath = path.join(
    paths.facilityDir,
    `.current-${randomUUID()}.tmp`,
  );
  let previousPointer;
  let stagingCreated = false;
  let setPublished = false;
  let pointerMutationAttempted = false;
  let evidenceCommitAttempted = false;
  let result;
  let publicationError;

  await acquirePublicationLock(io, paths);
  try {
    previousPointer = await readOptionalFile(io, paths.currentPath);
    await io.mkdir(paths.setsDir, { recursive: true, mode: 0o700 });
    if (await pathExists(io, paths.setDir)) {
      const error = new Error(
        `continuity pack set ${paths.setName} already exists and is immutable`,
      );
      error.code = 'CONTINUITY_PACK_SET_EXISTS';
      throw error;
    }
    const previousManifestVersion = currentManifestVersion(paths, previousPointer);
    if (
      previousManifestVersion !== null
      && BigInt(paths.manifestVersion) <= BigInt(previousManifestVersion)
    ) {
      throw publicationStateError(
        'CONTINUITY_PACK_MANIFEST_ROLLBACK',
        `manifest version ${paths.manifestVersion} cannot replace current version ${previousManifestVersion}`,
      );
    }

    await io.mkdir(stagingDir, { recursive: false, mode: 0o700 });
    stagingCreated = true;

    const stagedDirectories = new Set([stagingDir]);
    for (const asset of assets) {
      const relativePath = buildContinuityAssetRelativePath(asset, asset.relativePath);
      const stagedPath = path.join(stagingDir, ...relativePath.split('/'));
      const parentDir = path.dirname(stagedPath);
      await io.mkdir(parentDir, { recursive: true, mode: 0o700 });
      addDirectoryChain(stagedDirectories, parentDir, stagingDir);
      await writeExclusiveAndSync(io, stagedPath, asset.bytes);
    }

    const stagedManifestPath = path.join(stagingDir, 'manifest.json');
    await writeExclusiveAndSync(io, stagedManifestPath, manifestBytes);

    for (const asset of assets) {
      const relativePath = buildContinuityAssetRelativePath(asset, asset.relativePath);
      const readback = await io.readFile(path.join(stagingDir, ...relativePath.split('/')));
      const actualHash = sha256Hex(readback);
      if (actualHash !== asset.sha256) {
        const error = new Error(`asset readback hash mismatch for ${relativePath}`);
        error.code = 'CONTINUITY_PACK_READBACK_MISMATCH';
        throw error;
      }
    }
    const manifestReadback = await io.readFile(stagedManifestPath);
    if (sha256Hex(manifestReadback) !== manifestSha256) {
      const error = new Error('manifest readback hash mismatch');
      error.code = 'CONTINUITY_PACK_READBACK_MISMATCH';
      throw error;
    }

    const directoriesByDepth = [...stagedDirectories]
      .sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
    for (const directory of directoriesByDepth) {
      await syncDirectory(io, directory);
    }

    await io.rename(stagingDir, paths.setDir);
    stagingCreated = false;
    setPublished = true;
    await syncDirectory(io, paths.setsDir);

    // Cross-system atomicity is impossible, so evidence is committed only
    // after the immutable set is complete and durable, but before readers can
    // discover it through current.json. If the callback commits externally
    // and then throws, the complete orphan is retained for reconciliation.
    if (commitEvidence) {
      evidenceCommitAttempted = true;
      await commitEvidence(evidenceReceipt);
    }

    const currentBytes = pointerBytes(paths, manifestSha256);
    await writeExclusiveAndSync(io, currentTempPath, currentBytes);
    pointerMutationAttempted = true;
    await io.rename(currentTempPath, paths.currentPath);
    await syncDirectory(io, paths.facilityDir);

    result = {
      tenantId: paths.tenantId,
      facilityId: paths.facilityId,
      manifestVersion: paths.manifestVersion,
      manifestSha256,
      coverage: coverage.produced,
      assets: evidenceReceipt.assets,
      evidenceReceipt,
      paths,
    };
  } catch (error) {
    const cleanupErrors = [];
    let pointerRestored = !pointerMutationAttempted;

    if (pointerMutationAttempted && previousPointer) {
      try {
        await restorePreviousPointer(io, paths, previousPointer);
        pointerRestored = true;
      } catch (restoreError) {
        cleanupErrors.push(restoreError);
      }
    }
    if (pointerMutationAttempted && !previousPointer) {
      try {
        await unlinkIfPresent(io, paths.currentPath);
        await syncDirectory(io, paths.facilityDir);
        pointerRestored = true;
      } catch (restoreError) {
        cleanupErrors.push(restoreError);
      }
    }

    try {
      await unlinkIfPresent(io, currentTempPath);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (stagingCreated) {
      try {
        await removeTreeIfPresent(io, stagingDir);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (setPublished && pointerRestored && !evidenceCommitAttempted) {
      try {
        await removeTreeIfPresent(io, paths.setDir);
        await syncDirectory(io, paths.setsDir);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    publicationError = withCleanupErrors(error, cleanupErrors);
  }

  try {
    await io.unlink(paths.publicationLockPath);
    await syncDirectory(io, paths.facilityDir);
  } catch (lockReleaseError) {
    publicationError = publicationError
      ? withCleanupErrors(publicationError, [lockReleaseError])
      : lockReleaseError;
  }

  if (publicationError) throw publicationError;
  return result;
}

export const publishPackSet = publishContinuityPackSet;

export default {
  publishContinuityPackSet,
  publishPackSet,
  buildContinuityPackPaths,
  getContinuityPackPublicationPaths,
  buildContinuityAssetRelativePath,
  normalizeCoverageLocation,
  normalizeCoverageLocations,
  normalizeManifestVersion,
  assertExactCoverage,
  sanitizeLocationSegment,
  sanitizeAssetRelativePath,
  sha256Hex,
  contentBytes,
  CONTINUITY_LAYOUT_VERSION,
  DEFAULT_TENANT_ID,
};
