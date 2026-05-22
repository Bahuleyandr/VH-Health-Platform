// Regression test for D6 (surfaced during D3).
//
// dischargeService.materialiseDischargeMedsAsPrescription INSERTs into
// e_prescriptions, binding $4 (doctor_uid) to a `uuid` column. Without a
// `::uuid` cast Postgres typed the bound string as text → SQLSTATE 42804,
// which the function's best-effort catch swallowed — so when a discharge
// summary was signed by a doctor, the discharge medications silently never
// materialised to the patient's Rx tab. The cast fix makes the row land.

import prisma from '../lib/prisma.js';
import { materialiseDischargeMedsAsPrescription } from '../services/discharge/dischargeService.js';

const PATIENT_UID = 'd6d6d6d6-0001-4d6d-8d6d-d6d6d6d60001';
const DOCTOR_UID = 'd6d6d6d6-0002-4d6d-8d6d-d6d6d6d60002';
let dischargeSummaryId;

describe('materialiseDischargeMedsAsPrescription — discharge meds reach the Rx tab (D6)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9006060001', 'D6 Patient', 'PATIENT', true, NOW()),
              ($2::uuid, '9006060002', 'D6 Doctor', 'DOCTOR', true, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT_UID, DOCTOR_UID,
    );
    const ds = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_summaries (patient_uid, status)
       VALUES ($1::uuid, 'signed') RETURNING id`,
      PATIENT_UID,
    );
    dischargeSummaryId = ds[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO discharge_summary_sections
         (discharge_summary_id, section_key, section_title, body)
       VALUES ($1::int, 'discharge_medications', 'Discharge Medications',
               'Tab Paracetamol 500mg BD x 5 days\nTab Pantoprazole 40mg OD x 5 days')`,
      dischargeSummaryId,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    if (dischargeSummaryId) {
      await prisma.$executeRawUnsafe(`DELETE FROM discharge_summary_sections WHERE discharge_summary_id = $1::int`, dischargeSummaryId).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE id = $1::int`, dischargeSummaryId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('creates an e_prescriptions row (no swallowed 42804) with doctor_uid bound', async () => {
    await materialiseDischargeMedsAsPrescription({
      discharge_summary_id: dischargeSummaryId,
      patient_uid: PATIENT_UID,
      doctor_uid: DOCTOR_UID,
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT doctor_uid, status, clinical_notes, medications
         FROM e_prescriptions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].doctor_uid)).toBe(DOCTOR_UID);
    expect(rows[0].status).toBe('active');
    expect(String(rows[0].clinical_notes)).toContain(`[discharge_summary_id=${dischargeSummaryId}]`);
  });

  it('is idempotent — a second call does not duplicate the prescription', async () => {
    await materialiseDischargeMedsAsPrescription({
      discharge_summary_id: dischargeSummaryId,
      patient_uid: PATIENT_UID,
      doctor_uid: DOCTOR_UID,
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM e_prescriptions WHERE patient_uid = $1::uuid`, PATIENT_UID,
    );
    expect(rows.length).toBe(1);
  });
});
