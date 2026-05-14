// Regression tests for the Stage-5 admission cluster.
//
// Findings:
//   2026-05-09-surgical-day-care-admission-consent-no-preop-carryover
//     — admission was blocked by CONSENT_REQUIRED even when consent had
//       been obtained at the pre-op OPD visit. The gate now also accepts
//       an active `procedure` consent granted within the carry-over
//       window (30 days), so a scheduled day-care/surgical patient
//       doesn't have to re-consent at the admission counter.
//   2026-05-09-inpatient-admission-admission-no-cmchis-flag-no-tamil-consent
//     — admission had no place to flag CMCHIS / Ayushman Bharat
//       eligibility, so a scheme-eligible patient was silently admitted
//       as cash-paying. admissions.govt_scheme / govt_scheme_status now
//       carry it.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateTestToken } from './testClient.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const DOCTOR_UID = 'a8888888-8888-4888-8888-88888888ff01';
const ADMIN_UID = 'a8888888-8888-4888-8888-88888888ff02';
// Pre-op patient: has a recent `procedure` consent, NO `treatment` consent.
const PATIENT_PREOP_UID = 'a8888888-8888-4888-8888-88888888ff03';
// Stale patient: has a `procedure` consent granted 40 days ago (outside
// the carry-over window) and NO `treatment` consent.
const PATIENT_STALE_UID = 'a8888888-8888-4888-8888-88888888ff04';
// Scheme patient: has a `treatment` consent, used for the govt_scheme test.
const PATIENT_SCHEME_UID = 'a8888888-8888-4888-8888-88888888ff05';

function adminClient() {
  const token = generateTestToken('ADMIN', { uid: ADMIN_UID, id: 880002 });
  return {
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanupFixtures() {
  const uids = [PATIENT_PREOP_UID, PATIENT_STALE_UID, PATIENT_SCHEME_UID];
  for (const uid of uids) {
    await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM audit_logs WHERE resource = 'admission' AND metadata->>'patient_uid' = $1`, uid)
      .catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number IN ('PREOP-BED-A','PREOP-BED-B')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = 'PREOP-TEST-WARD'`).catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      DOCTOR_UID,
      ADMIN_UID,
      PATIENT_PREOP_UID,
      PATIENT_STALE_UID,
      PATIENT_SCHEME_UID,
    )
    .catch(() => {});
}

describe('POST /emr/admit — Stage-5 pre-op consent carry-over + govt-scheme flag', () => {
  const admin = adminClient();
  let bed1Id;
  let bed2Id;

  beforeAll(async () => {
    await cleanupFixtures();

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, '9555100001', 'Pre-op Test Doctor', 'DOCTOR', true, NOW()),
         ($2::uuid, '9555100002', 'Pre-op Test Admin', 'ADMIN', true, NOW()),
         ($3::uuid, '9555100003', 'Pre-op Cataract Patient', 'PATIENT', true, NOW()),
         ($4::uuid, '9555100004', 'Stale Consent Patient', 'PATIENT', true, NOW()),
         ($5::uuid, '9555100005', 'Scheme Eligible Patient', 'PATIENT', true, NOW())`,
      DOCTOR_UID,
      ADMIN_UID,
      PATIENT_PREOP_UID,
      PATIENT_STALE_UID,
      PATIENT_SCHEME_UID,
    );

    // Pre-op patient: `procedure` consent captured at the OPD visit today.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status, granted_at)
       VALUES ($1::uuid, 'procedure', true, 'active', NOW())`,
      PATIENT_PREOP_UID,
    );
    // Stale patient: `procedure` consent granted 40 days ago — outside the
    // 30-day carry-over window.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status, granted_at)
       VALUES ($1::uuid, 'procedure', true, 'active', NOW() - INTERVAL '40 days')`,
      PATIENT_STALE_UID,
    );
    // Scheme patient: ordinary active `treatment` consent.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status, granted_at)
       VALUES ($1::uuid, 'treatment', true, 'active', NOW())`,
      PATIENT_SCHEME_UID,
    );

    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ('PREOP-TEST-WARD', 3, 2) RETURNING id`,
    );
    const wardId = wardRows[0].id;
    const bedA = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status) VALUES ($1, 'PREOP-BED-A', 'available') RETURNING id`,
      wardId,
    );
    bed1Id = bedA[0].id;
    const bedB = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status) VALUES ($1, 'PREOP-BED-B', 'available') RETURNING id`,
      wardId,
    );
    bed2Id = bedB[0].id;
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('admits a scheduled patient on a recent pre-op `procedure` consent — no re-grant needed', async () => {
    const res = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_PREOP_UID,
      admitting_doctor: DOCTOR_UID,
      attending_doctor: DOCTOR_UID,
      department: 'Ophthalmology',
      ward: 'PREOP-TEST-WARD',
      bed_id: bed1Id,
      chief_complaint: 'Scheduled left eye cataract surgery',
      admission_type: 'elective',
      priority: 'routine',
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.data?.admission?.id).toBeDefined();
  });

  it('still blocks admission when the only `procedure` consent is older than the carry-over window', async () => {
    const res = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_STALE_UID,
      admitting_doctor: DOCTOR_UID,
      chief_complaint: 'Elective hernia repair',
      bed_id: bed2Id,
      admission_type: 'elective',
      priority: 'routine',
    });
    expect(res.statusCode).toBe(403);
    expect(String(res.body.code || res.body.message || '')).toMatch(/CONSENT/i);
  });

  it('records CMCHIS govt-scheme eligibility on the admission row', async () => {
    const res = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_SCHEME_UID,
      admitting_doctor: DOCTOR_UID,
      ward: 'PREOP-TEST-WARD',
      bed_id: bed2Id,
      chief_complaint: 'Community-acquired pneumonia',
      admission_type: 'elective',
      priority: 'routine',
      govt_scheme: 'CMCHIS',
    });
    expect(res.statusCode).toBe(201);
    // No explicit status sent → defaults to pending_verification so it
    // lands on the insurance counsellor's worklist.
    expect(res.body.data?.admission?.govt_scheme).toBe('CMCHIS');
    expect(res.body.data?.admission?.govt_scheme_status).toBe('pending_verification');

    const row = await prisma.$queryRawUnsafe(
      `SELECT govt_scheme, govt_scheme_status FROM admissions WHERE id = $1`,
      res.body.data.admission.id,
    );
    expect(row[0]).toMatchObject({ govt_scheme: 'CMCHIS', govt_scheme_status: 'pending_verification' });
  });

  it('rejects an invalid govt_scheme_status', async () => {
    const res = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_SCHEME_UID,
      admitting_doctor: DOCTOR_UID,
      bed_id: bed1Id,
      chief_complaint: 'duplicate attempt with bad scheme status',
      admission_type: 'elective',
      priority: 'routine',
      govt_scheme: 'Ayushman Bharat',
      govt_scheme_status: 'definitely_maybe',
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.message || '')).toMatch(/govt_scheme_status/i);
  });
});
