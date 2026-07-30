import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  CONTINUITY_LAYOUT_VERSION,
} from './constants.mjs';
import {
  fsyncDirectory,
  fsyncTree,
} from './atomic-files.mjs';
import {
  advanceFloors,
  persistFloors,
} from './floors.mjs';
import { verifyAndAdvanceCurrentState } from './current-state.mjs';
import {
  defaultMetricPaths,
  recordSyncSuccess,
  recordVerificationFailure,
} from './metrics.mjs';
import {
  facilityDirectory,
  parsePointerBytes,
  sha256Hex,
} from './pointer.mjs';
import { verifyPolicyReceipt } from './policy.mjs';
import { withDirectoryLock } from './lock.mjs';

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function replacePointerAtomically(
  facilityDir,
  pointerBytes,
  faultInjector = async () => {},
) {
  const temporary = path.join(facilityDir, `.current.${randomUUID()}.tmp`);
  await writeFile(temporary, pointerBytes, { flag: 'wx', mode: 0o600 });
  const handle = await open(temporary, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await faultInjector('beforePointerRename');
  await rename(temporary, path.join(facilityDir, 'current.json'));
  await fsyncDirectory(facilityDir);
  await faultInjector('afterPointerRename');
}

function verificationError(result) {
  const error = new Error(result.reason || 'CONTINUITY_EDGE_VERIFICATION_FAILED');
  error.reason = result.reason || 'INVALID_ENVELOPE';
  error.details = result.details;
  return error;
}

function manifestFreshness(manifestEnvelope) {
  const generatedAt = manifestEnvelope?.issuedAt;
  const freshUntil = manifestEnvelope?.expiresAt;
  if (
    !Number.isFinite(Date.parse(generatedAt)) ||
    !Number.isFinite(Date.parse(freshUntil))
  ) {
    throw new Error('MANIFEST_INVALID');
  }
  return { generatedAt, freshUntil };
}

export async function activateFromSource({
  source,
  dataRoot,
  scope,
  trustedKeys,
  policyReceipt,
  floors,
  bootstrapFloorsPath,
  floorsPath,
  trustedNow,
  runtime,
  prometheusPath,
  faultInjector = async () => {},
}) {
  const resolvedRoot = path.resolve(dataRoot);
  const lockPath = path.join(resolvedRoot, 'state', 'activation.lock');
  const metricPaths = defaultMetricPaths(resolvedRoot, prometheusPath);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  return withDirectoryLock(lockPath, async () => {
    const currentState = await verifyAndAdvanceCurrentState({
      dataRoot: resolvedRoot,
      scope,
      runtime,
      trustedNow,
      floorsPath,
      bootstrapFloorsPath,
      fallbackFloors: floors,
      trustedKeys,
      allowMissingCurrent: true,
    });
    const effectiveFloors = currentState.floors;
    const runId = randomUUID();
    const stagingRoot = path.join(resolvedRoot, '.staging', runId, 'root');
    const stagingFacility = facilityDirectory(
      stagingRoot,
      scope.tenantId,
      scope.facilityId,
    );
    let pointer;
    let pointerBytes;
    try {
      pointerBytes = Buffer.from(await source.readFile('current.json'));
      pointer = parsePointerBytes(pointerBytes, scope);
      const stagingSet = path.join(stagingFacility, ...pointer.set.split('/'));
      await mkdir(stagingSet, { recursive: true, mode: 0o700 });
      await source.copySet(pointer.set, stagingSet);
      await mkdir(stagingFacility, { recursive: true, mode: 0o700 });
      await writeFile(path.join(stagingFacility, 'current.json'), pointerBytes, {
        flag: 'wx',
        mode: 0o600,
      });

      const manifestBytes = await readFile(
        path.join(stagingFacility, ...pointer.manifest.split('/')),
      );
      if (sha256Hex(manifestBytes) !== pointer.manifest_sha256) {
        throw new Error('MANIFEST_HASH_MISMATCH');
      }
      const manifestEnvelope = JSON.parse(manifestBytes.toString('utf8'));
      const verified = await runtime.verifyContinuityEdgeMirror({
        root: stagingRoot,
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        trustedKeys: trustedKeys.packKeys,
        persistedFloors: effectiveFloors,
        trustedNow,
        clockTrusted: true,
      });
      if (!verified.ok) throw verificationError(verified);
      verifyPolicyReceipt(policyReceipt, {
        policyKeys: trustedKeys.policyKeys,
        manifestEnvelope,
        scope,
        trustedNow,
        floors: effectiveFloors,
        canonical: runtime.canonical,
      });

      await fsyncTree(stagingSet);
      await fsyncTree(stagingFacility);
      const finalFacility = facilityDirectory(
        resolvedRoot,
        scope.tenantId,
        scope.facilityId,
      );
      const finalSets = path.join(finalFacility, 'sets');
      const finalSet = path.join(finalFacility, ...pointer.set.split('/'));
      await mkdir(finalSets, { recursive: true, mode: 0o700 });
      await faultInjector('beforeSetRename');
      if (await exists(finalSet)) {
        const existingManifest = await readFile(path.join(finalSet, 'manifest.json'));
        if (sha256Hex(existingManifest) !== pointer.manifest_sha256) {
          throw new Error('IMMUTABLE_SET_CONFLICT');
        }
        await rm(stagingSet, { recursive: true, force: true });
      } else {
        await rename(stagingSet, finalSet);
        await fsyncDirectory(finalSets);
      }
      await faultInjector('afterSetRename');
      await replacePointerAtomically(finalFacility, pointerBytes, faultInjector);

      const advanced = advanceFloors(
        effectiveFloors,
        verified,
        pointer.manifest_sha256,
      );
      await persistFloors(floorsPath, advanced);
      const freshness = manifestFreshness(manifestEnvelope);
      await recordSyncSuccess(metricPaths, {
        freshUntil: freshness.freshUntil,
        manifestGeneratedAt: freshness.generatedAt,
        coverageComplete: true,
      });
      await rm(path.join(resolvedRoot, '.staging', runId), {
        recursive: true,
        force: true,
      });
      return {
        ok: true,
        pointer,
        verified,
        policyVersion: verified.policyVersion,
        floors: advanced,
      };
    } catch (error) {
      const reason = error.reason || error.message || 'INVALID_ENVELOPE';
      if (/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)) {
        await recordVerificationFailure(metricPaths, reason).catch(() => {});
      }
      throw error;
    }
  });
}

export function stagingFacilityPath(root, runId, scope) {
  return path.join(
    path.resolve(root),
    '.staging',
    runId,
    'root',
    CONTINUITY_LAYOUT_VERSION,
    'tenants',
    scope.tenantId,
    'facilities',
    String(scope.facilityId),
  );
}
