// Regression test for finding
// 2026-05-21-lab-walk-in-lab-tech-65aded1a
//
// When a pathologist signs off (verifies) lab results, nothing notified the
// patient that their results were ready to view — only the critical-alert
// path fires a notification, and that targets the ordering clinician. A
// patient (or the guardian of a dependent minor) whose normal results were
// finalised was never told.
//
// signOffResults now queues a 'lab_result_ready' notification to the patient,
// and additionally to the guardian when the patient is a dependent minor
// (users.guardian_user_id, migration 202).

import prisma from '../lib/prisma.js';
import * as labResults from '../services/lab/labResultsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ADULT_UID = 'f5555555-5555-4555-8555-555555550001';
const GUARDIAN_UID = 'f5555555-5555-4555-8555-555555550002';
const MINOR_UID = 'f5555555-5555-4555-8555-555555550003';
const PATHOLOGIST_UID = 'f5555555-5555-4555-8555-555555550009';

let adultResultId;
let minorResultId;
const allUids = [ADULT_UID, GUARDIAN_UID, MINOR_UID];

async function insertUser(uid, phone, name, guardianDbId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, guardian_user_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', true, $4::int, NOW())
     ON CONFLICT (uid) DO UPDATE SET phone = EXCLUDED.phone, guardian_user_id = EXCLUDED.guardian_user_id
     RETURNING id`,
    uid, phone, name, guardianDbId,
  );
  return rows[0].id;
}

async function insertResult(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status)
     VALUES ($1::uuid, $2::uuid, 'GLU', 'Glucose, Fasting', '92', 'preliminary')
     RETURNING id`,
    TENANT, patientUid,
  );
  return rows[0].id;
}

describe('Lab sign-off notifies the patient + guardian (65aded1a)', () => {
  beforeAll(async () => {
    await insertUser(ADULT_UID, '9811100001', 'Adult Patient');
    const guardianDbId = await insertUser(GUARDIAN_UID, '9811100002', 'Guardian Parent');
    await insertUser(MINOR_UID, '9811100003', 'Minor Dependent', guardianDbId);
    adultResultId = await insertResult(ADULT_UID);
    minorResultId = await insertResult(MINOR_UID);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM notifications WHERE uid = ANY($1::uuid[])`, allUids,
    ).catch(() => {});
    for (const rid of [adultResultId, minorResultId]) {
      if (rid) {
        await prisma.$executeRawUnsafe(`DELETE FROM lab_pathologist_signoffs WHERE $1 = ANY(result_ids)`, rid).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE id = $1::int`, rid).catch(() => {});
      }
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('queues a result-ready notification to the patient on verified sign-off', async () => {
    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [adultResultId],
      decision: 'verified',
      patient_uid: ADULT_UID,
    });

    const notifs = await prisma.$queryRawUnsafe(
      `SELECT title, body, type FROM notifications
        WHERE uid = $1::uuid AND type = 'lab_result_ready'`,
      ADULT_UID,
    );
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0].body).toMatch(/your lab/i);
  });

  it('also notifies the guardian when the patient is a dependent minor', async () => {
    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [minorResultId],
      decision: 'verified',
      patient_uid: MINOR_UID,
    });

    const minorNotifs = await prisma.$queryRawUnsafe(
      `SELECT body FROM notifications WHERE uid = $1::uuid AND type = 'lab_result_ready'`,
      MINOR_UID,
    );
    const guardianNotifs = await prisma.$queryRawUnsafe(
      `SELECT body FROM notifications WHERE uid = $1::uuid AND type = 'lab_result_ready'`,
      GUARDIAN_UID,
    );
    expect(minorNotifs.length).toBeGreaterThanOrEqual(1);
    expect(guardianNotifs.length).toBeGreaterThanOrEqual(1);
    expect(guardianNotifs[0].body).toMatch(/dependent/i);
  });

  it('does NOT notify on a non-verifying decision (e.g. rejected)', async () => {
    const rid = await insertResult(ADULT_UID);
    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [rid],
      decision: 'rejected',
      patient_uid: ADULT_UID,
    });
    // Only the verified sign-off (test 1) should have produced a notification.
    const notifs = await prisma.$queryRawUnsafe(
      `SELECT id FROM notifications WHERE uid = $1::uuid AND type = 'lab_result_ready'`,
      ADULT_UID,
    );
    expect(notifs.length).toBe(1); // from test 1 only, not this rejected one
    await prisma.$executeRawUnsafe(`DELETE FROM lab_pathologist_signoffs WHERE $1 = ANY(result_ids)`, rid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE id = $1::int`, rid).catch(() => {});
  });
});
