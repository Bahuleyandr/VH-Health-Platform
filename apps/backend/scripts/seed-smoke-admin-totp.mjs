#!/usr/bin/env node
// scripts/seed-smoke-admin-totp.mjs
//
// Enrolls a known TOTP secret on the seeded `admin` (SUPER_ADMIN) so the admin
// route-crawl smoke (apps/admin/e2e) can complete a REAL 2FA challenge in
// auth.setup.ts and obtain an `mfa: true` session.
//
// Why this exists: the route-crawl visits SUPER_ADMIN-only pages (e.g.
// /dashboard/admin-management → /auth/admin/list), so it must authenticate as a
// SUPER_ADMIN. But the 2026-06-18 audit's requireSuperAdminStepUp gate 403s a
// SUPER_ADMIN that lacks a 2FA-verified (mfa:true) session on sensitive
// namespaces (incl. the admin dashboard the crawl loads on every page). The
// only session that satisfies BOTH the step-up gate and the super-admin-only
// RBAC is a SUPER_ADMIN with mfa:true — which the test obtains by completing the
// real TOTP challenge against the secret this script enrolls.
//
// The plaintext base32 secret is printed on stdout (nothing else) so the CI
// workflow can hand it to the Playwright step:
//   SECRET=$(node scripts/seed-smoke-admin-totp.mjs)
//   echo "PLAYWRIGHT_ADMIN_TOTP_SECRET=$SECRET" >> "$GITHUB_ENV"
//
// Smoke / test DB only. Requires DATABASE_URL + TOTP_ENCRYPTION_KEY in env
// (the smoke-e2e.yml job sets both).

import pg from 'pg';
import { generateSecret } from 'otplib';
import { encryptSecret } from '../src/utils/totpUtils.js';
import { assertSyntheticSeedTarget } from './lib/testDataSeedGuard.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  process.stderr.write('seed-smoke-admin-totp: DATABASE_URL not set\n');
  process.exit(1);
}
if (!process.env.TOTP_ENCRYPTION_KEY) {
  process.stderr.write('seed-smoke-admin-totp: TOTP_ENCRYPTION_KEY not set\n');
  process.exit(1);
}

assertSyntheticSeedTarget({
  connectionString: DATABASE_URL,
  scriptName: 'seed-smoke-admin-totp.mjs',
});

const secret = generateSecret();
const encryptedSecret = encryptSecret(secret);

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
let rowCount;
try {
  ({ rowCount } = await client.query(
    `UPDATE admins
        SET totp_enabled = true,
            totp_secret_encrypted = $1,
            totp_enrolled_at = NOW()
      WHERE username = 'admin'`,
    [encryptedSecret],
  ));
} finally {
  await client.end();
}

if (rowCount !== 1) {
  process.stderr.write(
    `seed-smoke-admin-totp: expected to enroll exactly 1 'admin' row, updated ${rowCount}\n`,
  );
  process.exit(1);
}

// stdout = the plaintext secret ONLY (consumed by the CI step). All logs go to stderr.
process.stderr.write("seed-smoke-admin-totp: enrolled TOTP on 'admin' (SUPER_ADMIN)\n");
process.stdout.write(secret);
