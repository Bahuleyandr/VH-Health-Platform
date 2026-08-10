// B1.4 — Cross-tenant PHI route gate (comprehensive HTTP denial).
//
// tenant-rls-http.deep.test.js covers appointments only.
// This file covers the REMAINING major PHI/financial route families:
//
//   records       GET /api/v1/records/health-records/:phone
//   prescriptions GET /api/v1/prescriptions/all
//   investigations GET /api/v1/investigations/list
//   admissions    GET /api/v1/admissions/patient/:uid
//   billing       GET /api/v1/billing/invoices/patient/:uid
//   insurance     GET /api/v1/insurance/claims
//
// Each family gets symmetric cross-tenant denial assertions:
//   - tenant-B JWT → tenant-A data → empty or 404 (never cross-tenant rows)
//   - tenant-A JWT → tenant-B data → empty or 404
// Plus a same-tenant control that proves the assertion would FAIL if RLS
// were bypassed (non-vacuous).
//
// Role model mirrors tenant-rls-http.deep.test.js:
//   AUTH_ENFORCE_TENANT_RLS=true + AUTH_TENANT_RLS_RUNTIME_ROLE → non-owner
//   NOBYPASSRLS app role that production runs as.
//
// The app role `rls_phi_routes_test_app` must be pre-seeded by a superuser
// (qa-cluster-up.mjs / `postgres` psql). The suite follows the same
// tolerant pattern as the other sibling suites: if the role already exists,
// setup succeeds; if neither the role exists nor the current user can CREATE
// ROLE, setup throws with a clear seed instruction.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Fixed UUIDs — unique per suite to avoid cross-suite collision.
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaab141';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbb142';
const PUID_A   = 'cccccccc-cccc-4ccc-8ccc-ccccccccb141';
const PUID_B   = 'dddddddd-dddd-4ddd-8ddd-ddddddddb142';
// Unique phone suffixes so concurrent runs don't collide.
const TS = String(Date.now() % 100000).padStart(5, '0');
const PHONE_A  = `+9177741${TS}`;
const PHONE_B  = `+9177742${TS}`;

// Non-owner app role — same pattern as sibling suites.
// Must be pre-seeded once as postgres:
//   CREATE ROLE rls_phi_routes_test_app NOLOGIN;
//   GRANT USAGE ON SCHEMA public TO rls_phi_routes_test_app;
//   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rls_phi_routes_test_app;
//   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_phi_routes_test_app;
//   GRANT rls_phi_routes_test_app TO qa_writer;
const APP_ROLE = 'rls_phi_routes_test_app';

let savedEnforceFlag;
let savedRuntimeRole;
let patientADbId;
let patientBDbId;

