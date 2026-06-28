// PHARMACY_ORDER care-team guard — phone-identified patient resolution (deep,
// real engine + DB).
//
// Regression guard for the int4-overflow bug: the PHARMACY_ORDER mount
// (`patientAccessGuard('PHARMACY_ORDER', { careTeamModeGoverned: true })`)
// resolves the patient from the request, and a pharmacy order can identify its
// patient by PHONE (`{ phone: '+91XXXXXXXXXX', order_note: '...' }`). The
// resolver used to parse that phone with parseInt() and bind it to an
// `id = $N::int` comparison, so any real Indian mobile number (parsed value
// > 2,147,483,647) blew up with Postgres 22003 "value out of range for type
// integer". In the default SHADOW posture the guard fails OPEN and swallowed
// that error, masking it; under CARE_TEAM_ENFORCEMENT_MODE='enforce' the same
// phone-identified order would 500 (PATIENT_ACCESS_CHECK_FAILED) for EVERY
// patient instead of doing a real relationship check.
//
// These tests assert, under enforce, that a phone-identified order:
//   1. for a patient the caller has NO relationship to is DENIED (403) — not
//      500. A 403 also proves the patient RESOLVED (an unresolvable patient
//      ref is a no_patient_context pass-through on this mount, never a 403).
//   2. for a related patient (active admission relationship) PASSES the guard.
// A 10-digit raw phone (the int4-overflow trigger) is used for the deny case to
// prove both the overflow fix and the normalize-to-stored-+91-form fix.
//
// Direct guard invocation (real accessDecisionService + real DB) mirrors
// careteam-abac-shadow.deep.test.js: it isolates the GUARD decision from the
// pharmacy controller's body validation. Enforce is forced via the env var,
// which the per-tenant resolver reads fresh each call; the default tenant has
// no care_team_enforcement_mode setting, so the env override wins deterministically.

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { patientAccessGuard } from '../middleware/phiAccessMiddleware.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PATIENT_UID = 'c0de9001-0000-4000-8000-000000009001';
const DOCTOR_UID = 'c0de9001-0000-4000-8000-000000009002';
// Stored E.164 form. The deny case sends the bare 10-digit form ('9000090011')
// which parseInt() would overflow int4 and which must normalize back to this.
const PATIENT_PHONE = '+919000090011';
const RAW_PHONE = '9000090011';
const DOCTOR_ID = 9009002;

function guardReq({ phone }) {
  return {
    id: `pharm-phone-${phone}`,
    method: 'POST',
    originalUrl: '/api/v1/pharmacy-orders/orders',
    params: {},
    query: {},
    body: { phone, order_note: 'Please prepare amoxicillin 500mg, 10 tabs' },
    tenantId: DEFAULT_TENANT_ID,
    user: { id: DOCTOR_ID, uid: DOCTOR_UID, role: 'DOCTOR', tenant_id: DEFAULT_TENANT_ID },
  };
}

function resStub() {
  return {
    statusCode: 200,
    _status: null,
    _json: null,
    status(code) { this._status = code; this.statusCode = code; return this; },
    json(payload) { this._json = payload; return this; },
    on() {},
  };
}

async function runGuard(req) {
  const res = resStub();
  let nexted = false;
  await patientAccessGuard('PHARMACY_ORDER', { careTeamModeGoverned: true })(
    req, res, () => { nexted = true; },
  );
  return { res, nexted };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID,
  ).catch(() => {});
}

d('PHARMACY_ORDER guard — phone-identified patient (deep, real engine/DB)', () => {
  let prevMode;

  beforeAll(async () => {
    prevMode = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Pharmacy Phone Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, '+919000090012', 'Pharmacy Phone Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, DEFAULT_TENANT_ID, DOCTOR_UID,
    );
  }, 30000);

  afterAll(async () => {
    if (prevMode === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    else process.env.CARE_TEAM_ENFORCEMENT_MODE = prevMode;
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('ENFORCE: a phone-identified order for an unrelated patient is DENIED (403), not 500', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    // 10-digit raw phone — the historical int4-overflow trigger.
    const { res, nexted } = await runGuard(guardReq({ phone: RAW_PHONE }));

    expect(res._status).toBe(403);
    expect(res._status).not.toBe(500);
    expect(nexted).toBe(false);
    // A 403 (not a pass-through) proves the phone resolved to the patient and
    // the engine ran a real relationship check that found none.
    expect(res._json?.code).toBe('PATIENT_ACCESS_DENIED');
  });

  it('ENFORCE: a phone-identified order for a related patient PASSES the guard', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    // Give the caller an active admission relationship to the patient.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, tenant_id, admitting_doctor, attending_doctor, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, 'ADMITTED', NOW(), NOW())`,
      PATIENT_UID, DEFAULT_TENANT_ID, DOCTOR_UID,
    );

    // Send the stored +91 form here to cover that path too.
    const { res, nexted } = await runGuard(guardReq({ phone: PATIENT_PHONE }));

    expect(nexted).toBe(true);
    expect(res._status).toBeNull();
  });
});
