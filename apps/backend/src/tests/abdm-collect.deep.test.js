// Roadmap C1 follow-up — collectHealthData column-drift regression.
//
// Every HI-type branch had drifted from the real schema (selected columns
// that do not exist) and the bind params were passed un-spread, so the M2
// data-collection path could never have produced a bundle. This pins each
// repaired branch against real rows.

import prisma from '../lib/prisma.js';
import abdmService from '../services/abdm/abdmService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_NAME = 'ABDMCOLLECT Patient';
let patientUid;
let patientId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM prescriptions WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE patient_id IN (SELECT id FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, TEST_NAME).catch(() => {});
}

d('ABDM collectHealthData — schema-drift regression (roadmap C1)', () => {
  beforeAll(async () => {
    await cleanup();
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING id, uid`,
      `+9198811${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_NAME,
    );
    patientUid = u[0].uid;
    patientId = u[0].id;

    await prisma.$queryRawUnsafe(
      `INSERT INTO prescriptions (patient_uid, medication_name, dosage, frequency, duration_days, status, issued_at, created_at)
       VALUES ($1::uuid, 'Amoxicillin 500mg', '500 mg', 'TID', 5, 'active', NOW(), NOW()) RETURNING id`,
      patientUid,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results (patient_uid, test_code, test_name, loinc_code, value_numeric, unit, reference_range, status, created_at)
       VALUES ($1::uuid, 'HB', 'Haemoglobin', '718-7', 13.2, 'g/dL', '13-17', 'final', NOW()) RETURNING id`,
      patientUid,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO appointments (phone, patient_id, patient_name, doctor_name, appointment_date, appointment_time, status, reason, created_at, updated_at)
       VALUES ('+919811110000', $1, $2, 'Dr ABDM Test', CURRENT_DATE, '10:00', 'completed', 'Fever follow-up', NOW(), NOW()) RETURNING id`,
      patientId,
      TEST_NAME,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('collects Prescription entries with real columns', async () => {
    const bundle = await abdmService.collectHealthData(patientUid, ['Prescription'], null, null);
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0]).toMatchObject({
      resourceType: 'MedicationRequest',
      hiType: 'Prescription',
      medicationName: 'Amoxicillin 500mg',
      dosage: '500 mg',
      frequency: 'TID',
      durationDays: 5,
    });
    expect(bundle.entry[0].date).toBeTruthy();
  });

  test('collects DiagnosticReport entries from lab_results', async () => {
    const bundle = await abdmService.collectHealthData(patientUid, ['DiagnosticReport'], null, null);
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0]).toMatchObject({
      resourceType: 'DiagnosticReport',
      hiType: 'DiagnosticReport',
      testName: 'Haemoglobin',
      loincCode: '718-7',
      resultValue: 13.2,
      resultUnit: 'g/dL',
      referenceRange: '13-17',
      status: 'final',
    });
  });

  test('collects OPConsultation entries via the uid→patient_id resolution', async () => {
    const bundle = await abdmService.collectHealthData(patientUid, ['OPConsultation'], null, null);
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0]).toMatchObject({
      resourceType: 'Encounter',
      hiType: 'OPConsultation',
      doctorName: 'Dr ABDM Test',
      reason: 'Fever follow-up',
    });
  });

  test('date-range filters actually bind (the un-spread params regression)', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const bundle = await abdmService.collectHealthData(
      patientUid,
      ['Prescription', 'DiagnosticReport', 'OPConsultation'],
      future,
      null,
    );
    expect(bundle.total).toBe(0);

    // Window is ±2 days: created_at columns are server-local timestamps
    // (IST in dev) while JS Dates bind as UTC — Phase-0.5 timezone note.
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const bundleAll = await abdmService.collectHealthData(
      patientUid,
      ['Prescription', 'DiagnosticReport', 'OPConsultation'],
      past,
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    );
    expect(bundleAll.total).toBe(3);
  });

  test('unknown HI types are skipped without throwing', async () => {
    const bundle = await abdmService.collectHealthData(patientUid, ['WellnessRecord', 'NoSuchType'], null, null);
    expect(bundle.total).toBe(0);
  });
});
