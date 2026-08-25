// Owner decision, 2026-08-25 — administrators may print a patient wristband
// without break-glass, and the print is recorded for audit.
//
//   "Yes administrator should be able to print a wristband without
//    break-glass, but such an action should be noted in logs for future audit
//    if needed."
//
// This suite is the proof for BOTH halves, against the real database:
//
//   1. ADMIN and SUPER_ADMIN get the band (JSON and printable HTML) with no
//      break-glass session, and each print leaves an administrative-access
//      record in patient_access_audit_log AND audit_logs.
//   2. A relationship-backed nursing print still succeeds and is NOT labelled
//      administrative in either sink.
//   3. A staff role that is neither an administrator nor related to the
//      patient is still refused — both a role that never has a bedside
//      relationship (OT_NURSE) and a nurse against a patient with no
//      admission.
//   4. THE SCOPE PROOF. PATIENT_CLINICAL_WORKFLOW_ACCESS — the policy the
//      wristband route used to share with 27 other clinical surfaces — is
//      unchanged: an administrator is still refused on
//      GET /api/v1/allergies/patient/:patientUid/unified, which runs the same
//      legacy always-enforce guard on that policy, for the SAME patient, in
//      the SAME session that just printed the band.
//
// Test 4 is the one that would catch a leak. If someone "simplifies" the grant
// by adding PATIENT_CLINICAL_WORKFLOW_ACCESS to the administrative set or to
// OPERATIONAL_ROLE_POLICIES, the wristband tests keep passing and this one
// turns red.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import {
  ACCESS_POLICY_CODES,
  administrativeGrantForPolicy,
  ADMINISTRATIVE_ACCESS_GRANTS,
} from '../services/security/accessDecisionService.js';
import { getAccessPolicy, ACCESS_POLICIES } from '../services/security/accessPolicyRegistry.js';
import { WRISTBAND_ADMIN_AUDIT_ACTION } from '../routes/clinical/bcmaRoutes.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TAG = 'WBADMTEST';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');

const NURSE_UID = 'aa000001-1111-4111-8111-aa0000000001';
const ADMIN_UID = 'aa000002-1111-4111-8111-aa0000000002';
const SUPER_ADMIN_UID = 'aa000003-1111-4111-8111-aa0000000003';
const OT_NURSE_UID = 'aa000004-1111-4111-8111-aa0000000004';

let admittedPatientUid;
let unadmittedPatientUid;

const client = (role, uid) => {
  const token = generateTestToken(role, { uid });
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
};

const nurse = () => client('NURSING_STAFF', NURSE_UID);
const admin = () => client('ADMIN', ADMIN_UID);
const superAdmin = () => client('SUPER_ADMIN', SUPER_ADMIN_UID);
const otNurse = () => client('OT_NURSE', OT_NURSE_UID);

async function accessRowsFor(patientUid, actorUid) {
  return prisma.$queryRawUnsafe(
    `SELECT actor_uid::text AS actor_uid, actor_role, access_decision, access_source,
            reason, route, action, tenant_id::text AS tenant_id, created_at, metadata
       FROM patient_access_audit_log
      WHERE patient_uid = $1::uuid
        AND ($2::uuid IS NULL OR actor_uid = $2::uuid)
      ORDER BY id ASC`,
    patientUid,
    actorUid ?? null,
  );
}

