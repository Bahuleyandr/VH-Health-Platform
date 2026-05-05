#!/usr/bin/env node
// scripts/ci-schema-drift.mjs
//
// CI wrapper around utils/schemaDriftDetector. Exits 1 if any expected
// table is missing from the database — that means a Prisma model or raw
// migration wasn't applied, which would break routes at runtime.
// Additional tables are expected in this hybrid Prisma + raw-SQL schema and
// are covered by contract and seeded-table checks elsewhere in CI.

import { detectSchemaDrift } from '../src/utils/schemaDriftDetector.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set — cannot run schema-drift check');
  process.exit(1);
}

const { missing, additional = [], expected = 0, total, error } = await detectSchemaDrift();

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

console.log(`✓ Schema drift check: ${expected} route-critical tables expected, ${total} tables present, 0 missing.`);
if (additional.length > 0) {
  console.log(
    `  (${additional.length} additional managed table(s) are present beyond the ` +
    'route-critical sentinel list; seeded-table coverage protects them.)',
  );
}
process.exit(0);
