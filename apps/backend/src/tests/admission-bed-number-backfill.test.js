// Regression test for findings
//   2026-05-22-tpa-insurance-claim-admission-c52e8649
//   2026-05-23-emergency-walk-in-admission-b92372d9
//
// `GET /api/v1/emr/admission/:id` and `GET /api/v1/admissions/:id` returned
// `bed_id` correctly but `bed_number: null` despite the bed being correctly
// allocated on the `beds` table. Root cause: `admissions.bed_number` is a
// denormalised column (already in `ADMISSION_RETURNING_SELECT`), but the
// admit-time INSERT never populated it because the create() fires BEFORE
// the bed FOR-UPDATE lookup. Admission clerks / ward nurses couldn't print
// or verbally hand over the physical bed from the admission summary
// without a cross-fetch of the bed board.
//
// Fix: after the bed-allocation block back-fills the bed onto `beds`,
// also UPDATE `admissions.bed_number` from `bedRows[0].bed_number` so
// subsequent admission-detail reads surface the bed without an extra
// join. (The sibling `assignBedToAdmission` path — used when a bedless
// emergency admission gets a bed assigned later — was already correct.)

import prisma from '../lib/prisma.js';
import admissionService from '../services/emr/admissionService.js';

const PATIENT_UID = 'e6666666-6666-4666-8666-bbbbbbbb5d60';
const DOCTOR_UID  = 'e6666666-6666-4666-8666-bbbbbbbb5d61';

let bedId;
const createdAdmissionIds = [];

describe('admission bed_number back-fill (c52e8649 + b92372d9)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`UPDATE beds SET status = 'available', patient_id = NULL, patient_name = NULL, patient_uid = NULL, admission_id = NULL, admitted_at = NULL, assigned_at = NULL WHERE bed_number = 'TEST-BACKFILL-01'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000550060', 'Bed Backfill Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000550061', 'Dr. Bed Backfill', 'DOCTOR', true, NOW())`,
      DOCTOR_UID);

    // Treatment consent is a precondition for admitPatient (the service
    // throws AppError.forbidden('Active treatment consent required …')
    // otherwise). Seed an active grant so the admit path under test
    // actually reaches the bed-allocation block we're verifying.
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid AND consent_type = 'treatment'`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents
         (patient_uid, consent_type, granted, status, granted_at, source, version)
       VALUES ($1::uuid, 'treatment', true, 'active', NOW(), 'test', 'v1')`,
      PATIENT_UID);

    // Reuse an existing TEST bed if present (idempotent across test runs).
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM beds WHERE bed_number = 'TEST-BACKFILL-01' LIMIT 1`,
    );
    if (existing.length) {
      bedId = existing[0].id;
      await prisma.$executeRawUnsafe(`UPDATE beds SET status = 'available', patient_id = NULL, patient_name = NULL, patient_uid = NULL, admission_id = NULL WHERE id = $1::int`, bedId);
    } else {
      const created = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (bed_number, status, bed_type, created_at, updated_at)
         VALUES ('TEST-BACKFILL-01', 'available', 'general', NOW(), NOW())
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
      await prisma.$executeRawUnsafe(`UPDATE beds SET status = 'available', patient_id = NULL, patient_name = NULL, patient_uid = NULL, admission_id = NULL, admitted_at = NULL, assigned_at = NULL WHERE id = $1::int`, bedId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('admitPatient back-fills admissions.bed_number from the allocated bed (the repro)', async () => {
    const result = await admissionService.admitPatient({
      patient_uid: PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      attending_doctor: DOCTOR_UID,
      department: 'General Medicine',
      ward: 'GEN-A',
      bed_id: bedId,
      chief_complaint: 'Test admit for bed_number back-fill',
      admission_type: 'elective',
      created_by: DOCTOR_UID,
    });
    createdAdmissionIds.push(result.id);

    // The function returns the in-memory mutated admission shape.
    expect(result.bed_id).toBe(bedId);
    expect(result.bed_number).toBe('TEST-BACKFILL-01');

    // Verify the DB row too — not just the in-memory mutation.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT bed_id, bed_number FROM admissions WHERE id = $1::int`,
      result.id,
    );
    expect(rows[0].bed_id).toBe(bedId);
    expect(rows[0].bed_number).toBe('TEST-BACKFILL-01');
  });

  it('getAdmissionDetail surfaces bed_number for the same admission', async () => {
    // Reuse the admission from the prior test (createdAdmissionIds[0]).
    const detail = await admissionService.getAdmissionDetail(createdAdmissionIds[0]);
    expect(detail).toBeTruthy();
    expect(detail.bed_id).toBe(bedId);
    expect(detail.bed_number).toBe('TEST-BACKFILL-01');
  });
});
