#!/usr/bin/env node
import logger from '../src/logging/logger.js';
// scripts/ci-setup-db.mjs
//
// Apply the full hybrid schema that local dev + tests depend on:
//   1. Prisma schema is the starting point (69 models) — already applied by
//      `prisma db push` before this script runs.
//   2. Root `migrations/*.sql` files create ~100 additional tables that Prisma
//      doesn't model but tests + services expect (ot_schedules, radiology_orders,
//      vitals_chart, diagnoses, admissions, bed_transfers, blood_requests,
//      pharmacy_order_history, icd10_codes, clinical_alerts, intake_output, …).
//   3. Seed scripts populate departments/doctors + a minimal ICD-10 catalog.
//
// Some individual migrations are known to fail against the Prisma-generated
// schema (duplicate columns, different defaults) — we log and continue. The
// goal here is "test DB looks like prod DB" not "every statement succeeds".

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  logger.error('DATABASE_URL not set');
  process.exit(1);
}

// Migrations that the memory file notes will fully fail — skip to keep noise down.
const SKIP_MIGRATIONS = new Set([
  '017_seed_departments_doctors.sql', // replaced by seed-departments-doctors-local.mjs
]);

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

logger.info('→ Applying raw migrations/*.sql …');
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let applied = 0;
let skipped = 0;
let errors = 0;
for (const file of files) {
  if (SKIP_MIGRATIONS.has(file)) {
    logger.info(`  ~ ${file} (skipped — known-bad)`);
    skipped++;
    continue;
  }
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  try {
    await client.query(sql);
    logger.info(`  ✓ ${file}`);
    applied++;
  } catch (err) {
    // Non-fatal — many raw migrations conflict with Prisma-created tables.
    // We care about the net schema state, not strict migration order.
    logger.info(`  ! ${file} — ${err.code || ''} ${(err.message || '').split('\n')[0]}`);
    errors++;
  }
}
logger.info(`→ Migrations: ${applied} applied, ${skipped} skipped, ${errors} with non-fatal errors\n`);

// Seed minimal lookup data the tests rely on
logger.info('→ Seeding departments + doctors …');
try {
  await import('./seed-departments-doctors-local.mjs');
  logger.info('  ✓ Departments + doctors seeded\n');
} catch (err) {
  logger.info(`  ! Seed departments failed: ${err.message}\n`);
}

logger.info('→ Seeding ICD-10 catalog …');
try {
  await import('./seed-icd10-local.mjs');
  logger.info('  ✓ ICD-10 seeded\n');
} catch (err) {
  logger.info(`  ! Seed ICD-10 failed: ${err.message}\n`);
}

await client.end();
logger.info('CI DB setup complete.');
