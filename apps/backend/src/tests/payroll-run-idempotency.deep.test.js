// POST /staff/admin/payroll/run is mounted with
// `requireIdempotencyKey({ required: true, scope: 'payroll_run' })`.
//
// This suite pins the three properties that guard is there to provide, end to
// end over HTTP against a real database:
//
//   1. No header  → 400. The guard is fail-closed; a client that has not been
//      wired up must be told so, not silently allowed to generate payroll.
//   2. Same key, same body → the ORIGINAL response is replayed, and the
//      database still holds exactly one run and one payslip per staff member.
//      This is the property a double-click or a retry of a request whose 2xx
//      was lost in transit depends on.
//   3. A different key for the same already-completed month is NOT a replay —
//      it reaches the handler and gets the handler's own 409. The key collapses
//      retries; it must not swallow a genuinely separate request.
//
// Kept separate from payroll-contract.deep.test.js on purpose: that suite runs
// the whole sign-off lifecycle and is currently blocked further down by an
// unrelated hr-sign authorization defect, which would hide this property.

import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import {
  provisionTenantKek,
  resetTenantKekCacheForTesting,
} from '../services/security/tenantKekProvider.js';
import { generateTestToken } from './testClient.js';

process.env.FIELD_ENCRYPTION_MASTER_KEK ||= 'payroll-run-idempotency-test-only-master-kek-material';

const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const BASE = '/api/v1/staff/admin';

// Far-future month/year so this suite never collides with a real run row
// (uniq_payroll_runs_tenant_month_year) or with payroll-contract.deep.test.js.
const RUN_MONTH = 3;
const RUN_YEAR = 2097;

const STAFF_UID = 'a0510001-0001-4d00-8d00-a05100000001';
const ADMIN_UID = 'a0510002-0002-4d00-8d00-a05100000002';
const STAFF_PHONE = '9502000001';
const ADMIN_PHONE = '9502000002';
const UIDS = [STAFF_UID, ADMIN_UID];

const KEY = 'payroll-run-idem-deep:2097-03:attempt-1';
const OTHER_KEY = 'payroll-run-idem-deep:2097-03:attempt-2';

function adminClient() {
  const token = generateTestToken('ADMIN', { uid: ADMIN_UID, id: undefined, phone: ADMIN_PHONE });
  return p => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
}

async function cleanup() {
  const runScope = `SELECT id FROM payroll_runs WHERE (month = ${RUN_MONTH} AND year = ${RUN_YEAR}) OR generated_by = ANY($1::uuid[])`;
  const payslipScope = `SELECT id FROM payslips WHERE staff_uid = ANY($1::uuid[]) OR payroll_run_id IN (${runScope})`;
  const stmts = [
    `DELETE FROM payroll_run_staff_results WHERE payslip_id IN (${payslipScope}) OR payroll_run_id IN (${runScope})`,
    `DELETE FROM payslip_documents WHERE payslip_id IN (${payslipScope}) OR payroll_run_id IN (${runScope})`,
    `DELETE FROM payslips WHERE staff_uid = ANY($1::uuid[]) OR payroll_run_id IN (${runScope})`,
    `DELETE FROM staff_salary WHERE staff_uid = ANY($1::uuid[])`,
    // payroll_runs ⇄ payroll_run_attempts is an FK cycle and attempt_token is
    // NOT NULL, so neither side can go first — delete both in ONE statement so
    // the FK triggers fire once, at end of statement. See the same note in
    // payroll-contract.deep.test.js.
    `WITH doomed AS (
       SELECT id, tenant_id FROM payroll_runs
        WHERE (month = ${RUN_MONTH} AND year = ${RUN_YEAR}) OR generated_by = ANY($1::uuid[])
     ), del_attempts AS (
       DELETE FROM payroll_run_attempts a USING doomed d
        WHERE a.payroll_run_id = d.id AND a.tenant_id = d.tenant_id
        RETURNING a.payroll_run_id
     )
     DELETE FROM payroll_runs r USING doomed d
      WHERE r.id = d.id AND r.tenant_id = d.tenant_id`,
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
  ];
  for (const sql of stmts) {
    await prisma.$executeRawUnsafe(sql, UIDS).catch(() => {});
  }
  // The idempotency claim outlives the payroll rows it guarded; a leftover row
  // would replay the previous run's (now deleted) run_id on the next execution.
  await prisma.$executeRawUnsafe(
    `DELETE FROM idempotency_keys WHERE request_key LIKE 'payroll-run-idem-deep:%'`,
  ).catch(() => {});
}