async function adminActionRowsFor(patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT uid::text AS uid, actor_uid::text AS actor_uid, role, action, resource,
            resource_id, tenant_id::text AS tenant_id, created_at, metadata
       FROM audit_logs
      WHERE action = $1
        AND metadata->>'patient_uid' = $2
      ORDER BY id ASC`,
    WRISTBAND_ADMIN_AUDIT_ACTION,
    patientUid,
  );
}

// The audit_logs write goes through logAudit(), which is awaited by the route,
// so the row is durable by the time the response lands. patient_access_audit_log
// is likewise awaited inside the guard. Neither sink is deferred, so no polling
// is needed — a missing row here is a real missing row, not a race.

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log
      WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE '${TAG}%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE action = $1`,
    WRISTBAND_ADMIN_AUDIT_ACTION,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM hipaa_access_log
      WHERE patient_id IN (SELECT uid::text FROM users WHERE name LIKE '${TAG}%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE ward = '${TAG} Ward'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE '${TAG}%'`).catch(() => {});
}

d('BCMA wristband — administrator grant + audit (owner decision 2026-08-25)', () => {
  beforeAll(async () => {
    await cleanup();

    const admitted = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, birthday, gender, blood_group, updated_at)
       VALUES ($1, '${TAG} Admitted Patient', 'PATIENT', true, '1979-03-03', 'female', 'O+', NOW())
       RETURNING uid`,
      `+9198801${SUFFIX}`,
    );
    admittedPatientUid = admitted[0].uid;

    const unadmitted = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, birthday, gender, updated_at)
       VALUES ($1, '${TAG} Outpatient', 'PATIENT', true, '1990-09-09', 'male', NOW())
       RETURNING uid`,
      `+9198802${SUFFIX}`,
    );
    unadmittedPatientUid = unadmitted[0].uid;

    const staff = [
      [NURSE_UID, `${TAG} Nurse`, 'NURSING_STAFF', `+9198803${SUFFIX}`],
      [ADMIN_UID, `${TAG} Admin`, 'ADMIN', `+9198804${SUFFIX}`],
      [SUPER_ADMIN_UID, `${TAG} Super Admin`, 'SUPER_ADMIN', `+9198805${SUFFIX}`],
      [OT_NURSE_UID, `${TAG} OT Nurse`, 'OT_NURSE', `+9198806${SUFFIX}`],
    ];
    for (const [uid, name, role, phone] of staff) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, $4, true, NOW())
         ON CONFLICT (uid) DO NOTHING`,
        uid, phone, name, role,
      );
    }

    // Active admission — the ONLY care relationship in this fixture. It gives
    // the nursing roles an `admission` link to the admitted patient and gives
    // nobody else anything: no care-team row, no referral, no appointment, no
    // authored clinical material, and no break-glass session anywhere.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, allergies, status, admitted_at, ward, bed_number, created_by, created_at, updated_at)
       VALUES ($1::uuid, '{}', 'admitted', NOW(), '${TAG} Ward', 'WB-01', $2::uuid, NOW(), NOW())`,
      admittedPatientUid, NURSE_UID,
    );
    // Explicit hook budget: fixture setup and teardown touch six tables on a
    // possibly-cold connection and legitimately exceed jest's 5s hook default.
    // A blown hook fails the SUITE while every test still reports passed —
    // exactly the misleading 'Suites failed / Tests passed' shape — so the
    // budget is stated rather than left to chance.
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 120000);

  // -------------------------------------------------------------------------
  // Registry / grant shape — pins the blast radius without touching the DB.
  // -------------------------------------------------------------------------

  test('the administrative grant is keyed on the wristband policy alone', () => {
    const wristband = getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT);
    expect(wristband).toBeTruthy();
    expect(wristband.code).toBe('patient.wristband.print');
    expect(wristband.required_phi_level).toBe('patient_relationship_required');

    // Exactly the two administrator roles, on exactly this one policy.
    for (const role of ['ADMIN', 'SUPER_ADMIN']) {
      expect(administrativeGrantForPolicy(role, wristband))
        .toBe(ADMINISTRATIVE_ACCESS_GRANTS.ADMINISTRATOR_NO_RELATIONSHIP);
    }
    for (const role of ['NURSING_STAFF', 'DOCTOR', 'OT_NURSE', 'CMO', 'MEDICAL_SUPERINTENDENT', 'PATIENT', '']) {
      expect(administrativeGrantForPolicy(role, wristband)).toBeNull();
    }

    // No OTHER registered policy grants an administrator relationship-free
    // access — above all not the 27-site clinical-workflow policy.
    for (const [code, policy] of Object.entries(ACCESS_POLICIES)) {
      if (code === ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT) continue;
      expect(administrativeGrantForPolicy('ADMIN', policy)).toBeNull();
      expect(administrativeGrantForPolicy('SUPER_ADMIN', policy)).toBeNull();
    }
    expect(administrativeGrantForPolicy(
      'ADMIN',
      getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS),
    )).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 1. Administrators print, without break-glass, and it is audited.
  // -------------------------------------------------------------------------

  test('ADMIN prints the band without break-glass and the print is audited in both sinks', async () => {
    const before = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_access_break_glass WHERE patient_uid = $1::uuid`,
      admittedPatientUid,
    );
    expect(before[0].n).toBe(0); // no break-glass session exists — the grant is doing the work

    const json = await admin().get(`/api/v1/bcma/wristband/${admittedPatientUid}`);
    expect(json.status).toBe(200);
    expect(json.body.data.barcode_payload).toBe(admittedPatientUid);
    expect(json.body.data.patient.name).toBe(`${TAG} Admitted Patient`);

    const html = await admin().get(`/api/v1/bcma/wristband/${admittedPatientUid}?format=html`);
    expect(html.status).toBe(200);
    expect(html.text).toContain(`${TAG} Admitted Patient`);

    // Sink 1 — patient_access_audit_log. Automatic, append-only, one row per
    // guard evaluation. Every allow for this actor is administrative.
    const accessRows = await accessRowsFor(admittedPatientUid, ADMIN_UID);
    const allows = accessRows.filter((r) => r.access_decision === 'allow');
    // Exactly one decision row per request. The /api/v1/bcma MOUNT also carries
    // a patientAccessGuard, but at mount time Express has not matched the route
    // yet, so `:patientUid` is not in req.params and the guard short-circuits on
    // no_patient_context without evaluating a policy or writing a row. The
    // route's own guard is the only one that decides this request. If that ever
    // changes, this count goes to 4 and this line says so.
    expect(allows).toHaveLength(2);
    for (const row of allows) {
      expect(row.actor_role).toBe('ADMIN');
      expect(row.actor_uid).toBe(ADMIN_UID);
      expect(row.tenant_id).toBeTruthy();
      expect(row.created_at).toBeTruthy();
      expect(row.route).toContain(`/api/v1/bcma/wristband/${admittedPatientUid}`);
      expect(row.metadata.policy_code).toBe(ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT);
      expect(row.metadata.administrative_access).toBe(true);
      expect(row.metadata.administrative_grant)
        .toBe(ADMINISTRATIVE_ACCESS_GRANTS.ADMINISTRATOR_NO_RELATIONSHIP);
      // Not a break-glass allow.
      expect(row.access_decision).not.toBe('break_glass');
      expect(row.access_source).not.toBe('break_glass');
    }

    // Sink 2 — audit_logs, the administrative-action sink with a REST reader.
    const actionRows = await adminActionRowsFor(admittedPatientUid);
    const adminActions = actionRows.filter((r) => r.actor_uid === ADMIN_UID);
    expect(adminActions.length).toBe(2); // one JSON print, one HTML print
    for (const row of adminActions) {
      expect(row.role).toBe('ADMIN');
      expect(row.uid).toBe(ADMIN_UID);
      expect(row.resource).toBe('patient_wristband');
      expect(row.resource_id).toBe(admittedPatientUid);
      expect(row.tenant_id).toBeTruthy();
      expect(row.created_at).toBeTruthy();
      expect(row.metadata.patient_uid).toBe(admittedPatientUid);
      expect(row.metadata.care_relationship).toBe('none');
      expect(row.metadata.break_glass).toBe(false);
      expect(row.metadata.discloses_patient_name).toBe(true);
      expect(row.metadata.administrative_grant)
        .toBe(ADMINISTRATIVE_ACCESS_GRANTS.ADMINISTRATOR_NO_RELATIONSHIP);
      expect(row.metadata.policy_code).toBe(ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT);
      expect(row.metadata.actor_raw_role).toBe('ADMIN');
      expect(row.metadata.tenant_id).toBeTruthy();
      expect(row.metadata.occurred_at).toBeTruthy();
    }
    expect(adminActions.map((r) => r.metadata.format).sort())
      .toEqual(['json', 'printable_html']);
  });

  test('SUPER_ADMIN prints the band without break-glass and is audited the same way', async () => {
    const res = await superAdmin().get(`/api/v1/bcma/wristband/${admittedPatientUid}`);
    expect(res.status).toBe(200);
    expect(res.body.data.barcode_payload).toBe(admittedPatientUid);

    const allows = (await accessRowsFor(admittedPatientUid, SUPER_ADMIN_UID))
      .filter((r) => r.access_decision === 'allow');
    expect(allows.length).toBeGreaterThan(0);
    for (const row of allows) {
      // jwtMiddleware canonicalises SUPER_ADMIN → ADMIN on req.user.role
      // (utils/roles.js#canonicalizeRequestRole), so every audit column that
      // reads req.user.role says ADMIN. The actor_uid is the identity that
      // matters, and the route's own audit row carries the raw role below.
      expect(row.actor_role).toBe('ADMIN');
      expect(row.actor_uid).toBe(SUPER_ADMIN_UID);
      expect(row.metadata.administrative_access).toBe(true);
      expect(row.metadata.policy_code).toBe(ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT);
    }

    const actions = (await adminActionRowsFor(admittedPatientUid))
      .filter((r) => r.actor_uid === SUPER_ADMIN_UID);
    expect(actions.length).toBe(1);
    expect(actions[0].metadata.actor_raw_role).toBe('SUPER_ADMIN');
    expect(actions[0].metadata.care_relationship).toBe('none');
    expect(actions[0].resource).toBe('patient_wristband');
  });

  test('the administrative print is queryable as such — the compliance query returns it', async () => {
    // The exact shape a compliance reviewer would run: "which administrators
    // read a patient with no care relationship, and when".
    const rows = await prisma.$queryRawUnsafe(
      `SELECT actor_uid::text AS actor_uid, actor_role, patient_uid::text AS patient_uid,
              tenant_id::text AS tenant_id, created_at
         FROM patient_access_audit_log
        WHERE metadata->>'administrative_access' = 'true'
          AND patient_uid = $1::uuid
        ORDER BY created_at ASC`,
      admittedPatientUid,
    );
    expect(rows.length).toBeGreaterThan(0);
    const actors = new Set(rows.map((r) => r.actor_uid));
    expect(actors.has(ADMIN_UID)).toBe(true);
    expect(actors.has(SUPER_ADMIN_UID)).toBe(true);
    expect(actors.has(NURSE_UID)).toBe(false);
    for (const row of rows) {
      expect(row.patient_uid).toBe(admittedPatientUid);
      expect(row.tenant_id).toBeTruthy();
      expect(row.created_at).toBeInstanceOf(Date);
    }
  });

  // -------------------------------------------------------------------------
  // 2. The bedside path is unchanged and is NOT labelled administrative.
  // -------------------------------------------------------------------------

  test('a nursing print still succeeds and is NOT recorded as administrative access', async () => {
    const json = await nurse().get(`/api/v1/bcma/wristband/${admittedPatientUid}`);
    expect(json.status).toBe(200);
    expect(json.body.data.barcode_payload).toBe(admittedPatientUid);
    expect(json.body.data.allergies_status).toBe('ok');

    const html = await nurse().get(`/api/v1/bcma/wristband/${admittedPatientUid}?format=html`);
    expect(html.status).toBe(200);
    expect(html.text).toContain('<svg');
    expect(html.text).toContain(`${TAG} Admitted Patient`);

    const allows = (await accessRowsFor(admittedPatientUid, NURSE_UID))
      .filter((r) => r.access_decision === 'allow');
    expect(allows.length).toBeGreaterThan(0);
    for (const row of allows) {
      expect(row.actor_role).toBe('NURSING_STAFF');
      // Attributed to the real care relationship, not to any role grant.
      expect(row.access_source).toBe('admission');
      expect(row.metadata.administrative_access).toBe(false);
      expect(row.metadata.administrative_grant).toBeNull();
    }

    // And nothing landed in the administrative-action sink for the nurse.
    const actions = (await adminActionRowsFor(admittedPatientUid))
      .filter((r) => r.actor_uid === NURSE_UID);
    expect(actions).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Everyone else with no relationship is still refused.
  // -------------------------------------------------------------------------

  test('a staff role that is neither administrator nor related is still refused', async () => {
    // OT_NURSE clears the mount RBAC, the PHI-level bar and the capability
    // group (theatre) — so the refusal comes from the relationship layer,
    // which is the layer the owner decision did NOT change.
    const res = await otNurse().get(`/api/v1/bcma/wristband/${admittedPatientUid}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_ACCESS_DENIED');
    expect(res.body.policy_code).toBe(ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT);

    const denies = (await accessRowsFor(admittedPatientUid, OT_NURSE_UID))
      .filter((r) => r.access_decision === 'deny');
    expect(denies.length).toBeGreaterThan(0);
    for (const row of denies) {
      expect(row.metadata.administrative_access).toBe(false);
    }
    const actions = (await adminActionRowsFor(admittedPatientUid))
      .filter((r) => r.actor_uid === OT_NURSE_UID);
    expect(actions).toHaveLength(0);
  });

  test('a nurse is still refused for a patient she has no admission to', async () => {
    const res = await nurse().get(`/api/v1/bcma/wristband/${unadmittedPatientUid}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_ACCESS_DENIED');

    const actions = (await adminActionRowsFor(unadmittedPatientUid));
    expect(actions).toHaveLength(0);
  });

  test('an administrator reaches an unadmitted patient too — the grant is not admission-scoped, and it is still audited', async () => {
    const res = await admin().get(`/api/v1/bcma/wristband/${unadmittedPatientUid}`);
    expect(res.status).toBe(200);

    const allows = (await accessRowsFor(unadmittedPatientUid, ADMIN_UID))
      .filter((r) => r.access_decision === 'allow');
    expect(allows.length).toBeGreaterThan(0);
    for (const row of allows) {
      expect(row.metadata.administrative_access).toBe(true);
    }
    const actions = await adminActionRowsFor(unadmittedPatientUid);
    expect(actions.length).toBe(1);
    expect(actions[0].actor_uid).toBe(ADMIN_UID);
  });

  // -------------------------------------------------------------------------
  // 4. THE SCOPE PROOF — PATIENT_CLINICAL_WORKFLOW_ACCESS is untouched.
  // -------------------------------------------------------------------------

  test('PATIENT_CLINICAL_WORKFLOW_ACCESS is unchanged — an administrator is still refused on a route that uses it', async () => {
    // Same mount role set (CLINICAL_STAFF_ROLES), same always-enforce legacy
    // guard style, same patient, same administrator session that just printed
    // a band two tests ago. The only difference is the policy code.
    const adminAllergies = await admin()
      .get(`/api/v1/allergies/patient/${admittedPatientUid}/unified`);
    expect(adminAllergies.status).toBe(403);
    expect(adminAllergies.body.code).toBe('PATIENT_ACCESS_DENIED');
    expect(adminAllergies.body.policy_code)
      .toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);

    const superAdminAllergies = await superAdmin()
      .get(`/api/v1/allergies/patient/${admittedPatientUid}/unified`);
    expect(superAdminAllergies.status).toBe(403);
    expect(superAdminAllergies.body.policy_code)
      .toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);

    // …while the nurse, whose relationship is what that policy asks for, is
    // still allowed there. The policy did not get stricter either.
    const nurseAllergies = await nurse()
      .get(`/api/v1/allergies/patient/${admittedPatientUid}/unified`);
    expect(nurseAllergies.status).toBe(200);

    // The refused administrative reads produced deny rows, never an
    // administrative-access label.
    const clinicalRows = (await accessRowsFor(admittedPatientUid, ADMIN_UID))
      .filter((r) => r.metadata.policy_code === ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
    expect(clinicalRows.length).toBeGreaterThan(0);
    for (const row of clinicalRows) {
      expect(row.access_decision).toBe('deny');
      expect(row.metadata.administrative_access).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 5. The decision must also hold on a tenant that ENFORCES care-team ABAC.
  // -------------------------------------------------------------------------

  test('the grant survives care_team_enforcement_mode=enforce on the whole chain', async () => {
    // The /api/v1/bcma mount runs a SECOND, care-team-mode-governed guard whose
    // default mode is shadow, so every test above ran with that guard passive.
    // It stays passive under 'enforce' too — it has no patient context at mount
    // time (see the count assertion in the ADMIN test) — but "should be inert"
    // is a claim about a PHI gate, and a claim about a PHI gate is worth an
    // assertion rather than a comment. Flip the deployment-wide mode to
    // 'enforce' and re-run the four outcomes end to end.
    const previous = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    try {
      const adminBand = await admin().get(`/api/v1/bcma/wristband/${admittedPatientUid}`);
      expect(adminBand.status).toBe(200);

      const nurseBand = await nurse().get(`/api/v1/bcma/wristband/${admittedPatientUid}`);
      expect(nurseBand.status).toBe(200);

      const otBand = await otNurse().get(`/api/v1/bcma/wristband/${admittedPatientUid}`);
      expect(otBand.status).toBe(403);

      // …and the clinical-workflow policy still refuses the administrator when
      // the tenant enforces, exactly as it does in shadow.
      const adminAllergies = await admin()
        .get(`/api/v1/allergies/patient/${admittedPatientUid}/unified`);
      expect(adminAllergies.status).toBe(403);
      expect(adminAllergies.body.policy_code)
        .toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
    } finally {
      if (previous === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
      else process.env.CARE_TEAM_ENFORCEMENT_MODE = previous;
    }
  });
});
