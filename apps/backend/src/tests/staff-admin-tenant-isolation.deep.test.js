import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { jest } from '@jest/globals';
import express from 'express';
import pg from 'pg';
import request from 'supertest';

const originalEnv = Object.fromEntries(
  ['DATABASE_URL', 'DATABASE_READ_URL', 'ALLOW_DEFAULT_TENANT', 'AUTH_ENFORCE_TENANT_RLS', 'AUTH_TENANT_RLS_RUNTIME_ROLE', 'AUTH_TENANT_RLS_TEST_ROLE']
    .map(key => [key, process.env[key]]),
);
const ownerDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const applicationUrl = new URL(ownerDatabaseUrl);
applicationUrl.searchParams.set('options', [applicationUrl.searchParams.get('options'), '-c role=vhhealth_app'].filter(Boolean).join(' '));
process.env.DATABASE_URL = applicationUrl.toString();
process.env.DATABASE_READ_URL = applicationUrl.toString();
process.env.ALLOW_DEFAULT_TENANT = 'false';
// T1 isolates explicit predicates from the production request auto-wrapper.
process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

const { default: prisma, pinSessionTimeZoneToUrl } = await import('../lib/prisma.js');
const { default: router } = await import('../routes/staff/staffAdminRoutes.js');
const { requireRole } = await import('../middleware/rbacMiddleware.js');
const leaveHandlers = await import('../controllers/staff/staffAdminLeaveController.js');
const { approvePerformanceReview } = await import('../controllers/staff/staffAdminHRController.js');
const { getStaffAdminDashboard } = await import('../controllers/staff/staffAdminDashboardController.js');
const { getReportAuditTrail } = await import('../controllers/staff/reportAuditController.js');
const { authorizeStaffAccessRequest, STAFF_ACCESS_POLICY_CODES } = await import('../services/security/staffAccessDecisionService.js');
const owner = new pg.Client({ connectionString: pinSessionTimeZoneToUrl(ownerDatabaseUrl) });
const fixtures = [];
let year;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const fixture = fixtures[Number(req.get('x-test-actor') || 0)];
  req.user = { ...fixture.actor, role: req.get('x-test-role') || 'ADMIN' };
  if (req.get('x-test-no-tenant') !== 'true') {
    req.tenantId = fixture.tenantId;
    req.user.tenant_id = fixture.tenantId;
  }
  next();
});
app.use('/api/v1/staff/admin', requireRole('ADMIN', 'SUPER_ADMIN', 'HR_STAFF'), router);

function call(path, { actor = 0, role = 'ADMIN', noTenant = false, method = 'get', body } = {}) {
  const req = request(app)[method](`/api/v1/staff/admin${path}`);
  if (body) req.send(body);
  return req.set('x-test-actor', String(actor)).set('x-test-role', role).set('x-test-no-tenant', String(noTenant));
}

