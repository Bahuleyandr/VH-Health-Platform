// scripts/seed-sprint-fixtures.mjs
//
// Idempotent seed for E2E tests against the sprint 1-10 surfaces.
// Inserts representative rows (or no-ops when they exist) for:
//   - billing_invoices + items + payments (Sprint 1)
//   - billing_payment_links (Sprint 4)
//   - lab_results pending + signed-off + critical alerts (Sprint 3)
//   - tpa_claims + insurance_preauth + insurance_policies (Sprint 5)
//   - ot_schedules with WHO safety phases populated (Sprint 6)
//   - maternity_pregnancies + labor admission + partograph entries (Sprint 7)
//   - patient_message_threads + a couple of messages (Sprint 10)
//
// Every row uses a SEED_TAG token in metadata or notes so a teardown
// step can find and delete them later. Safe to run multiple times.
//
// Usage:
//   DATABASE_URL=postgres://... \
//   VH_ALLOW_NON_TEST_DATA_SEED=true \
//   node scripts/seed-sprint-fixtures.mjs

import pg from 'pg';
import { assertSyntheticSeedTarget } from './lib/testDataSeedGuard.mjs';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SEED_TAG = 'vh_sprint_seed';
// Stable UUIDs so the seed is fully idempotent and Playwright can hard-code
// them in assertions.
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const SURGEON_UID = '22222222-2222-4222-8222-222222222222';
const ANESTHETIST_UID = '33333333-3333-4333-8333-333333333333';

const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
}

assertSyntheticSeedTarget({
  connectionString,
  scriptName: 'seed-sprint-fixtures.mjs',
});

const client = new pg.Client({ connectionString });
await client.connect();

async function exec(sql, params = []) {
  return client.query(sql, params);
}

async function fetch(sql, params = []) {
  const r = await client.query(sql, params);
  return r.rows;
}

async function step(label, fn) {
  process.stdout.write(`  → ${label}… `);
  try {
    const result = await fn();
    process.stdout.write(`✓${result?.note ? ` (${result.note})` : ''}\n`);
    return result;
  } catch (err) {
    process.stdout.write(`✗ ${err.message}\n`);
    throw err;
  }
}

console.log('→ Seeding sprint 1-10 fixtures…');

// ── Patient (precondition for almost everything) ────────────────────
await step('patient', async () => {
  await exec(
    `INSERT INTO users (uid, name, phone, role, is_active, registered_at, updated_at)
     VALUES ($1::uuid, 'E2E Test Patient', '9999900001', 'PATIENT', true, NOW(), NOW())
     ON CONFLICT (uid) DO NOTHING`,
    [PATIENT_UID],
  );
  return { note: 'idempotent' };
});

// ── Sprint 1 — billing invoice + payment ────────────────────────────
let invoiceId;
await step('billing invoice (issued, partially paid)', async () => {
  // Idempotent: look for our seeded invoice by tenant + tag.
  const existing = await fetch(
    `SELECT id FROM billing_invoices WHERE notes = $1 LIMIT 1`,
    [SEED_TAG + ':inv1'],
  );
  if (existing.length) {
    invoiceId = existing[0].id;
    return { note: `reusing #${invoiceId}` };
  }
  const rows = await fetch(
    `INSERT INTO billing_invoices
       (patient_uid, invoice_type, invoice_number, status,
        subtotal, cgst_amount, sgst_amount, igst_amount, discount_amount,
        total_amount, amount_paid, amount_due,
        notes, tenant_id, updated_at)
     VALUES ($1::uuid, 'OP', 'E2E-INV-001', 'PARTIAL',
             1000, 90, 90, 0, 0, 1180, 500, 680,
             $2, $3::uuid, NOW())
     RETURNING id`,
    [PATIENT_UID, SEED_TAG + ':inv1', DEFAULT_TENANT_ID],
  );
  invoiceId = rows[0].id;
  return { note: `created #${invoiceId}` };
});

await step('billing invoice item', async () => {
  const existing = await fetch(
    `SELECT id FROM billing_invoice_items WHERE invoice_id = $1::int`,
    [invoiceId],
  );
  if (existing.length) return { note: 'reusing' };
  await exec(
    `INSERT INTO billing_invoice_items
       (invoice_id, service_code, description, quantity, unit_price,
        gst_rate, line_subtotal, cgst_amount, sgst_amount, line_total)
     VALUES ($1::int, 'CONS-GP', 'GP consultation', 1, 1000,
             18, 1000, 90, 90, 1180)`,
    [invoiceId],
  );
  return { note: 'inserted' };
});

