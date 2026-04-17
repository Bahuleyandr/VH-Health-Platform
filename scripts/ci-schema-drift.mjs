#!/usr/bin/env node
// scripts/ci-schema-drift.mjs
//
// CI wrapper around utils/schemaDriftDetector. Exits 1 if any expected
// table is missing from the database — that means a Prisma model or raw
// migration wasn't applied, which would break routes at runtime.
// "Unexpected tables" (raw migrations the detector's allowlist doesn't
// know about) are surfaced as info but DO NOT fail the build — the
// allowlist is static + incomplete by design.

import { detectSchemaDrift } from '../src/utils/schemaDriftDetector.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set — cannot run schema-drift check');
  process.exit(1);
}

const { missing, unexpected, total, error } = await detectSchemaDrift();

if (error) {
  console.error(`✗ Schema drift detector errored: ${error}`);
  process.exit(1);
}

if (missing.length > 0) {
  console.error(`✗ ${missing.length} expected table(s) MISSING from database:`);
  for (const t of missing) console.error(`  - ${t}`);
  console.error(
    '\nFix: add the table to prisma/schema.prisma or the appropriate ' +
    'migrations/*.sql, then run `npx prisma db push` + `node scripts/ci-setup-db.mjs`.',
  );
  process.exit(1);
}

console.log(`✓ Schema drift check: ${total} tables present, 0 missing.`);
if (unexpected.length > 0) {
  console.log(
    `  (${unexpected.length} tables not in the detector allowlist — this is ` +
    'fine, the allowlist lags the raw-migrations set.)',
  );
}
process.exit(0);
