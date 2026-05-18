#!/usr/bin/env node
// check-phi-tenant-id.mjs
//
// Phase 0 of the tenant RLS gap remediation (docs/GAP_ANALYSIS_TENANT_RLS.md).
//
// Scans prisma/schema.prisma for tables that look like they carry PHI
// (patient identifier columns + clinical/billing/identifying payload) and
// fails CI if any of them is missing a `tenant_id` column. Prevents the
// half-built multi-tenant state from widening while Phases 1–3 land.
//
// PHI detection heuristic — a table is in scope if it has at least one of:
//   * patient_uid (uuid FK to users.uid)
//   * patient_id  (int  FK to users.id)
//   * encounter_id with patient_uid / patient_id alongside
// AND the table is not in the explicit allowlist below (utility tables,
// view-like aggregates, archive tables that intentionally denormalise).
//
// Exit codes:
//   0 — every PHI table carries tenant_id (or is allow-listed)
//   1 — at least one PHI table is missing tenant_id
//   2 — schema file missing / parse error

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');

// Tables explicitly known to be PHI but allowed to skip the column check.
//
// PHASE-1 BASELINE (2026-05-18): the 40 tables below were already missing
// tenant_id when Phase 1 of the tenant RLS rollout landed (migration 236
// addressed the 7 highest-value PHI tables: appointments, admissions,
// clinical_notes, prescriptions, e_prescriptions, investigations,
// vitals_chart). These 40 are deferred to Phase 2 in
// docs/GAP_ANALYSIS_TENANT_RLS.md; each migration that closes one entry
// should remove it from this allowlist.
//
// The check still fails on any NEW PHI-shaped table added without
// tenant_id — the allowlist is closed: contributors must explicitly opt
// out with a comment explaining why.
const ALLOWLIST = new Set([
  // Phase-2 backlog — track removal under docs/GAP_ANALYSIS_TENANT_RLS.md.
  'abdm_consents',
  'abdm_data_requests',
  'allergies',
  'appointment_documents',
  'bed_transfers',
  'beds',
  'blood_requests',
  'cds_alerts',
  'claim_denials',
  'clinical_alerts',
  'clinical_orders',
  'diagnoses',
  'diet_orders',
  'discharge_consults',
  'downtime_snapshots',
  'event_outbox',
  'family_members',
  'hipaa_access_log',
  'infection_cases',
  'insurance_claims',
  'intake_output',
  'investigation_bookings',
  'invoices',
  'medical_records',
  'medication_administrations',
  'medication_reminders',
  'news2_scores',
  'nurse_handovers',
  'ot_schedules',
  'patient_allergies',
  'patient_consents',
  'patient_data_rights_requests',
  'patient_records',
  'patient_vitals',
  'pharmacy_orders',
  'prescription_safety_overrides',
  'quality_incidents',
  'radiology_orders',
  'referrals',
  'staff_messages',
]);

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
const phiModels = models.filter((m) => looksLikePHI(m.body));
const missing = phiModels
  .filter((m) => !ALLOWLIST.has(m.name))
  .filter((m) => !hasColumn(m.body, 'tenant_id'));

if (missing.length === 0) {
  console.log(`✓ phi-tenant-id check passed (${phiModels.length} PHI tables scanned, all have tenant_id or are allow-listed)`);
  process.exit(0);
}

console.error('');
console.error('✗ PHI tables missing tenant_id column:');
console.error('');
for (const m of missing) {
  console.error(`  - ${m.name}`);
}
console.error('');
console.error('Every PHI-shaped table (one with patient_uid or patient_id) must');
console.error('declare a tenant_id column so multi-tenant isolation can be');
console.error('enforced via RLS. See docs/GAP_ANALYSIS_TENANT_RLS.md for the');
console.error('full plan.');
console.error('');
console.error('To resolve, EITHER:');
console.error('  (1) add `tenant_id uuid NOT NULL DEFAULT \'00000000-0000-4000-8000-000000000001\'::uuid`');
console.error('      to the table via a new migration in apps/backend/src/migrations/,');
console.error('      regenerate the Prisma schema, and add a tenant_isolation RLS policy');
console.error('      (mirror migration 236 for the pattern), OR');
console.error('  (2) if the table is intentionally non-tenant-scoped, add its model');
console.error('      name to the ALLOWLIST at the top of this script with a comment');
console.error('      explaining the justification + the related finding id.');
console.error('');
process.exit(1);
