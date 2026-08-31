// Salary-revision tenant boundary (CAN-016 + migration 754).
//
// RLS auto-wrapping is disabled in CI, so these mounted HTTP cases prove the
// explicit route/controller predicates: a tenant cannot propose for, inspect,
// sign, apply, or reject another tenant's revision, and every denial leaves the
// revision and salary rows unchanged.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import {
  claimBulkRevisionItems,
  processBulkSalaryRevisionJobs,
} from '../services/staff/bulkSalaryRevisionService.js';
import { processPendingSalaryRevisionArrearsWork } from '../services/staff/payrollService.js';
import {
  parkInactiveTenantPayrollRevisionWork,
} from '../services/staff/salaryRevisionReconciliationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const STAFF_A = 'c0de0016-00a0-4000-8000-0000000000a1';
const STAFF_B = 'c0de0016-00b0-4000-8000-0000000000b1';
// Single array-valued parameter for `= ANY($1::uuid[])`. Passed via a
// variable, the repo idiom (see billing-money-path-concurrency-deep.test.js),
// because an inline array literal is indistinguishable from the mistaken
// params-array form the raw-param lint rule exists to catch.
const STAFF_UIDS = [STAFF_A, STAFF_B];
const ADMIN_A = 'c0de0016-00a0-4000-8000-0000000000a2';
const ADMIN_B = 'c0de0016-00b0-4000-8000-0000000000b2';
const HR_A = 'c0de0016-00a0-4000-8000-0000000000a3';
const HR_B = 'c0de0016-00b0-4000-8000-0000000000b3';
// Declared after the four actor uids, not before them: `const` gives no
// hoisted value, so listing them earlier threw a temporal-dead-zone
// ReferenceError and took the whole suite down at module load.
const ACTOR_UIDS = [ADMIN_A, ADMIN_B, HR_A, HR_B];
const OWNED_UIDS = [STAFF_A, STAFF_B, ADMIN_A, ADMIN_B, HR_A, HR_B];
let requestSequence = 0;
const CURRENT_MONTH_START = new Date().toISOString().slice(0, 8) + '01';
// Bulk cohorts target the seeded nursing role rather than target_type 'all'.
// The committed seed already carries an ADMIN ('Test Harness User',
// 550e8400-…-446655440000) with an active staff_salary row in TENANT_A, and
// canCreateBulkRevisionForTarget (bulkSalaryRevisionService.js:277-284) lets
// only a SUPER_ADMIN include an ADMIN target. So an 'all' cohort built by
// adminA is a CORRECT 403, and even without the guard it would hold two
// members while every case below asserts a cohort of exactly one. STAFF_A is
// the only active NURSING_STAFF with an active salary row in TENANT_A.
const BULK_COHORT = { target_type: 'role', target_value: 'NURSING_STAFF' };

function client(role, uid, tenantId) {
  const token = generateTestToken(role, { uid, tenant_id: tenantId });
  const withAuth = (verb, path) => request(app)[verb](path)
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
  return {
    get: (path) => withAuth('get', path),
    post: (path) => withAuth('post', path)
      .set('Idempotency-Key', `can016-${uid.slice(-4)}-${++requestSequence}`),
  };
}

const adminA = client('ADMIN', ADMIN_A, TENANT_A);
const adminB = client('ADMIN', ADMIN_B, TENANT_B);
const hrA = client('HR_STAFF', HR_A, TENANT_A);
const hrB = client('HR_STAFF', HR_B, TENANT_B);
let quarantinedRevisionId;

// Migration 754 made the salary-revision evidence tables append-only: a
// BEFORE UPDATE OR DELETE trigger on salary_revision_activation_events,
// salary_revision_command_receipts and salary_arrears_command_receipts raises
// 55000, and the new composite FKs then pin the arrears work items, the
// revisions and finally the fixture users behind those stranded rows. A plain
// DELETE cascade cannot unwind that, so the old per-statement `.catch(() => {})`
// swallowed the failure and the NEXT seed died on users_uid_key instead.
//
// Same mechanism the migration-589 evidence teardown uses
// (tests/helpers/diagnosticEvidenceCleanup.js): one transaction with user and
// constraint triggers disabled. Suites only ever run against a disposable test
// database; the guard itself is untouched and no production path can reach
// this. The errors are deliberately no longer swallowed — a teardown that
// cannot clean up must fail loudly rather than poison the following run.
async function clean() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_revision_activation_events
        WHERE revision_id IN (
          SELECT id FROM salary_revisions WHERE staff_uid = ANY($1::uuid[])
        )`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_revision_arrears_work_items WHERE staff_uid = ANY($1::uuid[])`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_revision_activation_jobs
        WHERE revision_id IN (
          SELECT id FROM salary_revisions WHERE staff_uid = ANY($1::uuid[])
        )`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_revision_command_receipts WHERE actor_uid = ANY($1::uuid[])`,
      ACTOR_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_revision_payables WHERE staff_uid = ANY($1::uuid[])`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM bulk_revision_job_items WHERE staff_uid = ANY($1::uuid[])`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM bulk_revision_jobs WHERE created_by = ANY($1::uuid[])`,
      ACTOR_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_arrears_command_receipts WHERE actor_uid = ANY($1::uuid[])`,
      ACTOR_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_arrears WHERE staff_uid = ANY($1::uuid[])`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM annual_review_reminders WHERE staff_uid = ANY($1::uuid[])`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM idempotency_keys WHERE user_uid = ANY($1::uuid[])`,
      ACTOR_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM salary_revisions WHERE staff_uid = ANY($1::uuid[])`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM staff_salary WHERE staff_uid = ANY($1::uuid[])`,
      STAFF_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      OWNED_UIDS,
    );
  });
}

async function seedUser(uid, tenantId, phone, role, name) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,true,NOW())`,
    uid,
    tenantId,
    phone,
    name,
    role,
  );
}

