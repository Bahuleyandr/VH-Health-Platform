// Journey: cross-tenant-rls (swarm journey #1) — deterministic in-CI replacement.
//
// The multi-tenant isolation journey. Where the other ten journeys prove ONE
// hospital's workflow works, this proves that TWO hospitals (tenants) sharing
// the platform can never see each other's PHI. Flow through the REAL API
// surface + the DB-layer RLS policies (migration 075/236/272/304):
//   1. A receptionist authenticated to tenant A registers a walk-in OPD
//      patient — and every row created (the patient users row + the
//      appointment) binds to the receptionist's AUTHENTICATED tenant, NOT the
//      column default and NOT a spoofed x-tenant-id header
//      (finding: 2026-05-22-cross-tenant-rls-receptionist-0ff7bac5).
//   2. A receptionist authenticated to tenant B registers their own walk-in,
//      so each tenant has exactly one appointment under its own department.
//   3. HTTP isolation: the tenant-B admin cannot read tenant-A's appointment
//      via GET /api/v1/appointments/list (and vice versa); each admin still
//      sees its OWN rows (isolation, not an outage).
//   4. DB-layer isolation: a tenant-scoped raw read (setTenantTx, the primitive
//      the request path funnels through) returns only the scoped tenant's
//      appointment — with a NON-VACUOUS control proving a bare, unscoped tx
//      still sees BOTH rows, so a regression that stops scoping fails loudly.
//   5. DB-layer write guard: an INSERT scoped to tenant A that tries to plant a
//      row under tenant B is rejected by the RLS WITH CHECK; a cross-tenant
//      UPDATE matches zero rows (RLS USING hides the target).
//
// Assertions: walk-in tenant binding (authenticated tenant, not default, not
// header), symmetric cross-tenant HTTP denial + same-tenant visibility, the
// tenant_isolation read policy (scoped + bypass), and the WITH CHECK / USING
// write guards.
//
// Determinism: Postgres exempts SUPERUSER / table-owner roles from RLS, so CI
// (connects as a cluster superuser) and local QA (qa_writer) would BOTH bypass
// the policy and make every assertion vacuous. To make enforcement real and
// identical in both environments this suite — exactly like the sibling
// tenant-rls *deep* tests — turns AUTH_ENFORCE_TENANT_RLS on and points
// AUTH_TENANT_RLS_RUNTIME_ROLE at a seeded non-owner, NOBYPASSRLS app role for
// the duration of the suite (restored in afterAll). Every fixture id is
// namespaced per run; both tenants are seeded explicitly; no time-of-day
// dependence.

import request from 'supertest';
import app from '../../app.js';
import { generateToken } from '../../utils/jwtUtils.js';
import {
  describeJourney,
  runSuffix,
  cleanupJourney,
  uidForUserId,
  prisma,
  API_KEY,
  DEFAULT_TENANT,
} from './_journeyHarness.js';
import { setTenantTx } from '../../lib/prisma.js';
import { runInTenantContext } from '../../lib/tenantContext.js';
import { waitForAuditLogDrain } from '../../middleware/auditLog.js';
import { deleteWithAuditBypass } from '../helpers/auditBypass.js';

const RUN = runSuffix();
// Two distinct, per-run tenants (never the DB default — the point is to prove
// rows do NOT fall back to it). A third tenant exists only as an UNTRUSTED
// x-tenant-id header value a receptionist must not be able to write into.
const TENANT_A = `c1a00000-0000-4000-8000-${RUN.padStart(12, '0')}`;
const TENANT_B = `c1b00000-0000-4000-8000-${RUN.padStart(12, '0')}`;
const HEADER_TENANT = `c1c00000-0000-4000-8000-${RUN.padStart(12, '0')}`;

