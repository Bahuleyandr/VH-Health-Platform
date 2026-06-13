#!/usr/bin/env node
/**
 * Field-encryption KEK rotation (SEC-4).
 *
 * Re-wraps every enc:v2: record's per-record DEK under a NEW KEK keyId, WITHOUT
 * re-encrypting the field data. This is the entire payoff of envelope
 * encryption: rotating the master key touches only the tiny wrapped-DEK blob,
 * so we never have to decrypt + re-encrypt (and re-read) PHI/secret plaintext.
 *
 * enc:v1: rows have no separable DEK, so they CANNOT be re-wrapped — they are
 * left untouched and upgrade to enc:v2: opportunistically on their next write
 * (every writer guards with isEncrypted() + re-encrypts only un-encrypted
 * input; to force an upgrade, decrypt+re-set the value via the owning service).
 * This script reports how many v1 rows remain so you can decide whether a
 * forced upgrade pass is warranted.
 *
 * ============================ RUNBOOK ============================
 *
 *  GOAL: move the active KEK from <OLD> to <NEW> with zero plaintext exposure.
 *
 *  1. Generate a new KEK secret (32 bytes):
 *       openssl rand -base64 32
 *     Store it as the new FIELD_ENCRYPTION_KEK SealedSecret. Pick a new
 *     FIELD_ENCRYPTION_KEK_ID (e.g. 'local-v2') — keyIds must be unique and
 *     monotonic so payloads are self-describing.
 *
 *  2. Run this script with BOTH keys provisioned so it can unwrap-old /
 *     re-wrap-new in one process:
 *       FIELD_ENCRYPTION_KEK=<new secret>      FIELD_ENCRYPTION_KEK_ID=local-v2 \
 *       FIELD_ENCRYPTION_KEK_OLD=<old secret>  FIELD_ENCRYPTION_KEK_OLD_ID=local-v1 \
 *       node apps/backend/scripts/rotate-field-kek.mjs --dry-run
 *     Review the dry-run counts, then drop --dry-run to apply.
 *
 *  3. After the run reports 0 records still on the old keyId, you may retire
 *     the old KEK (remove FIELD_ENCRYPTION_KEK_OLD*). Keep it until then —
 *     un-rotated rows can only be unwrapped with the old KEK.
 *
 *  NOTE: the app continues to DECRYPT both keyIds throughout, as long as the
 *  old KEK stays provisioned (FIELD_ENCRYPTION_KEK_OLD*). Rotation can run live.
 * ================================================================
 *
 * Usage:
 *   node apps/backend/scripts/rotate-field-kek.mjs --dry-run
 *   node apps/backend/scripts/rotate-field-kek.mjs --batch-size 500
 *   node apps/backend/scripts/rotate-field-kek.mjs --table webhook_subscriptions
 */

import 'dotenv/config';
import process from 'node:process';
import prisma from '../src/lib/prisma.js';
import {
  rewrapField,
  getKeyId,
  __testing__ as feTesting,
} from '../src/utils/fieldEncryption.js';
import { getKekProvider } from '../src/utils/fieldKeyProvider.js';

const { ENVELOPE_PREFIX, ENCRYPTED_PREFIX } = feTesting;

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
 * Every table/column that stores a fieldEncryption.js payload (enc:v1:/enc:v2:).
 * Keep this in sync with the encryptField() call sites:
 *   hl7OutboundService, webhookSubscriptionService, smartOAuthService,
 *   telemedicineService.
 * Each column is rotated independently; `idCol` is the PK used for the UPDATE.
 */
const TARGETS = [
  { table: 'hl7_feed_subscriptions', idCol: 'id', columns: ['auth_header'] },
  { table: 'webhook_subscriptions', idCol: 'id', columns: ['ciphertext'] },
  { table: 'smart_apps', idCol: 'id', columns: ['client_secret_ciphertext'] },
  {
    table: 'teleconsult_provider_configs',
    idCol: 'id',
    columns: ['api_key_ciphertext', 'api_secret_ciphertext', 'webhook_secret_ciphertext'],
  },
];

