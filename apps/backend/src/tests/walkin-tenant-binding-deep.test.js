// Deep regression test for finding C4 — tenant-isolation hardening on the
// walk-in registration path.
//
//   2026-05-22-cross-tenant-rls-receptionist-0ff7bac5
//
// registerWalkIn used to bind every row it created (users, appointments,
// emergency_visits) to the DB *default* tenant rather than the
// *authenticated* tenant:
//   * the `INSERT INTO users` and `INSERT INTO appointments` statements
//     omitted tenant_id entirely → relied on the column default
//     ('00000000-0000-4000-8000-000000000001');
//   * the `INSERT INTO emergency_visits` read `req.user?.tenantId`
//     (camelCase) which jwtMiddleware never sets — it sets snake_case
//     `tenant_id` — so it was always undefined and fell to the same
//     default.
//
// The fix derives a single `actingTenantId = req.user?.tenant_id || default`
// at the top of the handler and binds it on all three inserts. These tests
// drive the real HTTP surface with a RECEPTIONIST JWT carrying a NON-default
// tenant_id and assert the persisted rows carry THAT tenant — proving the
// inserts bind the authenticated tenant, not the column default.
//
// They also assert the `x-tenant-id` header is NOT trusted: a RECEPTIONIST
// sending a header pointing at a third tenant does not move the row off the
// JWT's tenant (only SUPER_ADMIN + an override-reason can shift req.tenantId,
// and even then the controller binds req.user.tenant_id from the token).
//
// Test-isolation notes mirror walkin-registration-fields.test.js:
//   * appointments.visit_no is globally UNIQUE
//     (`${deptPrefix}-YYYYMMDD-${token}`). The OPD department resolves to a
//     `STAG` prefix no other suite uses; the EMERGENCY walk-in shares the
//     `EMER` prefix so beforeAll pre-seeds a high token for the per-run
//     emergency department string to dodge visit_no collisions.
//   * registerWalkIn normalizes phones to E.164, so cleanup sweeps both the
//     raw and +91 forms plus the per-run department strings.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
// The authenticated (non-default) tenant the JWT will carry.
const ACTING_TENANT_ID = 'c4000000-0000-4000-8000-0000000000a1';
// A third tenant used only as an UNTRUSTED x-tenant-id header value.
const HEADER_TENANT_ID = 'c4000000-0000-4000-8000-0000000000b2';

const STAFF_UID = 'a7777777-7777-4777-8777-77777777fc01';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const OPD_PHONE = `96661${RUN_SUFFIX}`;
const EMER_PHONE = `96662${RUN_SUFFIX}`;
const MINOR_PHONE = `96663${RUN_SUFFIX}`;
const GUARDIAN_PHONE = `96664${RUN_SUFFIX}`;
const HEADER_PHONE = `96665${RUN_SUFFIX}`;
const PHONE_FORMS = [
  OPD_PHONE, `+91${OPD_PHONE}`,
  EMER_PHONE, `+91${EMER_PHONE}`,
  MINOR_PHONE, `+91${MINOR_PHONE}`,
  GUARDIAN_PHONE, `+91${GUARDIAN_PHONE}`,
  HEADER_PHONE, `+91${HEADER_PHONE}`,
];

// `C4Emergency-...` → deptPrefix() substring-matches "emergency" → EMER.
// `C4Reception-...` → no map hit → first-4-alpha fallback → C4RE (STAG-style
// per-run-unique prefix; never collides with another suite).
const EMER_DEPARTMENT = `C4Emergency-${RUN_SUFFIX}`;
const OPD_DEPARTMENT = `C4Reception-${RUN_SUFFIX}`;

async function cleanupFixtures() {
  await prisma
    .$executeRawUnsafe(
      `UPDATE users SET guardian_user_id = NULL
        WHERE phone = ANY($1::text[]) OR guardian_phone = ANY($1::text[])`,
      PHONE_FORMS,
    )
    .catch(() => {});
  const userRows = await prisma
    .$queryRawUnsafe(
      `SELECT id, uid FROM users
        WHERE uid = $1::uuid
           OR phone = ANY($2::text[])
           OR guardian_phone = ANY($2::text[])`,
      STAFF_UID,
      PHONE_FORMS,
    )
    .catch(() => []);
  const userUids = userRows.map((r) => r.uid);
  if (userUids.length > 0) {
    await prisma
      .$executeRawUnsafe(`DELETE FROM emergency_visits WHERE patient_uid = ANY($1::uuid[])`, userUids)
      .catch(() => {});
  }
  // Sweep appointments by per-run department (also catches the pre-seeded
  // high-token row) and by patient phone via the users join above.
  const apptIdRows = await prisma
    .$queryRawUnsafe(
      `SELECT id FROM appointments WHERE department IN ($1, $2)`,
      EMER_DEPARTMENT,
      OPD_DEPARTMENT,
    )
    .catch(() => []);
  const apptIds = apptIdRows.map((r) => r.id);
  if (apptIds.length > 0) {
    await prisma
      .$executeRawUnsafe(`DELETE FROM appointment_status_history WHERE appointment_id = ANY($1::int[])`, apptIds)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM appointments WHERE id = ANY($1::int[])`, apptIds)
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users
        WHERE uid = $1::uuid
           OR phone = ANY($2::text[])
           OR guardian_phone = ANY($2::text[])`,
      STAFF_UID,
      PHONE_FORMS,
    )
    .catch(() => {});
}

