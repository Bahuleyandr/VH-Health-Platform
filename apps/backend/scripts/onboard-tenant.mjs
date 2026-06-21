#!/usr/bin/env node
// onboard-tenant.mjs — multi-tenancy W7 Part-B tenant-onboarding orchestrator.
//
// Idempotent: every step is create-or-skip, so a re-run after a partial failure
// is safe (same discipline as ci-setup-db.mjs). Wraps the subsystems W2–W6 built:
// create the tenant row → seed branding → provision the per-tenant KEK → bootstrap
// one tenant-bound ADMIN. Prints the subdomain + admin credentials + the
// per-tenant client build command.
//
// Usage:
//   node apps/backend/scripts/onboard-tenant.mjs \
//     --slug acme --name "Acme Hospital" --region IN --compliance DPDP \
//     --primary "#1565C0" [--admin-username admin-acme] [--admin-password ...] \
//     [--base-host api.vhhealth.app] [--dry-run]
//
// Env: DATABASE_URL (target DB) + the field-encryption keys used to wrap the
// per-tenant KEK (FIELD_ENCRYPTION_MASTER_KEK, and FIELD_ENCRYPTION_KEK or its
// FIELD_ENCRYPTION_KEY fallback) — the same secrets the backend runs with.
// See docs/TENANT_ONBOARDING_RUNBOOK.md.
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import prisma from '../src/lib/prisma.js';
import { getTenantBySlug, createTenant, updateTenant } from '../src/services/tenant/tenantService.js';
import { provisionTenantKek } from '../src/services/security/tenantKekProvider.js';

