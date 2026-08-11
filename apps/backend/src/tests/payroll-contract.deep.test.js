// Live OpenAPI contract deep-test for the PAYROLL surface — the biggest slice in
// the Phase-5 non-money program. Drives the full admin + HR-self-service payroll
// lifecycle over HTTP (supertest) and validates EVERY successful response
// against the committed 200 $ref schemas in src/docs/openapi.json (via
// assertResponse). This is the runtime contract gate for the 47 typed /payroll
// ops; it proves the live payloads actually match the typed schemas the
// admin/codegen consumers rely on — not just that the spec lints.
//
// The single most valuable thing it proves is the per-field Decimal-STRING vs
// JS-computed-NUMBER classification: assertResponse fails (ajv) the instant a
// field typed `string` comes back a number, or vice versa. Examples baked into
// the overlay (and exercised here):
//   • payslip/run/config money fields are NUMERIC columns read back via Prisma
//     select / SELECT * → JSON STRINGS.
//   • runPayroll.total_gross/total_net are .toFixed(2) → STRINGS (formatting).
//   • GratuityStatus.years_of_service / projected_gratuity are JS Math.round
//     → NUMBERS.
//   • ComparisonPayslip money fields are parseFloat'd in JS → NUMBERS, but its
//     lop_days/overtime_hours are emitted raw from the Decimal column → STRINGS.
//   • applyRevision.revision_id / approveBulkRevision.id are the raw
//     req.params.id STRING (not the int column).
//
// DISTINCT-SCHEMA coverage: the 47 typed ops collapse onto ~40 distinct response
// schemas (e.g. the 2 run-sign ops share PayrollRunResponse; hr-sign / admin-sign
// / reject revisions share SalaryRevisionSignResponse; the 3 FnF ops share
// FnFDetailResponse). This suite asserts at least one live payload against every
// distinct response schema. See the coverage ledger comment at the bottom.
//
// Modelled on discharge-summaries-contract.deep.test.js (auth bootstrap +
// assertResponse + direct-prisma fixtures + cleanup).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { assertResponse } from './helpers/assertSchema.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_BASE = '/api/v1/staff/admin';
const HR_BASE = '/api/v1/staff/hr';

// Far-future month/year so this run never collides with a real payroll_runs row
// (uniq_payroll_runs_tenant_month_year) seeded by other suites.
const RUN_MONTH = 7;
const RUN_YEAR = 2099;
const FY = '2098-99';

// Unique uid / phone / employee_id prefixes so this suite never collides.
// (Hex-only v4 UUIDs — 'pay…' literals are not valid UUIDs and 22P02 the cast.)
const STAFF_UID = 'a0500001-0001-4d00-8d00-a05000000001'; // main GENERAL_STAFF: salary config + payslip + HR self-service
const STAFF2_UID = 'a0500002-0002-4d00-8d00-a05000000002'; // fresh GENERAL_STAFF: no payslip → tax summary 404
const HR_UID = 'a0500003-0003-4d00-8d00-a05000000003'; // ADMIN-role HR signer (hr-sign)
const ADMIN_UID = 'a0500004-0004-4d00-8d00-a05000000004'; // ADMIN-role admin signer (admin-sign) — distinct uid for SoD

const STAFF_PHONE = '9501000001';
const STAFF2_PHONE = '9501000002';
const HR_PHONE = '9501000003';
const ADMIN_PHONE = '9501000004';