describe('POST /appointments/walk-in — C4 binds rows to the authenticated tenant', () => {
  let staffId;
  let staffToken;

  beforeAll(async () => {
    await cleanupFixtures();
    // Seed the non-default acting tenant + the header-target tenant so the
    // FK on users/appointments/emergency_visits.tenant_id → tenants(id) is
    // satisfied for whichever tenant a row binds to.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'c4-acting-${RUN_SUFFIX}', 'C4 Acting Tenant', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      ACTING_TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'c4-header-${RUN_SUFFIX}', 'C4 Header Tenant', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      HEADER_TENANT_ID,
    );

    // Receptionist staff row lives in the acting tenant.
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '9666100099', 'C4 Tenant Staff', 'RECEPTIONIST', true, $2::uuid, NOW())
       RETURNING id`,
      STAFF_UID,
      ACTING_TENANT_ID,
    );
    staffId = rows[0].id;
    // The JWT carries the NON-default tenant_id (snake_case — the field
    // jwtMiddleware actually reads at line 197 / decodes at line 173).
    staffToken = generateTestToken('RECEPTIONIST', {
      uid: STAFF_UID,
      id: staffId,
      tenant_id: ACTING_TENANT_ID,
    });

    // Pre-seed a high token for the per-run emergency department so the
    // EMER-prefixed walk-in lands on a collision-proof visit_no.
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments
         (phone, appointment_date, appointment_time, status, confirmed_at,
          token_number, department, tenant_id, updated_at)
       VALUES ('0000000000', NOW(), 'seed', 'CONFIRMED', NOW(), '910', $1, $2::uuid, NOW())`,
      EMER_DEPARTMENT,
      ACTING_TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma
      .$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, ACTING_TENANT_ID, HEADER_TENANT_ID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('binds the new patient users row + appointment row to the JWT tenant, not the default', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Tenant Bound Patient',
        patient_phone: OPD_PHONE,
        patient_gender: 'F',
        department: OPD_DEPARTMENT,
        reason: 'Walk-in OPD consultation',
        visit_type: 'NEW',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const userRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM users WHERE id = $1`,
      res.body.data.patient_id,
    );
    expect(userRows[0].tenant_id).toBe(ACTING_TENANT_ID);
    expect(userRows[0].tenant_id).not.toBe(DEFAULT_TENANT_ID);

    const apptRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM appointments WHERE id = $1`,
      res.body.data.id,
    );
    expect(apptRows[0].tenant_id).toBe(ACTING_TENANT_ID);
    expect(apptRows[0].tenant_id).not.toBe(DEFAULT_TENANT_ID);
  });

  it('binds the auto-created guardian users row to the JWT tenant (minor walk-in)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Minor Patient',
        patient_phone: MINOR_PHONE,
        patient_gender: 'M',
        // ~5 years old → minor → guardian row is created from guardian_phone.
        date_of_birth: '2021-01-01',
        department: OPD_DEPARTMENT,
        reason: 'Paediatric walk-in',
        visit_type: 'NEW',
        guardian_name: 'Guardian Of Minor',
        guardian_phone: GUARDIAN_PHONE,
        guardian_relationship: 'mother',
        // D74 — minor walk-in now requires guardian legal ID.
        guardian_id_type: 'aadhaar',
        guardian_id: 'XXXX-XXXX-9999',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // The minor's own row binds to the acting tenant...
    const minorRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM users WHERE id = $1`,
      res.body.data.patient_id,
    );
    expect(minorRows[0].tenant_id).toBe(ACTING_TENANT_ID);

    // ...and so does the freshly-minted guardian row (the first
    // `INSERT INTO users` branch). Match on the normalized guardian phone.
    const guardianRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM users
        WHERE phone = $1 OR phone = $2
        ORDER BY id DESC LIMIT 1`,
      `+91${GUARDIAN_PHONE}`,
      GUARDIAN_PHONE,
    );
    expect(guardianRows.length).toBe(1);
    expect(guardianRows[0].tenant_id).toBe(ACTING_TENANT_ID);
    expect(guardianRows[0].tenant_id).not.toBe(DEFAULT_TENANT_ID);
  });

  it('binds the emergency_visits row to the JWT tenant (was the camelCase req.user.tenantId bug)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'ER Tenant Patient',
        patient_phone: EMER_PHONE,
        patient_gender: 'M',
        department: EMER_DEPARTMENT,
        reason: 'Emergency walk-in',
        visit_type: 'EMERGENCY',
        chief_complaint: 'Chest pain',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.er_visit_id).not.toBeNull();

    const evRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM emergency_visits WHERE id = $1`,
      res.body.data.er_visit_id,
    );
    expect(evRows[0].tenant_id).toBe(ACTING_TENANT_ID);
    expect(evRows[0].tenant_id).not.toBe(DEFAULT_TENANT_ID);
  });

  it('ignores an x-tenant-id header — the row binds to the JWT tenant, not the header', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      // Untrusted: a RECEPTIONIST cannot move rows into another tenant by
      // asserting a header. (Only SUPER_ADMIN + an override reason can even
      // shift req.tenantId, and the controller binds req.user.tenant_id
      // from the token regardless.)
      .set('x-tenant-id', HEADER_TENANT_ID)
      .send({
        patient_name: 'Header Ignored Patient',
        patient_phone: HEADER_PHONE,
        patient_gender: 'F',
        department: OPD_DEPARTMENT,
        reason: 'Walk-in OPD consultation',
        visit_type: 'NEW',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const userRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM users WHERE id = $1`,
      res.body.data.patient_id,
    );
    expect(userRows[0].tenant_id).toBe(ACTING_TENANT_ID);
    expect(userRows[0].tenant_id).not.toBe(HEADER_TENANT_ID);

    const apptRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM appointments WHERE id = $1`,
      res.body.data.id,
    );
    expect(apptRows[0].tenant_id).toBe(ACTING_TENANT_ID);
    expect(apptRows[0].tenant_id).not.toBe(HEADER_TENANT_ID);
  });
});
