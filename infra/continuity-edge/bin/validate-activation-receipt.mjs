#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAndVerifyActivationReceipt } from '../lib/activation-receipt.mjs';

export async function main(
  [receiptPath] = process.argv.slice(2),
  env = process.env,
) {
  if (!receiptPath) throw new Error('activation receipt path is required');
  await loadAndVerifyActivationReceipt(path.resolve(receiptPath), {
    tenantId: env.VHEDGE_TENANT_ID,
    facilityId: env.VHEDGE_FACILITY_ID,
  });
  process.stdout.write('activation receipt verified\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