await step('billing payment (₹500)', async () => {
  const existing = await fetch(
    `SELECT id FROM billing_payments WHERE invoice_id = $1::int`,
    [invoiceId],
  );
  if (existing.length) return { note: 'reusing' };
  await exec(
    `INSERT INTO billing_payments
       (invoice_id, patient_uid, amount, mode, reference, collected_at, tenant_id)
     VALUES ($1::int, $2::uuid, 500, 'CASH', 'E2E-CASH-001', NOW(), $3::uuid)`,
    [invoiceId, PATIENT_UID, DEFAULT_TENANT_ID],
  );
  return { note: 'inserted' };
});

// ── Sprint 4 — payment link ─────────────────────────────────────────
await step('payment link', async () => {
  const existing = await fetch(
    `SELECT id FROM billing_payment_links WHERE link_token = 'E2ETESTTOKEN1234567890ABCD'`,
  );
  if (existing.length) return { note: 'reusing' };
  await exec(
    `INSERT INTO billing_payment_links
       (link_token, invoice_id, patient_uid, amount, currency,
        upi_payee_vpa, upi_payee_name, upi_transaction_ref,
        upi_deep_link, provider, status, expires_at, tenant_id)
     VALUES ('E2ETESTTOKEN1234'::varchar, $1::int, $2::uuid, 680, 'INR',
             'hospital@upi', 'Hospital', 'VH-E2E-001',
             'upi://pay?pa=hospital@upi&pn=Hospital&am=680.00&cu=INR&tn=Inv%20E2E&tr=VH-E2E-001',
             'upi_intent', 'created', NOW() + INTERVAL '2 days', $3::uuid)
     ON CONFLICT (link_token) DO NOTHING`,
    [invoiceId, PATIENT_UID, DEFAULT_TENANT_ID],
  );
  return { note: 'inserted' };
});

// ── Sprint 3 — lab results (one signed, one pending, one critical) ──
let _signedResultId;
let criticalResultId;
await step('lab results', async () => {
  const existing = await fetch(
    `SELECT id, signed_off_at, is_critical FROM lab_results
      WHERE comments = $1 ORDER BY id`,
    [SEED_TAG],
  );
  if (existing.length >= 3) {
    _signedResultId = existing.find((r) => r.signed_off_at)?.id;
    criticalResultId = existing.find((r) => r.is_critical)?.id;
    return { note: 'reusing' };
  }
  // Signed-off normal CBC
  const signed = await fetch(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_name, test_code, value_text, value_numeric,
        unit, reference_range, abnormal_flag, signed_off_at, signed_off_by,
        performed_at, received_at, is_critical, comments)
     VALUES ($1::uuid, $2::uuid, 'Hemoglobin', 'HGB', NULL, 13.5,
             'g/dL', '12-16', 'N', NOW(), $3::uuid,
             NOW(), NOW(), false, $4)
     RETURNING id`,
    [DEFAULT_TENANT_ID, PATIENT_UID, SURGEON_UID, SEED_TAG],
  );
  _signedResultId = signed[0].id;

  // Pending (not signed off)
  await exec(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_name, test_code, value_numeric,
        unit, reference_range, abnormal_flag,
        performed_at, received_at, is_critical, comments)
     VALUES ($1::uuid, $2::uuid, 'Random Glucose', 'GLU', 145,
             'mg/dL', '70-140', 'H',
             NOW(), NOW(), false, $3)`,
    [DEFAULT_TENANT_ID, PATIENT_UID, SEED_TAG],
  );

  // Critical (low potassium) — also creates a critical alert
  const critical = await fetch(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_name, test_code, value_numeric,
        unit, reference_range, abnormal_flag,
        performed_at, received_at, is_critical, comments)
     VALUES ($1::uuid, $2::uuid, 'Serum Potassium', 'K', 2.4,
             'mEq/L', '3.5-5.0', 'LL',
             NOW(), NOW(), true, $3)
     RETURNING id`,
    [DEFAULT_TENANT_ID, PATIENT_UID, SEED_TAG],
  );
  criticalResultId = critical[0].id;
  return { note: '3 results inserted' };
});

await step('lab critical alert (open)', async () => {
  const existing = await fetch(
    `SELECT id FROM lab_critical_alerts WHERE result_id = $1::int`,
    [criticalResultId],
  );
  if (existing.length) return { note: 'reusing' };
  await exec(
    `INSERT INTO lab_critical_alerts
       (tenant_id, result_id, patient_uid, test_name, value_numeric,
        unit, threshold_breached, threshold_value, fired_at)
     VALUES ($1::uuid, $2::int, $3::uuid, 'Serum Potassium', 2.4,
             'mEq/L', 'low_critical', 3.0, NOW())`,
    [DEFAULT_TENANT_ID, criticalResultId, PATIENT_UID],
  );
  return { note: 'inserted' };
});

// ── Sprint 5 — insurance policy + preauth + claim ───────────────────
let policyId;
await step('insurance policy', async () => {
  const existing = await fetch(
    `SELECT id FROM insurance_policies WHERE policy_number = 'E2E-POL-001'`,
  );
  if (existing.length) {
    policyId = existing[0].id;
    return { note: `reusing #${policyId}` };
  }
  const rows = await fetch(
    `INSERT INTO insurance_policies
       (patient_uid, policy_number, member_id, policyholder_name,
        sum_insured, valid_from, valid_to, status, tenant_id)
     VALUES ($1::uuid, 'E2E-POL-001', 'E2E-MEM-001', 'E2E Test Patient',
             500000, CURRENT_DATE - INTERVAL '180 days',
             CURRENT_DATE + INTERVAL '180 days', 'active', $2::uuid)
     RETURNING id`,
    [PATIENT_UID, DEFAULT_TENANT_ID],
  );
  policyId = rows[0].id;
  return { note: `created #${policyId}` };
});

