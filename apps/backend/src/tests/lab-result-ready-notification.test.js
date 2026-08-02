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
import {
  getResultEpisodeReleaseDecision,
} from '../services/portal/portalAccessService.js';
import { purgeDiagnosticEvidence } from './helpers/diagnosticEvidenceCleanup.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ADULT_UID = 'f5555555-5555-4555-8555-555555550001';
const GUARDIAN_UID = 'f5555555-5555-4555-8555-555555550002';
const MINOR_UID = 'f5555555-5555-4555-8555-555555550003';
const PATHOLOGIST_UID = 'f5555555-5555-4555-8555-555555550009';

let adultResultId;
let minorResultId;
const allUids = [ADULT_UID, GUARDIAN_UID, MINOR_UID, PATHOLOGIST_UID];
let previousReleaseDelay;

async function insertUser(uid, phone, name, guardianDbId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users
       (uid, tenant_id, phone, name, role, status, is_active, is_deleted,
        guardian_user_id, updated_at)
     VALUES ($1::uuid, $5::uuid, $2, $3, 'PATIENT', 'active', true, false, $4::int, NOW())
     ON CONFLICT (uid) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           phone = EXCLUDED.phone,
           guardian_user_id = EXCLUDED.guardian_user_id,
           status = EXCLUDED.status,
           is_active = true,
           is_deleted = false,
           deleted_at = NULL
     RETURNING id`,
    uid, phone, name, guardianDbId, TENANT,
  );
  return rows[0].id;
}

async function insertResult(patientUid) {
  const patientRows = await prisma.$queryRawUnsafe(
    `SELECT id, phone FROM users WHERE uid = $1::uuid`,
    patientUid,
  );
  const patient = patientRows[0];
  const investigationRows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, phone, patient_id, patient_uid, test_name, test_type,
        status, priority, requested_at, updated_at)
     VALUES
       ($1::uuid, $2, $3, $4::uuid, 'Glucose, Fasting', 'blood',
        'REQUESTED', 'NORMAL', NOW(), NOW())
     RETURNING id`,
    TENANT,
    patient.phone,
    patient.id,
    patientUid,
  );
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, investigation_id, test_code, test_name, value_text, status)
     VALUES ($1::uuid, $2::uuid, $3::int, 'GLU', 'Glucose, Fasting', '92', 'preliminary')
     RETURNING id`,
    TENANT, patientUid, investigationRows[0].id,
  );
  return rows[0].id;
}

describe('Lab sign-off notifies the patient + guardian (65aded1a)', () => {
  beforeAll(async () => {
    previousReleaseDelay = process.env.PORTAL_RESULT_RELEASE_DELAY_HOURS;
    process.env.PORTAL_RESULT_RELEASE_DELAY_HOURS = '0';
    // Clear append-only sign-off evidence a previous run may have stranded, so
    // a database that is already poisoned heals instead of staying wedged.
    await purgeDiagnosticEvidence(prisma, TENANT, allUids);
    await insertUser(ADULT_UID, '9811100001', 'Adult Patient');
    const guardianDbId = await insertUser(GUARDIAN_UID, '9811100002', 'Guardian Parent');
    await insertUser(MINOR_UID, '9811100003', 'Minor Dependent', guardianDbId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, status, is_active, is_deleted, updated_at)
       VALUES ($1::uuid, $2::uuid, '9811100009', 'Result Pathologist',
               'PATHOLOGIST', 'active', true, false, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             role = EXCLUDED.role,
             status = EXCLUDED.status,
             is_active = true,
             is_deleted = false,
             deleted_at = NULL`,
      PATHOLOGIST_UID,
      TENANT,
    );
    adultResultId = await insertResult(ADULT_UID);
    minorResultId = await insertResult(MINOR_UID);
  });

  afterAll(async () => {
    // Must precede the sign-off / result / investigation / user deletes below:
    // until this evidence is gone every one of them is rejected by an FK, and
    // because they all swallow their errors the teardown failed in silence.
    // Deliberately NOT swallowed — a purge that stops working should be loud.
    await purgeDiagnosticEvidence(prisma, TENANT, allUids);
    await prisma.$executeRawUnsafe(
      `DELETE FROM notifications WHERE uid = ANY($1::uuid[])`, allUids,
    ).catch(() => {});
    for (const rid of [adultResultId, minorResultId]) {
      if (rid) {
        await prisma.$executeRawUnsafe(`DELETE FROM lab_pathologist_signoffs WHERE $1 = ANY(result_ids)`, rid).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE id = $1::int`, rid).catch(() => {});
      }
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE patient_uid = ANY($1::uuid[])`,
      allUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids).catch(() => {});
    if (previousReleaseDelay === undefined) delete process.env.PORTAL_RESULT_RELEASE_DELAY_HOURS;
    else process.env.PORTAL_RESULT_RELEASE_DELAY_HOURS = previousReleaseDelay;
    await prisma.$disconnect().catch(() => {});
  });

  it('queues a result-ready notification to the patient on verified sign-off', async () => {
    const signoff = await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [adultResultId],
      decision: 'verified',
      patient_uid: ADULT_UID,
    });
    await expect(getResultEpisodeReleaseDecision({
      tenantId: TENANT,
      patientUid: ADULT_UID,
      investigationId: Number(String(signoff.episode_key).split(':')[1]),
    })).resolves.toEqual({ outcome: 'visible' });

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

  it('rejects a non-sign-off decision and does not notify', async () => {
    const rid = await insertResult(ADULT_UID);
    await expect(labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [rid],
      decision: 'rejected',
      patient_uid: ADULT_UID,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_DECISION_UNSUPPORTED',
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
