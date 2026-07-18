#!/usr/bin/env node
// check-phi-tenant-id.mjs
//
// Tenant RLS coverage guard (docs/GAP_ANALYSIS_TENANT_RLS.md + audit
// finding DB-1, B1.2). Two independent assertions, both static (no DB
// required) so they run in any CI lane:
//
//   CHECK 1 (column presence) — every PHI-shaped table in
//     prisma/schema.prisma (one with patient_uid or patient_id) must
//     declare a `tenant_id` column, so isolation CAN be enforced. Catches a
//     new PHI table being added without tenant scoping.
//
//   CHECK 2 (policy presence) — every table that DOES carry `tenant_id`
//     (i.e. is tenant-owned by schema design) must also have a
//     `tenant_isolation` RLS policy declared in a migration under
//     src/migrations/. Without the policy the column is inert and the table
//     is silently cross-tenant readable/writable once
//     AUTH_ENFORCE_TENANT_RLS=true — exactly the DB-1 gap that migration
//     304 closed. This check stops the gap from re-opening when someone adds
//     a new tenant_id table but forgets the policy.
//
// PHI detection heuristic (CHECK 1) — a table is in scope if it has at least
// one of:
//   * patient_uid (uuid FK to users.uid)
//   * patient_id  (int  FK to users.id)
// AND the table is not in the explicit allowlist below.
//
// Genuinely-global reference/terminology/catalog tables (icd10_codes,
// terminology_concepts/_systems, drug masters, the seeded clinical_protocols,
// etc.) self-exclude from CHECK 2 by carrying no tenant_id column — that is
// the deliberate signal that they are intentionally cross-tenant.
//
// Exit codes:
//   0 — both checks pass
//   1 — at least one PHI table is missing tenant_id, OR at least one
//       tenant_id table is missing a tenant_isolation policy
//   2 — schema / migrations unreadable / parse error

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'src', 'migrations');

// Tables explicitly known to be PHI but allowed to skip the column check.
//
// PHI tenant-scoping is fully closed as of 2026-05-19. The historical
// baseline (40 missing tables at Phase-1 land time) was retired across
// three migrations:
//   * 236 (Phase 1, 2026-05-17) — 7 highest-value PHI tables
//   * 238 (Phase 2b, 2026-05-18) — 13 patient-linked PHI tables
//   * 239 (Phase 2c, 2026-05-19) — final 27 residual tables
//
// The allowlist is intentionally empty: any NEW PHI-shaped table added
// without `tenant_id` fails this check immediately. If a contributor
// has a genuine case for a non-tenant-scoped PHI table (extremely
// rare — almost everything PHI-shaped is per-tenant), add it here
// with a comment explaining why.
const ALLOWLIST = new Set([]);

// Tables that carry `tenant_id` but are intentionally exempt from the
// tenant_isolation RLS policy requirement (CHECK 2). This should stay
// EMPTY: migration 304 policied every tenant-owned base table, and the
// genuinely-global reference tables carry no tenant_id so they never reach
// CHECK 2. Add an entry ONLY with a comment justifying why a tenant_id
// table must NOT be tenant-isolated (extremely rare) + the related finding
// id. Note: DB views are not Prisma models, so they never appear here.
const POLICY_ALLOWLIST = new Set([]);

// Resolve a model to its physical table name (honours @@map; defaults to the
// model name, which is the case for ~every table in this schema).
function tableNameOf(model) {
  const m = model.body.match(/@@map\("([^"]+)"\)/);
  return m ? m[1] : model.name;
}

// Build the set of tables that have a `tenant_isolation` policy declared in
// any migration. Mirrors the two policy-authoring shapes used across the
// migrations (verified against pg_policies on the QA DB, 2026-06-13):
//   (a) explicit:  CREATE POLICY tenant_isolation ON <table>
//   (b) data-driven loop:  CREATE POLICY tenant_isolation ON %I  — the table
//       names come from `text[] := ARRAY[ '<table>', ... ]` literals in the
//       same file. We collect every quoted identifier from ARRAY[...] blocks
//       in files that use the %I loop form. (Over-collecting a name that is
//       not actually tenant_id-bearing is harmless — CHECK 2 only consults
//       this set for tables that DO carry tenant_id.)
function readPoliciedTables() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`✗ migrations dir not found at ${MIGRATIONS_DIR}`);
    process.exit(2);
  }
  const policied = new Set();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    // Strip line comments so commented-out examples don't count.
    const text = raw.replace(/--[^\n]*/g, '');
    if (!text.includes('tenant_isolation')) continue;

    // (a) explicit ON <ident> or ON public.<ident>. Prisma models in this
    // repository map to the public schema, so policies in any other explicit
    // schema must not satisfy the coverage check.
    const explicitRe = /CREATE\s+POLICY\s+tenant_isolation\s+ON\s+(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/gi;
    let e;
    while ((e = explicitRe.exec(text)) !== null) {
      const schema = e[1] || e[2];
      const name = e[3] || e[4];
      if (schema && schema.toLowerCase() !== 'public') continue;
      if (name && name !== '%I' && name.toLowerCase() !== 'i') policied.add(name);
    }

    // (b) %I loop form — harvest ARRAY[...] quoted identifiers.
    if (/CREATE\s+POLICY\s+tenant_isolation\s+ON\s+%I/i.test(text)) {
      const arrRe = /ARRAY\s*\[([\s\S]*?)\]/g;
      let a;
      while ((a = arrRe.exec(text)) !== null) {
        const idRe = /'([a-z_][a-z0-9_]*)'/gi;
        let id;
        while ((id = idRe.exec(a[1])) !== null) policied.add(id[1]);
      }
    }
  }
  return policied;
}

