#!/usr/bin/env node
import { loadActivatedEdgeConfig, currentTrustedNow } from '../lib/config.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { loadTrustedKeys } from '../lib/trusted-keys.mjs';
import { readProtectedJson } from '../lib/json-files.mjs';
import { RcloneFacilitySource } from '../lib/rclone-source.mjs';
import { activateFromSource } from '../lib/activation.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function main(env = process.env) {
  const config = await loadActivatedEdgeConfig(env);
  const [runtime, trustedKeys, policyReceipt] = await Promise.all([
    loadRuntime(config.runtimeRoot),
    loadTrustedKeys(config.trustedKeysPath),
    readProtectedJson(config.policyReceiptPath, {
      label: 'signed schema-v2 policy receipt',
    }),
  ]);
  const source = new RcloneFacilitySource(config.rclone);
  const result = await activateFromSource({
    source,
    dataRoot: config.dataRoot,
    scope: config.scope,
    trustedKeys,
    policyReceipt,
    bootstrapFloorsPath: config.bootstrapFloorsPath,
    floorsPath: config.floorsPath,
    trustedNow: currentTrustedNow(),
    runtime,
    prometheusPath: config.prometheusPath,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.reason || error.message}\n`);
    process.exitCode = 1;
  });
}
