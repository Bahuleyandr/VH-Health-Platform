#!/usr/bin/env node
import { loadActivatedEdgeConfig, currentTrustedNow } from '../lib/config.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { loadTrustedKeys } from '../lib/trusted-keys.mjs';
import { loadLoggingIdentities } from '../lib/audit-log.mjs';
import {
  purgeObsoleteSetsUnderLock,
  purgeUploadedLogs,
} from '../lib/purge.mjs';
import { withVerifiedCurrentState } from '../lib/current-state.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function main(env = process.env) {
  const config = await loadActivatedEdgeConfig(env);
  const [runtime, trustedKeys, identities] =
    await Promise.all([
      loadRuntime(config.runtimeRoot),
      loadTrustedKeys(config.trustedKeysPath),
      loadLoggingIdentities(
        config.gateway.loggingIdentitiesPath,
        config.scope,
      ),
    ]);
  const result = await withVerifiedCurrentState({
    dataRoot: config.dataRoot,
    scope: config.scope,
    runtime,
    trustedNow: currentTrustedNow(),
    floorsPath: config.floorsPath,
    bootstrapFloorsPath: config.bootstrapFloorsPath,
    trustedKeys,
    policyReceiptPath: config.policyReceiptPath,
    requirePersisted: true,
  }, async (state) => {
    const sets = await purgeObsoleteSetsUnderLock({
      dataRoot: config.dataRoot,
      scope: config.scope,
      trustedKeys,
      runtime,
      policy: state.policy,
    });
    const logs = await purgeUploadedLogs({
      logRoot: config.logRoot,
      identities,
      canonical: runtime.canonical,
      policy: state.policy,
    });
    return { removedSets: sets, removedLogBatches: logs };
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
