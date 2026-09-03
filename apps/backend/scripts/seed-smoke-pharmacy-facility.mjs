#!/usr/bin/env node
// Seed exactly ONE active default facility for a tenant, so the pharmacy pages
// the admin route crawl visits can resolve their custody facility.
//
// Why this exists (audit row OPEN-25). The smoke database is built by
// scripts/ci-setup-db.mjs, which applies the migration corpus plus a minimal
// lookup seed (departments/doctors, ICD-10, test staff accounts). It does NOT
// run seed-comprehensive-test-data.mjs, so the smoke tenant has no `facilities`
// row at all. pharmacyFacilityAuthorityService resolves the tenant's custody
// facility by `status = 'active' AND is_default = TRUE` whenever no facility_id
// is supplied, and answers 409 PHARMACY_FACILITY_REQUIRED with
// `recovery_action: contact_admin_to_configure_one_default_pharmacy_facility`
// when that resolves to anything other than exactly one row. So
// /dashboard/pharmacy fired GET /pharmacy-orders/orders/sla and took a 409 on
// every attempt, failing the crawl.
//
// That 409 is the backend being right: it treats a tenant with no default
// pharmacy facility as a misconfiguration needing admin action, not a
// legitimate steady state. The gap is in the synthetic environment, which is
// why this is fixed here rather than by teaching the page to tolerate the error
// or by waiving the response in the crawl.
//
// Deliberately NOT added to ci-setup-db.mjs's seed set: that setup is shared
// with the backend test tier, and introducing a default facility there would
// move the baseline for every backend suite — including any that assert the
// unconfigured behaviour. This follows the same shape as
// seed-clinical-ai-preflight-reviewers.mjs: a smoke-only gap closed by a
// smoke-only step.
//
// Idempotent, and fails closed rather than creating the OTHER 409: if the
// tenant already has an active default facility it is left alone, and if it
// somehow has more than one this exits non-zero rather than adding a third,
// because "multiple active default pharmacy facilities" is the same error code
// with the opposite cause.
//
// Usage: node scripts/seed-smoke-pharmacy-facility.mjs [--tenant <uuid>]
// Needs DATABASE_URL. Synthetic targets only.

import { assertSyntheticSeedTarget } from './lib/testDataSeedGuard.mjs';

process.env.JWT_SECRET ||= 'cli-only-not-a-secret';
process.env.API_KEY ||= 'cli-only';

assertSyntheticSeedTarget({
  connectionString: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL,
  scriptName: 'seed-smoke-pharmacy-facility.mjs',
});

const args = process.argv.slice(2);
const tenantFlag = args.indexOf('--tenant');
const tenantId =
  tenantFlag >= 0 && args[tenantFlag + 1]
    ? args[tenantFlag + 1]
    : '00000000-0000-4000-8000-000000000001';

const FACILITY_CODE = 'SMOKE-PHARM-MAIN';

const { default: prisma } = await import('../src/lib/prisma.js');

try {
  // Mirror the authority service's own predicate exactly, so what this asserts
  // is what the service will resolve at request time.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, facility_code
       FROM facilities
      WHERE tenant_id = $1::uuid
        AND status = 'active'
        AND is_default = TRUE
      ORDER BY id`,
    tenantId,
  );

  if (existing.length > 1) {
    console.error(
      `[seed-smoke-pharmacy-facility] tenant ${tenantId} already has ${existing.length} active default facilities ` +
        `(${existing.map((r) => r.facility_code).join(', ')}). Custody authority is ambiguous and adding another ` +
        'cannot help — resolve the duplicates instead.',
    );
    process.exitCode = 1;
  } else if (existing.length === 1) {
    console.log(
      `[seed-smoke-pharmacy-facility] tenant ${tenantId} already resolves ` +
        `facility ${existing[0].facility_code} (id ${existing[0].id}) — nothing to do.`,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, timezone, status, is_default)
       VALUES ($1::uuid, $2::text, 'Smoke Pharmacy Main', 'Asia/Kolkata', 'active', TRUE)
       ON CONFLICT (tenant_id, facility_code) DO UPDATE
         SET status = 'active',
             is_default = TRUE`,
      tenantId,
      FACILITY_CODE,
    );

    const after = await prisma.$queryRawUnsafe(
      `SELECT id, facility_code
         FROM facilities
        WHERE tenant_id = $1::uuid
          AND status = 'active'
          AND is_default = TRUE
        ORDER BY id`,
      tenantId,
    );
    if (after.length !== 1) {
      console.error(
        `[seed-smoke-pharmacy-facility] expected exactly one active default facility after seeding, got ${after.length}.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `[seed-smoke-pharmacy-facility] seeded ${after[0].facility_code} (id ${after[0].id}) ` +
          `as the active default facility for tenant ${tenantId}.`,
      );
    }
  }
} finally {
  await prisma.$disconnect();
}