describe('POST /payroll/run — Idempotency-Key contract', () => {
  let post;

  beforeAll(async () => {
    await cleanup();
    resetTenantKekCacheForTesting();
    // executePayrollRun loads the tenant KEK before writing a payslip; a fresh
    // database has none.
    await provisionTenantKek(TENANT_ID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at) VALUES
         ($1::uuid, $2, 'Payroll Idem Staff', 'GENERAL_STAFF', true, NOW()),
         ($3::uuid, $4, 'Payroll Idem Admin', 'ADMIN', true, NOW())`,
      STAFF_UID, STAFF_PHONE, ADMIN_UID, ADMIN_PHONE,
    );
    post = adminClient();

    const salary = await post(`${BASE}/payroll/salary/${STAFF_UID}`).send({
      basic_salary: 30000, employee_id: 'PAYIDEM-001', department: 'General Medicine',
    });
    expect(salary.statusCode).toBe(200);
  }, 60000);

  afterAll(async () => {
    await cleanup();
    resetTenantKekCacheForTesting();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  it('rejects a run with no Idempotency-Key instead of generating payroll', async () => {
    const res = await post(`${BASE}/payroll/run`).send({ month: RUN_MONTH, year: RUN_YEAR });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Idempotency-Key header is required/i);
    // Fail-closed means nothing ran.
    const runs = await prisma.$queryRawUnsafe(
      `SELECT id FROM payroll_runs WHERE tenant_id = $1::uuid AND month = $2::int AND year = $3::int`,
      TENANT_ID, RUN_MONTH, RUN_YEAR,
    );
    expect(runs).toHaveLength(0);
  }, 60000);

  it('replays an identical retry instead of running payroll a second time', async () => {
    const first = await post(`${BASE}/payroll/run`)
      .set('Idempotency-Key', KEY)
      .send({ month: RUN_MONTH, year: RUN_YEAR });
    expect(first.statusCode).toBe(200);
    expect(first.body.data.processed).toBeGreaterThanOrEqual(1);
    const runId = first.body.data.run_id;

    const replay = await post(`${BASE}/payroll/run`)
      .set('Idempotency-Key', KEY)
      .send({ month: RUN_MONTH, year: RUN_YEAR });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);

    // The response being identical is not enough — a re-execution could also
    // produce an identical body. Assert the DATABASE did not double-run.
    const runs = await prisma.$queryRawUnsafe(
      `SELECT id FROM payroll_runs WHERE tenant_id = $1::uuid AND month = $2::int AND year = $3::int`,
      TENANT_ID, RUN_MONTH, RUN_YEAR,
    );
    expect(runs).toHaveLength(1);
    expect(Number(runs[0].id)).toBe(runId);

    const perStaff = await prisma.$queryRawUnsafe(
      `SELECT staff_uid, COUNT(*)::int AS n FROM payslips
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2::int
        GROUP BY staff_uid`,
      TENANT_ID, runId,
    );
    expect(perStaff.length).toBeGreaterThanOrEqual(1);
    for (const row of perStaff) expect(row.n).toBe(1);
    expect(perStaff.some(row => row.staff_uid === STAFF_UID)).toBe(true);
  }, 120000);

  it('does not swallow a genuinely separate attempt carrying a different key', async () => {
    // Same month, new key → not a replay. The request reaches the handler,
    // which refuses because the run is already complete. A 409 here (rather
    // than a silently replayed 200) is what proves the key scopes retries only.
    const res = await post(`${BASE}/payroll/run`)
      .set('Idempotency-Key', OTHER_KEY)
      .send({ month: RUN_MONTH, year: RUN_YEAR });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/already complete/i);
  }, 60000);

  it('rejects a key reused against a different request body', async () => {
    // The backend hashes the body; the same key with different content is an
    // idempotency violation, not a replay. This is why clients must rotate the
    // key whenever the payload changes.
    const res = await post(`${BASE}/payroll/run`)
      .set('Idempotency-Key', KEY)
      .send({ month: RUN_MONTH, year: RUN_YEAR + 1 });

    expect(res.statusCode).toBe(422);
    expect(res.body.message).toMatch(/different request body/i);
  }, 60000);
});