async function seedRevision(staffUid, tenantId, proposerUid, num) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO salary_revisions (
       revision_number, revision_type, salary_baseline,
       current_basic, proposed_basic, current_gross, proposed_gross,
       increment_amount, increment_pct, effective_from, reason, staff_uid,
       proposed_by, proposed_at, status, tenant_id, created_at
     )
     SELECT $1, 'increment',
            jsonb_build_object(
              'basic_salary', salary.basic_salary,
              'hra_pct', salary.hra_pct,
              'da_pct', salary.da_pct,
              'special_allowance', salary.special_allowance,
              'transport_allowance', salary.transport_allowance,
              'medical_allowance', salary.medical_allowance,
              'tds_monthly', salary.tds_monthly,
              'pf_employee_pct', salary.pf_employee_pct,
              'esi_applicable', salary.esi_applicable
            ),
            salary.basic_salary, salary.basic_salary + 1000,
            ROUND((salary.basic_salary * (1 + salary.hra_pct / 100 + salary.da_pct / 100)
              + salary.special_allowance + salary.transport_allowance
              + salary.medical_allowance)::numeric, 2),
            ROUND(((salary.basic_salary + 1000)
              * (1 + salary.hra_pct / 100 + salary.da_pct / 100)
              + salary.special_allowance + salary.transport_allowance
              + salary.medical_allowance)::numeric, 2),
            1000, ROUND((1000 / salary.basic_salary * 100)::numeric, 2),
            date_trunc('month', CURRENT_DATE)::date, 'CAN-016 list fixture',
            $2::uuid, $3::uuid, clock_timestamp(), 'pending_hr', $4::uuid,
            clock_timestamp()
       FROM staff_salary salary
      WHERE salary.tenant_id = $4::uuid AND salary.staff_uid = $2::uuid
        AND salary.is_active = true`,
    num,
    staffUid,
    proposerUid,
    tenantId,
  );
}

async function revisionState(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, tenant_reconciliation_required, status,
            hr_signed_by, admin_signed_by, rejected_by
       FROM salary_revisions
      WHERE id = $1::int`,
    Number(id),
  );
  return rows[0];
}

