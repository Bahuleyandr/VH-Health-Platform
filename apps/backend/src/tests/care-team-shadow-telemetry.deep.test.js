// CT-001 — care-team governed PHI guards: enforce blocks, shadow logs.
//
// The governed care-team guards default to SHADOW (careTeamEnforcement.js): a
// relationship denial is recorded but the request proceeds, until an operator
// flips per-tenant tenants.settings.care_team_enforcement_mode='enforce' (or the
// deployment env). That flip is staged on a shadow-telemetry review — so the
// telemetry MUST actually be captured. This regression pins the full contract on
// a governed PHI route (records by uid):
//   * ENFORCE: an unrelated clinician is blocked (403).
//   * SHADOW : the same request is NOT blocked, AND a would-be denial is written
//     to patient_access_audit_log (access_decision='deny', metadata.shadow_mode
//     =true) — the "shadow_denied" telemetry the staged review depends on.
// (Enforce-mode 403 is also covered for investigation [investigation-booking-
// guard], pharmacy [pharmacy-phone-careteam-guard], and records [CAN-039 in
// referral-records-child-guard]; this adds the shadow-telemetry leg.)
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'c0de0c01-0000-4000-8000-0000000007a1';
const DOCTOR_UID = 'c0de0c01-00d0-4000-8000-00000000d001';

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_UID, tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid AND actor_uid = $2::uuid`,
    PATIENT, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
}

d('CT-001 care-team governed guard: enforce blocks, shadow logs (records/uid)', () => {
  let prevMode;
  beforeAll(async () => {
    prevMode = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000901701','CT Patient','PATIENT',true,NOW())`, PATIENT, TENANT_ID);
  }, 30000);
  afterAll(async () => {
    if (prevMode === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    else process.env.CARE_TEAM_ENFORCEMENT_MODE = prevMode;
    await clean(); await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('ENFORCE: an unrelated clinician is blocked (403)', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    const res = await doctor().get(`/api/v1/records/uid/${PATIENT}`);
    expect(res.statusCode).toBe(403);
  });

  it('SHADOW: same request is not blocked AND a shadow_denied row is logged', async () => {
    delete process.env.CARE_TEAM_ENFORCEMENT_MODE; // default = shadow
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid AND actor_uid = $2::uuid`,
      PATIENT, DOCTOR_UID).catch(() => {});

    const res = await doctor().get(`/api/v1/records/uid/${PATIENT}`);
    expect(res.statusCode).not.toBe(403); // shadow must NOT block

    // The would-be denial must be captured for the staged telemetry review.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT access_decision, metadata->>'shadow_mode' AS shadow_mode
         FROM patient_access_audit_log
        WHERE patient_uid = $1::uuid AND actor_uid = $2::uuid
        ORDER BY created_at DESC LIMIT 1`, PATIENT, DOCTOR_UID);
    expect(rows[0]?.access_decision).toBe('deny');
    expect(rows[0]?.shadow_mode).toBe('true');
  });
});
