import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  advanceFloors,
  loadFloors,
  persistFloors,
} from './floors.mjs';
import { withDirectoryLock } from './lock.mjs';
import { facilityDirectory, readCurrentSelection } from './pointer.mjs';
import { loadAndVerifyPolicyReceipt } from './policy.mjs';
import { loadTrustedKeys } from './trusted-keys.mjs';

function verificationError(result) {
  const error = new Error(result.reason || 'CONTINUITY_EDGE_VERIFICATION_FAILED');
  error.reason = result.reason || 'INVALID_ENVELOPE';
  error.details = result.details;
  return error;
}

async function effectiveFloors({
  statePath,
  bootstrapPath,
  scope,
  fallbackFloors,
}) {
  try {
    return await loadFloors({ statePath, bootstrapPath, scope });
  } catch (error) {
    if (error.message !== 'ROLLBACK_STATE_REQUIRED' || !fallbackFloors) {
      throw error;
    }
    return { source: 'fallback', values: fallbackFloors };
  }
}

export function activationLockPath(dataRoot) {
  return path.join(path.resolve(dataRoot), 'state', 'activation.lock');
}

export async function verifyAndAdvanceCurrentState({
  dataRoot,
  scope,
  runtime,
  trustedNow,
  floorsPath,
  bootstrapFloorsPath,
  fallbackFloors,
  trustedKeys,
  trustedKeysPath,
  policyReceiptPath,
  requirePersisted = false,
  allowMissingCurrent = false,
}) {
  const [floorResult, resolvedTrustedKeys] = await Promise.all([
    effectiveFloors({
      statePath: floorsPath,
      bootstrapPath: bootstrapFloorsPath,
      scope,
      fallbackFloors,
    }),
    trustedKeys ? Promise.resolve(trustedKeys) : loadTrustedKeys(trustedKeysPath),
  ]);
  if (requirePersisted && floorResult.source !== 'persisted') {
    throw new Error('ROLLBACK_STATE_REQUIRED');
  }

  if (allowMissingCurrent) {
    const currentPath = path.join(
      facilityDirectory(dataRoot, scope.tenantId, scope.facilityId),
      'current.json',
    );
    try {
      await access(currentPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return {
        floors: floorResult.values,
        floorSource: floorResult.source,
        policy: null,
        selection: null,
        trustedKeys: resolvedTrustedKeys,
        verified: null,
      };
    }
  }

  const selection = await readCurrentSelection(dataRoot, scope);
  const verified = await runtime.verifyContinuityEdgeMirror({
    root: dataRoot,
    tenantId: scope.tenantId,
    facilityId: scope.facilityId,
    trustedKeys: resolvedTrustedKeys.packKeys,
    persistedFloors: floorResult.values,
    trustedNow,
    clockTrusted: true,
  });
  if (!verified.ok) throw verificationError(verified);

  const policy = policyReceiptPath
    ? await loadAndVerifyPolicyReceipt(policyReceiptPath, {
        policyKeys: resolvedTrustedKeys.policyKeys,
        manifestEnvelope: selection.manifestEnvelope,
        scope,
        trustedNow,
        floors: floorResult.values,
        canonical: runtime.canonical,
      })
    : null;
  const advanced = advanceFloors(
    floorResult.values,
    verified,
    selection.pointer.manifest_sha256,
    new Date(trustedNow),
  );
  await persistFloors(floorsPath, advanced);
  return {
    floors: advanced,
    floorSource: floorResult.source,
    policy,
    selection,
    trustedKeys: resolvedTrustedKeys,
    verified,
  };
}

export async function withVerifiedCurrentState(options, callback = (state) => state) {
  const lockPath = activationLockPath(options.dataRoot);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return withDirectoryLock(lockPath, async () => {
    const state = await verifyAndAdvanceCurrentState(options);
    return callback(state);
  });
}
