#!/usr/bin/env node
import { loadActivatedEdgeConfig } from '../lib/config.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { loadLoggingIdentities } from '../lib/audit-log.mjs';
import { uploadCompletedBatches } from '../lib/upload.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function main(env = process.env) {
  const config = await loadActivatedEdgeConfig(env);
  const [runtime, identities] = await Promise.all([
    loadRuntime(config.runtimeRoot),
    loadLoggingIdentities(
      config.gateway.loggingIdentitiesPath,
      config.scope,
    ),
  ]);
  const receipts = await uploadCompletedBatches({
    logRoot: config.logRoot,
    identities,
    canonical: runtime.canonical,
    upload: config.upload,
  });
  process.stdout.write(`${JSON.stringify({ uploaded: receipts }, null, 2)}\n`);
  return receipts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