async function snapshot(table, id) {
  return (await owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE id=$1`, [id])).rows;
}

async function population() {
  for (const f of fixtures) {
    for (const [table, ids] of [
      ['users', [f.actor.id, f.person.id]], ['staff', [f.staffId]],
      ['leave_applications', [f.leaveId, f.approvedId]], ['staff_performance_reviews', [f.reviewId]],
      ['staff_attendance', [f.attendanceId]], ['incident_reports', [f.incidentId]],
      ['staff_grievances', [f.grievanceId]], ['report_updates', [f.incidentUpdate, f.grievanceUpdate]],
      ['leave_balance_overrides', [f.overrideId]],
      ['payslips', [f.payslipId]], ['attendance_disputes', [f.disputeId]],
    ]) {
      const rows = (await owner.query(`SELECT tenant_id FROM ${table} WHERE id=ANY($1::int[])`, [ids])).rows;
      expect(rows).toHaveLength(ids.length);
      expect(rows.every(row => row.tenant_id === f.tenantId)).toBe(true);
    }
  }
}

beforeAll(async () => {
  await owner.connect();
  await owner.query("DO $$ BEGIN IF to_regrole('vhhealth_app') IS NULL THEN CREATE ROLE vhhealth_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import prisma, { ensureTenantRlsRuntimeRoleGrants } from './src/lib/prisma.js';
    try {
      const result = await ensureTenantRlsRuntimeRoleGrants();
      if (result.skipped || result.error) throw new Error('Runtime role bootstrap failed');
    } finally { await prisma.$disconnect(); }
  `], { env: { ...process.env, DATABASE_URL: ownerDatabaseUrl, DATABASE_READ_URL: ownerDatabaseUrl }, stdio: 'pipe', timeout: 30000 });
  year = Number((await owner.query('SELECT EXTRACT(YEAR FROM CURRENT_DATE) AS year')).rows[0].year);
  for (const label of ['A', 'B']) {
    const f = { tenantId: randomUUID(), marker: `RLS-STAFF-${label}-${randomUUID()}` };
    fixtures.push(f);
    await owner.query('INSERT INTO tenants (id,slug,name) VALUES ($1::uuid,$2,$2)', [f.tenantId, f.marker]);
    for (const [key, role] of [['actor', 'ADMIN'], ['person', 'IP_STAFF_NURSE']]) {
      f[key] = (await owner.query(
        `INSERT INTO users (uid,tenant_id,phone,name,role,is_active,updated_at,id)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,true,NOW(),$6) RETURNING id,uid,phone,name`,
        [randomUUID(), f.tenantId, `+91${randomInt(6000000000, 9999999999)}`, `${f.marker}-${key}`, role, randomInt(1500000000, 2000000000)],
      )).rows[0];
    }
    f.staffId = (await owner.query(
      'INSERT INTO staff (tenant_id,user_id,name,department,is_active,updated_at,id) VALUES ($1::uuid,$2::uuid,$3,$4,true,NOW(),$5) RETURNING id',
      [f.tenantId, f.person.uid, f.person.name, f.marker, label === 'B' ? fixtures[0].person.id : randomInt(1500000000, 2000000000)],
    )).rows[0].id;
    for (const [key, status] of [['leaveId', 'pending'], ['approvedId', 'approved']]) {
      f[key] = (await owner.query(
        `INSERT INTO leave_applications (tenant_id,staff_id,leave_type,start_date,end_date,status,reason)
         VALUES ($1::uuid,$2,'annual',CURRENT_DATE,CURRENT_DATE,$3,$4) RETURNING id`,
        [f.tenantId, f.person.id, status, f.marker],
      )).rows[0].id;
    }
    f.reviewId = (await owner.query(
      "INSERT INTO staff_performance_reviews (tenant_id,staff_id,review_period,reviewer_comments) VALUES ($1::uuid,$2,'annual',$3) RETURNING id",
      [f.tenantId, f.person.id, f.marker],
    )).rows[0].id;
    f.attendanceId = (await owner.query(
      'INSERT INTO staff_attendance (tenant_id,staff_id,check_in_time) VALUES ($1::uuid,$2,NOW()) RETURNING id',
      [f.tenantId, f.person.id],
    )).rows[0].id;
    f.overrideId = (await owner.query(
      "INSERT INTO leave_balance_overrides (tenant_id,staff_id,leave_type,new_balance,reason) VALUES ($1::uuid,$2,'annual',10,$3) RETURNING id",
      [f.tenantId, f.person.id, f.marker],
    )).rows[0].id;
    f.payslipId = (await owner.query(
      'INSERT INTO payslips (tenant_id,staff_uid,month,year) VALUES ($1::uuid,$2::uuid,1,$3) RETURNING id',
      [f.tenantId, f.person.uid, year],
    )).rows[0].id;
    f.disputeId = (await owner.query(
      "INSERT INTO attendance_disputes (tenant_id,staff_id,dispute_date,dispute_type,reason) VALUES ($1::uuid,$2,CURRENT_DATE,'missing_punch',$3) RETURNING id",
      [f.tenantId, f.person.id, f.marker],
    )).rows[0].id;
    f.incidentId = (await owner.query(
      `INSERT INTO incident_reports (tenant_id,reporter_id,incident_type,title,description,incident_date,assigned_to,resolved_by)
       VALUES ($1::uuid,$2::uuid,'other',$3::text,$3::text,NOW(),$2::uuid,$2::uuid) RETURNING id`,
      [f.tenantId, f.person.uid, f.marker],
    )).rows[0].id;
    f.grievanceId = (await owner.query(
      `INSERT INTO staff_grievances (tenant_id,reporter_id,grievance_type,subject,description,assigned_to,resolved_by)
       VALUES ($1::uuid,$2::uuid,'other',$3::text,$3::text,$2::uuid,$2::uuid) RETURNING id`,
      [f.tenantId, f.person.uid, f.marker],
    )).rows[0].id;
    for (const type of ['incident', 'grievance']) {
      f[`${type}Update`] = (await owner.query(
        `INSERT INTO report_updates (tenant_id,report_type,report_id,author_id,author_role,message)
         VALUES ($1::uuid,$2,$3,$4::uuid,'admin',$5) RETURNING id`,
        [f.tenantId, type, f[`${type}Id`], f.actor.uid, f.marker],
      )).rows[0].id;
    }
  }
}, 60000);

