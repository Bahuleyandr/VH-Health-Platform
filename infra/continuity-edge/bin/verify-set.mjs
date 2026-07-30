#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadActivatedEdgeConfig, currentTrustedNow } from '../lib/config.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { loadTrustedKeys } from '../lib/trusted-keys.mjs';
import { withVerifiedCurrentState } from '../lib/current-state.mjs';
import {
  defaultMetricPaths,
  recordVerificationFailure,
} from '../lib/metrics.mjs';

export async function main(env = process.env) {
  const config = await loadActivatedEdgeConfig(env);
  const [runtime, trustedKeys] = await Promise.all([
    loadRuntime(config.runtimeRoot),
    loadTrustedKeys(config.trustedKeysPath),
  ]);
  try {
    const state = await withVerifiedCurrentState({
      dataRoot: config.dataRoot,
      scope: config.scope,
      runtime,
      trustedNow: currentTrustedNow(),
      floorsPath: config.floorsPath,
      bootstrapFloorsPath: config.bootstrapFloorsPath,
      trustedKeys,
      policyReceiptPath: config.policyReceiptPath,
    });
    const result = { ok: true, verified: state.verified, floors: state.floors };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    const reason = error.reason || error.message || 'INVALID_ENVELOPE';
    if (/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)) {
      await recordVerificationFailure(
        defaultMetricPaths(config.dataRoot, config.prometheusPath),
        reason,
      ).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.reason || error.message}\n`);
    process.exitCode = 1;
  });
}
