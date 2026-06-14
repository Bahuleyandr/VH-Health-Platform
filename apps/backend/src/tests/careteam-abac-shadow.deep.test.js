// CareTeam ABAC Phase 0–1 — deep integration against the REAL engine + DB.
//
// Proves, end to end (real accessDecisionService, real patient_access_audit_log,
// real per-tenant mode resolver against the default tenant, which has no
// care_team_enforcement_mode set and therefore resolves to the platform default
// 'shadow'):
//
//   1. SHADOW NON-BREAKING: an unrelated clinician hitting a care-team-governed
//      guard on a previously-audit-only family (DIALYSIS) is ALLOWED (next()
//      called, no 403, no throw) AND a 'deny' decision is recorded with
//      shadow_mode=true. This is the core "shadow logs would-be denials but
//      never blocks a PHI route" guarantee, verified against the real DB.
//   2. PHASE 1 HOOK: populateAdmissionCareTeam materialises the admitting +
//      attending doctor as active care_team_members (idempotently), after which
//      the engine recognises the care-team relationship (allow, source
//      'care_team').
//
// Enforce-mode 403 and mode resolution from tenant settings are covered
// deterministically by the unit suites (careTeamEnforcement-guard.test.js,
// careTeamEnforcement.test.js); they are not re-asserted here because the
// 60s getTenantById cache makes an in-process mode flip non-deterministic.

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { patientAccessGuard } from '../middleware/phiAccessMiddleware.js';
import { populateAdmissionCareTeam } from '../services/security/careTeamPopulationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_UID = `ab100000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DOCTOR_UID = `ab200000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const ATTENDING_UID = `ab300000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_PHONE = `+9198001${SUFFIX}`;
const DOCTOR_PHONE = `+9198002${SUFFIX}`;
const ATTENDING_PHONE = `+9198003${SUFFIX}`;

let admissionId;

function reqFor() {
  return {
    id: `abac-${SUFFIX}`,
    method: 'GET',
    originalUrl: `/api/v1/dialysis?patient_uid=${PATIENT_UID}`,
    params: {},
    query: { patient_uid: PATIENT_UID },
    body: {},
    tenantId: DEFAULT_TENANT_ID,
    user: { id: 0, uid: DOCTOR_UID, role: 'DOCTOR', tenant_id: DEFAULT_TENANT_ID },
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

async function latestAuditRow() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT access_decision, access_source, metadata
       FROM patient_access_audit_log
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY id DESC
      LIMIT 1`,
    DEFAULT_TENANT_ID,
    PATIENT_UID,
  );
  return rows[0] || null;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_team_members WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_teams WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID, DOCTOR_UID, ATTENDING_UID,
  ).catch(() => {});
}

d('CareTeam ABAC — shadow + admission hook (deep, real engine/DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'ABAC Patient [test]', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, DEFAULT_TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'ABAC Doctor [test]', 'DOCTOR', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'ABAC Attending [test]', 'DOCTOR', true, $3::uuid, NOW())`,
      DOCTOR_UID, DOCTOR_PHONE, DEFAULT_TENANT_ID, ATTENDING_UID, ATTENDING_PHONE,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('SHADOW (default): an unrelated doctor is allowed through a governed guard, but a deny is audited', async () => {
    // DEFAULT_TENANT has no care_team_enforcement_mode set → resolver default is
    // 'shadow'. The doctor has NO relationship to the patient → would-be deny.
    const req = reqFor();
    const res = resStub();
    let nexted = false;

    await patientAccessGuard('DIALYSIS', { careTeamModeGoverned: true })(req, res, () => { nexted = true; });

    // Non-breaking: request proceeds, no 403 / no 500.
    expect(nexted).toBe(true);
    expect(res._status).toBeNull();

    // But the would-be denial is recorded with shadow_mode=true.
    const audit = await latestAuditRow();
    expect(audit).toBeTruthy();
    expect(audit.access_decision).toBe('deny');
    const metadata = typeof audit.metadata === 'string' ? JSON.parse(audit.metadata) : audit.metadata;
    expect(metadata.shadow_mode).toBe(true);
  });

  it('PHASE 1 HOOK: populateAdmissionCareTeam makes the engine recognise the care-team relationship', async () => {
    const adm = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (patient_uid, tenant_id, admitting_doctor, attending_doctor, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ADMITTED', NOW(), NOW())
       RETURNING id`,
      PATIENT_UID, DEFAULT_TENANT_ID, DOCTOR_UID, ATTENDING_UID,
    );
    admissionId = adm[0].id;

    const result = await populateAdmissionCareTeam({
      id: admissionId,
      tenant_id: DEFAULT_TENANT_ID,
      patient_uid: PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      attending_doctor: ATTENDING_UID,
      created_by: DOCTOR_UID,
    });
    expect(result.careTeamId).toBeTruthy();
    expect(result.membersAttempted).toBe(2);

    const members = await prisma.$queryRawUnsafe(
      `SELECT staff_uid::text AS staff_uid, relationship_kind
         FROM care_team_members
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status = 'active'`,
      DEFAULT_TENANT_ID, PATIENT_UID,
    );
    const uids = members.map((m) => m.staff_uid);
    expect(uids).toContain(DOCTOR_UID);
    expect(uids).toContain(ATTENDING_UID);

    // Idempotent: a second call adds no new active members.
    const again = await populateAdmissionCareTeam({
      id: admissionId,
      tenant_id: DEFAULT_TENANT_ID,
      patient_uid: PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      attending_doctor: ATTENDING_UID,
      created_by: DOCTOR_UID,
    });
    expect(again.careTeamId).toBe(result.careTeamId);
    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM care_team_members
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status = 'active'`,
      DEFAULT_TENANT_ID, PATIENT_UID,
    );
    expect(countRows[0].n).toBe(2);

    // Now the engine allows the doctor via the care-team relationship.
    const req = reqFor();
    const res = resStub();
    let nexted = false;
    await patientAccessGuard('DIALYSIS', { careTeamModeGoverned: true })(req, res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res._status).toBeNull();

    const audit = await latestAuditRow();
    expect(audit.access_decision).toBe('allow');
    expect(audit.access_source).toBe('care_team');
  });
});