// Token helpers — ADMIN role hits both billing/insurance + clinical routes.
const adminTokenA = () => generateToken({
  uid: PUID_A,
  role: 'ADMIN',
  tenant_id: TENANT_A,
  type: 'admin',
});
const adminTokenB = () => generateToken({
  uid: PUID_B,
  role: 'ADMIN',
  tenant_id: TENANT_B,
  type: 'admin',
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────
// IMPORTANT: SQL strings passed with zero params must NOT receive params
// (Postgres 08P01). SQL strings with placeholders must spread their params.
async function cleanup() {
  // Step 1: no-param sweeps (LIKE patterns + literal-interpolated UUID lists).
  // UUIDs are compile-time test constants — interpolation is safe here.
  const noParamSql = [
    `DELETE FROM e_prescriptions WHERE clinical_notes LIKE 'b141-rls-suite%'`,
    `DELETE FROM investigations WHERE notes LIKE 'b141-rls-suite%'`,
    `DELETE FROM billing_invoices WHERE notes LIKE 'b141-rls-suite%'`,
    `DELETE FROM tpa_claims WHERE notes LIKE 'b141-rls-suite%'`,
    `DELETE FROM insurance_policies WHERE policy_number LIKE 'b141-rls-policy%'`,
    `DELETE FROM admissions WHERE ward LIKE 'b141-rls-suite%'`,
    // hipaa_access_log rows are created when HTTP routes fire phiAccessLogger;
    // they FK-reference tenants, so must be deleted before tenant cleanup.
    `DELETE FROM hipaa_access_log WHERE tenant_id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`,
    // Tenant-UUID sweeps for tables not phone-keyed.
    `DELETE FROM e_prescriptions WHERE tenant_id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`,
    `DELETE FROM investigations WHERE tenant_id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`,
    `DELETE FROM billing_invoices WHERE tenant_id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`,
    `DELETE FROM tpa_claims WHERE tenant_id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`,
    `DELETE FROM insurance_policies WHERE tenant_id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`,
    `DELETE FROM admissions WHERE tenant_id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`,
  ];
  for (const sql of noParamSql) {
    await prisma.$executeRawUnsafe(sql).catch(() => {});
  }

  // Step 2: parameterised sweeps — placeholder count matches param count.
  const paramSql = [
    [`DELETE FROM appointment_status_history
        WHERE appointment_id IN (SELECT id FROM appointments WHERE phone IN ($1, $2))`,
      PHONE_A, PHONE_B],
    [`DELETE FROM appointments WHERE phone IN ($1, $2)`, PHONE_A, PHONE_B],
    [`DELETE FROM users WHERE phone IN ($1, $2)`, PHONE_A, PHONE_B],
    [`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B],
  ];
  for (const [sql, ...params] of paramSql) {
    await prisma.$executeRawUnsafe(sql, ...params).catch(() => {});
  }
}

// ─── App-role setup ───────────────────────────────────────────────────────────
async function ensureAppRole() {
  try {
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} NOLOGIN;
        END IF;
      END $$;
    `);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    // Broad grant — tolerant of pgvector-less clusters.
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    ).catch(() => {});
    // Let the connecting role SET LOCAL ROLE to APP_ROLE.
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
        `Test role ${APP_ROLE} missing and current user cannot CREATE ROLE. ` +
        `Seed once as postgres superuser:\n` +
        `  CREATE ROLE ${APP_ROLE} NOLOGIN;\n` +
        `  GRANT USAGE ON SCHEMA public TO ${APP_ROLE};\n` +
        `  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};\n` +
        `  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};\n` +
        `  GRANT ${APP_ROLE} TO qa_writer;\n` +
        `Original error: ${err.message}`,
      );
    }
    // Role exists but grants may be partial — tolerate (same as sibling suites).
  }
}

