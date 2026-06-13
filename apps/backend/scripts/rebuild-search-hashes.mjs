#!/usr/bin/env node
/**
 * Rebuild searchable-hash columns after rotating FIELD_SEARCH_HMAC_KEY (SEC-4).
 *
 * ============================ WHY THIS EXISTS ============================
 * fieldEncryption.searchableHash() is a DETERMINISTIC HMAC used to support
 * equality lookups on encrypted columns (a `_hash` companion column holds
 * HMAC(plaintext), the query filters by HMAC(searchTerm)).
 *
 * The HMAC key now comes from FIELD_SEARCH_HMAC_KEY (a secret DISTINCT from the
 * encryption key). For backward-compat, when FIELD_SEARCH_HMAC_KEY is UNSET the
 * key falls back to the exact legacy-derived bytes, so every hash already in the
 * DB still matches and existing lookups keep working with ZERO action.
 *
 * The moment you set a genuinely NEW FIELD_SEARCH_HMAC_KEY, every stored hash
 * was computed under the OLD key and will no longer match a freshly-computed
 * lookup hash — equality search silently returns nothing. Rotating the search
 * key therefore REQUIRES re-hashing every stored value with the new key. That
 * is what this script does.
 *
 * It re-derives the hash from the *decrypted plaintext* of the paired encrypted
 * column (so we never need to keep plaintext around), under the CURRENTLY
 * configured FIELD_SEARCH_HMAC_KEY. Run it AFTER deploying the new key.
 * ========================================================================
 *
 * IMPORTANT SCOPE NOTE
 * --------------------
 * As of this writing, fieldEncryption.searchableHash() has NO column that
 * persists its output — the only `phone_search_hash` column in the schema is
 * written by services/security/phiColumnEncryption.searchableHash(), which is a
 * SEPARATE system keyed by PHI_SEARCH_HASH_KEY (rebuilt by phi-backfill.mjs, not
 * this script). So TARGETS below is intentionally EMPTY: with no fieldEncryption
 * search-hash columns in the schema, there is nothing to rebuild and this script
 * is a no-op that prints guidance.
 *
 * When you DO add a column populated by fieldEncryption.searchableHash(), append
 * an entry to TARGETS:
 *   {
 *     table:       'some_table',
 *     idCol:       'id',
 *     hashCol:     'foo_search_hash',   // stores searchableHash(plaintext)
 *     encCol:      'foo_encrypted',     // stores encryptField(plaintext)
 *   }
 * The plaintext is recovered via decryptField(encCol) and re-hashed.
 *
 * Usage:
 *   node apps/backend/scripts/rebuild-search-hashes.mjs --dry-run
 *   node apps/backend/scripts/rebuild-search-hashes.mjs --batch-size 500
 *   node apps/backend/scripts/rebuild-search-hashes.mjs --table some_table
 */

import 'dotenv/config';
import process from 'node:process';
import prisma from '../src/lib/prisma.js';
import { decryptField, searchableHash } from '../src/utils/fieldEncryption.js';

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

/**
 * Columns whose values are produced by fieldEncryption.searchableHash().
 * Empty today — see the SCOPE NOTE above. Do NOT add phiColumnEncryption's
 * phone_search_hash here; that is keyed by a different secret.
 */
const TARGETS = [
  // Example (commented — wire up when such a column exists):
  // { table: 'example', idCol: 'id', hashCol: 'foo_search_hash', encCol: 'foo_encrypted' },
];

async function rebuildTarget(target) {
  const stats = { scanned: 0, updated: 0, errors: 0, skippedNoPlaintext: 0 };
  let lastId = 0;
  for (;;) {
    const sql = `SELECT ${target.idCol} AS id, ${target.encCol} AS enc, ${target.hashCol} AS hash
                 FROM ${target.table}
                 WHERE ${target.encCol} IS NOT NULL
                   AND ${target.idCol} > $1
                 ORDER BY ${target.idCol} ASC
                 LIMIT $2`;
    let rows;
    try {
      rows = await prisma.$queryRawUnsafe(sql, lastId, BATCH_SIZE);
    } catch (err) {
      if (/does not exist/i.test(String(err.message))) {
        console.warn(`  skip ${target.table}: ${err.message.split('\n')[0]}`);
        return stats;
      }
      throw err;
    }
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = Number(row.id) > lastId ? Number(row.id) : lastId;
      stats.scanned += 1;
      let plaintext;
      try {
        plaintext = decryptField(row.enc);
      } catch (err) {
        stats.errors += 1;
        console.error(`  ${target.table}#${row.id} decrypt failed: ${err.message}`);
        continue;
      }
      if (plaintext === null || plaintext === undefined || plaintext === '') {
        stats.skippedNoPlaintext += 1;
        continue;
      }
      const newHash = searchableHash(plaintext);
      if (newHash === row.hash) continue; // already current

      if (DRY_RUN) {
        stats.updated += 1;
        continue;
      }
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE ${target.table} SET ${target.hashCol} = $1 WHERE ${target.idCol} = $2`,
          newHash,
          row.id,
        );
        stats.updated += 1;
      } catch (err) {
        stats.errors += 1;
        console.error(`  ${target.table}#${row.id} update failed: ${err.message}`);
      }
    }
    if (rows.length < BATCH_SIZE) break;
  }
  return stats;
}

async function main() {
  console.log(
    `Rebuild search hashes — batch=${BATCH_SIZE} dry_run=${DRY_RUN} table=${TABLE_FILTER || 'all'}`,
  );
  if (!process.env.FIELD_SEARCH_HMAC_KEY) {
    console.warn(
      'FIELD_SEARCH_HMAC_KEY is unset — searchableHash() is on the legacy-compatible default, ' +
        'so existing hashes already match and there is nothing to rebuild. ' +
        'Only run this AFTER setting a new FIELD_SEARCH_HMAC_KEY.',
    );
  }
  if (TARGETS.length === 0) {
    console.log(
      'No fieldEncryption search-hash columns are configured (TARGETS is empty). ' +
        'Nothing to rebuild. See the SCOPE NOTE in this file before adding entries.',
    );
    await prisma.$disconnect();
    return;
  }

  const summary = {};
  for (const target of TARGETS) {
    if (TABLE_FILTER && target.table !== TABLE_FILTER) continue;
    const s = await rebuildTarget(target);
    summary[target.table] = s;
    console.log(
      `  ${target.table}.${target.hashCol}: updated=${s.updated} errors=${s.errors} scanned=${s.scanned}`,
    );
  }
  console.log('Summary:', JSON.stringify(summary, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