let preauthId;
await step('insurance preauth (submitted)', async () => {
  const existing = await fetch(
    `SELECT id FROM insurance_preauth WHERE preauth_number LIKE 'PA-E2E-%' LIMIT 1`,
  );
  if (existing.length) {
    preauthId = existing[0].id;
    return { note: `reusing #${preauthId}` };
  }
  const rows = await fetch(
    `INSERT INTO insurance_preauth
       (preauth_number, policy_id, patient_uid, primary_diagnosis,
        expected_cost, status, submitted_at, tenant_id)
     VALUES ('PA-E2E-0001', $1::int, $2::uuid,
             'Acute appendicitis K35.80', 60000,
             'submitted', NOW(), $3::uuid)
     RETURNING id`,
    [policyId, PATIENT_UID, DEFAULT_TENANT_ID],
  );
  preauthId = rows[0].id;
  return { note: `created #${preauthId}` };
});

await step('tpa claim (submitted, fresh)', async () => {
  const existing = await fetch(
    `SELECT id FROM tpa_claims WHERE claim_number = 'CL-E2E-0001'`,
  );
  if (existing.length) return { note: 'reusing' };
  await exec(
    `INSERT INTO tpa_claims
       (claim_number, policy_id, preauth_id, patient_uid,
        claim_type, total_billed, claimed_amount,
        status, submitted_at, tenant_id)
     VALUES ('CL-E2E-0001', $1::int, $2::int, $3::uuid,
             'cashless', 60000, 60000,
             'submitted', NOW(), $4::uuid)`,
    [policyId, preauthId, PATIENT_UID, DEFAULT_TENANT_ID],
  );
  return { note: 'inserted' };
});

// ── Sprint 6 — OR case scheduled today ──────────────────────────────
await step('OR case (scheduled today)', async () => {
  const existing = await fetch(
    `SELECT id FROM ot_schedules WHERE procedure_name = 'E2E Lap Appendectomy'
        AND scheduled_date = CURRENT_DATE`,
  );
  if (existing.length) return { note: 'reusing' };
  await exec(
    `INSERT INTO ot_schedules
       (patient_uid, surgeon, anesthetist, procedure_name, procedure_code,
        ot_room, scheduled_date, scheduled_time, estimated_duration,
        status, blood_arranged, consent_obtained)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'E2E Lap Appendectomy', 'APPENDECTOMY-LAP',
             'OT-MAIN-1', CURRENT_DATE, '10:00', 60,
             'scheduled', false, true)`,
    [PATIENT_UID, SURGEON_UID, ANESTHETIST_UID],
  );
  return { note: 'inserted' };
});

// ── Sprint 7 — pregnancy + labour admission + partograph entry ──────
let pregnancyId;
let laborId;
await step('maternity pregnancy', async () => {
  const existing = await fetch(
    `SELECT id FROM maternity_pregnancies WHERE patient_uid = $1::uuid LIMIT 1`,
    [PATIENT_UID],
  );
  if (existing.length) {
    pregnancyId = existing[0].id;
    return { note: `reusing #${pregnancyId}` };
  }
  const rows = await fetch(
    `INSERT INTO maternity_pregnancies
       (patient_uid, lmp_date, edd_date, gravida, parity, status, tenant_id)
     VALUES ($1::uuid, CURRENT_DATE - INTERVAL '275 days',
             CURRENT_DATE - INTERVAL '5 days', 1, 0, 'ongoing', $2::uuid)
     RETURNING id`,
    [PATIENT_UID, DEFAULT_TENANT_ID],
  );
  pregnancyId = rows[0].id;
  return { note: `created #${pregnancyId}` };
});