const RECEP_A_UID = `c1000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEP_B_UID = `c1000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ADMIN_A_UID = `c1000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ADMIN_B_UID = `c1000004-0000-4000-8000-${RUN.padStart(12, '0')}`;

// Department names MUST yield DISTINCT visit_no prefixes. registerWalkIn
// composes visit_no as `${deptPrefix(department)}-YYYYMMDD-${token}` and
// appointments.visit_no carries a GLOBAL (not tenant-scoped) unique index
// (idx_appointments_visit_no_unique). deptPrefix() falls back to the first 4
// alpha chars uppercased for unrecognised departments, so e.g. "JXTenantA" and
// "JXTenantB" BOTH collapse to "JXTE" → both walk-ins compose
// "JXTE-YYYYMMDD-001" (each tenant's RLS-scoped token counter sees only its own
// rows, so both pick token 1) → the second INSERT trips the global unique
// constraint and 500s. Prefix the distinguishing letter into the first 4 chars
// (AX / BX) so the two tenants' appointments get distinct visit_no.
const DEPT_A = `AX-RLS-${RUN}`;
const DEPT_B = `BX-RLS-${RUN}`;
const PATIENT_A_PHONE = `96701${RUN}`;
const PATIENT_B_PHONE = `96702${RUN}`;
const RECEP_A_PHONE = `96703${RUN}`;
const RECEP_B_PHONE = `96704${RUN}`;
const ADMIN_A_PHONE = `96705${RUN}`;
const ADMIN_B_PHONE = `96706${RUN}`;
// The phone the Step-1 header-spoof patient is registered under. Named here so
// both cleanups sweep it — its in-test sweep is skipped if an assertion throws
// first, so otherwise the auto-created PATIENT row would orphan across runs.
const HEADER_SPOOF_PHONE = `96707${RUN}`;

// Non-owner, NOBYPASSRLS role the suite SET LOCAL ROLEs into so RLS actually
// fires under a superuser/owner connection. Same proven, tolerant seed pattern
// as tenant-rls-http.deep.test.js / tenant-rls-interactive-tx.deep.test.js.
const APP_ROLE = 'rls_journey_test_app';

// JWT bound to a specific tenant. The harness roleClient ONLY forwards
// uid/id/phone into generateTestToken — NOT tenant_id (see _journeyHarness.js
// roleClient signature `{ uid, id, phone }`). So a tenant_id passed through
// roleClient is silently dropped, the JWT carries no tenant claim, and
// jwtMiddleware leaves req.user.tenant_id null. registerWalkIn reads
// req.user?.tenant_id directly and falls back to the DB default — which made
// every walk-in here bind to DEFAULT_TENANT instead of TENANT_A/B. To bind the
// authenticated tenant we mint the tenant-bearing token directly via the same
// util the harness uses underneath (generateToken puts tenant_id in the JWT;
// jwtMiddleware reads it into req.user.tenant_id). Mirrors the green
// tenant-rls-http.deep.test.js, which mints its admin tokens the same way.
function adminClientForTenant(uid, tenantId) {
  const token = generateToken({ uid, role: 'ADMIN', tenant_id: tenantId, type: 'admin' });
  const auth = (req) => req.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  return { get: (p) => auth(request(app).get(p)) };
}

// Receptionist client bound to a specific tenant. id carries the seeded
// users.id (so logAudit / status-history int FKs line up); tenant_id makes the
// walk-in controller stamp the authenticated tenant on every row it creates.
function recepClientForTenant({ uid, id, phone, tenantId }) {
  const token = generateToken({
    uid, id, phone, role: 'RECEPTIONIST', tenant_id: tenantId,
    // Clinical-write routes 403 without a deviceType claim (phone-mode gate);
    // walk-in isn't gated, but stay consistent with the harness default.
    deviceType: 'desktop',
  });
  const auth = (req) => req.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  return { post: (p) => auth(request(app).post(p)) };
}

describeJourney('Journey: cross-tenant-rls', () => {
  let savedEnforceFlag;
  let savedRuntimeRole;

  let recepA;
  let recepB;
  let adminA;
  let adminB;

  let patientAId;
  let patientAUid;
  let appointmentAId;
  let patientBId;
  let patientBUid;
  let appointmentBId;

  async function cleanupTenants() {
    // The shared harness cleanup doesn't touch the tenants table; sweep our
    // three per-run tenant rows after their children are gone. The walk-in
    // path writes hipaa_access_log and universal audit_log rows, while the admin
    // x-tenant-id override path can write audit_logs rows; all FK->tenants —
    // clear them first so the tenant DELETE doesn't FK-fail and orphan the
    // per-run tenant rows. Best-effort; per-run namespacing keeps stale rows
    // from ever colliding with a future run regardless.
    await waitForAuditLogDrain();
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM audit_log WHERE tenant_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      TENANT_A, TENANT_B, HEADER_TENANT,
    ).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM audit_logs WHERE tenant_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      TENANT_A, TENANT_B, HEADER_TENANT,
    ).catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM hipaa_access_log WHERE tenant_id IN ($1::uuid, $2::uuid, $3::uuid)`,
        TENANT_A, TENANT_B, HEADER_TENANT,
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`,
        TENANT_A, TENANT_B, HEADER_TENANT,
      );
  }

  beforeAll(async () => {
    savedEnforceFlag = process.env.AUTH_ENFORCE_TENANT_RLS;
    savedRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;

    await cleanupJourney({
      patientUids: [],
      staffUids: [RECEP_A_UID, RECEP_B_UID, ADMIN_A_UID, ADMIN_B_UID],
      phones: [PATIENT_A_PHONE, PATIENT_B_PHONE, RECEP_A_PHONE, RECEP_B_PHONE, ADMIN_A_PHONE, ADMIN_B_PHONE, HEADER_SPOOF_PHONE],
      departments: [DEPT_A, DEPT_B],
    });
    await cleanupTenants();

    // Seed the non-owner app role with the grants the request path + the raw
    // assertions need. Tolerant: on local QA (qa_writer, not a superuser) the
    // role is expected to already exist (qa-cluster-up seeds it / seed once as
    // postgres); we only throw if it is genuinely missing AND uncreatable.
    try {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
            CREATE ROLE ${APP_ROLE} NOLOGIN;
            ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$;
      `);
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
      // The full walk-in + list path touches many tables; grant broadly so the
      // scoped role can execute it. Tolerant of pgvector-less clusters that
      // throw resolving vector-typed columns mid-grant.
      await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`).catch(() => {});
      await prisma.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`).catch(() => {});
      // Let the connecting role SET LOCAL ROLE into APP_ROLE. Skip the grant
      // when membership already exists (a redundant GRANT from a non-admin
      // role errors loudly).
      const member = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles g ON g.oid = m.member
          WHERE r.rolname = $1 AND g.rolname = current_user LIMIT 1`,
        APP_ROLE,
      );
      if (!member.length) {
        const me = (await prisma.$queryRawUnsafe(`SELECT current_user AS u`))[0].u;
        await prisma.$executeRawUnsafe(`GRANT ${APP_ROLE} TO ${me}`).catch(() => {});
      }
    } catch (err) {
      const exists = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1`, APP_ROLE,
      );
      if (!exists.length) {
        throw new Error(
          `Test role ${APP_ROLE} missing and current user cannot CREATE ROLE ` +
          `(seed once as superuser). Original error: ${err.message}`,
        );
      }
    }

    // Seed the three tenants (FK target for users/appointments.tenant_id).
    // Seeds run with the GUC unset → permissive policy branch → FORCE doesn't
    // block them. Region/compliance match the other suites' tenant rows.
    for (const [id, slug] of [[TENANT_A, `xrls-a-${RUN}`], [TENANT_B, `xrls-b-${RUN}`], [HEADER_TENANT, `xrls-h-${RUN}`]]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        id, slug, `XTenant ${slug}`,
      );
    }

    // Receptionists + admins, each bound to their own tenant. Receptionists are
    // seeded directly so we can stamp tenant_id; admins only need a JWT (the
    // list route is RBAC-gated, not relationship-gated, with
    // allowNoPatientResource).
    const recepArow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'RECEPTIONIST', true, $4::uuid, NOW()) RETURNING id`,
      RECEP_A_UID, `+91${RECEP_A_PHONE}`, `Reception A ${RUN}`, TENANT_A,
    );
    const recepBrow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'RECEPTIONIST', true, $4::uuid, NOW()) RETURNING id`,
      RECEP_B_UID, `+91${RECEP_B_PHONE}`, `Reception B ${RUN}`, TENANT_B,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'ADMIN', true, $4::uuid, NOW()) RETURNING id`,
      ADMIN_A_UID, `+91${ADMIN_A_PHONE}`, `Admin A ${RUN}`, TENANT_A,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'ADMIN', true, $4::uuid, NOW()) RETURNING id`,
      ADMIN_B_UID, `+91${ADMIN_B_PHONE}`, `Admin B ${RUN}`, TENANT_B,
    );

    // Receptionist clients carry the tenant_id claim so the walk-in controller
    // (which reads req.user?.tenant_id directly) binds rows to the
    // authenticated tenant rather than the DB default. roleClient does NOT
    // forward tenant_id (its signature is `{ uid, id, phone }`), so we mint the
    // tenant-bearing JWT directly — see recepClientForTenant above.
    recepA = recepClientForTenant({ uid: RECEP_A_UID, id: recepArow[0].id, phone: `+91${RECEP_A_PHONE}`, tenantId: TENANT_A });
    recepB = recepClientForTenant({ uid: RECEP_B_UID, id: recepBrow[0].id, phone: `+91${RECEP_B_PHONE}`, tenantId: TENANT_B });
    adminA = adminClientForTenant(ADMIN_A_UID, TENANT_A);
    adminB = adminClientForTenant(ADMIN_B_UID, TENANT_B);

    // Turn enforcement ON for the suite so the prisma proxy auto-applies
    // setTenant on the HTTP path and SET LOCAL ROLE pins the non-bypass role.
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;
  });

  afterAll(async () => {
    // Restore env BEFORE cleanup so the teardown sweeps run on the permissive
    // legacy path (no tenant context in this process anyway).
    if (savedEnforceFlag === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedEnforceFlag;
    if (savedRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = savedRuntimeRole;

    await cleanupJourney({
      patientUids: [patientAUid, patientBUid].filter(Boolean),
      staffUids: [RECEP_A_UID, RECEP_B_UID, ADMIN_A_UID, ADMIN_B_UID],
      phones: [PATIENT_A_PHONE, PATIENT_B_PHONE, RECEP_A_PHONE, RECEP_B_PHONE, ADMIN_A_PHONE, ADMIN_B_PHONE, HEADER_SPOOF_PHONE],
      departments: [DEPT_A, DEPT_B],
    });
    await cleanupTenants();
    await prisma.$disconnect().catch(() => {});
  }, 120000);

  describe('Step 1 — tenant-A receptionist registers a walk-in (rows bind to the authenticated tenant)', () => {
    it('binds the new patient + appointment to tenant A, not the DB default', async () => {
      const res = await recepA.post('/api/v1/appointments/walk-in').send({
        patient_name: `XTenant Patient A ${RUN}`,
        patient_phone: PATIENT_A_PHONE,
        patient_gender: 'F',
        department: DEPT_A,
        reason: 'Walk-in OPD consultation (tenant A)',
        visit_type: 'NEW',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      appointmentAId = res.body.data.id;
      patientAId = res.body.data.patient_id;
      patientAUid = await uidForUserId(patientAId);
      expect(patientAUid).toBeTruthy();

      const userRows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id::text AS tenant_id FROM users WHERE id = $1`, patientAId);
      expect(userRows[0].tenant_id).toBe(TENANT_A);
      expect(userRows[0].tenant_id).not.toBe(DEFAULT_TENANT);

      const apptRows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id::text AS tenant_id, department FROM appointments WHERE id = $1`, appointmentAId);
      expect(apptRows[0].tenant_id).toBe(TENANT_A);
      expect(apptRows[0].tenant_id).not.toBe(DEFAULT_TENANT);
      expect(apptRows[0].department).toBe(DEPT_A);
    });

    it('ignores an untrusted x-tenant-id header — a receptionist cannot plant rows in a third tenant', async () => {
      const headerPhone = HEADER_SPOOF_PHONE;
      const res = await recepA
        .post('/api/v1/appointments/walk-in')
        .set('x-tenant-id', HEADER_TENANT)
        .send({
          patient_name: `XTenant Header Ignored ${RUN}`,
          patient_phone: headerPhone,
          patient_gender: 'M',
          department: DEPT_A,
          reason: 'Walk-in OPD consultation (header spoof attempt)',
          visit_type: 'NEW',
        });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      const userRows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id::text AS tenant_id FROM users WHERE id = $1`, res.body.data.patient_id);
      expect(userRows[0].tenant_id).toBe(TENANT_A);
      expect(userRows[0].tenant_id).not.toBe(HEADER_TENANT);

      // Sweep this extra patient so afterAll's phone-scoped cleanup catches it.
      await prisma.$executeRawUnsafe(
        `DELETE FROM appointments WHERE id = $1`, res.body.data.id).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM users WHERE id = $1`, res.body.data.patient_id).catch(() => {});
    });
  });

  describe('Step 2 — tenant-B receptionist registers their own walk-in', () => {
    it('binds the tenant-B patient + appointment to tenant B', async () => {
      const res = await recepB.post('/api/v1/appointments/walk-in').send({
        patient_name: `XTenant Patient B ${RUN}`,
        patient_phone: PATIENT_B_PHONE,
        patient_gender: 'M',
        department: DEPT_B,
        reason: 'Walk-in OPD consultation (tenant B)',
        visit_type: 'NEW',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      appointmentBId = res.body.data.id;
      patientBId = res.body.data.patient_id;
      patientBUid = await uidForUserId(patientBId);
      expect(patientBUid).toBeTruthy();

      const apptRows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id::text AS tenant_id FROM appointments WHERE id = $1`, appointmentBId);
      expect(apptRows[0].tenant_id).toBe(TENANT_B);
      expect(apptRows[0].tenant_id).not.toBe(TENANT_A);
    });
  });

  describe('Step 3 — HTTP isolation across tenants (GET /appointments/list)', () => {
    it("tenant-B admin cannot see tenant-A's appointment", async () => {
      const res = await adminB.get(`/api/v1/appointments/list?department=${DEPT_A}`);
      expect(res.statusCode).toBe(200);
      const appts = res.body?.data?.appointments || [];
      expect(appts).toEqual([]);
      // Belt-and-braces: tenant-A's patient phone must not appear anywhere.
      expect(JSON.stringify(res.body)).not.toContain(PATIENT_A_PHONE);
    });

    it("tenant-A admin cannot see tenant-B's appointment", async () => {
      const res = await adminA.get(`/api/v1/appointments/list?department=${DEPT_B}`);
      expect(res.statusCode).toBe(200);
      const appts = res.body?.data?.appointments || [];
      expect(appts).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(PATIENT_B_PHONE);
    });

    it('tenant-A admin still sees tenant-A appointment (isolation, not outage)', async () => {
      const res = await adminA.get(`/api/v1/appointments/list?department=${DEPT_A}`);
      expect(res.statusCode).toBe(200);
      const appts = res.body?.data?.appointments || [];
      expect(appts.length).toBe(1);
      expect(appts[0].department).toBe(DEPT_A);
      expect(String(appts[0].id)).toBe(String(appointmentAId));
    });

    it('tenant-B admin still sees tenant-B appointment (symmetry)', async () => {
      const res = await adminB.get(`/api/v1/appointments/list?department=${DEPT_B}`);
      expect(res.statusCode).toBe(200);
      const appts = res.body?.data?.appointments || [];
      expect(appts.length).toBe(1);
      expect(appts[0].department).toBe(DEPT_B);
      expect(String(appts[0].id)).toBe(String(appointmentBId));
    });
  });

  describe('Step 4 — DB-layer read isolation (tenant_isolation policy)', () => {
    // NON-VACUOUS control: a bare prisma.$transaction with the GUC unset hits
    // the policy's permissive branch and sees BOTH tenants' appointments. If
    // this ever fails, the scoped assertions below are vacuous and must be
    // re-examined (mirrors tenant-rls-interactive-tx.deep.test.js).
    it('LEAK (control): an unscoped tx under the non-owner role sees BOTH tenants rows', async () => {
      const rows = await runInTenantContext(TENANT_A, () => prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        return tx.$queryRawUnsafe(
          `SELECT id, tenant_id::text AS tenant_id FROM appointments
            WHERE department IN ($1, $2) ORDER BY id`,
          DEPT_A, DEPT_B);
      }));
      const tenants = rows.map((r) => r.tenant_id);
      expect(tenants).toContain(TENANT_A);
      expect(tenants).toContain(TENANT_B);
      expect(rows).toHaveLength(2);
    });

    it('FIX: a tenant-A-scoped read returns ONLY tenant-A appointment', async () => {
      const rows = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
        `SELECT id, tenant_id::text AS tenant_id FROM appointments
          WHERE department IN ($1, $2) ORDER BY id`,
        DEPT_A, DEPT_B));
      expect(rows).toHaveLength(1);
      expect(String(rows[0].id)).toBe(String(appointmentAId));
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    it('FIX: a tenant-B-scoped read returns ONLY tenant-B appointment (symmetry)', async () => {
      const rows = await setTenantTx(TENANT_B, (tx) => tx.$queryRawUnsafe(
        `SELECT id, tenant_id::text AS tenant_id FROM appointments
          WHERE department IN ($1, $2) ORDER BY id`,
        DEPT_A, DEPT_B));
      expect(rows).toHaveLength(1);
      expect(String(rows[0].id)).toBe(String(appointmentBId));
      expect(rows[0].tenant_id).toBe(TENANT_B);
    });

    it('SUPER_ADMIN bypass sees both tenants appointments (cross-tenant admin read)', async () => {
      const rows = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
        `SELECT id, tenant_id::text AS tenant_id FROM appointments
          WHERE department IN ($1, $2) ORDER BY id`,
        DEPT_A, DEPT_B), { superAdmin: true });
      expect(rows).toHaveLength(2);
      const tenants = rows.map((r) => r.tenant_id);
      expect(tenants).toContain(TENANT_A);
      expect(tenants).toContain(TENANT_B);
    });
  });

  describe('Step 5 — DB-layer write isolation (WITH CHECK + USING)', () => {
    it('rejects a tenant-A-scoped INSERT that tries to plant a row under tenant B (WITH CHECK)', async () => {
      await expect(
        setTenantTx(TENANT_A, (tx) => tx.$executeRawUnsafe(
          `INSERT INTO appointments
             (phone, appointment_date, appointment_time, status, token_number,
              department, tenant_id, updated_at)
           VALUES ($1, CURRENT_DATE, '09:30', 'CONFIRMED', '970', $2, $3::uuid, NOW())`,
          `+91${PATIENT_A_PHONE}`, DEPT_A, TENANT_B)),
      ).rejects.toThrow();

      // Nothing landed, even via bypass.
      const verify = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
        `SELECT 1 FROM appointments WHERE token_number = '970' AND department = $1`, DEPT_A,
      ), { superAdmin: true });
      expect(Array.isArray(verify) ? verify.length : 0).toBe(0);
    });

    it('a tenant-A-scoped UPDATE cannot touch tenant-B appointment (RLS USING hides the row)', async () => {
      const affected = await setTenantTx(TENANT_A, (tx) => tx.$executeRawUnsafe(
        `UPDATE appointments SET updated_at = NOW() WHERE id = $1`, appointmentBId));
      expect(Number(affected)).toBe(0);

      // Confirm B's row is intact + still tenant-B via a bypass read.
      const check = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
        `SELECT tenant_id::text AS tenant_id FROM appointments WHERE id = $1`, appointmentBId,
      ), { superAdmin: true });
      expect(check[0].tenant_id).toBe(TENANT_B);
    });
  });
});
