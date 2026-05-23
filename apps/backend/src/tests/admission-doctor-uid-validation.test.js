// Regression test for findings
//   2026-05-22-inpatient-admission-receptionist-06e43c24
//   2026-05-22-inpatient-admission-receptionist-7523da24
//
// `POST /api/v1/emr/admit` accepted any uuid for `admitting_doctor`
// and `attending_doctor` without checking the uid existed in `users`
// or pointed at a clinical-role user. A typo'd uuid or a patient/HR
// user uid sailed through, got stamped on `admissions.admitting_doctor`
// / `.attending_doctor`, and then surfaced on the ward roundup queue
// + the discharge-summary signer lookup as a "real" doctor name —
// breaking the TPA preauth treating-doctor declaration, the chart
// audit trail, and the patient-facing care-team display.
//
// The fix adds an `assertDoctorUid()` validator that runs before any
// transaction is opened or bed is locked:
//   * 400 INVALID_DOCTOR_UID    — value isn't a uuid at all
//   * 400 DOCTOR_UID_NOT_FOUND  — no users row with that uid
//   * 400 DOCTOR_UID_INACTIVE   — users.is_active = false
//   * 400 DOCTOR_UID_ROLE_INVALID — users.role isn't a clinical role
// Same gate is applied to PATCH /admissions/:id/attending-doctor via
// `updateAttendingDoctor()`.

import prisma from '../lib/prisma.js';
import admissionService from '../services/emr/admissionService.js';

const PATIENT_UID = 'e5555555-5555-4555-8555-cccccccc5005';
const REAL_DOCTOR_UID = 'e5555555-5555-4555-8555-cccccccc5006';
const PATIENT_ROLE_UID = 'e5555555-5555-4555-8555-cccccccc5007';
const INACTIVE_DOCTOR_UID = 'e5555555-5555-4555-8555-cccccccc5008';
const NONEXISTENT_UID = 'e5555555-5555-4555-8555-ffffffffffff';

let bedId;
const createdAdmissionIds = [];

describe('admission doctor uid validation (06e43c24 + 7523da24)', () => {
  beforeAll(async () => {
    // Clean any stragglers.
    await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`UPDATE beds SET status = 'available', patient_id = NULL, patient_name = NULL, patient_uid = NULL, admission_id = NULL, admitted_at = NULL, assigned_at = NULL WHERE bed_number = 'TEST-DR-VALID'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, REAL_DOCTOR_UID, PATIENT_ROLE_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, INACTIVE_DOCTOR_UID).catch(() => {});

    // Seed canonical fixtures.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9001550070', 'Validator Test Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9001550071', 'Dr. Validator Test', 'DOCTOR', true, NOW())`,
      REAL_DOCTOR_UID,
    );
    // A patient-role user — the swarm's repro: a real users.uid but
    // wrong role (the wrong tab in the admit dialog picked a patient).
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9001550072', 'Another Patient', 'PATIENT', true, NOW())`,
      PATIENT_ROLE_UID,
    );
    // An inactive doctor — kept on roster but flagged out, must still
    // be rejected because they cannot legally sign the chart.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9001550073', 'Dr. Retired', 'DOCTOR', false, NOW())`,
      INACTIVE_DOCTOR_UID,
    );

    // Seed treatment consent (precondition for admitPatient).
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents
         (patient_uid, consent_type, granted, status, granted_at, source, version)
       VALUES ($1::uuid, 'treatment', true, 'active', NOW(), 'test', 'v1')
       ON CONFLICT DO NOTHING`,
      PATIENT_UID,
    );

    // Seed a bed for the happy-path admission.
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM beds WHERE bed_number = 'TEST-DR-VALID' LIMIT 1`,
    );
    if (existing.length) {
      bedId = existing[0].id;
      await prisma.$executeRawUnsafe(
        `UPDATE beds SET status = 'available', patient_id = NULL, patient_name = NULL, patient_uid = NULL, admission_id = NULL WHERE id = $1::int`,
        bedId,
      );
    } else {
      const created = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (bed_number, status, bed_type, created_at, updated_at)
         VALUES ('TEST-DR-VALID', 'available', 'general', NOW(), NOW())
         RETURNING id`,
      );
      bedId = created[0].id;
    }
  });

  afterAll(async () => {
    for (const id of createdAdmissionIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE admission_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE id = $1::int`, id).catch(() => {});
    }
    if (bedId) {
      await prisma.$executeRawUnsafe(
        `UPDATE beds SET status = 'available', patient_id = NULL, patient_name = NULL, patient_uid = NULL, admission_id = NULL, admitted_at = NULL, assigned_at = NULL WHERE id = $1::int`,
        bedId,
      ).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID, REAL_DOCTOR_UID, PATIENT_ROLE_UID, INACTIVE_DOCTOR_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  async function admitWith(overrides) {
    return admissionService.admitPatient({
      patient_uid: PATIENT_UID,
      admitting_doctor: REAL_DOCTOR_UID,
      department: 'General Medicine',
      ward: 'GEN-DR',
      bed_id: bedId,
      chief_complaint: 'Validator test',
      admission_type: 'elective',
      created_by: REAL_DOCTOR_UID,
      ...overrides,
    });
  }

  it('rejects a syntactically invalid uuid for admitting_doctor (INVALID_DOCTOR_UID)', async () => {
    await expect(admitWith({ admitting_doctor: 'not-a-uuid' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_DOCTOR_UID' });
  });

  it('rejects a uuid that points at no users row (DOCTOR_UID_NOT_FOUND)', async () => {
    await expect(admitWith({ admitting_doctor: NONEXISTENT_UID }))
      .rejects.toMatchObject({ statusCode: 400, code: 'DOCTOR_UID_NOT_FOUND' });
  });

  it('rejects a uid that points at a PATIENT (DOCTOR_UID_ROLE_INVALID) — the swarm repro', async () => {
    await expect(admitWith({ admitting_doctor: PATIENT_ROLE_UID }))
      .rejects.toMatchObject({ statusCode: 400, code: 'DOCTOR_UID_ROLE_INVALID' });
  });

  it('rejects an inactive doctor uid (DOCTOR_UID_INACTIVE)', async () => {
    await expect(admitWith({ admitting_doctor: INACTIVE_DOCTOR_UID }))
      .rejects.toMatchObject({ statusCode: 400, code: 'DOCTOR_UID_INACTIVE' });
  });

  it('rejects a bad attending_doctor even when admitting_doctor is valid', async () => {
    await expect(admitWith({
      admitting_doctor: REAL_DOCTOR_UID,
      attending_doctor: PATIENT_ROLE_UID,
    }))
      .rejects.toMatchObject({ statusCode: 400, code: 'DOCTOR_UID_ROLE_INVALID' });
  });

  it('accepts a real DOCTOR uid (happy path completes the admission)', async () => {
    const result = await admitWith({
      admitting_doctor: REAL_DOCTOR_UID,
      attending_doctor: REAL_DOCTOR_UID,
    });
    createdAdmissionIds.push(result.id);
    expect(result.id).toBeTruthy();
    expect(result.admitting_doctor).toBe(REAL_DOCTOR_UID);
    expect(result.attending_doctor).toBe(REAL_DOCTOR_UID);
  });
});
