#!/usr/bin/env node
// Seed one active reviewer user per reviewRole referenced by an ENABLED Clinical
// AI module, for a given tenant — so the rollout preflight's per-module reviewer
// staffing check (apps/backend/scripts/check-clinical-ai-tenant-preflight.mjs,
// surfaced via scripts/check-clinical-ai-tenant-preflight.ps1) reports zero
// `some_review_roles_unstaffed` warnings and the smoke can run strict
// (`-RequireNoWarnings`).
//
// Why this exists: the global catalogue enables ~18 modules for every tenant by
// default, and their reviewRoles span niche roles (MEDICAL_RECORDS,
// INFECTION_CONTROL, IT_ADMIN, FINANCE_STAFF, …) that the comprehensive test
// seed does not staff. Rather than hard-code that gap (which drifts as the
// catalogue changes), this derives the required role set from the catalogue at
// run time and fills only the gaps. Idempotent: a role already staffed by an
// active user in the tenant is skipped (WHERE NOT EXISTS), so re-runs are no-ops.
//
// Usage: node scripts/seed-clinical-ai-preflight-reviewers.mjs [--tenant <uuid>]
// Needs DATABASE_URL. Safe on the smoke/test DB only — creates synthetic users.

import { assertSyntheticSeedTarget } from './lib/testDataSeedGuard.mjs';

process.env.JWT_SECRET ||= 'cli-only-not-a-secret';
process.env.API_KEY ||= 'cli-only';

assertSyntheticSeedTarget({
  connectionString: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL,
  scriptName: 'seed-clinical-ai-preflight-reviewers.mjs',
});

const args = process.argv.slice(2);
const tenantFlag = args.indexOf('--tenant');
const tenantId =
  tenantFlag >= 0 && args[tenantFlag + 1]
    ? args[tenantFlag + 1]
    : '00000000-0000-4000-8000-000000000001';

const { default: prisma } = await import('../src/lib/prisma.js');

try {
  const needed = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT jsonb_array_elements_text(settings->'reviewRoles') AS role
       FROM clinical_ai_modules
      WHERE enabled = true
        AND settings ? 'reviewRoles'`
  );
  const roles = [...new Set(needed.map((r) => r.role).filter(Boolean))].sort();

  const seeded = [];
  for (let i = 0; i < roles.length; i += 1) {
    const role = roles[i];
    // Distinctly-synthetic phone, <= users.phone varchar(15), unique per role.
    const phone = `pfr${String(i).padStart(9, '0')}`;
    // $3 (role) is used both as the inserted role value and in `role = $3`;
    // cast ::text at every use so Postgres doesn't deduce conflicting types
    // (42P08 "inconsistent types deduced for parameter $3").
    const inserted = await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       SELECT gen_random_uuid(), $1, $2, $3::text, true, 'active', $4::uuid, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM users
           WHERE role = $3::text
             AND is_active = true
             AND COALESCE(tenant_id, $4::uuid) = $4::uuid
        )`,
      phone,
      `Preflight Reviewer ${role}`,
      role,
      tenantId
    );
    if (inserted > 0) seeded.push(role);
  }

  console.log(
    JSON.stringify({ tenant: tenantId, rolesNeeded: roles.length, seeded })
  );
} finally {
  await prisma.$disconnect().catch(() => {});
}