function parseArgs(argv) {
  // Flat model: base host is the apex (vhhealth.app); the per-tenant API host is
  // <slug>-api.<base>. Pick the first non-localhost TENANT_BASE_HOST, else apex.
  const baseFromEnv = String(process.env.TENANT_BASE_HOST || '').split(',').map((s) => s.trim()).filter((b) => b && b !== 'localhost')[0];
  const out = { region: 'IN', compliance: 'DPDP', baseHost: baseFromEnv || 'vhhealth.app', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--slug') out.slug = next();
    else if (a === '--name') out.name = next();
    else if (a === '--region') out.region = next();
    else if (a === '--compliance') out.compliance = next();
    else if (a === '--primary') out.primary = next();
    else if (a === '--logo') out.logo = next();
    else if (a === '--admin-username') out.adminUsername = next();
    else if (a === '--admin-password') out.adminPassword = next();
    else if (a === '--base-host') out.baseHost = next();
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug || !SLUG_RE.test(args.slug)) fail('--slug is required (lowercase, 3–40 chars, [a-z0-9-], no leading/trailing dash)');
  if (!args.name) fail('--name is required');

  const adminUsername = args.adminUsername || `admin-${args.slug}`;
  const adminPassword = args.adminPassword || `Vh!${crypto.randomBytes(9).toString('base64url')}`;
  const generatedPassword = !args.adminPassword;
  const branding = {
    name: args.name,
    ...(args.primary ? { primaryColor: args.primary } : {}),
    ...(args.logo ? { logoUrl: args.logo } : {}),
  };

  console.log(`\n▶ Onboarding tenant "${args.slug}" (${args.name})${args.dryRun ? '  [DRY RUN — no writes]' : ''}\n`);

  // ── Step 1: tenant row (create-or-get) ───────────────────────────────────
  let tenant = await getTenantBySlug(args.slug);
  if (tenant) {
    console.log(`  1. tenant row …………… exists (${tenant.id})`);
  } else if (args.dryRun) {
    console.log(`  1. tenant row …………… WOULD create (slug=${args.slug}, region=${args.region}, compliance=${args.compliance})`);
  } else {
    tenant = await createTenant({ slug: args.slug, name: args.name, region: args.region, compliance_profile: args.compliance });
    if (!tenant) tenant = await getTenantBySlug(args.slug); // race / conflict
    console.log(`  1. tenant row …………… created (${tenant.id})`);
  }
  const tenantId = tenant?.id;
  if (!tenantId && !args.dryRun) fail('could not resolve the tenant id after create');

  // ── Step 2: branding (merge into settings) ───────────────────────────────
  if (args.dryRun) {
    console.log(`  2. branding …………………… WOULD set settings.branding = ${JSON.stringify(branding)}`);
  } else {
    const current = (tenant.settings && typeof tenant.settings === 'object') ? tenant.settings : {};
    const merged = { ...current, branding: { ...(current.branding || {}), ...branding } };
    tenant = await updateTenant(tenantId, { settings: merged });
    console.log(`  2. branding …………………… set (name="${branding.name}"${branding.primaryColor ? `, primary=${branding.primaryColor}` : ''})`);
  }

  // ── Step 3: per-tenant KEK (idempotent ON CONFLICT) ──────────────────────
  if (args.dryRun) {
    console.log('  3. per-tenant KEK ……… WOULD provision (envelope: master KEK → tenant KEK)');
  } else {
    const { keyId } = await provisionTenantKek(tenantId);
    console.log(`  3. per-tenant KEK ……… provisioned (kid=${keyId})`);
  }

  // ── Step 4: bootstrap tenant ADMIN (check-then-insert) ───────────────────
  let adminExisted = false;
  if (!args.dryRun) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT uid FROM admins WHERE tenant_id = $1::uuid AND lower(username) = lower($2) LIMIT 1`,
      tenantId, adminUsername,
    );
    adminExisted = existing.length > 0;
    if (!adminExisted) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await prisma.$executeRawUnsafe(
        `INSERT INTO admins (username, password_hash, role, status, tenant_id, failed_login_attempts, totp_enabled, created_at, updated_at)
         VALUES ($1, $2, 'ADMIN', 'active', $3::uuid, 0, false, NOW(), NOW())`,
        adminUsername, hash, tenantId,
      );
    }
    console.log(`  4. tenant admin ……………… ${adminExisted ? `exists (${adminUsername})` : `created (${adminUsername})`}`);
  } else {
    console.log(`  4. tenant admin ……………… WOULD ensure ADMIN "${adminUsername}" (tenant-bound)`);
  }

  // ── Summary + next steps ─────────────────────────────────────────────────
  const apiHost = `${args.slug}-api.${args.baseHost}`;        // flat: <slug>-api.<base>
  const adminHost = `admin.${args.baseHost}`;                 // single admin host (token-driven)
  console.log('\n  ✔ Onboarding steps complete.\n');
  console.log('  Tenant:');
  console.log(`    id            ${tenantId || '(dry-run)'}`);
  console.log(`    slug          ${args.slug}`);
  console.log(`    api host      https://${apiHost}/api/v1`);
  console.log(`    admin host    https://${adminHost}`);
  if (!args.dryRun && !adminExisted) {
    console.log('\n  Bootstrap admin (force a reset on first login):');
    console.log(`    username      ${adminUsername}`);
    console.log(`    password      ${adminPassword}${generatedPassword ? '   (generated — store securely, rotate after first login)' : ''}`);
  }
  console.log('\n  Per-tenant client build (patient/staff):');
  console.log(`    flutter build apk --flavor ${args.slug} \\`);
  console.log(`      --dart-define=VH_BASE_URL=https://${apiHost}/api/v1 \\`);
  console.log(`      --dart-define=VH_TENANT_SLUG=${args.slug} --dart-define=VH_TENANT_ID=${tenantId || '<uuid>'} \\`);
  console.log(`      --dart-define=VH_API_KEY=<key>${branding.primaryColor ? ` --dart-define=VH_TENANT_PRIMARY=${branding.primaryColor}` : ''}`);
  console.log('\n  Next (operator): ensure wildcard DNS+TLS exist (runbook Part A), then verify');
  console.log('  Phase-E RLS for this tenant_id. Interop secrets (ABDM/HL7) only if the tenant federates.\n');

  await prisma.$disconnect().catch(() => {});
}

main().catch(async (err) => {
  console.error('\n✗ onboard-tenant failed:', err?.message || err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
