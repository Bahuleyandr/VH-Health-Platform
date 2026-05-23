// Regression test for finding 2026-05-22-emergency-walk-in-nurse-009ad565.
//
// POST /api/v1/emr/vitals echoed `triage_acuity` (via the in-memory
// `record.triage_acuity = normalizedAcuity` assignment after the sibling
// UPDATE), but the subsequent GET /vitals/.../latest read returned
// `triage_acuity: null` for the same row id. Root cause: `VITAL_SELECT`
// in vitalsChartService.js omitted the `triage_acuity` column, so all
// vitals reads (latest, chart, trend) silently dropped it — producing
// a dangerous split-brain (nurse charts ATS-2 acuity for chest pain;
// the next doctor reads vitals and sees acuity null).
//
// Fix: add `triage_acuity: true` to VITAL_SELECT. The write side
// already persisted it correctly; only the projection was wrong.

import prisma from '../lib/prisma.js';
import { recordVitals, getLatestVitals, getVitalsChart } from '../services/emr/vitalsChartService.js';

const PATIENT_UID = 'd7777777-7777-4777-8777-aaaaaaaa5d70';
const RECORDER_UID = 'd7777777-7777-4777-8777-aaaaaaaa5d71';

describe('vitals read-back surfaces triage_acuity (009ad565)', () => {
  let patientId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID).catch(() => {});

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000440070', 'Vitals Read Patient', 'PATIENT', true, NOW())
       RETURNING id`, PATIENT_UID);
    patientId = p[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000440071', 'Vitals Read Nurse', 'NURSING_STAFF', true, NOW())`,
      RECORDER_UID);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('getLatestVitals returns triage_acuity that POST stored (the repro)', async () => {
    const created = await recordVitals({
      patient_uid: PATIENT_UID,
      patient_id: patientId,
      heart_rate: 110, systolic_bp: 140, diastolic_bp: 90,
      spo2: 96, respiratory_rate: 22, pain_score: 8,
      triage_acuity: 2,
      recorded_by: RECORDER_UID,
    });
    expect(created.triage_acuity).toBe(2);  // POST response carries it (in-memory mutation, pre-fix)

    // The actual round-trip test: pull it back through getLatestVitals.
    const latest = await getLatestVitals(PATIENT_UID);
    expect(latest).toBeTruthy();
    expect(latest.id).toBe(created.id);
    expect(latest.triage_acuity).toBe(2);  // <- was null before this PR
  });

  it('getVitalsChart includes triage_acuity in each row', async () => {
    await recordVitals({
      patient_uid: PATIENT_UID,
      patient_id: patientId,
      heart_rate: 95, spo2: 98,
      triage_acuity: 3,
      recorded_by: RECORDER_UID,
    });
    const chart = await getVitalsChart(PATIENT_UID, null, { page: 1, limit: 50 });
    expect(chart.vitals.length).toBeGreaterThanOrEqual(2);
    for (const row of chart.vitals) {
      // Every row carries an acuity (either 2 or 3 from this test's writes)
      expect([2, 3]).toContain(row.triage_acuity);
    }
  });

  it('getLatestVitals returns triage_acuity:null for a vitals row recorded without acuity (unchanged behaviour)', async () => {
    // Recording with no acuity must still return the row + a null acuity
    // — we are not auto-defaulting to anything, just surfacing the column.
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await recordVitals({
      patient_uid: PATIENT_UID,
      patient_id: patientId,
      heart_rate: 78, spo2: 99,
      recorded_by: RECORDER_UID,
    });
    const latest = await getLatestVitals(PATIENT_UID);
    expect(latest).toBeTruthy();
    expect(latest.triage_acuity).toBeNull();
  });
});