// SEPARATION OF DUTIES: payroll-run + salary-revision admin-sign reject (403)
// when the admin signer == the hr signer (uid comparison in
// adminSignPayrollRun / adminSignRevision). Both signers are ADMIN role (the
// staffAccessGuard short-circuits for ADMIN; HR role is NOT in the role-policy
// graph and is denied), but carry DISTINCT uids — that satisfies the guard.
function mkClient(role, uid, phone) {
  const token = generateTestToken(role, { uid, id: undefined, phone });
  return {
    uid,
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  const uids = [STAFF_UID, STAFF2_UID, HR_UID, ADMIN_UID];
  // The payslip set we must tear down = our staff's payslips PLUS every payslip in
  // OUR run. runPayroll processes EVERY staff with an active salary_salary config,
  // so a foreign staff row that happens to live in the shared QA cluster gets a
  // payslip in our run too — and its child rows (arrears/encashments/queries/
  // advance_deductions) are NOT covered by a staff_uid-scoped delete. So scope the
  // four payslip-child FKs by payslip_id over (our staff OR our run) to avoid a
  // dangling-FK 23503 when the payslips delete runs.
  const PS_SET = `SELECT id FROM payslips WHERE staff_uid = ANY($1::uuid[]) OR payroll_run_id IN (SELECT id FROM payroll_runs WHERE month = ${RUN_MONTH} AND year = ${RUN_YEAR})`;
  // Child rows first (FK + tidy). Each guarded so a missing table never aborts.
  const stmts = [
    `DELETE FROM payslip_query_replies WHERE query_id IN (SELECT id FROM payslip_queries WHERE staff_uid = ANY($1::uuid[]) OR payslip_id IN (${PS_SET}))`,
    `DELETE FROM payslip_queries WHERE staff_uid = ANY($1::uuid[]) OR payslip_id IN (${PS_SET})`,
    `DELETE FROM advance_deductions WHERE staff_uid = ANY($1::uuid[]) OR payslip_id IN (${PS_SET})`,
    `DELETE FROM salary_advances WHERE staff_uid = ANY($1::uuid[])`,
    `DELETE FROM salary_arrears WHERE staff_uid = ANY($1::uuid[]) OR payslip_id IN (${PS_SET})`,
    `DELETE FROM leave_encashments WHERE staff_uid = ANY($1::uuid[]) OR payslip_id IN (${PS_SET})`,
    `DELETE FROM full_final_settlements WHERE staff_uid = ANY($1::uuid[])`,
    `DELETE FROM investment_declarations WHERE staff_uid = ANY($1::uuid[])`,
    `DELETE FROM annual_tax_summaries WHERE staff_uid = ANY($1::uuid[])`,
    `DELETE FROM annual_review_reminders WHERE staff_uid = ANY($1::uuid[])`,
    `DELETE FROM salary_revisions WHERE staff_uid = ANY($1::uuid[])`,
    // payslips reference payroll_runs (payroll_run_id FK) AND staff_uid — clear
    // both our staff's rows and any row tied to our run before the run delete.
    `DELETE FROM payslips WHERE staff_uid = ANY($1::uuid[]) OR payroll_run_id IN (SELECT id FROM payroll_runs WHERE month = ${RUN_MONTH} AND year = ${RUN_YEAR})`,
    `DELETE FROM staff_salary WHERE staff_uid = ANY($1::uuid[])`,
    // payroll_runs.generated_by / hr_approved_by / admin_approved_by all FK to
    // users — delete by our month/year AND by any reference to our users so the
    // subsequent users delete never trips payroll_runs_generated_by_fkey.
    `DELETE FROM payroll_runs WHERE (month = ${RUN_MONTH} AND year = ${RUN_YEAR}) OR generated_by = ANY($1::uuid[]) OR hr_approved_by = ANY($1::uuid[]) OR admin_approved_by = ANY($1::uuid[])`,
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
  ];
  for (const sql of stmts) {
    await prisma.$executeRawUnsafe(sql, uids).catch(() => {});
  }
  // bulk_revision_jobs created by this suite (no staff_uid FK) — clear by the
  // sentinel description so reruns stay clean.
  await prisma.$executeRawUnsafe(
    `DELETE FROM bulk_revision_jobs WHERE description = 'PAYROLL_CONTRACT_DEEP_TEST bulk'`,
  ).catch(() => {});
}

describe('Payroll — live OpenAPI contract deep test (admin + HR self-service lifecycle)', () => {
  let admin; // ADMIN signer (admin-sign side of dual control)
  let hr; // ADMIN-role HR signer (hr-sign side); distinct uid
  let staff; // GENERAL_STAFF token whose uid owns the seeded payslip
  let staff2; // fresh GENERAL_STAFF token (no payslip) for the missing-summary contract

  let runId;
  let payslipId;
  let revisionId; // increment revision → drives full sign/apply lifecycle
  let arrearsRevisionId; // applied+backdated revision → drives arrears
  let bulkRevisionId;
  let declarationId; // submitted via HR self-service → admin approve
  let queryId; // raised via HR self-service → admin reply

  beforeAll(async () => {
    await cleanup();
    // Seed users: 1 STAFF (owns payslip), 1 STAFF (fresh), 2 ADMINs (signers).
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at) VALUES
         ($1::uuid, $2, 'Payroll Contract Staff',  'GENERAL_STAFF', true, NOW()),
         ($3::uuid, $4, 'Payroll Contract Staff2', 'GENERAL_STAFF', true, NOW()),
         ($5::uuid, $6, 'Payroll Contract HR',     'ADMIN', true, NOW()),
         ($7::uuid, $8, 'Payroll Contract Admin',  'ADMIN', true, NOW())`,
      STAFF_UID, STAFF_PHONE, STAFF2_UID, STAFF2_PHONE, HR_UID, HR_PHONE, ADMIN_UID, ADMIN_PHONE,
    );

    admin = mkClient('ADMIN', ADMIN_UID, ADMIN_PHONE);
    hr = mkClient('ADMIN', HR_UID, HR_PHONE);
    // GENERAL_STAFF (not the bare 'STAFF' placeholder): only a concrete staff
    // role present in BOTH the staffHRRoutes RBAC allowlist AND the role-policy
    // graph passes the wrapAutoRBAC gate + reaches staffAccessGuard, where
    // allow_self + isSelf grants the self-service payroll path. A bare 'STAFF'
    // token is rejected by RBAC (403 'Forbidden') before the guard ever runs.
    staff = mkClient('GENERAL_STAFF', STAFF_UID, STAFF_PHONE);
    staff2 = mkClient('GENERAL_STAFF', STAFF2_UID, STAFF2_PHONE);
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  // ════════════════════════════════════════════════════════════════════════
  // 1. salary-config: upsert → get → staff list
  // ════════════════════════════════════════════════════════════════════════
  it('salary-config: upsert + fetch config + staff list validate their schemas', async () => {
    // POST /payroll/salary/{staffUid} → StaffSalaryConfigResponse (basic_salary
    // is a STRING from the NUMERIC column even though we sent a number).
    const upsert = await admin.post(`${ADMIN_BASE}/payroll/salary/${STAFF_UID}`).send({
      basic_salary: 40000,
      hra_pct: 40,
      da_pct: 10,
      special_allowance: 5000,
      transport_allowance: 1600,
      medical_allowance: 1250,
      pf_employee_pct: 12,
      esi_applicable: false,
      professional_tax: 200,
      tds_monthly: 1000,
      designation: 'Staff Nurse',
      department: 'General Medicine',
      employee_id: 'PAYDEEP-001',
      date_of_joining: '2090-01-01',
    });
    expect(upsert.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/salary/{staffUid}`, upsert.body);
    expect(typeof upsert.body.data.basic_salary).toBe('string'); // Decimal-string trap
    expect(upsert.body.data.staff_uid).toBe(STAFF_UID);

    // Second staff also gets a config (so runPayroll produces a payslip for them
    // too — though we only need STAFF_UID's payslip; STAFF2 stays without an
    // ISSUED payslip for the missing-summary contract by NOT issuing this run for
    // them. They are in the run, but the contract uses an FY with no payslips.
    const upsert2 = await admin.post(`${ADMIN_BASE}/payroll/salary/${STAFF2_UID}`).send({
      basic_salary: 25000, employee_id: 'PAYDEEP-002', department: 'General Medicine',
    });
    expect(upsert2.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/salary/{staffUid}`, upsert2.body);

    // GET /payroll/salary/{staffUid} → StaffSalaryConfigViewResponse (loose
    // 3-way union; the populated branch here).
    const getCfg = await admin.get(`${ADMIN_BASE}/payroll/salary/${STAFF_UID}`);
    expect(getCfg.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/salary/{staffUid}`, getCfg.body);
    expect(getCfg.body.data.staff_uid).toBe(STAFF_UID);
    expect(typeof getCfg.body.data.basic_salary).toBe('string');

    // GET /payroll/staff → StaffForPayrollResponse (list; STRICT item).
    const staffList = await admin.get(`${ADMIN_BASE}/payroll/staff?search=PAYDEEP`);
    expect(staffList.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/staff`, staffList.body);
    expect(Array.isArray(staffList.body.data)).toBe(true);
    const mine = staffList.body.data.find((s) => s.uid === STAFF_UID);
    expect(mine).toBeDefined();
    expect(mine.has_salary_config).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════
  // 2. run lifecycle: run → list → detail → edit → hr-sign → admin-sign → issue
  //    NB real dependency order: a payslip can only be edited while DRAFT and
  //    BEFORE any signature; issue requires BOTH signatures. So edit precedes
  //    the signatures and issue is last (the prompt's "issue then edit" listing
  //    is the op SET, not the executable order).
  // ════════════════════════════════════════════════════════════════════════
  it('run lifecycle: run/list/detail/edit/dual-sign/issue validate their schemas', async () => {
    // POST /payroll/run → PayrollRunResultResponse. total_gross/total_net are
    // .toFixed(2) STRINGS; run_id/processed/failed integers.
    const run = await admin.post(`${ADMIN_BASE}/payroll/run`).send({ month: RUN_MONTH, year: RUN_YEAR });
    expect(run.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/run`, run.body);
    expect(typeof run.body.data.total_gross).toBe('string'); // toFixed string trap
    expect(typeof run.body.data.run_id).toBe('number');
    runId = run.body.data.run_id;
    expect(run.body.data.processed).toBeGreaterThanOrEqual(1);

    // GET /payroll/runs → PayrollRunsResponse (loose SELECT * list).
    const runs = await admin.get(`${ADMIN_BASE}/payroll/runs`);
    expect(runs.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/runs`, runs.body);
    const myRun = runs.body.data.find((r) => r.id === runId);
    expect(myRun).toBeDefined();
    expect(myRun.status).toBe('completed'); // run flips processing→completed
    expect(myRun.month).toBe(RUN_MONTH);

    // GET /payroll/runs/{runId} → PayrollRunDetailResponse ({ run, payslips }).
    const detail = await admin.get(`${ADMIN_BASE}/payroll/runs/${runId}`);
    expect(detail.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/runs/{runId}`, detail.body);
    expect(detail.body.data.run.id).toBe(runId);
    expect(Array.isArray(detail.body.data.payslips)).toBe(true);
    const myPayslip = detail.body.data.payslips.find((p) => p.staff_uid === STAFF_UID);
    expect(myPayslip).toBeDefined();
    expect(myPayslip.status).toBe('draft');
    expect(typeof myPayslip.gross_salary).toBe('string'); // payslip Decimal-string
    payslipId = myPayslip.id;

    // POST /payroll/payslips/{id}/edit → PayslipDetailResponse. Must run while the
    // payslip is DRAFT and the run is UNSIGNED. gross/total_deductions/net are
    // recomputed in JS but read BACK from NUMERIC columns → STRINGS.
    const edit = await admin.post(`${ADMIN_BASE}/payroll/payslips/${payslipId}/edit`).send({
      edit_reason: 'Contract deep-test manual edit',
      special_allowance_earned: 6000,
    });
    expect(edit.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/payslips/{id}/edit`, edit.body);
    expect(edit.body.data.id).toBe(payslipId);
    expect(edit.body.data.manually_edited).toBe(true);
    expect(typeof edit.body.data.gross_salary).toBe('string');

    // POST /payroll/runs/{runId}/hr-sign (HR signer) → PayrollRunResponse.
    const hrSign = await hr.post(`${ADMIN_BASE}/payroll/runs/${runId}/hr-sign`).send({ comment: 'HR ok' });
    expect(hrSign.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/runs/{runId}/hr-sign`, hrSign.body);
    expect(hrSign.body.data.hr_approved_at).toBeTruthy();
    expect(hrSign.body.data.hr_approved_by).toBe(HR_UID);

    // POST /payroll/runs/{runId}/admin-sign (DIFFERENT admin) → PayrollRunResponse,
    // status flips to 'approved'. SoD: admin uid !== hr uid (else 403).
    const adminSign = await admin.post(`${ADMIN_BASE}/payroll/runs/${runId}/admin-sign`).send({ comment: 'Admin ok' });
    expect(adminSign.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/runs/{runId}/admin-sign`, adminSign.body);
    expect(adminSign.body.data.status).toBe('approved');
    expect(adminSign.body.data.admin_approved_by).toBe(ADMIN_UID);
    expect(adminSign.body.data.approval_hash).toBeTruthy();

    // POST /payroll/issue → IssuePayslipsResponse ({ issued } integer). Requires
    // both signatures (now satisfied). Flips the draft payslips → issued.
    const issue = await admin.post(`${ADMIN_BASE}/payroll/issue`).send({ month: RUN_MONTH, year: RUN_YEAR });
    expect(issue.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/issue`, issue.body);
    expect(typeof issue.body.data.issued).toBe('number');
    expect(issue.body.data.issued).toBeGreaterThanOrEqual(1);

    // Confirm the payslip really materialised as issued at the DB layer.
    const row = await prisma.$queryRawUnsafe(
      `SELECT status FROM payslips WHERE id = $1::int`, Number(payslipId),
    );
    expect(row[0].status).toBe('issued');
  });

  // ════════════════════════════════════════════════════════════════════════
  // 3. revisions: propose → list → detail → hr-sign → admin-sign → apply,
  //    + separate propose→reject, + arrears, + annual-review, + bulk-revisions.
  // ════════════════════════════════════════════════════════════════════════
  it('revisions: full sign/apply lifecycle + reject + arrears + bulk validate their schemas', async () => {
    // POST /payroll/revisions/propose → SalaryRevisionProposeResponse (has
    // revision_number; status defaults pending_hr).
    const propose = await admin.post(`${ADMIN_BASE}/payroll/revisions/propose`).send({
      staff_uid: STAFF_UID,
      revision_type: 'increment',
      proposed_basic: 45000,
      increment_pct: 12.5,
      effective_from: '2099-08-01',
      reason: 'Contract deep-test increment',
    });
    expect(propose.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/revisions/propose`, propose.body);
    expect(propose.body.data.status).toBe('pending_hr');
    expect(propose.body.data.revision_number).toBeTruthy();
    expect(typeof propose.body.data.proposed_basic).toBe('string'); // Decimal-string
    revisionId = propose.body.data.id;

    // GET /payroll/revisions → SalaryRevisionsResponse (list, has rejected_by_name).
    // Scope to our staff_uid (the controller supports the filter) so the contract
    // assertion validates only rows THIS suite created. The shared QA cluster
    // carries a foreign legacy row (revision_type 'general', a value the live
    // proposeRevision API can never emit — validTypes is increment|bonus|
    // deduction_change|component_change — owned by a PATIENT user) that would
    // otherwise fail the strict REVISION_TYPE enum. That row is pre-existing dirty
    // data, not a contract violation, so we exclude it by scoping rather than by
    // weakening the schema.
    const list = await admin.get(`${ADMIN_BASE}/payroll/revisions?staff_uid=${STAFF_UID}`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/revisions`, list.body);
    expect(list.body.data.find((r) => r.id === revisionId)).toBeDefined();

    // GET /payroll/revisions/{id} → SalaryRevisionDetailResponse (no rejected_by_name).
    const detail = await admin.get(`${ADMIN_BASE}/payroll/revisions/${revisionId}`);
    expect(detail.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/revisions/{id}`, detail.body);
    expect(detail.body.data.id).toBe(revisionId);

    // POST /payroll/revisions/{id}/hr-sign (HR) → SalaryRevisionSignResponse,
    // status pending_hr → pending_admin.
    const hrSign = await hr.post(`${ADMIN_BASE}/payroll/revisions/${revisionId}/hr-sign`).send({ comment: 'HR ok' });
    expect(hrSign.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/revisions/{id}/hr-sign`, hrSign.body);
    expect(hrSign.body.data.status).toBe('pending_admin');

    // POST /payroll/revisions/{id}/admin-sign (DIFFERENT admin) →
    // SalaryRevisionSignResponse, status → approved. SoD applies here too.
    const adminSign = await admin.post(`${ADMIN_BASE}/payroll/revisions/${revisionId}/admin-sign`).send({ comment: 'Admin ok' });
    expect(adminSign.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/revisions/{id}/admin-sign`, adminSign.body);
    expect(adminSign.body.data.status).toBe('approved');

    // POST /payroll/revisions/{id}/apply → ApplyRevisionResponse. TRAP:
    // revision_id is the raw req.params.id STRING (not the int column).
    const apply = await admin.post(`${ADMIN_BASE}/payroll/revisions/${revisionId}/apply`).send({});
    expect(apply.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/revisions/{id}/apply`, apply.body);
    expect(typeof apply.body.data.revision_id).toBe('string'); // raw-param string trap
    expect(apply.body.data.staff_uid).toBe(STAFF_UID);

    // Separate propose → reject to cover SalaryRevisionSignResponse via reject.
    const propose2 = await admin.post(`${ADMIN_BASE}/payroll/revisions/propose`).send({
      staff_uid: STAFF_UID,
      revision_type: 'bonus',
      bonus_amount: 5000,
      effective_from: '2099-09-01',
      reason: 'Contract deep-test bonus to reject',
    });
    expect(propose2.statusCode).toBe(200);
    const rejectId = propose2.body.data.id;
    const reject = await admin.post(`${ADMIN_BASE}/payroll/revisions/${rejectId}/reject`).send({ reason: 'not this cycle' });
    expect(reject.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/revisions/{id}/reject`, reject.body);
    expect(reject.body.data.status).toBe('rejected');

    // ── arrears: a backdated, APPLIED revision with a basic change is required
    // (calculateArrears: status='applied' AND applied_at > effective_from).
    // Seed it directly (effective_from in the past, applied_at now) so the
    // arrears path computes a real row → ArrearsResultResponse with a nested
    // SalaryArrearsRow (string amount) AND a top-level number arrears_amount.
    const seeded = await prisma.$queryRawUnsafe(
      `INSERT INTO salary_revisions
         (staff_uid, revision_number, revision_type, current_basic, proposed_basic,
          effective_from, reason, status, applied_at)
       VALUES ($1::uuid, $2, 'increment', 40000, 45000,
          (CURRENT_DATE - INTERVAL '3 months')::date, 'Contract deep-test arrears base',
          'applied', NOW())
       RETURNING id`,
      STAFF_UID, `ARR-DEEP-${Date.now()}`,
    );
    arrearsRevisionId = seeded[0].id;
    const arrears = await admin.post(`${ADMIN_BASE}/payroll/revisions/${arrearsRevisionId}/arrears`).send({});
    expect(arrears.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/revisions/{revisionId}/arrears`, arrears.body);
    expect(typeof arrears.body.data.arrears_amount).toBe('number'); // top-level JS number
    if (arrears.body.data.result) {
      // nested row's arrears_amount is a Decimal-from-column STRING (the trap)
      expect(typeof arrears.body.data.result.arrears_amount).toBe('string');
    }

    // GET /payroll/annual-review → AnnualReviewStatusResponse. years_of_service
    // is an EXTRACT numeric → serialized STRING.
    const annual = await admin.get(`${ADMIN_BASE}/payroll/annual-review`);
    expect(annual.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/annual-review`, annual.body);
    expect(typeof annual.body.data.year).toBe('number');
    expect(Array.isArray(annual.body.data.staff)).toBe(true);

    // GET /payroll/bulk-revisions → BulkRevisionsResponse (empty list still
    // validates the envelope).
    const bulkList0 = await admin.get(`${ADMIN_BASE}/payroll/bulk-revisions`);
    expect(bulkList0.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/bulk-revisions`, bulkList0.body);

    // POST /payroll/bulk-revisions/create → BulkRevisionJobResponse (status draft).
    // target a department that has our seeded staff so staff_count > 0.
    const bulkCreate = await admin.post(`${ADMIN_BASE}/payroll/bulk-revisions/create`).send({
      description: 'PAYROLL_CONTRACT_DEEP_TEST bulk',
      revision_type: 'bonus',
      target_type: 'department',
      target_value: 'General Medicine',
      bonus_amount: 1000,
      effective_from: '2099-10-01',
    });
    expect(bulkCreate.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/bulk-revisions/create`, bulkCreate.body);
    expect(bulkCreate.body.data.status).toBe('draft');
    expect(bulkCreate.body.data.staff_count).toBeGreaterThanOrEqual(1);
    bulkRevisionId = bulkCreate.body.data.id;

    // POST /payroll/bulk-revisions/{id}/approve → ApproveBulkRevisionResponse.
    // TRAPS: id is the raw req.params.id STRING; status is the HTTP-only literal
    // 'processing' (not a DB enum value).
    const bulkApprove = await admin.post(`${ADMIN_BASE}/payroll/bulk-revisions/${bulkRevisionId}/approve`).send({});
    expect(bulkApprove.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/bulk-revisions/{id}/approve`, bulkApprove.body);
    expect(typeof bulkApprove.body.data.id).toBe('string'); // raw-param string trap
    expect(bulkApprove.body.data.status).toBe('processing'); // synthetic HTTP status
  });

  // ════════════════════════════════════════════════════════════════════════
  // 4. separations: advances + fnf + gratuity + leave-encashment.
  // ════════════════════════════════════════════════════════════════════════
  it('separations: advances / fnf / gratuity / leave-encashment validate their schemas', async () => {
    // POST /payroll/advances/create → PayrollAdvanceResponse. amount/
    // monthly_deduction Decimal-from-column STRINGS; status hardcoded 'approved'.
    const advCreate = await admin.post(`${ADMIN_BASE}/payroll/advances/create`).send({
      staff_uid: STAFF_UID,
      amount: 12000,
      reason: 'Contract deep-test advance',
      monthly_deduction: 2000,
      deduction_start_month: 8,
      deduction_start_year: 2099,
    });
    expect(advCreate.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/advances/create`, advCreate.body);
    expect(advCreate.body.data.status).toBe('approved');
    expect(typeof advCreate.body.data.amount).toBe('string');

    // GET /payroll/advances → PayrollAdvancesResponse (loose SELECT * list).
    // balance_remaining is a SQL-computed Decimal STRING.
    const advList = await admin.get(`${ADMIN_BASE}/payroll/advances`);
    expect(advList.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/advances`, advList.body);
    const myAdv = advList.body.data.find((a) => a.staff_uid === STAFF_UID);
    expect(myAdv).toBeDefined();
    expect(typeof myAdv.balance_remaining).toBe('string');

    // POST /payroll/fnf/create → FnFDetailResponse (status draft). All money
    // columns Decimal STRINGS even though JS-computed (round-trip via NUMERIC).
    const fnfCreate = await admin.post(`${ADMIN_BASE}/payroll/fnf/create`).send({
      staff_uid: STAFF_UID,
      separation_type: 'resignation',
      last_working_day: '2099-08-31',
      notice_shortfall_days: 5,
      bonus_payable: 3000,
    });
    expect(fnfCreate.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/fnf/create`, fnfCreate.body);
    expect(fnfCreate.body.data.status).toBe('draft');
    expect(typeof fnfCreate.body.data.net_payable).toBe('string');
    const fnfId = fnfCreate.body.data.id;

    // approveFnF's first transition (draft→hr_approved) requires actor role 'HR',
    // but an HR-role token is denied by the staffAccessGuard (HR is not in the
    // role-policy graph) — so it cannot be driven through the guarded route.
    // Move the row to hr_approved directly (simulating that HR step), then drive
    // the ADMIN-guarded transitions through the real routes:
    //   POST /payroll/fnf/{id}/approve  (ADMIN, hr_approved→admin_approved)
    //   POST /payroll/fnf/{id}/mark-paid (admin_approved→paid)
    await prisma.$executeRawUnsafe(
      `UPDATE full_final_settlements SET status='hr_approved', hr_approved_by=$2::uuid, hr_approved_at=NOW() WHERE id=$1::int`,
      Number(fnfId), HR_UID,
    );
    const fnfApprove = await admin.post(`${ADMIN_BASE}/payroll/fnf/${fnfId}/approve`).send({});
    expect(fnfApprove.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/fnf/{id}/approve`, fnfApprove.body);
    expect(fnfApprove.body.data.status).toBe('admin_approved');

    const fnfPaid = await admin.post(`${ADMIN_BASE}/payroll/fnf/${fnfId}/mark-paid`).send({
      payment_date: '2099-09-05', payment_reference: 'NEFT-DEEP-TEST',
    });
    expect(fnfPaid.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/fnf/{id}/mark-paid`, fnfPaid.body);
    expect(fnfPaid.body.data.status).toBe('paid');

    // GET /payroll/fnf → FnFListResponse (loose SELECT * list).
    const fnfList = await admin.get(`${ADMIN_BASE}/payroll/fnf`);
    expect(fnfList.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/fnf`, fnfList.body);
    expect(fnfList.body.data.find((f) => f.id === fnfId)).toBeDefined();

    // GET /payroll/gratuity → GratuityStatusResponse. TRAP: years_of_service &
    // projected_gratuity are JS Math.round NUMBERS (not Decimal strings).
    const gratuity = await admin.get(`${ADMIN_BASE}/payroll/gratuity`);
    expect(gratuity.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/gratuity`, gratuity.body);
    expect(Array.isArray(gratuity.body.data)).toBe(true);
    if (gratuity.body.data.length > 0) {
      expect(typeof gratuity.body.data[0].years_of_service).toBe('number'); // JS number trap
    }

    // POST /payroll/leave-encashment/create → LeaveEncashmentResponse. TRAP:
    // daily_rate/amount JS-computed but round-trip through Decimal → STRINGS.
    const leCreate = await admin.post(`${ADMIN_BASE}/payroll/leave-encashment/create`).send({
      staff_uid: STAFF_UID,
      leave_days: 10,
      encashment_type: 'annual',
      financial_year: FY,
    });
    expect(leCreate.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/leave-encashment/create`, leCreate.body);
    expect(leCreate.body.data.status).toBe('approved');
    expect(typeof leCreate.body.data.amount).toBe('string');

    // GET /payroll/leave-encashment → LeaveEncashmentListResponse (loose list).
    const leList = await admin.get(`${ADMIN_BASE}/payroll/leave-encashment`);
    expect(leList.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/leave-encashment`, leList.body);
    expect(leList.body.data.find((l) => l.staff_uid === STAFF_UID)).toBeDefined();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 5. queries-compliance: tax-summary/all, comparison, generate-payroll-data,
  //    declarations(+approve), queries(+reply), compliance-calendar.
  //    The declaration + query rows are created via HR self-service (test 6 runs
  //    AFTER this in file order would be wrong) — so we create them HERE inline
  //    via the HR-self-service POSTs, then admin-approve / admin-reply.
  // ════════════════════════════════════════════════════════════════════════
  it('queries-compliance: tax-summary/comparison/declarations/queries/calendar validate their schemas', async () => {
    // POST /payroll/tax-summary/all → GenerateTaxSummariesResponse (JS counters).
    const taxAll = await admin.post(`${ADMIN_BASE}/payroll/tax-summary/all`).send({ financial_year: FY });
    expect(taxAll.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/tax-summary/all`, taxAll.body);
    expect(typeof taxAll.body.data.generated).toBe('number');

    // GET /payroll/comparison → PayrollComparisonResponse. ComparisonPayslip money
    // fields are parseFloat'd NUMBERS, lop_days/overtime_hours raw Decimal STRINGS.
    const comparison = await admin.get(
      `${ADMIN_BASE}/payroll/comparison?from_month=${RUN_MONTH}&from_year=${RUN_YEAR}&to_month=${RUN_MONTH}&to_year=${RUN_YEAR}`,
    );
    expect(comparison.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/comparison`, comparison.body);
    expect(Array.isArray(comparison.body.data.staff)).toBe(true);
    const cmpStaff = comparison.body.data.staff.find((s) => s.staff_uid === STAFF_UID);
    expect(cmpStaff).toBeDefined();
    if (cmpStaff.payslips.length > 0) {
      expect(typeof cmpStaff.payslips[0].net_salary).toBe('number'); // parseFloat number
    }

    // POST /generate-payroll-data → GeneratePayrollDataResponse (NB: top-level
    // staff-admin route, NO /payroll prefix). days_worked/leaves_taken are bigint
    // COUNT → STRINGS.
    const genData = await admin.post(`${ADMIN_BASE}/generate-payroll-data`).send({ month: RUN_MONTH, year: RUN_YEAR });
    expect(genData.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/generate-payroll-data`, genData.body);
    expect(Array.isArray(genData.body.data.payrollData)).toBe(true);
    expect(genData.body.data.generatedAt).toBeTruthy();

    // Seed a declaration + a query via HR SELF-SERVICE (so the schemas for those
    // self-service ops are also exercised in this same block — see test 6 below
    // which validates the OTHER self-service GET shapes).
    const submitDecl = await staff.post(`${HR_BASE}/payroll/declarations/submit`).send({
      financial_year: FY, ppf: 50000, elss: 30000, health_insurance_self: 15000,
    });
    expect(submitDecl.statusCode).toBe(200);
    assertResponse('POST', `${HR_BASE}/payroll/declarations/submit`, submitDecl.body);
    expect(submitDecl.body.data.status).toBe('submitted');
    declarationId = submitDecl.body.data.id;

    const raiseQuery = await staff.post(`${HR_BASE}/payroll/queries/raise`).send({
      payslip_id: payslipId, subject: 'Deep-test query', description: 'Why is HRA X?', category: 'general',
    });
    expect(raiseQuery.statusCode).toBe(200);
    assertResponse('POST', `${HR_BASE}/payroll/queries/raise`, raiseQuery.body);
    expect(raiseQuery.body.data.status).toBe('open');
    queryId = raiseQuery.body.data.id;

    // GET /payroll/declarations → DeclarationListResponse (loose SELECT * list).
    const declList = await admin.get(`${ADMIN_BASE}/payroll/declarations`);
    expect(declList.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/declarations`, declList.body);
    expect(declList.body.data.find((d) => d.id === declarationId)).toBeDefined();

    // POST /payroll/declarations/{id}/approve → DeclarationResponse (DECLARATION_SELECT).
    const declApprove = await admin.post(`${ADMIN_BASE}/payroll/declarations/${declarationId}/approve`).send({});
    expect(declApprove.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/declarations/{id}/approve`, declApprove.body);
    expect(declApprove.body.data.status).toBe('approved');

    // GET /payroll/queries → PayslipQueryListResponse (loose SELECT * list +
    // replies json_agg).
    const queriesList = await admin.get(`${ADMIN_BASE}/payroll/queries`);
    expect(queriesList.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/queries`, queriesList.body);
    expect(queriesList.body.data.find((q) => q.id === queryId)).toBeDefined();

    // POST /payroll/queries/{id}/reply → PayslipQueryResponse (findUnique subset).
    // resolve:true → status 'resolved'.
    const reply = await admin.post(`${ADMIN_BASE}/payroll/queries/${queryId}/reply`).send({
      message: 'HRA is 40% of basic.', resolve: true,
    });
    expect(reply.statusCode).toBe(200);
    assertResponse('POST', `${ADMIN_BASE}/payroll/queries/{id}/reply`, reply.body);
    expect(reply.body.data.status).toBe('resolved');

    // GET /payroll/compliance-calendar → ComplianceCalendarResponse (JS-computed).
    const calendar = await admin.get(`${ADMIN_BASE}/payroll/compliance-calendar`);
    expect(calendar.statusCode).toBe(200);
    assertResponse('GET', `${ADMIN_BASE}/payroll/compliance-calendar`, calendar.body);
    expect(Array.isArray(calendar.body.data.deadlines)).toBe(true);
    expect(typeof calendar.body.data.current_month).toBe('number');
  });

  // ════════════════════════════════════════════════════════════════════════
  // 6. HR self-service (STAFF token owning a payslip): the remaining GET shapes
  //    + the populated and missing-summary branches of the own-tax-summary endpoint.
  //    (declarations/submit + queries/raise POSTs were exercised in test 5.)
  // ════════════════════════════════════════════════════════════════════════
  it('HR self-service: my-payslips / advances / declarations / queries / tax-summary validate their schemas', async () => {
    // GET /payroll/my-payslips → MyPayslipListResponse (STRICT item; money STRINGS).
    const myPayslips = await staff.get(`${HR_BASE}/payroll/my-payslips`);
    expect(myPayslips.statusCode).toBe(200);
    assertResponse('GET', `${HR_BASE}/payroll/my-payslips`, myPayslips.body);
    expect(Array.isArray(myPayslips.body.data)).toBe(true);
    const mine = myPayslips.body.data.find((p) => p.id === payslipId);
    expect(mine).toBeDefined(); // the issued payslip is visible to its owner
    expect(mine.status).toBe('issued');
    expect(typeof mine.net_salary).toBe('string');

    // GET /payroll/my-payslips/{id} → MyPayslipDetailResponse (LIST != detail).
    const detail = await staff.get(`${HR_BASE}/payroll/my-payslips/${payslipId}`);
    expect(detail.statusCode).toBe(200);
    assertResponse('GET', `${HR_BASE}/payroll/my-payslips/{id}`, detail.body);
    expect(detail.body.data.id).toBe(payslipId);
    expect(detail.body.data.staff_uid).toBe(STAFF_UID);
    expect(typeof detail.body.data.gross_salary).toBe('string');

    // GET /payroll/advances (self) → OwnAdvancesResponse (loose SELECT * list).
    const advances = await staff.get(`${HR_BASE}/payroll/advances`);
    expect(advances.statusCode).toBe(200);
    assertResponse('GET', `${HR_BASE}/payroll/advances`, advances.body);
    expect(advances.body.data.find((a) => a.staff_uid === STAFF_UID)).toBeDefined();

    // GET /payroll/declarations (self) → MyDeclarationsResponse (STRICT + 5 SQL
    // aggregate STRINGS: section_80c/section_80d/hra_exemption/lta/other_deductions).
    const declarations = await staff.get(`${HR_BASE}/payroll/declarations`);
    expect(declarations.statusCode).toBe(200);
    assertResponse('GET', `${HR_BASE}/payroll/declarations`, declarations.body);
    const myDecl = declarations.body.data.find((d) => d.id === declarationId);
    expect(myDecl).toBeDefined();
    expect(typeof myDecl.section_80c).toBe('string'); // SQL aggregate string

    // GET /payroll/queries (self) → MyPayslipQueriesResponse (loose SELECT * list).
    const queries = await staff.get(`${HR_BASE}/payroll/queries`);
    expect(queries.statusCode).toBe(200);
    assertResponse('GET', `${HR_BASE}/payroll/queries`, queries.body);
    expect(queries.body.data.find((q) => q.id === queryId)).toBeDefined();

    // GET /payroll/tax-summary → OwnTaxSummaryResponse. POPULATED branch:
    // generateAnnualTaxSummary runs because the staff has an ISSUED payslip for FY
    // (RUN_YEAR=2099, month=7 → falls in FY 2099-00 → financial_year derives from
    // the run). We pass fy explicitly to land on the issued payslip's FY.
    // RUN_MONTH=7 (>=4) → FY start year = RUN_YEAR.
    const populatedFY = `${RUN_YEAR}-${String((RUN_YEAR + 1) % 100).padStart(2, '0')}`;
    const taxPopulated = await staff.get(`${HR_BASE}/payroll/tax-summary?fy=${populatedFY}`);
    expect(taxPopulated.statusCode).toBe(200);
    assertResponse('GET', `${HR_BASE}/payroll/tax-summary`, taxPopulated.body);
    expect(taxPopulated.body.data.financial_year).toBe(populatedFY);
    expect(typeof taxPopulated.body.data.total_net).toBe('string');

    // A fresh staff member with no issued payslips has no authoritative summary.
    const taxMissing = await staff2.get(`${HR_BASE}/payroll/tax-summary?fy=2050-51`);
    expect(taxMissing.statusCode).toBe(404);
    assertResponse('GET', `${HR_BASE}/payroll/tax-summary`, taxMissing.body, 404);
    expect(taxMissing.body).toEqual(expect.objectContaining({
      success: false,
      message: 'No issued payslips found for this financial year',
    }));
  });
});

// ── DISTINCT-SCHEMA COVERAGE LEDGER ───────────────────────────────────────────
// Every typed 200 response schema in payroll.mjs is asserted against a live
// payload at least once above. The 4 generic CSV/redirect ops
// (GET /payroll/export/{summary,pf,esi}, GET /payroll/my-payslips/{id}/download)
// are INTENTIONALLY not asserted — they return text/csv or a 302, not a JSON
// envelope, and carry the generic untyped 200 in openapi.json.