async function rotateColumn(target, column) {
  const stats = { scanned: 0, rewrapped: 0, v1Skipped: 0, errors: 0 };
  // Only fetch enc:v2: rows (LIKE 'enc:v2:%'); v1 rows can't be re-wrapped.
  // We page by PK > lastId so a growing table doesn't loop forever.
  let lastId = 0;
  for (;;) {
    let rows;
    const sql = `SELECT ${target.idCol} AS id, ${column} AS val
                 FROM ${target.table}
                 WHERE ${column} IS NOT NULL
                   AND ${target.idCol} > $1
                 ORDER BY ${target.idCol} ASC
                 LIMIT $2`;
    try {
      rows = await prisma.$queryRawUnsafe(sql, lastId, BATCH_SIZE);
    } catch (err) {
      if (/does not exist/i.test(String(err.message))) {
        console.warn(`  skip ${target.table}.${column}: ${err.message.split('\n')[0]}`);
        return stats;
      }
      throw err;
    }
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = Number(row.id) > lastId ? Number(row.id) : lastId;
      const val = row.val;
      if (typeof val !== 'string') continue;
      stats.scanned += 1;

      if (val.startsWith(ENCRYPTED_PREFIX)) {
        stats.v1Skipped += 1;
        continue;
      }
      if (!val.startsWith(ENVELOPE_PREFIX)) continue; // plaintext / other — leave alone

      let rewrapped;
      try {
        rewrapped = rewrapField(val);
      } catch (err) {
        stats.errors += 1;
        console.error(`  ${target.table}#${row.id}.${column} rewrap failed: ${err.message}`);
        continue;
      }
      if (rewrapped === val) continue; // already on active keyId

      if (DRY_RUN) {
        stats.rewrapped += 1;
        continue;
      }
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE ${target.table} SET ${column} = $1 WHERE ${target.idCol} = $2`,
          rewrapped,
          row.id,
        );
        stats.rewrapped += 1;
      } catch (err) {
        stats.errors += 1;
        console.error(`  ${target.table}#${row.id}.${column} update failed: ${err.message}`);
      }
    }
    if (rows.length < BATCH_SIZE) break;
  }
  return stats;
}

async function main() {
  const provider = getKekProvider();
  console.log(
    `Field KEK rotation — active keyId=${provider.activeKeyId} known keyIds=[${provider.listKeyIds().join(', ')}] ` +
      `batch=${BATCH_SIZE} dry_run=${DRY_RUN} table=${TABLE_FILTER || 'all'}`,
  );
  // Quick self-check: rewrap a probe value so a misconfigured KEK fails loudly
  // before we touch any rows.
  try {
    const probe = '__rotation_probe__';
    const { encryptField } = await import('../src/utils/fieldEncryption.js');
    const enc = encryptField(probe);
    if (getKeyId(enc) !== provider.activeKeyId) {
      throw new Error('probe payload keyId mismatch');
    }
  } catch (err) {
    console.error('KEK self-check failed — aborting before touching data:', err.message);
    await prisma.$disconnect();
    process.exit(2);
  }

  const summary = {};
  for (const target of TARGETS) {
    if (TABLE_FILTER && target.table !== TABLE_FILTER) continue;
    summary[target.table] = {};
    for (const column of target.columns) {
      const s = await rotateColumn(target, column);
      summary[target.table][column] = s;
      console.log(
        `  ${target.table}.${column}: rewrapped=${s.rewrapped} v1Skipped=${s.v1Skipped} errors=${s.errors} scanned=${s.scanned}`,
      );
    }
  }
  console.log('Summary:', JSON.stringify(summary, null, 2));

  const totalV1 = Object.values(summary)
    .flatMap((cols) => Object.values(cols))
    .reduce((acc, s) => acc + s.v1Skipped, 0);
  if (totalV1 > 0) {
    console.log(
      `\nNOTE: ${totalV1} enc:v1: value(s) were NOT re-wrapped (no separable DEK). ` +
        `They will upgrade to enc:v2: on next write, or force-upgrade via the owning service.`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
