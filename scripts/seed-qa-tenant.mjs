#!/usr/bin/env node
// QA harness — additional edge-case fixtures.
//
// Runs AFTER apps/backend/scripts/seed-comprehensive-test-data.mjs has
// already populated baseline data. This script only adds QA-specific
// edge cases the harness should regularly hit:
//
//   - Timezone-boundary appointment (23:55 IST → next-day UTC)
//   - Unicode patient name (Tamil + emoji) to flush latin1 mishaps
//   - Multi-year history: same patient with appointments in 2024 / 2025 / 2026
//   - Long-string medical_history to surface truncation bugs
//   - NULL-friendly columns left empty where the schema allows it
//
// All inserts are idempotent (UPSERT / WHERE NOT EXISTS) so reruns are safe.
// Connects via DATABASE_URL — the orchestrator passes the qa_writer role.
//
// This script is intentionally additive. Anything that should be in the
// universal seed (every test, every dev) belongs in
// apps/backend/scripts/seed-comprehensive-test-data.mjs, not here.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromBackend = createRequire(
  path.join(__dirname, '..', 'apps', 'backend', 'package.json')
);
const pg = requireFromBackend('pg');

const QA_TAG = 'qa_seed';

const guard = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  // Best-effort safety net (qa-reset.mjs already enforced the full guardrails).
  if (!/(?:127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`refusing to seed: DATABASE_URL host is not loopback (${url})`);
  }
  if (!/vhhealth_test|vhhealth_qa/.test(url)) {
    throw new Error(`refusing to seed: DATABASE_URL does not target a QA test DB (${url})`);
  }
};

async function getOrCreateUnicodePatient(client) {
  const phone = '+919900000091';
  const existing = await client.query('SELECT id, uid, phone FROM users WHERE phone = $1', [phone]);
  if (existing.rowCount) return existing.rows[0];

  const inserted = await client.query(
    `INSERT INTO users (phone, name, gender, role, is_active, status, blood_group,
                        allergies, medical_history, profile_completed_at, updated_at)
     VALUES ($1, $2, $3, 'PATIENT', TRUE, 'active', 'O+', 'Penicillin',
             $4, NOW(), NOW())
     RETURNING id, uid, phone`,
    [
      phone,
      'காமாட்சி தேவி 🩺',
      'Female',
      'Hypertension; multi-paragraph history.\n'.repeat(40),
    ]
  );
  return inserted.rows[0];
}

async function ensureMultiYearAppointments(client, patient) {
  const doctor = await client.query(
    `SELECT id FROM users WHERE role = 'DOCTOR' AND is_active = TRUE
      ORDER BY id LIMIT 1`
  );
  if (!doctor.rowCount) {
    console.warn('[seed-qa-tenant] no DOCTOR user found, skipping multi-year appointments');
    return 0;
  }
  const doctorId = doctor.rows[0].id;

  const slots = [
    { date: '2024-12-31', time: '23:55', notes: 'qa_seed_year_boundary_2024' },
    { date: '2025-06-15', time: '10:30', notes: 'qa_seed_midyear_2025' },
    { date: '2026-05-04', time: '23:55', notes: 'qa_seed_year_boundary_2026' },
  ];

  let inserted = 0;
  for (const slot of slots) {
    const exists = await client.query(
      `SELECT 1 FROM appointments
        WHERE patient_id = $1
          AND appointment_date = $2
          AND notes = $3
        LIMIT 1`,
      [patient.id, slot.date, slot.notes]
    );
    if (exists.rowCount) continue;

    try {
      await client.query(
        `INSERT INTO appointments
           (patient_id, doctor_id, phone, appointment_date, appointment_time,
            status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4::date, $5::time, 'pending',
                 $6, NOW(), NOW())`,
        [patient.id, doctorId, patient.phone, slot.date, slot.time, slot.notes]
      );
      inserted += 1;
    } catch (err) {
      console.warn(`[seed-qa-tenant] appointment ${slot.date} skipped: ${err.message}`);
    }
  }
  return inserted;
}

async function ensureLongStringPatient(client) {
  const phone = '+919900000092';
  const existing = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (existing.rowCount) return false;

  await client.query(
    `INSERT INTO users (phone, name, gender, role, is_active, status,
                        blood_group, allergies, medical_history,
                        profile_completed_at, updated_at)
     VALUES ($1, $2, 'Other', 'PATIENT', TRUE, 'active', 'AB-',
             $3, $4, NOW(), NOW())`,
    [
      phone,
      'QA LongHistory Subject',
      // Deliberately oversized to flush truncation/escaping bugs.
      'Allergen: '.padEnd(800, 'X'),
      'Lorem ipsum dolor sit amet '.repeat(200),
    ]
  );
  return true;
}

async function main() {
  guard();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const patient = await getOrCreateUnicodePatient(client);
    const apptCount = await ensureMultiYearAppointments(client, patient);
    const longCreated = await ensureLongStringPatient(client);
    console.log(
      `[seed-qa-tenant] ${QA_TAG}: unicode_patient_uid=${patient.uid} ` +
        `multiyear_appointments_inserted=${apptCount} long_history_created=${longCreated}`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[seed-qa-tenant] crashed:', err);
  process.exit(1);
});
