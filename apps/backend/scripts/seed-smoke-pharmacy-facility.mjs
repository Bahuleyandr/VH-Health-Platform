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

  // A facility alone is not authority.
  //
  // Seeding the facility fixed the 409 PHARMACY_FACILITY_REQUIRED, but the
  // pharmacy dashboard still rendered no table: resolvePharmacyFacility also
  // requires the actor to hold an ACTIVE GRANT on that facility, and the smoke
  // tenant had none (pharmacy_staff_facility_grants was empty). So the page
  // correctly showed its "not assigned to a facility" scope notice, and
  // e2e/table-controls.spec.ts failed asking a table-less page for a
  // rows-per-page control.
  //
  // Same reasoning as the facility above: the backend is right that an actor
  // with no grant has no custody. The gap is that the synthetic tenant never
  // granted one, so it is closed here rather than by teaching the spec to
  // accept the empty state — which would stop it testing the table at all.
  if (process.exitCode !== 1) {
    const facilities = await prisma.$queryRawUnsafe(
      `SELECT id, facility_code
         FROM facilities
        WHERE tenant_id = $1::uuid AND status = 'active' AND is_default = TRUE`,
      tenantId,
    );

    // Mirror the authority service's actor predicate EXACTLY
    // (pharmacyFacilityAuthorityService.js, resolvePharmacyFacility), so what is
    // granted here is what the service will resolve at request time.
    //
    // CORRECTION (the comment here previously said this grants the route-crawl's
    // actor — it does not, and the claim cost a CI cycle). The admin e2e suite
    // authenticates via POST /api/v1/auth/admin/login, i.e. as a row in the
    // `admins` table, which is a SEPARATE IDENTITY REALM from `users`; see
    // services/auth/loginSessionHelper.js#54. A platform admin therefore has no
    // `users` row for resolvePharmacyFacility to find and correctly holds no
    // pharmacy custody, whatever is granted here.
    //
    // What this grants is the users-realm SUPER_ADMIN seeded by ci-setup-db's
    // test-staff seed, so any API-level smoke authenticating as that staff
    // identity has custody. The admin dashboard's own expectation is handled
    // where it belongs — apps/admin/e2e/table-controls.spec.ts asserts the scope
    // notice for /dashboard/pharmacy rather than a table.
    const actors = await prisma.$queryRawUnsafe(
      `SELECT actor.uid, staff.id AS staff_id
         FROM users actor
         JOIN staff
           ON staff.tenant_id = actor.tenant_id AND staff.user_id = actor.uid
          AND staff.is_active = TRUE AND staff.archived = FALSE
        WHERE actor.tenant_id = $1::uuid
          AND actor.role = 'SUPER_ADMIN'
          AND actor.is_active = TRUE AND actor.status = 'active'
          AND actor.is_deleted = FALSE AND actor.merged_into_uid IS NULL
        ORDER BY actor.uid`,
      tenantId,
    );

    if (facilities.length !== 1 || actors.length !== 1) {
      // Fail closed and say which half is wrong, rather than granting against a
      // guess. Both "no staffed SUPER_ADMIN" and "ambiguous facility" mean the
      // smoke database is not the shape this seed was written for.
      console.error(
        '[seed-smoke-pharmacy-facility] cannot seed a facility grant: expected exactly one active ' +
          `default facility (found ${facilities.length}) and exactly one staffed active SUPER_ADMIN ` +
          `(found ${actors.length}) for tenant ${tenantId}.`,
      );
      process.exitCode = 1;
    } else {
      const facilityId = Number(facilities[0].id);
      const staffUid = actors[0].uid;

      const heldGrants = await prisma.$queryRawUnsafe(
        `SELECT id::text AS id
           FROM pharmacy_staff_facility_grants
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid AND facility_id = $3::int
            AND status = 'active' AND revoked_at IS NULL`,
        tenantId,
        staffUid,
        facilityId,
      );

      if (heldGrants.length > 1) {
        // The service takes LIMIT 2 and treats anything but exactly one as no
        // authority at all, so a second grant is the same failure with the
        // opposite cause — adding a third cannot help.
        console.error(
          `[seed-smoke-pharmacy-facility] ${staffUid} already holds ${heldGrants.length} active grants on ` +
            `facility ${facilityId}; the authority service treats that as no authority. Resolve the duplicates.`,
        );
        process.exitCode = 1;
      } else if (heldGrants.length === 1) {
        console.log(
          `[seed-smoke-pharmacy-facility] ${staffUid} already holds an active grant on facility ${facilityId} — nothing to do.`,
        );
      } else {
        // granted_by is the actor itself: this is a synthetic environment with
        // no granting administrator to attribute it to, and the column is NOT
        // NULL. grant_reason must be 10-500 characters (CHECK constraint 753).
        await prisma.$executeRawUnsafe(
          `INSERT INTO pharmacy_staff_facility_grants
             (tenant_id, facility_id, staff_uid, status, grant_source, grant_reason, granted_by)
           VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'smoke_seed',
                   'Smoke environment seed: route-crawl actor needs custody of the default pharmacy facility',
                   $3::uuid)`,
          tenantId,
          facilityId,
          staffUid,
        );

        const grantsAfter = await prisma.$queryRawUnsafe(
          `SELECT id::text AS id
             FROM pharmacy_staff_facility_grants
            WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid AND facility_id = $3::int
              AND status = 'active' AND revoked_at IS NULL`,
          tenantId,
          staffUid,
          facilityId,
        );
        if (grantsAfter.length !== 1) {
          console.error(
            `[seed-smoke-pharmacy-facility] expected exactly one active grant after seeding, got ${grantsAfter.length}.`,
          );
          process.exitCode = 1;
        } else {
          console.log(
            `[seed-smoke-pharmacy-facility] granted ${staffUid} active custody of facility ${facilityId}.`,
          );
        }
      }
    }
  }
} finally {
  await prisma.$disconnect();
}
