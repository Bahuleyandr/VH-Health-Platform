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
import { isEncrypted, getKeyId, rewrapField } from '../src/utils/fieldEncryption.js';
import {
  tenantKeyId, loadTenantKekIntoProvider,
} from '../src/services/security/tenantKekProvider.js';

// (table, idCol, tenantCol, columns[]) for fieldEncryption-encrypted values.
// Extend as new enc:v2 columns are added. Missing tables/columns are skipped.
const MANIFEST = [
  { table: 'oauth_providers', id: 'id', tenant: 'tenant_id', cols: ['secret_cipher'] },
  { table: 'teleconsult_provider_configs', id: 'id', tenant: 'tenant_id', cols: ['api_key_ciphertext', 'api_secret_ciphertext', 'webhook_secret_ciphertext'] },
  { table: 'webhook_subscriptions', id: 'id', tenant: 'tenant_id', cols: ['signing_secret'] },
  { table: 'tenant_interop_secrets', id: 'id', tenant: 'tenant_id', cols: ['secret_ciphertext'] },
];

const BATCH = 500;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null;
}

async function columnExists(table, col) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    table, col,
  );
  return rows.length > 0;
}

async function listTenants(only) {
  if (only) return [only];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT tenant_id FROM encryption_keys WHERE provider='local-tenant' AND status='active' AND wrapped_key_material IS NOT NULL`,
  );
  return rows.map((r) => r.tenant_id);
}

async function rewrapTable(tenantId, kid, entry, dryRun) {
  if (!(await columnExists(entry.table, entry.tenant))) return { scanned: 0, rewrapped: 0, skipped: true };
  const cols = [];
  for (const c of entry.cols) if (await columnExists(entry.table, c)) cols.push(c);
  if (cols.length === 0) return { scanned: 0, rewrapped: 0, skipped: true };

  let scanned = 0;
  let rewrapped = 0;
  let lastId = 0;
  // Keyset pagination on the numeric/sortable id column.
  for (;;) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${entry.id} AS _id, ${cols.join(', ')} FROM ${entry.table}
        WHERE ${entry.tenant} = $1::uuid AND ${entry.id} > $2
        ORDER BY ${entry.id} ASC LIMIT ${BATCH}`,
      tenantId, lastId,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row._id;
      const sets = [];
      const params = [];
      for (const c of cols) {
        const v = row[c];
        if (isEncrypted(v) && getKeyId(v) !== kid && String(v).startsWith('enc:v2:')) {
          scanned += 1;
          const next = rewrapField(v, { keyId: kid });
          params.push(next);
          sets.push(`${c} = $${params.length}`);
        }
      }
      if (sets.length > 0) {
        rewrapped += sets.length;
        if (!dryRun) {
          params.push(row._id);
          await prisma.$executeRawUnsafe(
            `UPDATE ${entry.table} SET ${sets.join(', ')} WHERE ${entry.id} = $${params.length}`,
            ...params,
          );
        }
      }
    }
    if (rows.length < BATCH) break;
  }
  return { scanned, rewrapped, skipped: false };
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
  const manifest = onlyTable ? MANIFEST.filter((m) => m.table === onlyTable) : MANIFEST;

  let totalRewrapped = 0;
  for (const tenantId of tenants) {
    await loadTenantKekIntoProvider(tenantId);
    const kid = tenantKeyId(tenantId);
    for (const entry of manifest) {
      const { scanned, rewrapped, skipped } = await rewrapTable(tenantId, kid, entry, dryRun);
      if (!skipped && (scanned > 0 || rewrapped > 0)) {
        logger.info(`phi-rewrap[${dryRun ? 'DRY' : 'apply'}] tenant=${tenantId} ${entry.table}: ${rewrapped} value(s) re-wrapped onto ${kid}`);
      }
      totalRewrapped += rewrapped;
    }
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