function readSchemaModels() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`✗ schema.prisma not found at ${SCHEMA_PATH}`);
    process.exit(2);
  }
  const src = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const models = [];
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = modelRe.exec(src)) !== null) {
    models.push({ name: m[1], body: m[2] });
  }
  return models;
}

function hasColumn(body, name) {
  const re = new RegExp(`^\\s+${name}\\s+`, 'm');
  return re.test(body);
}

function looksLikePHI(body) {
  const hasPatientUid = hasColumn(body, 'patient_uid');
  const hasPatientId = hasColumn(body, 'patient_id');
  return hasPatientUid || hasPatientId;
}

const models = readSchemaModels();
const policiedTables = readPoliciedTables();

// ---------------------------------------------------------------------------
// CHECK 1 — PHI tables must declare tenant_id.
// ---------------------------------------------------------------------------
const phiModels = models.filter((m) => looksLikePHI(m.body));
const missingColumn = phiModels
  .filter((m) => !ALLOWLIST.has(m.name))
  .filter((m) => !hasColumn(m.body, 'tenant_id'));

// ---------------------------------------------------------------------------
// CHECK 2 — every tenant_id-bearing table must have a tenant_isolation policy.
// ---------------------------------------------------------------------------
const tenantModels = models.filter((m) => hasColumn(m.body, 'tenant_id'));
const missingPolicy = tenantModels
  .filter((m) => !POLICY_ALLOWLIST.has(m.name) && !POLICY_ALLOWLIST.has(tableNameOf(m)))
  .filter((m) => !policiedTables.has(tableNameOf(m)));

let failed = false;

if (missingColumn.length > 0) {
  failed = true;
  console.error('');
  console.error('✗ CHECK 1 FAILED — PHI tables missing tenant_id column:');
  console.error('');
  for (const m of missingColumn) console.error(`  - ${m.name}`);
  console.error('');
  console.error('Every PHI-shaped table (one with patient_uid or patient_id) must');
  console.error('declare a tenant_id column so multi-tenant isolation can be');
  console.error('enforced via RLS. See docs/GAP_ANALYSIS_TENANT_RLS.md.');
  console.error('');
  console.error('To resolve, EITHER:');
  console.error('  (1) add `tenant_id uuid NOT NULL DEFAULT \'00000000-0000-4000-8000-000000000001\'::uuid`');
  console.error('      to the table via a new migration in apps/backend/src/migrations/,');
  console.error('      regenerate the Prisma schema, and add a tenant_isolation RLS policy');
  console.error('      (mirror migration 236 / 304 for the pattern), OR');
  console.error('  (2) if the table is intentionally non-tenant-scoped, add its model');
  console.error('      name to the ALLOWLIST at the top of this script with a comment');
  console.error('      explaining the justification + the related finding id.');
}

if (missingPolicy.length > 0) {
  failed = true;
  console.error('');
  console.error('✗ CHECK 2 FAILED — tenant_id tables with NO tenant_isolation RLS policy:');
  console.error('');
  for (const m of missingPolicy) {
    console.error(`  - ${tableNameOf(m)}${m.name !== tableNameOf(m) ? ` (model ${m.name})` : ''}`);
  }
  console.error('');
  console.error('A table that carries tenant_id but has no tenant_isolation policy is');
  console.error('silently cross-tenant accessible once AUTH_ENFORCE_TENANT_RLS=true —');
  console.error('this is audit finding DB-1 (closed by migration 304). To resolve, add');
  console.error('the table to a new migration that ENABLEs + FORCEs RLS and creates the');
  console.error('tenant_isolation policy (mirror migration 304\'s data-driven DO block, or');
  console.error('migration 236 for a single table). If the table is genuinely global');
  console.error('reference data it should not carry tenant_id at all; otherwise, in the');
  console.error('truly-exceptional case, add it to POLICY_ALLOWLIST with a justification.');
}

if (failed) {
  console.error('');
  process.exit(1);
}

console.log(
  `✓ phi-tenant-id check passed — CHECK 1: ${phiModels.length} PHI tables all carry tenant_id; ` +
  `CHECK 2: ${tenantModels.length} tenant_id tables all have a tenant_isolation policy.`,
);
process.exit(0);
