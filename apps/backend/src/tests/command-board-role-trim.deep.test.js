// Command board server-side role trimming.
//
// FULL_INPATIENT_SCOPE_ROLES includes non-clinical desk roles (reception,
// billing, finance, insurance). Before this fix they received the full
// clinical row payload (diagnosis, CDS alerts, clinical tasks) and only the
// client-side `visible_sections` metadata hid it. The trim is now enforced in
// the row builder itself: non-clinical roles get rows without clinical detail
// while clinical and leadership roles are unchanged.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import patientCommandBoardService from '../services/emr/patientCommandBoardService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const PHONE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const WARD = `BOARD-TRIM-${randomUUID().slice(0, 8)}`;
const DIAGNOSIS_TEXT = 'Dengue fever with warning signs';
const ALERT_TITLE = 'Critical drug interaction';

async function cleanup() {
  for (const [table, column] of [
    ['clinical_orders', 'patient_uid'],
    ['cds_alerts', 'patient_uid'],
    ['diagnoses', 'patient_uid'],
    ['admissions', 'patient_uid'],
  ]) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE tenant_id = $1::uuid AND ${column} = $2::uuid`,
      TENANT,
      PATIENT_UID,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
  ).catch(() => {});
}

async function boardFor(role, uid = randomUUID()) {
  return patientCommandBoardService.getPatientCommandBoard(
    { patient_uid: PATIENT_UID },
    { uid, role, tenantId: TENANT },
  );
}

d('command board server-side role trimming', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Board Trim Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID,
      PHONE,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Board Trim Doctor', 'DOCTOR', true, $3::uuid, NOW())`,
      DOCTOR_UID,
      `8${PHONE.slice(1)}`,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, admitting_doctor, attending_doctor, ward, bed_number,
          status, admission_type, priority, admitting_diagnosis, chief_complaint,
          admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4, 'BT-1',
               'admitted', 'IPD', 'routine', $5, 'Fever', NOW(), NOW())`,
      TENANT,
      PATIENT_UID,
      DOCTOR_UID,
      WARD,
      DIAGNOSIS_TEXT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO diagnoses (tenant_id, patient_uid, description, status, icd10_code, diagnosed_by)
       VALUES ($1::uuid, $2::uuid, $3, 'active', 'A97.1', $4::uuid)`,
      TENANT,
      PATIENT_UID,
      DIAGNOSIS_TEXT,
      DOCTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO cds_alerts (tenant_id, patient_uid, alert_type, severity, title, description, acknowledged)
       VALUES ($1::uuid, $2::uuid, 'drug_interaction', 'critical', $3, 'Warfarin + aspirin', false)`,
      TENANT,
      PATIENT_UID,
      ALERT_TITLE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, patient_uid, order_number, order_type, priority, details, status, ordered_by)
       VALUES ($1::uuid, $2::uuid, $3, 'medication', 'routine',
               '{"medication_name":"Paracetamol 500mg"}'::jsonb, 'ordered', $4::uuid)`,
      TENANT,
      PATIENT_UID,
      `BT-ORD-${randomUUID().slice(0, 8)}`,
      DOCTOR_UID,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test.each(['BILLING_STAFF', 'RECEPTIONIST', 'FINANCE_INCHARGE', 'INSURANCE_COORDINATOR'])(
    '%s gets rows without clinical detail server-side',
    async (role) => {
      const result = await boardFor(role);
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0];

      // Clinical detail is absent from the server response itself.
      expect(row.diagnosis).toEqual(expect.objectContaining({
        text: null,
        status: 'hidden',
        code: null,
        chief_complaint: null,
      }));
      expect(row.alerts).toEqual({ count: 0, critical_count: 0, items: [] });
      expect(row.tasks).toEqual(expect.objectContaining({ open_count: 0, items: [] }));
      expect(row.allergies).toEqual({ count: 0, items: [] });
      expect(row.notes).toEqual({ recent_count: 0, latest: null });
      expect(row.actions).toEqual([]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(DIAGNOSIS_TEXT);
      expect(serialized).not.toContain(ALERT_TITLE);
      expect(serialized).not.toContain('Paracetamol');

      // Operational identity stays — desk roles still need to know who is in
      // the bed (unlike housekeeping's minimized 'Occupied' payload).
      expect(row.patient.name).toBe('Board Trim Patient');
      expect(row.patient_uid).toBe(PATIENT_UID);
      expect(row.location.ward).toBe(WARD);

      // The advertised sections match what the server actually returned.
      expect(result.board.actor.visible_sections).toEqual(['summary', 'location', 'discharge']);
    },
  );

  test('a clinical role still receives the full clinical row', async () => {
    const result = await boardFor('DOCTOR', DOCTOR_UID);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];

    expect(row.diagnosis.text).toBe(DIAGNOSIS_TEXT);
    expect(row.alerts.count).toBe(1);
    expect(row.alerts.items[0].title).toBe(ALERT_TITLE);
    expect(row.tasks.open_order_count).toBe(1);
    expect(row.tasks.items.some((item) => item.label === 'Paracetamol 500mg')).toBe(true);
    expect(row.actions.length).toBeGreaterThan(0);
  });

  test('clinical leadership is unchanged', async () => {
    const result = await boardFor('MEDICAL_SUPERINTENDENT');
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.diagnosis.text).toBe(DIAGNOSIS_TEXT);
    expect(row.alerts.count).toBe(1);
  });

  test('pharmacy keeps its promised sections (tasks) but not diagnosis or alerts', async () => {
    const result = await boardFor('PHARMACY_STAFF');
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.diagnosis.status).toBe('hidden');
    expect(row.alerts.count).toBe(0);
    expect(row.tasks.open_order_count).toBe(1);
    expect(row.actions.map((a) => a.key)).toContain('drug_chart');
  });
});
