#!/usr/bin/env node
// abdm-preflight.mjs — roadmap C1 ABDM sandbox-readiness preflight.
//
// Answers "what stands between this deployment and the ABDM M1/M2/M3
// certification runs" in one pass: configuration, schema substrate, and
// the known engineering gaps. Exit 0 = ready for sandbox onboarding work,
// exit 1 = blockers listed below the report.
//
//   node -r dotenv/config scripts/abdm-preflight.mjs
//
// Owner-side by design: NDHM/ABDM sandbox signup, client credentials,
// bridge registration and the certification suites cannot be done from
// the repo. See docs/ABDM_READINESS.md for the full checklist.

import process from 'node:process';
import pg from 'pg';

const REQUIRED_ENV = ['ABDM_CLIENT_ID', 'ABDM_CLIENT_SECRET', 'ABDM_HIP_ID', 'ABDM_CALLBACK_URL'];
const OPTIONAL_ENV = ['ABDM_GATEWAY_URL', 'ABDM_BRIDGE_URL', 'ABDM_HIP_NAME', 'ABDM_ENABLED'];
const REQUIRED_TABLES = [
  'abdm_consents', 'abdm_consent_requests', 'abdm_consent_artifacts',
  'abdm_care_contexts', 'abdm_data_requests', 'abdm_data_transfers',
  'abdm_webhook_events',
];
// Engineering gaps that block M2 data-push certification regardless of
// credentials. Tracked here so the preflight never reports a false "ready".
const KNOWN_GAPS = [
  {
    id: 'fhir-bundle-encryption',
    blocker: false,
    summary: 'ECDH(Curve25519)+HKDF+AES-GCM payload encryption implemented (src/services/abdm/abdmCrypto.js; unit-tested incl. RFC 7748 vector). Byte-level interop sign-off against the sandbox HIU still pending — validate during the M2 dry run.',
  },
  {
    id: 'bridge-registration',
    blocker: true,
    summary: 'Bridge URL + HIP/HIU registration against the sandbox gateway is an owner-side step after credentials arrive.',
  },
  {
    id: 'scan-and-share',
    blocker: false,
    summary: 'Scan & Share OPD registration flow is schema-ready but untested against the sandbox QR profiles.',
  },
];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !(process.env[k] || '').trim());
  const present = REQUIRED_ENV.filter((k) => (process.env[k] || '').trim());
  return { missing, present };
}

async function checkTables() {
  if (!process.env.DATABASE_URL) return { error: 'DATABASE_URL not set — table checks skipped' };
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'abdm%'`,
    );
    const found = rows.map((r) => r.table_name);
    const missing = REQUIRED_TABLES.filter((t) => !found.includes(t));
    return { found, missing };
  } finally {
    await client.end();
  }
}

const env = checkEnv();
let tables = {};
try {
  tables = await checkTables();
} catch (err) {
  tables = { error: err.message };
}

console.log('═══ ABDM readiness preflight (roadmap C1) ═══\n');
console.log(`Config: ${env.present.length}/${REQUIRED_ENV.length} required env vars set`);
for (const k of env.present) console.log(`  ✓ ${k}`);
for (const k of env.missing) console.log(`  ✗ ${k} (owner-side: sandbox signup at https://sandbox.abdm.gov.in)`);
for (const k of OPTIONAL_ENV) {
  console.log(`  · ${k} = ${(process.env[k] || '(default)').slice(0, 60)}`);
}

console.log('\nSchema substrate:');
if (tables.error) {
  console.log(`  ! ${tables.error}`);
} else {
  console.log(`  ✓ ${tables.found.length} abdm* tables present`);
  for (const t of tables.missing) console.log(`  ✗ missing expected table: ${t}`);
}

console.log('\nKnown gaps:');
for (const gap of KNOWN_GAPS) {
  console.log(`  ${gap.blocker ? '✗ BLOCKER' : '· note  '} [${gap.id}] ${gap.summary}`);
}

const blockers =
  env.missing.length
  + (tables.missing?.length || 0)
  + KNOWN_GAPS.filter((g) => g.blocker).length;

console.log(`\nVerdict: ${blockers === 0
  ? 'READY for certification runs.'
  : `${blockers} blocker(s) before M1/M2 certification — see docs/ABDM_READINESS.md.`}`);
process.exit(blockers === 0 ? 0 : 1);
