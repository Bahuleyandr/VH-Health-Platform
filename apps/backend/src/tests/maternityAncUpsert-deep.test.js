// Finding: 2026-05-09-obstetric-anc-patient-duplicate-anc-visit-alarming-bp
//
// recordAncVisit must UPSERT on (pregnancy_id, visit_date). Multiple
// readings on the same calendar day belong to one row, not duplicates.
// Migration 222 enforces the unique constraint; the service uses
// ON CONFLICT DO UPDATE to merge new clinical fields onto the existing
// row, with EXCLUDED.* overriding existing values only when non-null.

import prisma from '../lib/prisma.js';
import { recordAncVisit } from '../services/maternity/maternityService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'b1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';

describe('recordAncVisit — same-day UPSERT (migration 222)', () => {
  let patientId;
  let pregnancyId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_anc_visits
        WHERE pregnancy_id IN (SELECT id FROM maternity_pregnancies WHERE patient_uid=$1::uuid)`,
      PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid=$1::uuid`,
      PATIENT_UID,
    );
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_pregnant, updated_at)
       VALUES ($1::uuid, '9000080001', 'ANC Upsert Test', 'PATIENT', true, true, NOW())
       RETURNING id`,
      PATIENT_UID,
    );
    patientId = u[0].id;
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO maternity_pregnancies (patient_uid, lmp_date, edd_date, status, tenant_id)
       VALUES ($1::uuid, '2025-11-01', '2026-08-08', 'active', $2::uuid)
       RETURNING id`,
      PATIENT_UID, TENANT,
    );
    pregnancyId = p[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_anc_visits WHERE pregnancy_id = $1`,
      pregnancyId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE id = $1`,
      pregnancyId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`,
      PATIENT_UID,
    );
    await prisma.$disconnect().catch(() => {});
  });

  it('merges a second-call BP reading into the same row instead of inserting a duplicate', async () => {
    // First visit: rich clinical data, no concerning BP
    await recordAncVisit({
      tenantId: TENANT,
      pregnancy_id: pregnancyId,
      visit_date: '2026-05-09',
      gestational_age_weeks: 24,
      weight_kg: 58.4,
      bp_systolic: 118,
      bp_diastolic: 76,
      fundal_height_cm: 24,
      fetal_heart_rate_bpm: 140,
      next_visit_date: '2026-06-09',
      iron_folic_acid_given: true,
    });

    // Same day, second reading: only BP supplied (the nurse's ghost
    // row case). Pre-migration-222 this inserted a duplicate.
    await recordAncVisit({
      tenantId: TENANT,
      pregnancy_id: pregnancyId,
      visit_date: '2026-05-09',
      bp_systolic: 142,
      bp_diastolic: 92,
      notes: 'BP rechecked at end of visit',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, visit_number, bp_systolic, bp_diastolic, weight_kg,
              fundal_height_cm, fetal_heart_rate_bpm, next_visit_date::text AS next_visit_date,
              iron_folic_acid_given, notes
         FROM maternity_anc_visits
        WHERE pregnancy_id = $1 AND visit_date = '2026-05-09'`,
      pregnancyId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bp_systolic).toBe(142);
    expect(rows[0].bp_diastolic).toBe(92);
    // Original clinical fields preserved (not blanked out)
    expect(Number(rows[0].weight_kg)).toBe(58.4);
    expect(rows[0].fundal_height_cm).toBe(24);
    expect(rows[0].fetal_heart_rate_bpm).toBe(140);
    expect(rows[0].next_visit_date).toBe('2026-06-09');
    expect(rows[0].iron_folic_acid_given).toBe(true);
    expect(rows[0].notes).toBe('BP rechecked at end of visit');
  });

  it('still creates a new row for a different visit_date', async () => {
    await recordAncVisit({
      tenantId: TENANT,
      pregnancy_id: pregnancyId,
      visit_date: '2026-05-23',
      gestational_age_weeks: 26,
      bp_systolic: 120,
      bp_diastolic: 78,
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT visit_date::text AS visit_date, visit_number
         FROM maternity_anc_visits
        WHERE pregnancy_id = $1
        ORDER BY visit_date`,
      pregnancyId,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].visit_date).toBe('2026-05-09');
    expect(rows[1].visit_date).toBe('2026-05-23');
    expect(rows[1].visit_number).toBe(2);
  });
});
