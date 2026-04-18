#!/usr/bin/env node
// scripts/dsar-erasure.mjs
//
// DSAR (Data Subject Access Request) erasure — DPDPA §11 / GDPR right to be
// forgotten. Pseudonymises clinical rows and deletes non-clinical PHI,
// mirroring the existing server-side `dataErasureService.executeErasure`.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/dsar-erasure.mjs \
//     --uid <patient-uid>                         # or
//     --phone <e164-phone>                        # either identifier works
//     --reason "<short audit-log reason>"         # required (non-dry)
//     --requested-by <admin-uid>                  # required (non-dry)
//     [--dry-run]                                 # preview counts, no writes
//     [--force]                                   # skip confirm prompt
//
// --dry-run shows per-table match counts + what action would be taken
// (delete / anonymize) WITHOUT running any DELETE/UPDATE. Safe to run
// against prod for preview.
//
// Non-dry: imports and calls `executeErasure` from the existing service
// so all audit-log behaviour (gdpr_erasure_log insert, legal-hold check,
// tables_processed summary) stays centralised.

import { argv, exit, env, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';

function parseArgs(a) {
  const out = { dryRun: false, force: false };
  for (let i = 2; i < a.length; i++) {
    const k = a[i];
    if (k === '--uid') out.uid = a[++i];
    else if (k === '--phone') out.phone = a[++i];
    else if (k === '--reason') out.reason = a[++i];
    else if (k === '--requested-by') out.requestedBy = a[++i];
    else if (k === '--dry-run') out.dryRun = true;
    else if (k === '--force') out.force = true;
    else if (k === '-h' || k === '--help') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage: node scripts/dsar-erasure.mjs [--dry-run] --uid <uid> | --phone <phone>
                                  --reason <text> --requested-by <admin-uid>

--dry-run shows per-table match counts without mutating any data.
Non-dry requires --reason + --requested-by for the audit trail.

Requires DATABASE_URL in the environment.`);
}

const args = parseArgs(argv);
if (args.help || (!args.uid && !args.phone)) {
  usage();
  exit(args.help ? 0 : 1);
}
if (!args.dryRun && (!args.reason || !args.requestedBy)) {
  console.error('Non-dry-run requires --reason and --requested-by');
  exit(1);
}

const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  exit(1);
}

// Mirror the per-table action list from dataErasureService.js so
// --dry-run can report accurate counts without running the actual erasure.
// Update this list in lockstep with ERASURE_TARGETS in that file.
const TARGETS = [
  // uidColumn + phoneColumn are OR'd; phoneColumn alone is fine when uid isn't indexed
  { table: 'users',                  uidCol: 'uid', phoneCol: 'phone',  action: 'anonymize' },
  { table: 'appointments',           uidCol: 'uid', phoneCol: 'phone',  action: 'anonymize' },
  { table: 'health_records',         uidCol: null,  phoneCol: 'phone',  action: 'anonymize' },
  { table: 'records',                uidCol: null,  phoneCol: 'phone',  action: 'anonymize' },
  { table: 'investigations',         uidCol: null,  phoneCol: 'phone',  action: 'anonymize' },
  { table: 'pharmacy_orders',        uidCol: null,  phoneCol: 'phone',  action: 'anonymize' },
  { table: 'feedback',               uidCol: null,  phoneCol: 'phone',  action: 'delete'    },
  { table: 'notifications',          uidCol: null,  phoneCol: 'phone',  action: 'delete'    },
  { table: 'sos_alerts',             uidCol: 'uid', phoneCol: 'phone',  action: 'delete'    },
  { table: 'staff_devices',          uidCol: 'uid', phoneCol: null,     action: 'delete'    },
  { table: 'staff_auth_sessions',    uidCol: 'uid', phoneCol: null,     action: 'delete'    },
  { table: 'e_prescriptions',        uidCol: null,  phoneCol: 'phone',  action: 'anonymize' },
];

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// --- Resolve patient --------------------------------------------------------
// uid is uuid + phone is varchar; cast uid to text so a single $1 bind works.
const who = await client.query(
  `SELECT uid, phone, name FROM users WHERE uid::text = $1 OR phone = $1 LIMIT 1`,
  [args.uid || args.phone],
);
if (who.rows.length === 0) {
  console.error(`No user found for ${args.uid ? `uid=${args.uid}` : `phone=${args.phone}`}`);
  await client.end();
  exit(2);
}
const uid = who.rows[0].uid;
const phone = who.rows[0].phone;
const name = who.rows[0].name;

console.log(`Target: ${name || '(no name)'} / uid=${uid} / phone=***${(phone || '').slice(-4)}`);

// --- Per-table count preview ------------------------------------------------
async function countMatches(t) {
  const conds = [];
  const params = [];
  let idx = 1;
  if (t.uidCol && uid) {
    conds.push(`${t.uidCol} = $${idx++}`);
    params.push(uid);
  }
  if (t.phoneCol && phone) {
    conds.push(`${t.phoneCol} = $${idx++}`);
    params.push(phone);
  }
  if (conds.length === 0) return null;
  try {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM ${t.table} WHERE ${conds.join(' OR ')}`,
      params,
    );
    return r.rows[0].c;
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  }
}

console.log(`\nPer-table impact preview:`);
let totalMatched = 0;
for (const t of TARGETS) {
  const c = await countMatches(t);
  if (c === null) {
    console.log(`  - ${t.table.padEnd(26)} skipped (no matching identifier column)`);
  } else if (typeof c === 'object') {
    console.log(`  - ${t.table.padEnd(26)} ? (${c.error})`);
  } else {
    console.log(`  - ${t.table.padEnd(26)} ${String(c).padStart(6)} row(s)  →  ${t.action}`);
    totalMatched += c;
  }
}
console.log(`  total rows affected: ~${totalMatched}`);

if (args.dryRun) {
  console.log(`\n[dry-run] no writes performed.`);
  await client.end();
  exit(0);
}

// --- Confirm prompt ---------------------------------------------------------
if (!args.force) {
  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = await rl.question(
    `\nThis will ERASE ~${totalMatched} row(s). Type the patient uid to confirm: `,
  );
  rl.close();
  if (confirm.trim() !== uid) {
    console.error('Confirmation did not match uid. Aborting.');
    await client.end();
    exit(3);
  }
}

// --- Delegate to the canonical service --------------------------------------
await client.end();

const { executeErasure, checkLegalHold } = await import('../src/services/gdpr/dataErasureService.js');

const hold = await checkLegalHold(uid);
if (hold.hasHold) {
  console.error(`Legal hold active for ${uid}. Clear the hold before erasure.`);
  exit(4);
}

const result = await executeErasure({
  uid,
  phone,
  requestedBy: args.requestedBy,
  reason: args.reason,
  ip: 'cli',
  requestId: `dsar-cli-${Date.now()}`,
});

console.log(`\n✓ Erasure complete`);
for (const [table, res] of Object.entries(result)) {
  console.log(`  - ${table.padEnd(26)} ${JSON.stringify(res)}`);
}