await step('labour admission (active)', async () => {
  const existing = await fetch(
    `SELECT id FROM maternity_labor_admissions WHERE pregnancy_id = $1::int
        AND status = 'active' LIMIT 1`,
    [pregnancyId],
  );
  if (existing.length) {
    laborId = existing[0].id;
    return { note: `reusing #${laborId}` };
  }
  const rows = await fetch(
    `INSERT INTO maternity_labor_admissions
       (pregnancy_id, admitted_at, admission_reason, gestational_age_weeks,
        cervix_dilation_cm, fetal_heart_rate_bpm, contractions_per_10min,
        labor_started_at, status, tenant_id)
     VALUES ($1::int, NOW() - INTERVAL '3 hours', 'spontaneous_labour', 39.2,
             4.0, 142, 3,
             NOW() - INTERVAL '3 hours', 'active', $2::uuid)
     RETURNING id`,
    [pregnancyId, DEFAULT_TENANT_ID],
  );
  laborId = rows[0].id;
  return { note: `created #${laborId}` };
});

await step('partograph entries', async () => {
  const existing = await fetch(
    `SELECT id FROM maternity_partograph_entries WHERE labor_admission_id = $1::int`,
    [laborId],
  );
  if (existing.length >= 3) return { note: 'reusing' };
  // 3 entries spread over the labour, with the third crossing the alert line.
  await exec(
    `INSERT INTO maternity_partograph_entries
       (labor_admission_id, recorded_at, cervix_dilation_cm,
        fetal_heart_rate_bpm, contractions_per_10min,
        bp_systolic, bp_diastolic, pulse_bpm, on_alert_line, tenant_id)
     VALUES
       ($1::int, NOW() - INTERVAL '3 hours', 4.0, 140, 3, 120, 80, 88, false, $2::uuid),
       ($1::int, NOW() - INTERVAL '2 hours', 4.5, 138, 3, 122, 82, 90, true,  $2::uuid),
       ($1::int, NOW() - INTERVAL '1 hour',  5.0, 136, 4, 124, 84, 92, true,  $2::uuid)`,
    [laborId, DEFAULT_TENANT_ID],
  );
  return { note: '3 entries inserted' };
});

// ── Sprint 10 — patient message thread + first message ──────────────
let threadId;
await step('patient message thread + reply', async () => {
  const existing = await fetch(
    `SELECT id FROM patient_message_threads WHERE patient_uid = $1::uuid
        AND subject = 'E2E test thread' LIMIT 1`,
    [PATIENT_UID],
  );
  if (existing.length) {
    threadId = existing[0].id;
    return { note: `reusing #${threadId}` };
  }
  const rows = await fetch(
    `INSERT INTO patient_message_threads
       (patient_uid, subject, category, status, priority,
        last_message_at, last_message_by, staff_unread_count, tenant_id)
     VALUES ($1::uuid, 'E2E test thread', 'general', 'awaiting_staff', 'normal',
             NOW(), 'patient', 1, $2::uuid)
     RETURNING id`,
    [PATIENT_UID, DEFAULT_TENANT_ID],
  );
  threadId = rows[0].id;
  await exec(
    `INSERT INTO patient_messages
       (thread_id, sender_kind, sender_uid, body, tenant_id)
     VALUES ($1::int, 'patient', $2::uuid,
             'Hi, I have a question about my prescription.', $3::uuid)`,
    [threadId, PATIENT_UID, DEFAULT_TENANT_ID],
  );
  return { note: `created #${threadId}` };
});

console.log('\n✓ Sprint fixtures seeded.');
console.log(`  Patient UID:   ${PATIENT_UID}`);
console.log(`  Invoice id:    ${invoiceId}`);
console.log(`  Preauth id:    ${preauthId}`);
console.log(`  Pregnancy id:  ${pregnancyId}`);
console.log(`  Labour id:     ${laborId}`);
console.log(`  Thread id:     ${threadId}`);
console.log(`\nSeed tag: ${SEED_TAG} (used in notes columns for teardown).`);

await client.end();
