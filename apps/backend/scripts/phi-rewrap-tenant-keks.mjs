#!/usr/bin/env node
// scripts/phi-rewrap-tenant-keks.mjs
//
// W3 WS5 — re-wrap existing field-encrypted (enc:v2) values onto each tenant's
// KEK so per-tenant crypto-shred covers historical data. Idempotent + resumable:
// only rows whose envelope kid is NOT already the tenant kid are touched, so a
// re-run (or a half-finished run) is safe. decryptField/rewrapField tolerate BOTH
// the legacy global kid and the per-tenant kid throughout, so the data is fully
// readable at every point.
//
// Usage:
//   DATABASE_URL=... FIELD_ENCRYPTION_MASTER_KEK=... \
//     node scripts/phi-rewrap-tenant-keks.mjs [--tenant <uuid>] [--table <name>] [--dry-run]
//
//   --tenant   re-wrap only this tenant (default: every tenant with an active KEK)
//   --table    restrict to one manifest table
//   --dry-run  report what WOULD change, write nothing
//
// Covers the fieldEncryption (getKekProvider) subsystem. The mig-132 PHI shadow
// columns use the separate kmsProviderService envelope; threading that subsystem
// onto per-tenant KEKs is tracked separately (see the W3 spec / program memory).

import process from 'node:process';
import prisma from '../src/lib/prisma.js';
import logger from '../src/logging/logger.js';
import {
  runTenantKekRewrap,
} from '../src/services/security/tenantKekRewrapService.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null;
}

async function listTenants(only) {
  if (only) return [only];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT tenant_id FROM encryption_keys WHERE provider='local-tenant' AND status='active' AND wrapped_key_material IS NOT NULL`,
  );
  return rows.map((r) => r.tenant_id);
}

async function main() {
  const onlyTenant = typeof arg('--tenant') === 'string' ? arg('--tenant') : null;
  const onlyTable = typeof arg('--table') === 'string' ? arg('--table') : null;
  const dryRun = Boolean(arg('--dry-run'));

  const tenants = await listTenants(onlyTenant);
  if (tenants.length === 0) {
    logger.info('phi-rewrap: no tenants with an active KEK — nothing to do');
    return;
  }
  let totalRewrapped = 0;
  for (const tenantId of tenants) {
    const result = await runTenantKekRewrap({ tenantId, table: onlyTable, dryRun });
    for (const table of result.tables) {
      if (!table.skipped && (table.scanned > 0 || table.rewrapped > 0)) {
        logger.info(`phi-rewrap[${dryRun ? 'DRY' : 'apply'}] tenant=${tenantId} ${table.table}: ${table.rewrapped} value(s) re-wrapped onto ${result.key_id}`);
      }
    }
    totalRewrapped += result.rewrapped;
  }
  logger.info(`phi-rewrap done: ${totalRewrapped} value(s) ${dryRun ? 'would be ' : ''}re-wrapped across ${tenants.length} tenant(s)`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error('phi-rewrap failed:', err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