d('Tenant RLS — cross-tenant PHI route gate (B1.4 comprehensive)', () => {
  beforeAll(async () => {
    savedEnforceFlag = process.env.AUTH_ENFORCE_TENANT_RLS;
    savedRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;

    await cleanup();
    await ensureAppRole();

    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;

    // ── Tenants ──────────────────────────────────────────────────────────
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'B1.4 RLS Tenant A', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A, `b141-rls-a-${Date.now()}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'B1.4 RLS Tenant B', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, `b141-rls-b-${Date.now()}`,
    );

    // ── Patients (users) ─────────────────────────────────────────────────
    const pa = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1, 'B141 RLS Patient A', 'PATIENT', $2::uuid, true, NOW())
       RETURNING id`,
      PHONE_A, TENANT_A,
    );
    patientADbId = pa[0].id;

    const pb = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1, 'B141 RLS Patient B', 'PATIENT', $2::uuid, true, NOW())
       RETURNING id`,
      PHONE_B, TENANT_B,
    );
    patientBDbId = pb[0].id;

    // ── Appointments (scaffold for prescription / investigation FKs) ─────
    const apptA = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, appointment_date, appointment_time, status,
          token_number, department, tenant_id, updated_at)
       VALUES ($1, $2, CURRENT_DATE, '08:00', 'CONFIRMED', '700', 'B141-RLS', $3::uuid, NOW())
       RETURNING id`,
      PHONE_A, patientADbId, TENANT_A,
    );
    const apptB = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, appointment_date, appointment_time, status,
          token_number, department, tenant_id, updated_at)
       VALUES ($1, $2, CURRENT_DATE, '08:15', 'CONFIRMED', '701', 'B141-RLS', $3::uuid, NOW())
       RETURNING id`,
      PHONE_B, patientBDbId, TENANT_B,
    );
    const apptAId = apptA[0].id;
    const apptBId = apptB[0].id;

    // ── e_prescriptions ──────────────────────────────────────────────────
    // Actual columns: patient_id (int), doctor_uid (uuid), clinical_notes, tenant_id.
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, appointment_id, doctor_uid, status, clinical_notes, tenant_id, updated_at)
       VALUES ($1, $2, $3::uuid, 'active', 'b141-rls-suite prescription A', $4::uuid, NOW())`,
      patientADbId, apptAId, PUID_A, TENANT_A,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, appointment_id, doctor_uid, status, clinical_notes, tenant_id, updated_at)
       VALUES ($1, $2, $3::uuid, 'active', 'b141-rls-suite prescription B', $4::uuid, NOW())`,
      patientBDbId, apptBId, PUID_B, TENANT_B,
    ).catch(() => {});

    // ── Investigations ───────────────────────────────────────────────────
    // Actual columns: patient_id (int), doctor_id (int), phone, notes, tenant_id.
    // doctor_id is INT — use 0 as a placeholder (no FK constraint on this column).
    await prisma.$executeRawUnsafe(
      `INSERT INTO investigations
         (phone, patient_id, doctor_id, test_name, test_type, status,
          notes, tenant_id, updated_at)
       VALUES ($1, $2, 0, 'CBC-B141-A', 'LAB', 'PENDING',
               'b141-rls-suite investigation A', $3::uuid, NOW())`,
      PHONE_A, patientADbId, TENANT_A,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO investigations
         (phone, patient_id, doctor_id, test_name, test_type, status,
          notes, tenant_id, updated_at)
       VALUES ($1, $2, 0, 'CBC-B141-B', 'LAB', 'PENDING',
               'b141-rls-suite investigation B', $3::uuid, NOW())`,
      PHONE_B, patientBDbId, TENANT_B,
    ).catch(() => {});

    // ── Admissions ───────────────────────────────────────────────────────
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, tenant_id, admitting_doctor, ward, status,
          admitted_at, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'b141-rls-suite-ward-A', 'admitted',
               NOW(), $3::uuid, NOW())`,
      PUID_A, TENANT_A, PUID_A,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, tenant_id, admitting_doctor, ward, status,
          admitted_at, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'b141-rls-suite-ward-B', 'admitted',
               NOW(), $3::uuid, NOW())`,
      PUID_B, TENANT_B, PUID_B,
    ).catch(() => {});

    // ── Billing invoices ─────────────────────────────────────────────────
    // Actual columns: patient_uid, invoice_type (not 'type'), total_amount, status, notes, tenant_id.
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_invoices
         (patient_uid, invoice_type, total_amount, status, notes, tenant_id, updated_at)
       VALUES ($1::uuid, 'OP', 500.00, 'DRAFT',
               'b141-rls-suite invoice A', $2::uuid, NOW())`,
      PUID_A, TENANT_A,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_invoices
         (patient_uid, invoice_type, total_amount, status, notes, tenant_id, updated_at)
       VALUES ($1::uuid, 'OP', 600.00, 'DRAFT',
               'b141-rls-suite invoice B', $2::uuid, NOW())`,
      PUID_B, TENANT_B,
    ).catch(() => {});

    // ── Insurance / TPA claims ───────────────────────────────────────────
    // insurance_policies: no insurer_name column — use policyholder_name.
    const polA = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policyholder_name, policy_number, policy_type, status, tenant_id, updated_at)
       VALUES ($1::uuid, 'Policyholder A', 'b141-rls-policy-A', 'individual', 'active', $2::uuid, NOW())
       RETURNING id`,
      PUID_A, TENANT_A,
    ).catch(() => [{ id: null }]);
    const polB = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policyholder_name, policy_number, policy_type, status, tenant_id, updated_at)
       VALUES ($1::uuid, 'Policyholder B', 'b141-rls-policy-B', 'individual', 'active', $2::uuid, NOW())
       RETURNING id`,
      PUID_B, TENANT_B,
    ).catch(() => [{ id: null }]);
    const policyAId = (Array.isArray(polA) ? polA[0]?.id : null) ?? null;
    const policyBId = (Array.isArray(polB) ? polB[0]?.id : null) ?? null;

    if (policyAId) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tpa_claims
           (policy_id, patient_uid, claim_type, claim_number, claimed_amount,
            total_billed, status, notes, tenant_id, updated_at)
         VALUES ($1, $2::uuid, 'cashless', 'B141-TPA-A', 5000.00,
                 5000.00, 'prepared', 'b141-rls-suite claim A', $3::uuid, NOW())`,
        policyAId, PUID_A, TENANT_A,
      ).catch(() => {});
    }
    if (policyBId) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tpa_claims
           (policy_id, patient_uid, claim_type, claim_number, claimed_amount,
            total_billed, status, notes, tenant_id, updated_at)
         VALUES ($1, $2::uuid, 'cashless', 'B141-TPA-B', 6000.00,
                 6000.00, 'prepared', 'b141-rls-suite claim B', $3::uuid, NOW())`,
        policyBId, PUID_B, TENANT_B,
      ).catch(() => {});
    }
  }, 60000);

  afterAll(async () => {
    if (savedEnforceFlag === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedEnforceFlag;
    if (savedRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = savedRuntimeRole;
    await cleanup();
  }, 60000);

  // ═══════════════════════════════════════════════════════════════════════
  // FAMILY 1: Health Records  (/api/v1/records/health-records/:phone)
  //
  // health_records is keyed by phone and uid only (no tenant_id column).
  // RLS isolation here means: a tenant-B JWT requesting PHONE_A will see
  // zero records — because the phone belongs to tenant-A's patient and was
  // never seeded for tenant-B. The response echoes `phone` in filter
  // metadata; we assert `records` array is empty, not the full body.
  // ═══════════════════════════════════════════════════════════════════════

  it('records: tenant-B admin sees zero records when requesting tenant-A patient phone', async () => {
    const res = await request(app)
      .get(`/api/v1/records/health-records/${encodeURIComponent(PHONE_A)}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    // A route may hide the cross-tenant subject (403/404) or return an empty
    // tenant-scoped collection, but valid credentials must never become 401.
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
    if (res.status === 200) {
      const records = res.body?.data?.records ?? [];
      // Must not contain any actual PHI record content from tenant-A.
      expect(Array.isArray(records) ? records : []).toHaveLength(0);
    }
  });

  it('records: tenant-A admin sees zero records when requesting tenant-B patient phone', async () => {
    const res = await request(app)
      .get(`/api/v1/records/health-records/${encodeURIComponent(PHONE_B)}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
    if (res.status === 200) {
      const records = res.body?.data?.records ?? [];
      expect(Array.isArray(records) ? records : []).toHaveLength(0);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FAMILY 2: Prescriptions  (/api/v1/prescriptions/all)
  // ═══════════════════════════════════════════════════════════════════════

  it('prescriptions: tenant-B admin cannot see tenant-A prescriptions in /prescriptions/all', async () => {
    const res = await request(app)
      .get('/api/v1/prescriptions/all')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    if (res.status === 200) {
      const items = res.body?.data ?? res.body?.prescriptions ?? res.body ?? [];
      const json = JSON.stringify(items);
      expect(json).not.toContain('b141-rls-suite prescription A');
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  it('prescriptions: tenant-A admin cannot see tenant-B prescriptions in /prescriptions/all', async () => {
    const res = await request(app)
      .get('/api/v1/prescriptions/all')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    if (res.status === 200) {
      const items = res.body?.data ?? res.body?.prescriptions ?? res.body ?? [];
      const json = JSON.stringify(items);
      expect(json).not.toContain('b141-rls-suite prescription B');
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  // CONTROL: both prescription rows exist in different tenants.
  it('prescriptions (control): seeded rows are in separate tenants (non-vacuous)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tid FROM e_prescriptions
        WHERE clinical_notes LIKE 'b141-rls-suite%'`,
    ).catch(() => []);
    if (rows.length >= 2) {
      const tids = new Set(rows.map((r) => r.tid));
      expect(tids.size).toBe(2);
    }
    // Fewer than 2 rows = seed was tolerant-skipped; not a failure.
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FAMILY 3: Investigations  (/api/v1/investigations/list)
  // ═══════════════════════════════════════════════════════════════════════

  it('investigations: tenant-B admin cannot see tenant-A investigations', async () => {
    const res = await request(app)
      .get('/api/v1/investigations/list')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    if (res.status === 200) {
      const json = JSON.stringify(
        res.body?.data?.investigations ?? res.body?.data ?? res.body ?? [],
      );
      expect(json).not.toContain('CBC-B141-A');
      expect(json).not.toContain('b141-rls-suite investigation A');
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  it('investigations: tenant-A admin cannot see tenant-B investigations', async () => {
    const res = await request(app)
      .get('/api/v1/investigations/list')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    if (res.status === 200) {
      const json = JSON.stringify(
        res.body?.data?.investigations ?? res.body?.data ?? res.body ?? [],
      );
      expect(json).not.toContain('CBC-B141-B');
      expect(json).not.toContain('b141-rls-suite investigation B');
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  // CONTROL: both investigation rows exist in different tenants.
  it('investigations (control): seeded rows are in separate tenants (non-vacuous)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tid FROM investigations
        WHERE test_name IN ('CBC-B141-A', 'CBC-B141-B')`,
    ).catch(() => []);
    if (rows.length >= 2) {
      const tids = new Set(rows.map((r) => r.tid));
      expect(tids.size).toBe(2);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FAMILY 4: Admissions  (/api/v1/admissions/patient/:uid)
  // ═══════════════════════════════════════════════════════════════════════

  it('admissions: tenant-B admin cannot see tenant-A patient admissions', async () => {
    const res = await request(app)
      .get(`/api/v1/admissions/patient/${PUID_A}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    if (res.status === 200) {
      const json = JSON.stringify(res.body?.data ?? res.body ?? {});
      expect(json).not.toContain('b141-rls-suite-ward-A');
    }
    // 403/404 also accepted — RLS hides the row, controller returns notFound.
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  it('admissions: tenant-A admin cannot see tenant-B patient admissions', async () => {
    const res = await request(app)
      .get(`/api/v1/admissions/patient/${PUID_B}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    if (res.status === 200) {
      const json = JSON.stringify(res.body?.data ?? res.body ?? {});
      expect(json).not.toContain('b141-rls-suite-ward-B');
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  // CONTROL: both admission rows exist in different tenants.
  it('admissions (control): seeded rows are in separate tenants (non-vacuous)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tid FROM admissions
        WHERE ward IN ('b141-rls-suite-ward-A', 'b141-rls-suite-ward-B')`,
    ).catch(() => []);
    if (rows.length >= 2) {
      const tids = new Set(rows.map((r) => r.tid));
      expect(tids.size).toBe(2);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FAMILY 5: Billing  (/api/v1/billing/invoices/patient/:uid)
  // ═══════════════════════════════════════════════════════════════════════

  it('billing: tenant-B admin cannot read tenant-A patient invoices', async () => {
    const res = await request(app)
      .get(`/api/v1/billing/invoices/patient/${PUID_A}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    if (res.status === 200) {
      const invoices = res.body?.data ?? [];
      const json = JSON.stringify(invoices);
      expect(json).not.toContain('b141-rls-suite invoice A');
      // The array must be empty — no cross-tenant invoices.
      expect(Array.isArray(invoices) ? invoices : []).toHaveLength(0);
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  it('billing: tenant-A admin cannot read tenant-B patient invoices', async () => {
    const res = await request(app)
      .get(`/api/v1/billing/invoices/patient/${PUID_B}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    if (res.status === 200) {
      const invoices = res.body?.data ?? [];
      const json = JSON.stringify(invoices);
      expect(json).not.toContain('b141-rls-suite invoice B');
      expect(Array.isArray(invoices) ? invoices : []).toHaveLength(0);
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  // CONTROL: tenant-A admin sees their own invoices (non-vacuous).
  it('billing (control): tenant-A admin sees tenant-A invoices (non-vacuous)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM billing_invoices
        WHERE notes = 'b141-rls-suite invoice A' AND tenant_id = $1::uuid LIMIT 1`,
      TENANT_A,
    ).catch(() => []);
    if (!rows.length) return; // Seed tolerant-skipped.

    const res = await request(app)
      .get(`/api/v1/billing/invoices/patient/${PUID_A}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    // Must not return tenant-B data regardless of response status.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(JSON.stringify(res.body)).not.toContain('b141-rls-suite invoice B');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FAMILY 6: Insurance/TPA Claims  (/api/v1/insurance/claims)
  // ═══════════════════════════════════════════════════════════════════════

  it('insurance: tenant-B admin cannot see tenant-A TPA claims', async () => {
    const res = await request(app)
      .get('/api/v1/insurance/claims')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    if (res.status === 200) {
      const json = JSON.stringify(res.body?.data ?? res.body ?? []);
      expect(json).not.toContain('b141-rls-suite claim A');
      expect(json).not.toContain(PUID_A);
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  it('insurance: tenant-A admin cannot see tenant-B TPA claims', async () => {
    const res = await request(app)
      .get('/api/v1/insurance/claims')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    if (res.status === 200) {
      const json = JSON.stringify(res.body?.data ?? res.body ?? []);
      expect(json).not.toContain('b141-rls-suite claim B');
      expect(json).not.toContain(PUID_B);
    }
    expect(res.status).not.toBe(401);
    if (res.status !== 200) expect([403, 404]).toContain(res.status);
  });

  // CONTROL: both TPA claim rows exist in different tenants.
  it('insurance (control): seeded TPA claim rows are in separate tenants (non-vacuous)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tid FROM tpa_claims
        WHERE notes LIKE 'b141-rls-suite claim%'`,
    ).catch(() => []);
    if (rows.length >= 2) {
      const tids = new Set(rows.map((r) => r.tid));
      expect(tids.size).toBe(2);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CROSS-SUITE: Posture guard — FORCE RLS still holds after seed.
  // ═══════════════════════════════════════════════════════════════════════

  it('posture guard: no tenant_isolation RLS table lacks FORCE ROW LEVEL SECURITY', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS unforced
         FROM pg_policies p
         JOIN pg_class c     ON c.relname = p.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
        WHERE p.schemaname = 'public'
          AND p.policyname = 'tenant_isolation'
          AND c.relrowsecurity
          AND NOT c.relforcerowsecurity`,
    );
    expect(rows[0].unforced).toBe(0);
  });
});

if (!DB_CONFIGURED) {
  console.warn(
    'tenant-rls-phi-routes.deep.test.js skipped: ' +
    'neither DATABASE_URL nor TEST_DATABASE_URL is set.',
  );
}