beforeEach(async () => {
  await population();
  for (const f of fixtures) {
    await owner.query("UPDATE leave_applications SET status='pending',reviewed_by=NULL,reviewed_at=NULL,review_notes=NULL WHERE id=$1", [f.leaveId]);
    await owner.query('UPDATE staff_performance_reviews SET review_date=NULL,rating=NULL,reviewer_id=NULL,reviewer_comments=$2 WHERE id=$1', [f.reviewId, f.marker]);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    const tenants = fixtures.map(f => f.tenantId);
    for (const table of ['staff_access_audit_log', 'report_updates', 'incident_reports', 'staff_grievances',
      'leave_balance_overrides', 'payslips', 'attendance_disputes', 'staff_attendance', 'staff_performance_reviews', 'leave_applications', 'staff', 'users']) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`, [tenants]);
    }
    await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
  } finally {
    await owner.end();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 45000);

it('executes real SQL as vhhealth_app without superuser or bypass privileges', async () => {
  expect(await prisma.$queryRawUnsafe('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
    .toEqual([{ role: 'vhhealth_app', rolsuper: false, rolbypassrls: false }]);
});

describe.each([['leave_application', 'leaveId'], ['payslip', 'payslipId'], ['attendance_dispute', 'disputeId'], ['staff_row', 'staffId']])
  ('shared staff target resolver: %s', (resourceType, key) => {
    it('resolves an own populated target and denies the same foreign target', async () => {
      const [a, b] = fixtures;
      for (const [actor, allowed] of [[a, true], [b, false]]) {
        const req = { tenantId: actor.tenantId, user: { ...actor.actor, role: 'ADMIN' }, method: 'GET', params: {}, originalUrl: '/staff-target-proof' };
        const decision = await authorizeStaffAccessRequest(req, { policyCode: STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW, resourceType, resourceId: a[key], requireTarget: true });
        expect(decision.allowed).toBe(allowed);
        if (allowed) expect(req.staffAccessTarget).toMatchObject({ user_id: a.person.id, tenant_id: a.tenantId });
        else expect(req.staffAccessTarget).toBeNull();
      }
    });
  });

const routes = [
  ['get', '/dashboard'], ['get', '/analytics/leave-patterns'], ['get', '/hr/leave-requests'], ['get', '/leave/pending'],
  ['get', '/audit/trail/incident/1'], ['get', '/audit/trail/grievance/1'],
  ['post', '/bulk/leave-approval'], ['post', '/leave/1/approve'], ['post', '/leave/1/reject'],
  ['post', '/override/leave-balance'], ['put', '/approve/performance-review/1'],
];
describe.each(['false', 'true'])('missing tenant with ALLOW_DEFAULT_TENANT=%s', allowDefault => {
  it.each(routes)('refuses %s %s before any SQL', async (method, path) => {
    const previous = process.env.ALLOW_DEFAULT_TENANT;
    process.env.ALLOW_DEFAULT_TENANT = allowDefault;
    const spy = jest.spyOn(pg.Client.prototype, 'query');
    try {
      const response = await call(path, { method, noTenant: true, body: method === 'get' ? undefined : {} });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); process.env.ALLOW_DEFAULT_TENANT = previous; }
  });
  it.each(Object.entries({ ...leaveHandlers, approvePerformanceReview, getStaffAdminDashboard, getReportAuditTrail }))
    ('handler %s refuses absent context independently of route middleware', async (_name, handler) => {
      const previous = process.env.ALLOW_DEFAULT_TENANT;
      process.env.ALLOW_DEFAULT_TENANT = allowDefault;
      const spy = jest.spyOn(pg.Client.prototype, 'query');
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      try {
        await handler({ user: { ...fixtures[0].actor, role: 'ADMIN' }, params: {}, body: {}, query: {} }, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_CONTEXT_REQUIRED' }));
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); process.env.ALLOW_DEFAULT_TENANT = previous; }
    });
});

describe('performance approval', () => {
  it('denies a foreign review without changing or disclosing it', async () => {
    const a = fixtures[0];
    const before = await snapshot('staff_performance_reviews', a.reviewId);
    const response = await call(`/approve/performance-review/${a.reviewId}`, { actor: 1, method: 'put', body: { comments: 'foreign', final_rating: 1 } });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(a.marker);
    expect(await snapshot('staff_performance_reviews', a.reviewId)).toEqual(before);
  });
  it('approves the own-tenant review', async () => {
    const a = fixtures[0];
    const response = await call(`/approve/performance-review/${a.reviewId}`, { method: 'put', body: { comments: 'approved', final_rating: 5 } });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: a.reviewId, rating: 5, reviewer_id: a.actor.uid, reviewer_comments: 'approved' });
  });
});

describe('leave writes', () => {
  it.each(['bulk', 'approve', 'reject'])('denies foreign %s without changing or disclosing the leave', async action => {
    const a = fixtures[0];
    const before = await snapshot('leave_applications', a.leaveId);
    const response = await call(action === 'bulk' ? '/bulk/leave-approval' : `/leave/${a.leaveId}/${action}`, {
      actor: 1, method: 'post', body: { leave_ids: [a.leaveId], comments: 'foreign' },
    });
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(a.marker);
    expect(await snapshot('leave_applications', a.leaveId)).toEqual(before);
  });
  it.each(['bulk', 'approve', 'reject'])('processes own-tenant %s', async action => {
    const a = fixtures[0];
    const response = await call(action === 'bulk' ? '/bulk/leave-approval' : `/leave/${a.leaveId}/${action}`, {
      method: 'post', body: { leave_ids: [a.leaveId], comments: 'own' },
    });
    expect(response.status).toBe(200);
    const row = (await snapshot('leave_applications', a.leaveId))[0].row;
    expect(row).toMatchObject({ status: action === 'reject' ? 'rejected' : 'approved', reviewed_by: a.actor.uid });
  });
  it('bulk approval changes only the own rows in a mixed batch', async () => {
    const [a, b] = fixtures;
    const before = await snapshot('leave_applications', b.leaveId);
    const response = await call('/bulk/leave-approval', { method: 'post', body: { leave_ids: [a.leaveId, b.leaveId] } });
    expect(response.status).toBe(200);
    expect(response.body.data.processed).toBe(1);
    expect(await snapshot('leave_applications', b.leaveId)).toEqual(before);
  });
  it('denies a foreign override and leaves all existing overrides unchanged', async () => {
    const a = fixtures[0];
    expect(fixtures[1].staffId).toBe(a.person.id);
    const before = (await owner.query('SELECT to_jsonb(t) AS row FROM leave_balance_overrides t WHERE staff_id=$1 ORDER BY id', [a.person.id])).rows;
    const response = await call('/override/leave-balance', { actor: 1, method: 'post', body: { staff_id: a.person.id, leave_type: 'annual', new_balance: 999, reason: 'foreign' } });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(a.marker);
    expect((await owner.query('SELECT to_jsonb(t) AS row FROM leave_balance_overrides t WHERE staff_id=$1 ORDER BY id', [a.person.id])).rows).toEqual(before);
  });
  it('stamps an own override with the authenticated tenant and canonical users.id', async () => {
    const a = fixtures[0];
    const response = await call('/override/leave-balance', { method: 'post', body: { staff_id: a.person.id, leave_type: 'annual', new_balance: 12, reason: 'own override' } });
    expect(response.status).toBe(200);
    expect((await owner.query("SELECT tenant_id,staff_id,new_balance,overridden_by FROM leave_balance_overrides WHERE reason='own override' AND tenant_id=$1::uuid", [a.tenantId])).rows)
      .toEqual([{ tenant_id: a.tenantId, staff_id: a.person.id, new_balance: 12, overridden_by: a.actor.uid }]);
  });
});

describe('leave lists and patterns', () => {
  it.each(['/hr/leave-requests', '/leave/pending'])('scopes %s and preserves its own positive control', async path => {
    const a = fixtures[0];
    const foreign = await call(`${path}?department=${a.marker}`, { actor: 1 });
    expect(foreign.status).toBe(200);
    expect(foreign.body.data.leaveRequests).toEqual([]);
    const own = await call(`${path}?department=${a.marker}`);
    expect(own.status).toBe(200);
    expect(own.body.data.leaveRequests.map(row => row.id)).toEqual([a.leaveId]);
  });
  it('scopes approved pattern aggregates with an own positive control', async () => {
    const a = fixtures[0];
    const foreign = await call(`/analytics/leave-patterns?year=${year}&department=${a.marker}`, { actor: 1 });
    expect(foreign.status).toBe(200);
    expect(foreign.body.data.patterns).toEqual([]);
    const own = await call(`/analytics/leave-patterns?year=${year}&department=${a.marker}`);
    expect(own.status).toBe(200);
    expect(own.body.data.patterns).toHaveLength(1);
    expect(own.body.data.patterns[0]).toMatchObject({ leave_count: 1, total_days: 1 });
  });
  it('does not join own leaves to a foreign user', async () => {
    const [a, b] = fixtures;
    await owner.query('UPDATE leave_applications SET staff_id=$1 WHERE id=ANY($2::int[])', [b.person.id, [a.leaveId, a.approvedId]]);
    try {
      const list = await call('/hr/leave-requests');
      const patterns = await call(`/analytics/leave-patterns?year=${year}`);
      expect(list.status).toBe(200);
      expect(patterns.status).toBe(200);
      expect(list.body.data.leaveRequests).toEqual([]);
      expect(patterns.body.data.patterns).toEqual([]);
    } finally { await owner.query('UPDATE leave_applications SET staff_id=$1 WHERE id=ANY($2::int[])', [a.person.id, [a.leaveId, a.approvedId]]); }
  });
  it('does not enrich own leave rows with a foreign staff record', async () => {
    const [a, b] = fixtures;
    await owner.query('UPDATE staff SET user_id=NULL WHERE id=$1', [a.staffId]);
    await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [a.person.uid, b.staffId]);
    try {
      const list = await call('/hr/leave-requests');
      const patterns = await call(`/analytics/leave-patterns?year=${year}&department=${b.marker}`);
      expect(list.status).toBe(200);
      expect(list.body.data.leaveRequests).toHaveLength(1);
      expect(list.body.data.leaveRequests[0].department).toBeNull();
      expect(JSON.stringify(list.body)).not.toContain(b.marker);
      expect(patterns.status).toBe(200);
      expect(patterns.body.data.patterns).toEqual([]);
    } finally {
      await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [a.person.uid, a.staffId]);
      await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [b.person.uid, b.staffId]);
    }
  });
});

it('scopes every dashboard aggregate and recent activity with positive populations', async () => {
  for (let actor = 0; actor < fixtures.length; actor++) {
    const response = await call('/dashboard', { actor });
    expect(response.status).toBe(200);
    expect(response.body.data.overview.staff.total_staff).toBe(1);
    expect(response.body.data.overview.attendance.present_today).toBe(1);
    expect(response.body.data.overview.hr_actions).toMatchObject({ pending_reviews: 1, pending_leaves: 1 });
    expect(response.body.data.recentActivity).toHaveLength(1);
    expect(response.body.data.recentActivity[0].description).toContain(fixtures[actor].marker);
    expect(JSON.stringify(response.body)).not.toContain(fixtures[1 - actor].marker);
  }
});

it('does not enrich dashboard activity with a foreign staff row', async () => {
  const [a, b] = fixtures;
  await owner.query('UPDATE staff SET user_id=NULL WHERE id=$1', [a.staffId]);
  await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [a.person.uid, b.staffId]);
  try {
    const response = await call('/dashboard');
    expect(response.status).toBe(200);
    expect(response.body.data.recentActivity).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(b.marker);
  } finally {
    await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [a.person.uid, a.staffId]);
    await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [b.person.uid, b.staffId]);
  }
});

describe.each(['incident', 'grievance'])('%s audit trail', type => {
  it('denies a foreign report without disclosing the report or updates', async () => {
    const a = fixtures[0];
    const response = await call(`/audit/trail/${type}/${a[`${type}Id`]}`, { actor: 1 });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(a.marker);
  });
  it('shows the own report and its own trail', async () => {
    const a = fixtures[0];
    const response = await call(`/audit/trail/${type}/${a[`${type}Id`]}`);
    expect(response.status).toBe(200);
    expect(response.body.data.report).toMatchObject({ reporter_name: a.person.name, reporter_dept: a.marker });
    expect(response.body.data.audit_trail.map(row => row.id)).toEqual([a[`${type}Update`]]);
    expect(response.body.data.audit_trail[0].author_name).toBe(a.actor.name);
  });
  it('excludes foreign updates linked to the own report', async () => {
    const [a, b] = fixtures;
    await owner.query('UPDATE report_updates SET report_id=$1 WHERE id=$2', [a[`${type}Id`], b[`${type}Update`]]);
    try {
      const response = await call(`/audit/trail/${type}/${a[`${type}Id`]}`);
      expect(response.status).toBe(200);
      expect(response.body.data.audit_trail.map(row => row.id)).toEqual([a[`${type}Update`]]);
      expect(JSON.stringify(response.body)).not.toContain(b.marker);
    } finally { await owner.query('UPDATE report_updates SET report_id=$1 WHERE id=$2', [b[`${type}Id`], b[`${type}Update`]]); }
  });
  it('excludes foreign reporter, assignee, resolver and update-author joins', async () => {
    const [a, b] = fixtures;
    const table = type === 'incident' ? 'incident_reports' : 'staff_grievances';
    await owner.query(`UPDATE ${table} SET reporter_id=$1::uuid,assigned_to=$1::uuid,resolved_by=$1::uuid WHERE id=$2`, [b.person.uid, a[`${type}Id`]]);
    await owner.query('UPDATE report_updates SET author_id=$1::uuid WHERE id=$2', [b.actor.uid, a[`${type}Update`]]);
    try {
      const response = await call(`/audit/trail/${type}/${a[`${type}Id`]}`);
      expect(response.status).toBe(200);
      expect(response.body.data.report).toMatchObject({ reporter_name: null, reporter_dept: null, assigned_to_name: null, resolved_by_name: null });
      expect(response.body.data.audit_trail[0]).toMatchObject({ author_name: null, author_db_role: null });
      expect(JSON.stringify(response.body)).not.toContain(b.marker);
    } finally {
      await owner.query(`UPDATE ${table} SET reporter_id=$1::uuid,assigned_to=$1::uuid,resolved_by=$1::uuid WHERE id=$2`, [a.person.uid, a[`${type}Id`]]);
      await owner.query('UPDATE report_updates SET author_id=$1::uuid WHERE id=$2', [a.actor.uid, a[`${type}Update`]]);
    }
  });
  it('does not join a foreign staff department to the own reporter', async () => {
    const [a, b] = fixtures;
    await owner.query('UPDATE staff SET user_id=NULL WHERE id=$1', [a.staffId]);
    await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [a.person.uid, b.staffId]);
    try {
      const response = await call(`/audit/trail/${type}/${a[`${type}Id`]}`);
      expect(response.status).toBe(200);
      expect(response.body.data.report).toMatchObject({ reporter_name: a.person.name, reporter_dept: null });
      expect(JSON.stringify(response.body)).not.toContain(b.marker);
    } finally {
      await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [a.person.uid, a.staffId]);
      await owner.query('UPDATE staff SET user_id=$1::uuid WHERE id=$2', [b.person.uid, b.staffId]);
    }
  });
});

it('preserves anonymous grievance disclosure limits for HR and admin', async () => {
  const a = fixtures[0];
  await owner.query('UPDATE staff_grievances SET is_anonymous=true WHERE id=$1', [a.grievanceId]);
  try {
    const hr = await call(`/audit/trail/grievance/${a.grievanceId}`, { role: 'HR_STAFF' });
    expect(hr.status).toBe(200);
    expect(hr.body.data.report).toMatchObject({ reporter_id: null, reporter_name: 'Anonymous', reporter_dept: null });
    expect(hr.body.data.report).not.toHaveProperty('anonymous_reporter_uid');
    expect(hr.body.data.report).not.toHaveProperty('actual_reporter_name');
    const admin = await call(`/audit/trail/grievance/${a.grievanceId}`);
    expect(admin.status).toBe(200);
    expect(admin.body.data.report).toMatchObject({ reporter_name: 'Anonymous', anonymous_reporter_uid: a.person.uid, anonymous_reporter_name: a.person.name });
  } finally { await owner.query('UPDATE staff_grievances SET is_anonymous=false WHERE id=$1', [a.grievanceId]); }
});
