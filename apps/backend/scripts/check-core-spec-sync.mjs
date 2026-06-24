#!/usr/bin/env node
// apps/backend/scripts/check-core-spec-sync.mjs
// Fails if packages/vhhealth_core/swagger/openapi.json is not byte-identical to
// the canonical apps/backend/src/docs/openapi.json. Pure file compare — no app
// boot, no DB.
//   0 — synced   1 — drift   2 — a file is missing
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendSpec = resolve(__dirname, '..', 'src', 'docs', 'openapi.json');
const coreSpec = resolve(__dirname, '..', '..', '..', 'packages', 'vhhealth_core', 'swagger', 'openapi.json');

for (const [label, p] of [['backend', backendSpec], ['vhhealth_core', coreSpec]]) {
  if (!existsSync(p)) { console.error(`Missing ${label} spec: ${p}`); process.exit(2); }
}
if (Buffer.compare(readFileSync(backendSpec), readFileSync(coreSpec)) === 0) {
  console.log('✓ vhhealth_core/swagger/openapi.json matches the backend canonical');
  process.exit(0);
}
console.error('✗ vhhealth_core OpenAPI spec is out of sync with the backend canonical');
console.error('');
console.error('Re-sync it:');
console.error('  npm --prefix apps/backend run openapi:sync-core');
console.error('  git add packages/vhhealth_core/swagger/openapi.json');
process.exit(1);