async function seedIssuedPayslipsForRevision(revisionId, monthsBack = 2) {
  const revision = (await prisma.$queryRawUnsafe(
    `SELECT salary_baseline FROM salary_revisions
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    TENANT_A,
    revisionId,
  ))[0];
  const baseline = revision.salary_baseline;
  const basic = Number(baseline.basic_salary);
  const hra = Math.round(basic * Number(baseline.hra_pct)) / 100;
  const da = Math.round(basic * Number(baseline.da_pct)) / 100;
  const special = Number(baseline.special_allowance);
  const transport = Number(baseline.transport_allowance);
  const medical = Number(baseline.medical_allowance);
  const gross = basic + hra + da + special + transport + medical;
  const pf = Math.round(basic * Number(baseline.pf_employee_pct)) / 100;
  const esi = baseline.esi_applicable && gross < 21000
    ? Math.round(gross * 0.75) / 100 : 0;
  const professionalTax = gross <= 21000 ? 0 : (gross <= 30000 ? 135 : 200);
  const tds = Number(baseline.tds_monthly);
  const deductions = pf + esi + professionalTax + tds;
  await prisma.$executeRawUnsafe(
    `INSERT INTO payslips (
       tenant_id, staff_uid, month, year, total_working_days,
       days_present, days_absent, days_leave, basic_earned, hra_earned,
       da_earned, special_allowance_earned, transport_allowance_earned,
       medical_allowance_earned, overtime_pay, gross_salary, pf_employee,
       esi_employee, professional_tax, tds, total_deductions, net_salary, status
     )
     SELECT $1::uuid, $2::uuid, EXTRACT(MONTH FROM month_start)::int,
            EXTRACT(YEAR FROM month_start)::int, 26, 26, 0, 0,
            $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::numeric,
            $8::numeric, 0, $9::numeric, $10::numeric, $11::numeric,
            $12::numeric, $13::numeric, $14::numeric, $15::numeric, 'issued'
       -- Through the application month INCLUSIVE, not the month before it.
       -- computeArrears walks while (d < appliedMonth), where appliedMonth is
       -- applied_at with only the DAY forced to 1 (payrollService.js:3902-3908),
       -- so it keeps the time of day and the application month itself is an
       -- arrears month for any revision applied after midnight — i.e. always.
       -- Stopping a month short left that final month without the issued
       -- payslip the 409 evidence guard (payrollService.js:4026-4031) demands.
       FROM generate_series(
         date_trunc('month', CURRENT_DATE) - make_interval(months => $16::int),
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month'
       ) AS month_start
     ON CONFLICT (tenant_id, staff_uid, month, year)
       WHERE status IS DISTINCT FROM 'superseded'
     DO UPDATE SET total_working_days = 26, days_present = 26,
                   days_absent = 0, days_leave = 0, basic_earned = EXCLUDED.basic_earned,
                   hra_earned = EXCLUDED.hra_earned, da_earned = EXCLUDED.da_earned,
                   special_allowance_earned = EXCLUDED.special_allowance_earned,
                   transport_allowance_earned = EXCLUDED.transport_allowance_earned,
                   medical_allowance_earned = EXCLUDED.medical_allowance_earned,
                   overtime_pay = 0, gross_salary = EXCLUDED.gross_salary,
                   pf_employee = EXCLUDED.pf_employee, esi_employee = EXCLUDED.esi_employee,
                   professional_tax = EXCLUDED.professional_tax, tds = EXCLUDED.tds,
                   total_deductions = EXCLUDED.total_deductions,
                   net_salary = EXCLUDED.net_salary, status = 'issued'`,
    TENANT_A,
    STAFF_A,
    basic,
    hra,
    da,
    special,
    transport,
    medical,
    gross,
    pf,
    esi,
    professionalTax,
    tds,
    deductions,
    gross - deductions,
    monthsBack,
  );
}

d('Salary-revision tenant boundary (CAN-016)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'can016-tenant-b', 'CAN-016 Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    await seedUser(STAFF_A, TENANT_A, '+919000016701', 'NURSING_STAFF', 'Salary Staff A');
    await seedUser(STAFF_B, TENANT_B, '+919000016702', 'NURSING_STAFF', 'Salary Staff B');
    await seedUser(ADMIN_A, TENANT_A, '+919000016703', 'ADMIN', 'Salary Admin A');
    await seedUser(ADMIN_B, TENANT_B, '+919000016704', 'ADMIN', 'Salary Admin B');
    await seedUser(HR_A, TENANT_A, '+919000016705', 'HR_STAFF', 'Salary HR A');
    await seedUser(HR_B, TENANT_B, '+919000016706', 'HR_STAFF', 'Salary HR B');
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_salary (tenant_id, staff_uid, basic_salary, effective_from)
       VALUES ($1::uuid, $2::uuid, 40000, CURRENT_DATE),
              ($3::uuid, $4::uuid, 50000, CURRENT_DATE)`,
      TENANT_A,
      STAFF_A,
      TENANT_B,
      STAFF_B,
    );
    await seedRevision(STAFF_A, TENANT_A, ADMIN_A, 'REV-CAN016-A');
    await seedRevision(STAFF_B, TENANT_B, ADMIN_B, 'REV-CAN016-B');
    const quarantined = await prisma.$queryRawUnsafe(
      `INSERT INTO salary_revisions
         (revision_number, revision_type, effective_from, reason, staff_uid, proposed_by,
          status, tenant_id, tenant_reconciliation_required,
          tenant_reconciliation_reason, tenant_reconciliation_evidence, created_at)
       VALUES ('REV-CAN016-Q', 'increment', CURRENT_DATE,
               'CAN-016 mismatched legacy quarantine', $1::uuid, $2::uuid,
               'pending_hr', NULL, TRUE, 'identity_tenant_conflict',
               '{"fixture":"mismatched_staff_owner"}'::jsonb, NOW())
       RETURNING id`,
      STAFF_B,
      ADMIN_A,
    );
    quarantinedRevisionId = quarantined[0].id;
  }, 30000);

  afterAll(async () => {
    await clean();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('a tenant-A admin revision list excludes tenant-B revisions', async () => {
    const res = await adminA.get('/api/v1/staff/admin/payroll/revisions?limit=200');
    expect(res.statusCode).toBe(200);
    const staffUids = (res.body.data || []).map((row) => String(row.staff_uid));
    expect(staffUids).toContain(STAFF_A);
    expect(staffUids).not.toContain(STAFF_B);
  });

  it('never derives access from a quarantined legacy revision staff owner', async () => {
    const [tenantAResponse, tenantBResponse] = await Promise.all([
      adminA.get(`/api/v1/staff/admin/payroll/revisions/${quarantinedRevisionId}`),
      adminB.get(`/api/v1/staff/admin/payroll/revisions/${quarantinedRevisionId}`),
    ]);
    expect(tenantAResponse.statusCode).toBe(403);
    expect(tenantBResponse.statusCode).toBe(403);
    expect(await revisionState(quarantinedRevisionId)).toMatchObject({
      tenant_id: null,
      tenant_reconciliation_required: true,
      status: 'pending_hr',
    });
  });

  it('enforces exact active signer roles and same-person segregation', async () => {
    const seededRevision = (await prisma.$queryRawUnsafe(
      `SELECT id FROM salary_revisions WHERE revision_number = 'REV-CAN016-A'`,
    ))[0];
    const wrongRole = await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${seededRevision.id}/hr-sign`)
      .send({ comment: 'admin cannot occupy HR signer slot' });
    expect(wrongRole.statusCode).toBe(403);
    expect(await revisionState(seededRevision.id)).toMatchObject({
      status: 'pending_hr',
      hr_signed_by: null,
    });

    const hrSigned = await hrA
      .post(`/api/v1/staff/admin/payroll/revisions/${seededRevision.id}/hr-sign`)
      .send({ comment: 'authoritative HR signature' });
    expect(hrSigned.statusCode).toBe(200);

    await prisma.$executeRawUnsafe(
      `UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE uid = $1::uuid`,
      HR_A,
    );
    const sameActorAdminToken = client('ADMIN', HR_A, TENANT_A);
    const sameSigner = await sameActorAdminToken
      .post(`/api/v1/staff/admin/payroll/revisions/${seededRevision.id}/admin-sign`)
      .send({ comment: 'same person must remain forbidden' });
    expect(sameSigner.statusCode).toBe(403);
    expect(await revisionState(seededRevision.id)).toMatchObject({
      status: 'pending_admin',
      hr_signed_by: HR_A,
      admin_signed_by: null,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE users SET role = 'HR_STAFF', updated_at = NOW() WHERE uid = $1::uuid`,
      HR_A,
    );
  });

  it('freezes an active salary baseline at proposal and refuses stale or inactive apply targets', async () => {
    // A bonus proposal must carry bonus_reason as well as bonus_amount
    // (salaryRevisionController.proposeRevision:288-298). Without it the
    // request was rejected as malformed at 400 and never reached the guard
    // this case exists to prove, so assert the 409 reason too — that pins the
    // refusal to the missing salary baseline rather than to any other conflict.
    const noSalary = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: HR_A,
        revision_type: 'bonus',
        bonus_amount: 500,
        bonus_reason: 'CAN-016 baseline probe',
        effective_from: '2099-01-01',
        reason: 'CAN-016 no salary target',
      });
    expect(noSalary.statusCode).toBe(409);
    expect(noSalary.body.message).toBe('Active tenant-bound staff salary row is required');

    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = false, updated_at = NOW() WHERE uid = $1::uuid`,
      STAFF_A,
    );
    const inactiveProposal = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'increment',
        proposed_basic: 41000,
        effective_from: '2099-01-01',
        reason: 'CAN-016 inactive proposal target',
      });
    expect([403, 404]).toContain(inactiveProposal.statusCode);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = true, updated_at = NOW() WHERE uid = $1::uuid`,
      STAFF_A,
    );

    const contradictoryIncrement = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'increment',
        proposed_basic: 41000,
        increment_amount: 999,
        increment_pct: 2.5,
        effective_from: '2097-01-01',
        reason: 'CAN-016 contradictory increment evidence',
      });
    expect(contradictoryIncrement.statusCode).toBe(400);
    expect((await prisma.$queryRawUnsafe(
      `SELECT id FROM salary_revisions WHERE reason = 'CAN-016 contradictory increment evidence'`,
    ))).toHaveLength(0);

    const negativeComponent = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'component_change',
        other_changes: { special_allowance: -1 },
        effective_from: '2097-01-01',
        reason: 'CAN-016 invalid component evidence',
      });
    expect(negativeComponent.statusCode).toBe(400);
    const componentProposal = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'component_change',
        other_changes: { special_allowance: 1500 },
        effective_from: '2097-01-01',
        reason: 'CAN-016 canonical gross evidence',
      });
    expect(componentProposal.statusCode).toBe(200);
    const componentId = componentProposal.body.data.id;
    expect((await hrA
      .post(`/api/v1/staff/admin/payroll/revisions/${componentId}/hr-sign`)
      .send({})).statusCode).toBe(200);
    expect((await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${componentId}/admin-sign`)
      .send({})).statusCode).toBe(200);
    const componentEvidence = (await prisma.$queryRawUnsafe(
      `SELECT status, current_basic, proposed_basic, current_gross, proposed_gross,
              other_changes
         FROM salary_revisions
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      componentId,
    ))[0];
    expect(componentEvidence).toMatchObject({
      status: 'approved',
      proposed_basic: null,
      other_changes: { special_allowance: 1500 },
    });
    expect(Number(componentEvidence.current_basic)).toBe(40000);
    expect(Number(componentEvidence.current_gross)).toBe(60000);
    expect(Number(componentEvidence.proposed_gross)).toBe(61500);

    const proposeApproved = async (reason, proposedBasic) => {
      const proposed = await adminA
        .post('/api/v1/staff/admin/payroll/revisions/propose')
        .send({
          staff_uid: STAFF_A,
          revision_type: 'increment',
          proposed_basic: proposedBasic,
          effective_from: CURRENT_MONTH_START,
          reason,
        });
      expect(proposed.statusCode).toBe(200);
      const id = proposed.body.data.id;
      expect((await hrA
        .post(`/api/v1/staff/admin/payroll/revisions/${id}/hr-sign`)
        .send({})).statusCode).toBe(200);
      expect((await adminA
        .post(`/api/v1/staff/admin/payroll/revisions/${id}/admin-sign`)
        .send({})).statusCode).toBe(200);
      return id;
    };

    const priorYear = new Date().getFullYear() - 1;
    const currentYear = new Date().getFullYear();
    await prisma.$executeRawUnsafe(
      `INSERT INTO annual_review_reminders (
         tenant_id, staff_uid, review_year, status,
         tenant_reconciliation_required, tenant_reconciliation_evidence
       )
       VALUES ($1::uuid, $2::uuid, $3::int, 'pending', false, '{}'::jsonb)
       ON CONFLICT (tenant_id, staff_uid, review_year)
       DO UPDATE SET status = 'pending', revision_id = NULL,
                     tenant_reconciliation_required = false`,
      TENANT_A,
      STAFF_A,
      new Date().getFullYear(),
    );
    const staleId = await proposeApproved('CAN-016 stale salary baseline', 41000);
    await prisma.$executeRawUnsafe(
      `UPDATE staff_salary SET basic_salary = 40001
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
    const staleApply = await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${staleId}/apply`)
      .send({});
    expect(staleApply.statusCode).toBe(409);
    expect((await revisionState(staleId)).status).toBe('approved');
    await prisma.$executeRawUnsafe(
      `UPDATE staff_salary SET basic_salary = 40000
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );

    const inactiveId = await proposeApproved('CAN-016 inactive apply target', 42000);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = false, updated_at = NOW() WHERE uid = $1::uuid`,
      STAFF_A,
    );
    const inactiveApply = await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${inactiveId}/apply`)
      .send({});
    expect([403, 404, 409]).toContain(inactiveApply.statusCode);
    expect((await revisionState(inactiveId)).status).toBe('approved');
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = true, updated_at = NOW() WHERE uid = $1::uuid`,
      STAFF_A,
    );
    const reminder = (await prisma.$queryRawUnsafe(
      `SELECT status, revision_id
         FROM annual_review_reminders
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
          AND review_year = $3::int`,
      TENANT_A,
      STAFF_A,
      new Date().getFullYear(),
    ))[0];
    expect(reminder).toEqual({ status: 'pending', revision_id: null });

    await prisma.$executeRawUnsafe(
      `INSERT INTO annual_review_reminders (
         tenant_id, staff_uid, review_year, status,
         tenant_reconciliation_required, tenant_reconciliation_evidence
       )
       VALUES ($1::uuid, $2::uuid, $3::int, 'pending', false, '{}'::jsonb),
              ($1::uuid, $2::uuid, $4::int, 'pending', false, '{}'::jsonb)
       ON CONFLICT (tenant_id, staff_uid, review_year)
       DO UPDATE SET status = 'pending', revision_id = NULL,
                     tenant_reconciliation_required = false`,
      TENANT_A,
      STAFF_A,
      priorYear,
      currentYear,
    );
    const delayedProposal = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'increment',
        proposed_basic: 43000,
        effective_from: `${priorYear}-12-01`,
        reason: 'CAN-016 delayed cross-year apply',
      });
    expect(delayedProposal.statusCode).toBe(200);
    const delayedId = delayedProposal.body.data.id;
    expect((await hrA
      .post(`/api/v1/staff/admin/payroll/revisions/${delayedId}/hr-sign`)
      .send({})).statusCode).toBe(200);
    expect((await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${delayedId}/admin-sign`)
      .send({})).statusCode).toBe(200);
    expect((await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${delayedId}/apply`)
      .send({})).statusCode).toBe(200);
    const delayedReminders = await prisma.$queryRawUnsafe(
      `SELECT review_year, status, revision_id
         FROM annual_review_reminders
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
          AND review_year IN ($3::int, $4::int)
        ORDER BY review_year`,
      TENANT_A,
      STAFF_A,
      priorYear,
      currentYear,
    );
    expect(delayedReminders).toEqual([
      { review_year: priorYear, status: 'completed', revision_id: delayedId },
      { review_year: currentYear, status: 'pending', revision_id: null },
    ]);
    await prisma.$executeRawUnsafe(
      `UPDATE staff_salary SET basic_salary = 40000
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
  });

  it('creates one durable arrears identity and denies foreign or wrong-role retries without writes', async () => {
    const effectiveDate = new Date();
    effectiveDate.setUTCDate(1);
    effectiveDate.setUTCMonth(effectiveDate.getUTCMonth() - 2);
    const effectiveFrom = effectiveDate.toISOString().slice(0, 10);
    const proposed = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'increment',
        proposed_basic: 44000,
        effective_from: effectiveFrom,
        reason: 'CAN-016 arrears identity',
      });
    expect(proposed.statusCode).toBe(200);
    const revisionId = proposed.body.data.id;
    expect((await hrA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/hr-sign`)
      .send({})).statusCode).toBe(200);
    expect((await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/admin-sign`)
      .send({})).statusCode).toBe(200);
    expect((await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/apply`)
      .send({})).statusCode).toBe(200);
    await seedIssuedPayslipsForRevision(revisionId);
    const path = `/api/v1/staff/admin/payroll/revisions/${revisionId}/arrears`;
    const first = await adminA.post(path).set('Idempotency-Key', 'can016-arrears-repeat').send({});
    const replay = await adminA.post(path).set('Idempotency-Key', 'can016-arrears-repeat').send({});
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.result.id).toBe(first.body.data.result.id);

    const rowsBeforeDenials = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, revision_id, status
         FROM salary_arrears
        WHERE revision_id = $1::int`,
      revisionId,
    );
    expect(rowsBeforeDenials).toHaveLength(1);
    // The stamped row belongs to the acting tenant. This is the invariant the
    // former payrollTaxArrearsTenantScope unit cases existed for; proving it
    // here exercises the real auth, idempotency and command chain rather than
    // a mock's model of the service's internal call order.
    expect(rowsBeforeDenials[0].tenant_id).toBe(TENANT_A);

    const foreign = await adminB
      .post(path)
      .set('Idempotency-Key', 'can016-arrears-foreign')
      .send({});
    const wrongRole = await hrA
      .post(path)
      .set('Idempotency-Key', 'can016-arrears-wrong-role')
      .send({});
    expect(foreign.statusCode).toBe(403);
    expect(wrongRole.statusCode).toBe(403);
    expect(await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, revision_id, status
         FROM salary_arrears
        WHERE revision_id = $1::int`,
      revisionId,
    )).toEqual(rowsBeforeDenials);
    await prisma.$executeRawUnsafe(
      `UPDATE staff_salary SET basic_salary = 40000
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
  });

  it('records arrears-worker failure, reclaims an expired lease, and completes exactly once', async () => {
    // Precondition. processPendingSalaryRevisionArrearsWork is TENANT-wide, and
    // an earlier case here ('freezes an active salary baseline…') applies a
    // backdated cross-year revision whose arrears work item nothing drains.
    // Settle the queue first: a settled item is either completed or failed
    // behind a next_attempt_at backoff, and neither is claimable again. Without
    // this the claim counts below measure test order rather than this scenario.
    await processPendingSalaryRevisionArrearsWork({ tenantId: TENANT_A });

    const effectiveDate = new Date();
    effectiveDate.setUTCDate(1);
    effectiveDate.setUTCMonth(effectiveDate.getUTCMonth() - 2);
    const effectiveFrom = effectiveDate.toISOString().slice(0, 10);
    const proposed = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'increment',
        proposed_basic: 44500,
        effective_from: effectiveFrom,
        reason: 'CAN-016 leased arrears worker recovery',
      });
    expect(proposed.statusCode).toBe(200);
    const revisionId = proposed.body.data.id;
    expect((await hrA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/hr-sign`)
      .send({})).statusCode).toBe(200);
    expect((await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/admin-sign`)
      .send({})).statusCode).toBe(200);
    expect((await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/apply`)
      .send({})).statusCode).toBe(200);

    await prisma.$executeRawUnsafe(
      `DELETE FROM payslips
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
          AND make_date(year, month, 1) >= date_trunc('month', CURRENT_DATE)::date
            - INTERVAL '2 months'
          AND make_date(year, month, 1) < date_trunc('month', CURRENT_DATE)::date`,
      TENANT_A,
      STAFF_A,
    );
    const firstAttempt = await processPendingSalaryRevisionArrearsWork({
      tenantId: TENANT_A,
    });
    expect(firstAttempt.claimed).toBe(1);
    expect(firstAttempt.outcomes).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    const failedWork = (await prisma.$queryRawUnsafe(
      `SELECT id, status, attempt_count, next_attempt_at, last_error_hash,
              claim_token, claimed_at, lease_expires_at
         FROM salary_revision_arrears_work_items
        WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
      TENANT_A,
      revisionId,
    ))[0];
    expect(failedWork).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      claim_token: null,
      claimed_at: null,
      lease_expires_at: null,
    });
    expect(failedWork.last_error_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(failedWork.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    await prisma.$executeRawUnsafe(
      `UPDATE salary_revision_arrears_work_items
          SET status = 'processing',
              claim_token = 'c0de0016-00a0-4000-8000-0000000000f1'::uuid,
              claimed_at = clock_timestamp() - INTERVAL '10 minutes',
              lease_expires_at = clock_timestamp() - INTERVAL '5 minutes',
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND revision_id = $2::int
          AND status = 'pending' AND attempt_count = 1`,
      TENANT_A,
      revisionId,
    );
    await seedIssuedPayslipsForRevision(revisionId);

    const recovered = await processPendingSalaryRevisionArrearsWork({
      tenantId: TENANT_A,
    });
    expect(recovered.claimed).toBe(1);
    expect(recovered.outcomes).toEqual([
      expect.objectContaining({ outcome: 'completed' }),
    ]);
    const completedWork = (await prisma.$queryRawUnsafe(
      `SELECT status, attempt_count, arrears_id, outcome,
              claim_token, claimed_at, lease_expires_at
         FROM salary_revision_arrears_work_items
        WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
      TENANT_A,
      revisionId,
    ))[0];
    expect(completedWork).toMatchObject({
      status: 'completed',
      attempt_count: 2,
      claim_token: null,
      claimed_at: null,
      lease_expires_at: null,
    });
    expect(completedWork.outcome).toMatchObject({
      code: 'arrears_calculated',
      arrears_id: completedWork.arrears_id,
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM salary_arrears
        WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
      TENANT_A,
      revisionId,
    ))[0].count).toBe(1);
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM salary_arrears_command_receipts
        WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
      TENANT_A,
      revisionId,
    ))[0].count).toBe(1);

    const replay = await processPendingSalaryRevisionArrearsWork({
      tenantId: TENANT_A,
    });
    expect(replay.claimed).toBe(0);
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM salary_arrears
        WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
      TENANT_A,
      revisionId,
    ))[0].count).toBe(1);
    await prisma.$executeRawUnsafe(
      `UPDATE staff_salary SET basic_salary = 40000
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
  });

  it('durably resumes an expired bulk lease, closes reminders atomically, and keeps failed staff unapplied', async () => {
    const effectiveFrom = CURRENT_MONTH_START;
    const create = await adminA
      .post('/api/v1/staff/admin/payroll/bulk-revisions/create')
      .send({
        description: 'CAN-016 durable bulk resume',
        revision_type: 'increment',
        ...BULK_COHORT,
        increment_type: 'fixed',
        increment_value: 1000,
        effective_from: effectiveFrom,
      });
    expect(create.statusCode).toBe(200);
    const jobId = create.body.data.id;

    const wrongHr = await adminA
      .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/hr-sign`)
      .send({});
    const foreignHr = await hrB
      .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/hr-sign`)
      .send({});
    expect(wrongHr.statusCode).toBe(403);
    expect([403, 404]).toContain(foreignHr.statusCode);
    expect((await prisma.$queryRawUnsafe(
      `SELECT status, hr_signed_by FROM bulk_revision_jobs WHERE id = $1::int`,
      jobId,
    ))[0]).toMatchObject({ status: 'draft', hr_signed_by: null });

    const hrSigned = await hrA
      .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/hr-sign`)
      .send({});
    expect(hrSigned.statusCode).toBe(200);
    const foreignAdmin = await adminB
      .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/approve`)
      .send({});
    expect([403, 404]).toContain(foreignAdmin.statusCode);
    const approved = await adminA
      .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/approve`)
      .send({});
    expect(approved.statusCode).toBe(200);
    expect(approved.body.data.status).toBe('queued');

    await prisma.$executeRawUnsafe(
      `INSERT INTO annual_review_reminders (
         tenant_id, staff_uid, review_year, status,
         tenant_reconciliation_required, tenant_reconciliation_evidence
       )
       VALUES ($1::uuid, $2::uuid, $3::int, 'pending', false, '{}'::jsonb)
       ON CONFLICT (tenant_id, staff_uid, review_year)
       DO UPDATE SET status = 'pending', revision_id = NULL,
                     tenant_reconciliation_required = false`,
      TENANT_A,
      STAFF_A,
      new Date().getFullYear(),
    );
    const claimedAt = new Date('2098-01-01T00:00:00.000Z');
    const firstClaim = await claimBulkRevisionItems({
      tenantId: TENANT_A,
      jobId,
      leaseSeconds: 60,
    });
    expect(firstClaim).toHaveLength(1);
    await prisma.$executeRawUnsafe(
      `UPDATE bulk_revision_job_items
          SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND job_id = $2::int`,
      TENANT_A,
      jobId,
    );
    const resumed = await processBulkSalaryRevisionJobs({
      tenantId: TENANT_A,
      jobId,
      leaseSeconds: 60,
    });
    expect(resumed.claimed).toBe(1);
    const completed = (await prisma.$queryRawUnsafe(
      `SELECT status, staff_count, processed_count, failed_count
         FROM bulk_revision_jobs
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      jobId,
    ))[0];
    expect(completed).toMatchObject({ status: 'completed', failed_count: 0 });
    expect(Number(completed.processed_count)).toBe(Number(completed.staff_count));
    const reminder = (await prisma.$queryRawUnsafe(
      `SELECT status, revision_id
         FROM annual_review_reminders
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
          AND review_year = $3::int`,
      TENANT_A,
      STAFF_A,
      new Date().getFullYear(),
    ))[0];
    expect(reminder.status).toBe('completed');
    expect(reminder.revision_id).not.toBeNull();

    const failedCreate = await adminA
      .post('/api/v1/staff/admin/payroll/bulk-revisions/create')
      .send({
        description: 'CAN-016 atomic staff rollback',
        revision_type: 'increment',
        ...BULK_COHORT,
        increment_type: 'fixed',
        increment_value: 500,
        effective_from: effectiveFrom,
      });
    const failedJobId = failedCreate.body.data.id;
    await hrA
      .post(`/api/v1/staff/admin/payroll/bulk-revisions/${failedJobId}/hr-sign`)
      .send({});
    await adminA
      .post(`/api/v1/staff/admin/payroll/bulk-revisions/${failedJobId}/approve`)
      .send({});
    await prisma.$executeRawUnsafe(
      `UPDATE staff_salary
          SET basic_salary = basic_salary + 1
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
    await processBulkSalaryRevisionJobs({
      tenantId: TENANT_A,
      jobId: failedJobId,
      maxAttempts: 1,
    });
    const failedItem = (await prisma.$queryRawUnsafe(
      `SELECT status, revision_id, outcome
         FROM bulk_revision_job_items
        WHERE tenant_id = $1::uuid AND job_id = $2::int`,
      TENANT_A,
      failedJobId,
    ))[0];
    expect(failedItem).toMatchObject({
      status: 'reconciliation_required',
      revision_id: null,
    });
    expect(failedItem.outcome.code).toBe('bulk_revision_staff_failed');
    const partialRevisions = await prisma.$queryRawUnsafe(
      `SELECT id FROM salary_revisions
        WHERE tenant_id = $1::uuid AND reason = 'CAN-016 atomic staff rollback'`,
      TENANT_A,
    );
    expect(partialRevisions).toHaveLength(0);
    await prisma.$executeRawUnsafe(
      `UPDATE staff_salary
          SET basic_salary = 40000
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
  });

  it('preserves an annual reminder already linked to another revision during manual and bulk apply', async () => {
    const originalSalary = Number((await prisma.$queryRawUnsafe(
      `SELECT basic_salary FROM staff_salary
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    ))[0].basic_salary);
    try {
      const proposeApproved = async (reason, proposedBasic) => {
        const proposal = await adminA
          .post('/api/v1/staff/admin/payroll/revisions/propose')
          .send({
            staff_uid: STAFF_A,
            revision_type: 'increment',
            proposed_basic: proposedBasic,
            effective_from: CURRENT_MONTH_START,
            reason,
          });
        expect(proposal.statusCode).toBe(200);
        const revisionId = proposal.body.data.id;
        expect((await hrA
          .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/hr-sign`)
          .send({})).statusCode).toBe(200);
        expect((await adminA
          .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/admin-sign`)
          .send({})).statusCode).toBe(200);
        return revisionId;
      };
      const linkedRevisionId = await proposeApproved(
        'CAN-016 reminder owner',
        originalSalary + 200,
      );
      const manualRevisionId = await proposeApproved(
        'CAN-016 reminder manual contender',
        originalSalary + 100,
      );
      const reviewYear = new Date(`${CURRENT_MONTH_START}T00:00:00.000Z`).getUTCFullYear();
      await prisma.$executeRawUnsafe(
        `INSERT INTO annual_review_reminders (
           tenant_id, staff_uid, review_year, status, revision_id,
           tenant_reconciliation_required, tenant_reconciliation_evidence
         ) VALUES ($1::uuid, $2::uuid, $3::int, 'initiated', $4::int, false, '{}'::jsonb)
         ON CONFLICT (tenant_id, staff_uid, review_year)
         DO UPDATE SET status = 'initiated', revision_id = $4::int,
                       tenant_reconciliation_required = false`,
        TENANT_A,
        STAFF_A,
        reviewYear,
        linkedRevisionId,
      );
      expect((await adminA
        .post(`/api/v1/staff/admin/payroll/revisions/${manualRevisionId}/apply`)
        .send({})).statusCode).toBe(200);
      expect((await prisma.$queryRawUnsafe(
        `SELECT status, revision_id FROM annual_review_reminders
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
            AND review_year = $3::int`,
        TENANT_A,
        STAFF_A,
        reviewYear,
      ))[0]).toEqual({ status: 'initiated', revision_id: linkedRevisionId });

      await prisma.$executeRawUnsafe(
        `UPDATE staff_salary SET basic_salary = $3::numeric
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
        TENANT_A,
        STAFF_A,
        originalSalary,
      );
      const bulk = await adminA
        .post('/api/v1/staff/admin/payroll/bulk-revisions/create')
        .send({
          description: 'CAN-016 reminder bulk contender',
          revision_type: 'increment',
          ...BULK_COHORT,
          increment_type: 'fixed',
          increment_value: 100,
          effective_from: CURRENT_MONTH_START,
        });
      expect(bulk.statusCode).toBe(200);
      const jobId = bulk.body.data.id;
      expect((await hrA
        .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/hr-sign`)
        .send({})).statusCode).toBe(200);
      expect((await adminA
        .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/approve`)
        .send({})).statusCode).toBe(200);
      await processBulkSalaryRevisionJobs({ tenantId: TENANT_A, jobId });
      expect((await prisma.$queryRawUnsafe(
        `SELECT status, revision_id FROM annual_review_reminders
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
            AND review_year = $3::int`,
        TENANT_A,
        STAFF_A,
        reviewYear,
      ))[0]).toEqual({ status: 'initiated', revision_id: linkedRevisionId });
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE staff_salary SET basic_salary = $3::numeric
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
        TENANT_A,
        STAFF_A,
        originalSalary,
      );
    }
  });

  it('parks suspended-tenant activation, arrears, and bulk work without a financial mutation', async () => {
    const originalSalary = Number((await prisma.$queryRawUnsafe(
      `SELECT basic_salary FROM staff_salary
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    ))[0].basic_salary);
    const priorMonth = new Date();
    priorMonth.setUTCDate(1);
    priorMonth.setUTCMonth(priorMonth.getUTCMonth() - 1);
    try {
      const backdated = await adminA
        .post('/api/v1/staff/admin/payroll/revisions/propose')
        .send({
          staff_uid: STAFF_A,
          revision_type: 'increment',
          proposed_basic: originalSalary + 500,
          effective_from: priorMonth.toISOString().slice(0, 10),
          reason: 'CAN-016 inactive tenant arrears parking',
        });
      expect(backdated.statusCode).toBe(200);
      const backdatedId = backdated.body.data.id;
      expect((await hrA
        .post(`/api/v1/staff/admin/payroll/revisions/${backdatedId}/hr-sign`)
        .send({})).statusCode).toBe(200);
      expect((await adminA
        .post(`/api/v1/staff/admin/payroll/revisions/${backdatedId}/admin-sign`)
        .send({})).statusCode).toBe(200);
      expect((await adminA
        .post(`/api/v1/staff/admin/payroll/revisions/${backdatedId}/apply`)
        .send({})).statusCode).toBe(200);

      const future = await adminA
        .post('/api/v1/staff/admin/payroll/revisions/propose')
        .send({
          staff_uid: STAFF_A,
          revision_type: 'increment',
          proposed_basic: originalSalary + 1000,
          effective_from: '2099-12-01',
          reason: 'CAN-016 inactive tenant activation parking',
        });
      expect(future.statusCode).toBe(200);
      const futureId = future.body.data.id;
      expect((await hrA
        .post(`/api/v1/staff/admin/payroll/revisions/${futureId}/hr-sign`)
        .send({})).statusCode).toBe(200);
      expect((await adminA
        .post(`/api/v1/staff/admin/payroll/revisions/${futureId}/admin-sign`)
        .send({})).statusCode).toBe(200);

      const bulk = await adminA
        .post('/api/v1/staff/admin/payroll/bulk-revisions/create')
        .send({
          description: 'CAN-016 inactive tenant bulk parking',
          revision_type: 'increment',
          ...BULK_COHORT,
          increment_type: 'fixed',
          increment_value: 100,
          effective_from: CURRENT_MONTH_START,
        });
      expect(bulk.statusCode).toBe(200);
      const jobId = bulk.body.data.id;
      expect((await hrA
        .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/hr-sign`)
        .send({})).statusCode).toBe(200);
      expect((await adminA
        .post(`/api/v1/staff/admin/payroll/bulk-revisions/${jobId}/approve`)
        .send({})).statusCode).toBe(200);
      const salaryBeforeParking = Number((await prisma.$queryRawUnsafe(
        `SELECT basic_salary FROM staff_salary
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
        TENANT_A,
        STAFF_A,
      ))[0].basic_salary);

      await prisma.$executeRawUnsafe(
        `UPDATE tenants SET status = 'suspended', updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        TENANT_A,
      );
      const parked = await parkInactiveTenantPayrollRevisionWork();
      expect(parked.tenants_parked).toBeGreaterThanOrEqual(1);
      expect(parked.activation_jobs).toBeGreaterThanOrEqual(1);
      expect(parked.arrears_work_items).toBeGreaterThanOrEqual(1);
      expect(parked.bulk_jobs).toBeGreaterThanOrEqual(1);
      expect(parked.bulk_items).toBeGreaterThanOrEqual(1);
      expect((await prisma.$queryRawUnsafe(
        `SELECT status, outcome FROM salary_revision_activation_jobs
          WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
        TENANT_A,
        futureId,
      ))[0]).toMatchObject({
        status: 'reconciliation_required',
        outcome: { reason: 'tenant_inactive', tenant_status: 'suspended' },
      });
      expect((await prisma.$queryRawUnsafe(
        `SELECT status, outcome FROM salary_revision_arrears_work_items
          WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
        TENANT_A,
        backdatedId,
      ))[0]).toMatchObject({
        status: 'reconciliation_required',
        outcome: { reason: 'tenant_inactive', tenant_status: 'suspended' },
      });
      expect((await prisma.$queryRawUnsafe(
        `SELECT status, tenant_reconciliation_evidence
           FROM bulk_revision_jobs
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT_A,
        jobId,
      ))[0]).toMatchObject({
        status: 'reconciliation_required',
        tenant_reconciliation_evidence: {
          reason: 'tenant_inactive',
          tenant_status: 'suspended',
        },
      });
      const parkedItems = await prisma.$queryRawUnsafe(
        `SELECT status, outcome FROM bulk_revision_job_items
          WHERE tenant_id = $1::uuid AND job_id = $2::int`,
        TENANT_A,
        jobId,
      );
      expect(parkedItems.length).toBeGreaterThan(0);
      expect(parkedItems.every(item => (
        item.status === 'reconciliation_required'
        && item.outcome.reason === 'tenant_inactive'
      ))).toBe(true);
      expect(Number((await prisma.$queryRawUnsafe(
        `SELECT basic_salary FROM staff_salary
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
        TENANT_A,
        STAFF_A,
      ))[0].basic_salary)).toBe(salaryBeforeParking);
      const replay = await parkInactiveTenantPayrollRevisionWork();
      expect(replay.activation_jobs + replay.arrears_work_items
        + replay.bulk_jobs + replay.bulk_items).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE tenants SET status = 'active', updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        TENANT_A,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE staff_salary SET basic_salary = $3::numeric
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
        TENANT_A,
        STAFF_A,
        originalSalary,
      );
    }
  });

  it('denies every cross-tenant lifecycle action without mutating revision or salary state', async () => {
    const deniedProposal = await adminB
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'increment',
        proposed_basic: 45000,
        effective_from: '2099-08-01',
        reason: 'CAN-016 denied cross-tenant proposal',
      });
    expect(deniedProposal.statusCode).toBe(403);
    const deniedRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM salary_revisions
        WHERE reason = 'CAN-016 denied cross-tenant proposal'`,
    );
    expect(deniedRows[0].count).toBe(0);

    const proposed = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'increment',
        proposed_basic: 45000,
        effective_from: '2099-08-01',
        reason: 'CAN-016 owned lifecycle',
      });
    expect(proposed.statusCode).toBe(200);
    const revisionId = proposed.body.data.id;
    expect(String((await revisionState(revisionId)).tenant_id)).toBe(TENANT_A);

    const deniedDetail = await adminB.get(
      `/api/v1/staff/admin/payroll/revisions/${revisionId}`,
    );
    expect(deniedDetail.statusCode).toBe(403);

    const deniedHrSign = await hrB
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/hr-sign`)
      .send({ comment: 'cross-tenant signer' });
    expect(deniedHrSign.statusCode).toBe(403);
    expect(await revisionState(revisionId)).toMatchObject({
      status: 'pending_hr',
      hr_signed_by: null,
    });

    const ownedHrSign = await hrA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/hr-sign`)
      .send({ comment: 'owned HR signer' });
    expect(ownedHrSign.statusCode).toBe(200);

    const deniedAdminSign = await adminB
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/admin-sign`)
      .send({ comment: 'cross-tenant countersigner' });
    expect(deniedAdminSign.statusCode).toBe(403);
    expect(await revisionState(revisionId)).toMatchObject({
      status: 'pending_admin',
      admin_signed_by: null,
    });

    const ownedAdminSign = await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/admin-sign`)
      .send({ comment: 'owned admin countersigner' });
    expect(ownedAdminSign.statusCode).toBe(200);

    const deniedApply = await adminB
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/apply`)
      .send({});
    expect(deniedApply.statusCode).toBe(403);
    expect((await revisionState(revisionId)).status).toBe('approved');
    const salaryBeforeOwnedApply = await prisma.$queryRawUnsafe(
      `SELECT basic_salary FROM staff_salary
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
    expect(Number(salaryBeforeOwnedApply[0].basic_salary)).toBe(40000);

    const ownedApply = await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${revisionId}/apply`)
      .send({});
    expect(ownedApply.statusCode).toBe(200);
    expect(ownedApply.body.data).toMatchObject({
      revision_id: String(revisionId),
      staff_uid: STAFF_A,
      status: 'scheduled',
      effective_from: '2099-08-01',
    });
    expect((await revisionState(revisionId)).status).toBe('approved');
    const salaryAfterOwnedApply = await prisma.$queryRawUnsafe(
      `SELECT basic_salary FROM staff_salary
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT_A,
      STAFF_A,
    );
    expect(Number(salaryAfterOwnedApply[0].basic_salary)).toBe(40000);
    expect((await prisma.$queryRawUnsafe(
      `SELECT status, effective_on
         FROM salary_revision_activation_jobs
        WHERE tenant_id = $1::uuid AND revision_id = $2::int`,
      TENANT_A,
      revisionId,
    ))[0]).toMatchObject({ status: 'queued' });

    const rejectCandidate = await adminA
      .post('/api/v1/staff/admin/payroll/revisions/propose')
      .send({
        staff_uid: STAFF_A,
        revision_type: 'bonus',
        bonus_amount: 5000,
        // Required alongside bonus_amount for a bonus revision
        // (salaryRevisionController.proposeRevision:288-298); without it this
        // proposal 400s and the cross-tenant reject denial below never runs
        // against a real revision.
        bonus_reason: 'CAN-016 owned reject lifecycle bonus',
        effective_from: '2099-09-01',
        reason: 'CAN-016 owned reject lifecycle',
      });
    expect(rejectCandidate.statusCode).toBe(200);
    const rejectId = rejectCandidate.body.data.id;

    const deniedReject = await adminB
      .post(`/api/v1/staff/admin/payroll/revisions/${rejectId}/reject`)
      .send({ reason: 'cross-tenant rejecter' });
    expect(deniedReject.statusCode).toBe(403);
    expect(await revisionState(rejectId)).toMatchObject({
      status: 'pending_hr',
      rejected_by: null,
    });

    const ownedReject = await adminA
      .post(`/api/v1/staff/admin/payroll/revisions/${rejectId}/reject`)
      .send({ reason: 'owned rejecter' });
    expect(ownedReject.statusCode).toBe(200);
    expect((await revisionState(rejectId)).status).toBe('rejected');
  });
});
