#!/usr/bin/env node
/**
 * PHI shadow-column backfill (Phase E3 follow-up).
 *
 * Encrypts existing plaintext rows into their *_encrypted shadow columns
 * (added in migration 132). Idempotent — only touches rows whose
 * encrypted column is currently NULL. Safe to re-run.
 *
 * Required env (in addition to DATABASE_URL):
 *   KMS_MASTER_KEY        — 32 bytes base64 (the envelope KEK)
 *   PHI_SEARCH_HASH_KEY   — >=16 bytes base64 (HMAC for phone_search_hash)
 *
 * Usage:
 *   node apps/backend/scripts/phi-backfill.mjs --batch-size 500
 *   node apps/backend/scripts/phi-backfill.mjs --dry-run
 *   node apps/backend/scripts/phi-backfill.mjs --table users
 */

import 'dotenv/config';
import process from 'node:process';
import prisma from '../src/lib/prisma.js';
import {
  encryptColumn,
  searchableHash,
} from '../src/services/security/phiColumnEncryption.js';

const argv = process.argv.slice(2);
const arg = (flag, fallback = null) => {
  const idx = argv.indexOf(flag);
  if (idx === -1) return fallback;
  return argv[idx + 1] ?? true;
};
const has = (flag) => argv.includes(flag);

const BATCH_SIZE = Number(arg('--batch-size', 500));
const DRY_RUN = has('--dry-run');
const TABLE_FILTER = arg('--table', null);

const TABLES = [
  {
    name: 'users',
    selectSql: `SELECT id, name, phone, address FROM users
                WHERE (name IS NOT NULL AND name_encrypted IS NULL)
                   OR (phone IS NOT NULL AND phone_encrypted IS NULL)
                   OR (phone IS NOT NULL AND phone_search_hash IS NULL)
                   OR (address IS NOT NULL AND address_encrypted IS NULL)
                LIMIT $1`,
    encryptRow(row) {
      return {
        id: row.id,
        name_encrypted: row.name ? encryptColumn(row.name) : null,
        phone_encrypted: row.phone ? encryptColumn(row.phone) : null,
        phone_search_hash: row.phone ? searchableHash(row.phone) : null,
        address_encrypted: row.address ? encryptColumn(row.address) : null,
      };
    },
    updateSql: `UPDATE users SET
                  name_encrypted = COALESCE($2, name_encrypted),
                  phone_encrypted = COALESCE($3, phone_encrypted),
                  phone_search_hash = COALESCE($4, phone_search_hash),
                  address_encrypted = COALESCE($5, address_encrypted)
                WHERE id = $1`,
    updateParams(out) {
      return [
        out.id, out.name_encrypted, out.phone_encrypted,
        out.phone_search_hash, out.address_encrypted,
      ];
    },
  },
  {
    name: 'medical_records',
    selectSql: `SELECT id, description, diagnosis, treatment FROM medical_records
                WHERE (description IS NOT NULL AND description_encrypted IS NULL)
                   OR (diagnosis IS NOT NULL AND diagnosis_encrypted IS NULL)
                   OR (treatment IS NOT NULL AND treatment_encrypted IS NULL)
                LIMIT $1`,
    encryptRow(row) {
      return {
        id: row.id,
        description_encrypted: row.description ? encryptColumn(row.description) : null,
        diagnosis_encrypted: row.diagnosis ? encryptColumn(row.diagnosis) : null,
        treatment_encrypted: row.treatment ? encryptColumn(row.treatment) : null,
      };
    },
    updateSql: `UPDATE medical_records SET
                  description_encrypted = COALESCE($2, description_encrypted),
                  diagnosis_encrypted = COALESCE($3, diagnosis_encrypted),
                  treatment_encrypted = COALESCE($4, treatment_encrypted)
                WHERE id = $1`,
    updateParams(out) {
      return [
        out.id, out.description_encrypted, out.diagnosis_encrypted, out.treatment_encrypted,
      ];
    },
  },
];

async function backfillTable(table) {
  let totalEncrypted = 0;
  let totalScanned = 0;
  while (true) {
    let rows;
    try {
      rows = await prisma.$queryRawUnsafe(table.selectSql, BATCH_SIZE);
    } catch (err) {
      if (/does not exist/i.test(String(err.message))) {
        console.warn(`Skipping ${table.name}: schema not migrated`);
        return { totalScanned: 0, totalEncrypted: 0 };
      }
      throw err;
    }
    if (rows.length === 0) break;
    totalScanned += rows.length;
    for (const row of rows) {
      const out = table.encryptRow(row);
      if (DRY_RUN) {
        totalEncrypted += 1;
        continue;
      }
      try {
        await prisma.$queryRawUnsafe(table.updateSql, ...table.updateParams(out));
        totalEncrypted += 1;
      } catch (err) {
        console.error(`${table.name}#${row.id} update failed:`, err.message);
      }
    }
    process.stdout.write(`  ${table.name}: ${totalEncrypted}/${totalScanned} processed\n`);
    if (rows.length < BATCH_SIZE) break;
  }
  return { totalScanned, totalEncrypted };
}

async function main() {
  console.log(`PHI backfill — batch=${BATCH_SIZE} dry_run=${DRY_RUN} table=${TABLE_FILTER || 'all'}`);
  if (!process.env.KMS_MASTER_KEY) {
    console.error('KMS_MASTER_KEY missing — cannot encrypt');
    process.exit(2);
  }
  if (!process.env.PHI_SEARCH_HASH_KEY) {
    console.error('PHI_SEARCH_HASH_KEY missing — cannot compute phone_search_hash');
    process.exit(2);
  }
  const summary = {};
  for (const table of TABLES) {
    if (TABLE_FILTER && table.name !== TABLE_FILTER) continue;
    const r = await backfillTable(table);
    summary[table.name] = r;
  }
  console.log('Summary:', JSON.stringify(summary, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
