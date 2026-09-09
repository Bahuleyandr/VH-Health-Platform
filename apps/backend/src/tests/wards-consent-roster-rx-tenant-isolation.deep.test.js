import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import pg from 'pg';
import request from 'supertest';

const envKeys = ['DATABASE_URL', 'DATABASE_READ_URL', 'ALLOW_DEFAULT_TENANT', 'AUTH_ENFORCE_TENANT_RLS', 'AUTH_TENANT_RLS_RUNTIME_ROLE', 'AUTH_TENANT_RLS_TEST_ROLE'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const ownerUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const applicationUrl = new URL(ownerUrl);
applicationUrl.searchParams.set('options', [applicationUrl.searchParams.get('options'), '-c role=vhhealth_app'].filter(Boolean).join(' '));
process.env.DATABASE_URL = applicationUrl.toString();
process.env.DATABASE_READ_URL = applicationUrl.toString();
process.env.ALLOW_DEFAULT_TENANT = 'false';
// T1 isolates explicit predicates from production request auto-wrapping.
process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

const { default: prisma, pinSessionTimeZoneToUrl } = await import('../lib/prisma.js');
const { wardRouter } = await import('../routes/bed/bedRoutes.js');
const { default: consentRouter } = await import('../routes/consentRoutes.js');
const { default: prescriptionRouter } = await import('../routes/prescription/index.js');
const { default: rosterRouter } = await import('../routes/staff/rosterBoardRoutes.js');
const { default: bedService } = await import('../services/bed/bedService.js');
const { saveRosterBoard, saveRosterDay } = await import('../services/staff/rosterBoardService.js');
const { getPrescription } = await import('../controllers/prescription/ePrescriptionController.js');
const { relayAppError } = await import('../utils/responseHelper.js');
const owner = new pg.Client({ connectionString: pinSessionTimeZoneToUrl(ownerUrl) });
const fixtures = [];
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const f = fixtures[Number(req.get('x-test-actor') || 0)];
  const patient = req.get('x-test-role') === 'PATIENT';
  req.user = { ...(patient ? f.patient : f.actor), role: patient ? 'PATIENT' : 'ADMIN' };
  if (req.get('x-test-no-tenant') !== 'true') {
    req.tenantId = f.tenantId;
    req.user.tenant_id = f.tenantId;
  }
  next();
});
app.use('/wards', wardRouter);
app.use('/consent', consentRouter);
app.use('/prescriptions', prescriptionRouter);
app.use('/roster', rosterRouter);
app.use((err, req, res, _next) => relayAppError(res, err));

function call(method, path, { actor = 0, noTenant = false, role = 'ADMIN', body } = {}) {
  const req = request(app)[method](path).set('x-test-actor', String(actor))
    .set('x-test-no-tenant', String(noTenant)).set('x-test-role', role);
  return body ? req.send(body) : req;
}

async function row(table, id) {
  return (await owner.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE id=$1`, [id])).rows[0]?.value;
}

async function extraWard(f) {
  const ward = (await owner.query('INSERT INTO wards (tenant_id,name,floor,total_beds) VALUES ($1::uuid,$2,1,0) RETURNING id,name', [f.tenantId, `RLS-E-WARD-${randomUUID()}`])).rows[0];
  expect(await row('wards', ward.id)).toMatchObject({ tenant_id: f.tenantId });
  return ward;
}

function boardInput(f, staffId = f.staff.id) {
  return {
    shift_id: f.shiftId, shift_label: 'Morning',
    assignments: [{ staff_id: staffId, assignment_target_type: 'housekeeping_zone', assignment_target_id: f.wardId }],
  };
}

async function saveBoardRoute(kind, f, staffId = f.staff.id, actor = 0, extra = {}) {
  const input = { ...boardInput(f, staffId), ...extra };
  return call('post', `/roster/departments/housekeeping/${kind}`, {
    actor, body: kind === 'day-boards'
      ? { roster_date: '2041-03-17', boards: [input] }
      : { roster_date: '2041-03-17', ...input },
  });
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
  `], { env: { ...process.env, DATABASE_URL: ownerUrl, DATABASE_READ_URL: ownerUrl }, stdio: 'pipe', timeout: 30000 });
  for (const label of ['A', 'B']) {
    const f = { tenantId: randomUUID(), marker: `RLS-E-${label}-${randomUUID()}` };
    fixtures.push(f);
    await owner.query('INSERT INTO tenants (id,slug,name) VALUES ($1::uuid,$2,$2)', [f.tenantId, f.marker]);
    for (const [key, role] of [['actor', 'ADMIN'], ['patient', 'PATIENT'], ['doctor', 'DOCTOR'], ['staff', 'HOUSEKEEPING_STAFF']]) {
      f[key] = (await owner.query(
        'INSERT INTO users (tenant_id,uid,phone,name,role,is_active,updated_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,true,NOW()) RETURNING id,uid,name,phone',
        [f.tenantId, randomUUID(), `+91${randomInt(6000000000, 9999999999)}`, `${f.marker}-${key}`, role],
      )).rows[0];
    }
    f.departmentId = (await owner.query('INSERT INTO departments (tenant_id,name,updated_at) VALUES ($1::uuid,$2,NOW()) RETURNING id', [f.tenantId, f.marker])).rows[0].id;
    f.wardId = (await owner.query('INSERT INTO wards (tenant_id,name,floor,department_id,total_beds) VALUES ($1::uuid,$2,1,$3,0) RETURNING id', [f.tenantId, f.marker, f.departmentId])).rows[0].id;
    f.shiftId = (await owner.query("INSERT INTO staff_shifts (tenant_id,name,start_time,end_time,department) VALUES ($1::uuid,$2,'08:00','16:00','housekeeping') RETURNING id", [f.tenantId, f.marker])).rows[0].id;
    f.doctorId = (await owner.query("INSERT INTO doctors (tenant_id,user_id,name,department,specialty,updated_at) VALUES ($1::uuid,$2,$3,'General',$3,NOW()) RETURNING id", [f.tenantId, f.doctor.id, f.marker])).rows[0].id;
    f.rightsId = (await owner.query("INSERT INTO patient_data_rights_requests (tenant_id,patient_uid,request_type,notes) VALUES ($1::uuid,$2::uuid,'export',$3) RETURNING id", [f.tenantId, f.patient.uid, f.marker])).rows[0].id;
    f.rxId = (await owner.query("INSERT INTO e_prescriptions (tenant_id,patient_id,doctor_id,patient_uid,doctor_uid,diagnosis,medications) VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6,'[]'::jsonb) RETURNING id", [f.tenantId, f.patient.id, f.doctor.id, f.patient.uid, f.doctor.uid, f.marker])).rows[0].id;
  }
}, 60000);

beforeEach(async () => {
  for (const f of fixtures) {
    for (const [table, id] of [['wards', f.wardId], ['departments', f.departmentId], ['staff_shifts', f.shiftId], ['doctors', f.doctorId], ['patient_data_rights_requests', f.rightsId], ['e_prescriptions', f.rxId]]) {
      expect(await row(table, id)).toMatchObject({ tenant_id: f.tenantId });
    }
    for (const key of ['actor', 'patient', 'doctor', 'staff']) {
      expect(await row('users', f[key].id)).toMatchObject({ tenant_id: f.tenantId });
    }
  }
  const [role] = await prisma.$queryRawUnsafe('SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
  expect(role).toEqual({ name: 'vhhealth_app', rolsuper: false, rolbypassrls: false });
});

afterEach(async () => {
  const tenants = fixtures.map(f => f.tenantId);
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.audit_bypass','on',true)");
    for (const table of ['audit_logs', 'pathway_projector_inbox', 'event_outbox', 'notifications', 'staff_shift_swap_request_audit', 'staff_shift_swap_requests', 'staff_shift_roster_assignment_audit', 'staff_shift_roster_assignments', 'staff_shift_roster_boards', 'beds', 'admissions', 'leave_applications']) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`, [tenants]);
    }
    for (const f of fixtures) {
      await owner.query('DELETE FROM wards WHERE tenant_id=$1::uuid AND id<>$2', [f.tenantId, f.wardId]);
      await owner.query("UPDATE patient_data_rights_requests SET status='submitted',resolution=NULL,completed_at=NULL WHERE id=$1", [f.rightsId]);
      await owner.query('UPDATE wards SET name=$2,department_id=$3 WHERE id=$1', [f.wardId, f.marker, f.departmentId]);
      await owner.query('UPDATE e_prescriptions SET patient_id=$2,doctor_id=$3 WHERE id=$1', [f.rxId, f.patient.id, f.doctor.id]);
      await owner.query('UPDATE doctors SET user_id=$2 WHERE id=$1', [f.doctorId, f.doctor.id]);
    }
    await owner.query('COMMIT');
  } catch (err) { await owner.query('ROLLBACK'); throw err; }
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    const tenants = fixtures.map(f => f.tenantId);
    for (const table of ['e_prescriptions', 'patient_data_rights_requests', 'doctors', 'staff_shifts', 'wards', 'departments', 'patient_access_audit_log', 'hipaa_access_log', 'users']) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`, [tenants]);
    }
    await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
  } finally {
    await owner.end();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 60_000);

const routes = [
  ['put', '/wards/1', { name: 'Valid ward' }], ['delete', '/wards/1', undefined],
  ['patch', '/consent/data-rights/1', { status: 'completed' }], ['get', '/prescriptions/1', undefined],
  ['post', '/roster/departments/housekeeping/boards', {}], ['post', '/roster/departments/housekeeping/day-boards', {}],
];
describe.each(['false', 'true'])('missing context with ALLOW_DEFAULT_TENANT=%s', allowDefault => {
  it.each(routes)('refuses %s %s before SQL', async (method, path, body) => {
    process.env.ALLOW_DEFAULT_TENANT = allowDefault;
    const spy = jest.spyOn(pg.Client.prototype, 'query');
    try {
      const response = await call(method, path, { noTenant: true, body });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); process.env.ALLOW_DEFAULT_TENANT = 'false'; }
  });
  it.each(['updateWard', 'deleteWard', 'saveRosterBoard', 'saveRosterDay'])('service %s refuses context before SQL', async name => {
    process.env.ALLOW_DEFAULT_TENANT = allowDefault;
    const spy = jest.spyOn(pg.Client.prototype, 'query');
    try {
      const action = name === 'updateWard' ? () => bedService.updateWard(1, {})
        : name === 'deleteWard' ? () => bedService.deleteWard(1)
          : () => ({ saveRosterBoard, saveRosterDay })[name]({});
      await expect(action()).rejects.toMatchObject({ statusCode: 403, code: 'TENANT_CONTEXT_REQUIRED' });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); process.env.ALLOW_DEFAULT_TENANT = 'false'; }
  });
  it('prescription handler refuses context independently of its route guard', async () => {
    process.env.ALLOW_DEFAULT_TENANT = allowDefault;
    const spy = jest.spyOn(pg.Client.prototype, 'query');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    try {
      await getPrescription({ params: { id: '1' }, user: fixtures[0].actor }, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_CONTEXT_REQUIRED' }));
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); process.env.ALLOW_DEFAULT_TENANT = 'false'; }
  });
});

it('ward update denies a populated foreign row without changing or disclosing it', async () => {
  const a = fixtures[0];
  const before = await row('wards', a.wardId);
  const response = await call('put', `/wards/${a.wardId}`, { actor: 1, body: { name: 'Foreign overwrite' } });
  expect(response.status).toBe(404);
  expect(JSON.stringify(response.body)).not.toContain(a.marker);
  expect(await row('wards', a.wardId)).toEqual(before);
});
it('ward update preserves own-tenant work and named response fields', async () => {
  const a = fixtures[0];
  const response = await call('put', `/wards/${a.wardId}`, { body: { name: 'Updated own ward', department_id: a.departmentId } });
  expect(response.status).toBe(200);
  expect(await row('wards', a.wardId)).toMatchObject({ name: 'Updated own ward', tenant_id: a.tenantId });
});
it('ward update refuses a foreign department without changing the ward', async () => {
  const [a, b] = fixtures;
  const before = await row('wards', a.wardId);
  expect((await call('put', `/wards/${a.wardId}`, { body: { department_id: b.departmentId } })).status).toBe(404);
  expect(await row('wards', a.wardId)).toEqual(before);
});
it('ward deletion denies a populated foreign ward without changing or disclosing it', async () => {
  const a = fixtures[0];
  const before = await row('wards', a.wardId);
  const response = await call('delete', `/wards/${a.wardId}`, { actor: 1 });
  expect(response.status).toBe(404);
  expect(JSON.stringify(response.body)).not.toContain(a.marker);
  expect(await row('wards', a.wardId)).toEqual(before);
});
it('ward deletion removes an own empty ward and stamps its audit tenant', async () => {
  const a = fixtures[0];
  const ward = await extraWard(a);
  expect((await call('delete', `/wards/${ward.id}`)).status).toBe(200);
  expect(await row('wards', ward.id)).toBeUndefined();
  const audit = (await owner.query("SELECT tenant_id FROM audit_logs WHERE action='WARD_DELETED' AND resource_id=$1", [String(ward.id)])).rows;
  expect(audit).toEqual([{ tenant_id: a.tenantId }]);
});
it.each(['beds', 'admissions'])('ward deletion ignores foreign %s with the same ward name', async table => {
  const [a, b] = fixtures;
  const ward = await extraWard(a);
  const sql = table === 'beds'
    ? "INSERT INTO beds (tenant_id,ward_name,bed_number,status) VALUES ($1::uuid,$2,'RLS-E-FOREIGN','available') RETURNING id"
    : "INSERT INTO admissions (tenant_id,ward,patient_uid) VALUES ($1::uuid,$2,$3::uuid) RETURNING id";
  const params = table === 'beds' ? [b.tenantId, ward.name] : [b.tenantId, ward.name, b.patient.uid];
  const id = (await owner.query(sql, params)).rows[0].id;
  const before = await row(table, id);
  expect(before.tenant_id).toBe(b.tenantId);
  expect((await call('delete', `/wards/${ward.id}`)).status).toBe(200);
  expect(await row(table, id)).toEqual(before);
});
it.each(['beds', 'admissions'])('ward deletion preserves the own %s conflict check', async table => {
  const a = fixtures[0];
  const ward = await extraWard(a);
  const sql = table === 'beds'
    ? "INSERT INTO beds (tenant_id,ward_name,bed_number,status) VALUES ($1::uuid,$2,'RLS-E-OWN','available') RETURNING id"
    : 'INSERT INTO admissions (tenant_id,ward,patient_uid) VALUES ($1::uuid,$2,$3::uuid) RETURNING id';
  const params = table === 'beds' ? [a.tenantId, ward.name] : [a.tenantId, ward.name, a.patient.uid];
  const id = (await owner.query(sql, params)).rows[0].id;
  expect(await row(table, id)).toMatchObject({ tenant_id: a.tenantId });
  expect((await call('delete', `/wards/${ward.id}`)).status).toBe(409);
  expect(await row('wards', ward.id)).toBeDefined();
});

it('data-rights update denies a foreign request without changing or disclosing it', async () => {
  const a = fixtures[0];
  const before = await row('patient_data_rights_requests', a.rightsId);
  const response = await call('patch', `/consent/data-rights/${a.rightsId}`, { actor: 1, body: { status: 'completed', resolution: { note: 'Foreign overwrite' } } });
  expect(response.status).toBe(404);
  expect(JSON.stringify(response.body)).not.toContain(a.patient.uid);
  expect(await row('patient_data_rights_requests', a.rightsId)).toEqual(before);
  expect((await owner.query("SELECT id FROM event_outbox WHERE aggregate_type='patient_data_rights_request' AND aggregate_id=$1", [String(a.rightsId)])).rows).toHaveLength(0);
});
it('data-rights update succeeds for its tenant and stamps the event outbox', async () => {
  const a = fixtures[0];
  expect((await call('patch', `/consent/data-rights/${a.rightsId}`, { body: { status: 'completed', resolution: { note: 'Own update' } } })).status).toBe(200);
  expect(await row('patient_data_rights_requests', a.rightsId)).toMatchObject({ tenant_id: a.tenantId, status: 'completed' });
  const events = (await owner.query("SELECT tenant_id,patient_uid FROM event_outbox WHERE aggregate_type='patient_data_rights_request' AND aggregate_id=$1", [String(a.rightsId)])).rows;
  expect(events).toEqual([{ tenant_id: a.tenantId, patient_uid: a.patient.uid }]);
});
it('data-rights update preserves the patient-role denial', async () => {
  const a = fixtures[0];
  const before = await row('patient_data_rights_requests', a.rightsId);
  expect((await call('patch', `/consent/data-rights/${a.rightsId}`, { role: 'PATIENT', body: { status: 'completed' } })).status).toBe(403);
  expect(await row('patient_data_rights_requests', a.rightsId)).toEqual(before);
});

describe.each(['boards', 'day-boards'])('roster %s', kind => {
  it('denies foreign staff before any board or assignment is persisted', async () => {
    const [a, b] = fixtures;
    const before = await row('users', a.staff.id);
    const response = await saveBoardRoute(kind, b, a.staff.id, 1);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(a.staff.name);
    expect(await row('users', a.staff.id)).toEqual(before);
    expect((await owner.query('SELECT id FROM staff_shift_roster_boards WHERE tenant_id=$1::uuid', [b.tenantId])).rows).toHaveLength(0);
  });
  it('saves own staff and keeps both tenants separate for the same roster key', async () => {
    for (const [actor, f] of fixtures.entries()) {
      const response = await saveBoardRoute(kind, f, f.staff.id, actor);
      expect(response.status).toBe(200);
      const boards = (await owner.query('SELECT id FROM staff_shift_roster_boards WHERE tenant_id=$1::uuid', [f.tenantId])).rows;
      expect(boards).toHaveLength(1);
      const assignments = (await owner.query('SELECT tenant_id,staff_id FROM staff_shift_roster_assignments WHERE roster_id=$1', [boards[0].id])).rows;
      expect(assignments).toEqual([{ tenant_id: f.tenantId, staff_id: f.staff.id }]);
      const audit = (await owner.query('SELECT tenant_id FROM staff_shift_roster_assignment_audit WHERE roster_id=$1', [boards[0].id])).rows;
      expect(audit).toEqual([{ tenant_id: f.tenantId }]);
    }
  });
  it('refuses a foreign shift lookup', async () => {
    const [a, b] = fixtures;
    expect((await saveBoardRoute(kind, a, a.staff.id, 0, { shift_id: b.shiftId })).status).toBe(404);
  });
  it('refuses a foreign housekeeping target lookup', async () => {
    const [a, b] = fixtures;
    const assignments = [{ staff_id: a.staff.id, assignment_target_type: 'housekeeping_zone', assignment_target_id: b.wardId }];
    expect((await saveBoardRoute(kind, a, a.staff.id, 0, { assignments })).status).toBe(404);
  });
  it.each([false, true])('approved leave conflict is tenant-bound (foreign=%s)', async foreign => {
    const [a, b] = fixtures;
    const tenantId = foreign ? b.tenantId : a.tenantId;
    const leave = (await owner.query(
      "INSERT INTO leave_applications (tenant_id,staff_id,leave_type,start_date,end_date,status) VALUES ($1::uuid,$2,'annual','2041-03-17','2041-03-17','approved') RETURNING id",
      [tenantId, a.staff.id],
    )).rows[0];
    expect(await row('leave_applications', leave.id)).toMatchObject({ tenant_id: tenantId, staff_id: a.staff.id });
    const response = await saveBoardRoute(kind, a);
    expect(response.status).toBe(foreign ? 200 : 409);
    expect(await row('leave_applications', leave.id)).toMatchObject({ status: 'approved' });
  });
  it('re-saving cancels only own swaps and preserves foreign assignments, audit and notifications', async () => {
    const seeds = [];
    for (const [actor, f] of fixtures.entries()) {
      expect((await saveBoardRoute(kind, f, f.staff.id, actor)).status).toBe(200);
      const board = (await owner.query('SELECT id FROM staff_shift_roster_boards WHERE tenant_id=$1::uuid', [f.tenantId])).rows[0];
      const first = (await owner.query('SELECT id FROM staff_shift_roster_assignments WHERE roster_id=$1', [board.id])).rows[0];
      const second = (await owner.query(
        "INSERT INTO staff_shift_roster_assignments (tenant_id,roster_id,staff_id,assignment_target_type) VALUES ($1::uuid,$2,$3,'housekeeping_zone') RETURNING id",
        [f.tenantId, board.id, f.actor.id],
      )).rows[0];
      const swap = (await owner.query(
        "INSERT INTO staff_shift_swap_requests (tenant_id,department,requester_id,counterparty_id,requester_assignment_id,counterparty_assignment_id,expires_at) VALUES ($1::uuid,'housekeeping',$2,$3,$4,$5,'2041-03-18') RETURNING id",
        [f.tenantId, f.staff.id, f.actor.id, first.id, second.id],
      )).rows[0];
      seeds.push({ board, first, second, swap, snapshot: await row('staff_shift_swap_requests', swap.id) });
    }
    expect((await saveBoardRoute(kind, fixtures[0])).status).toBe(200);
    expect(await row('staff_shift_swap_requests', seeds[0].swap.id)).toMatchObject({ status: 'cancelled', requester_assignment_id: null, counterparty_assignment_id: null });
    expect(await row('staff_shift_swap_requests', seeds[1].swap.id)).toEqual(seeds[1].snapshot);
    expect(await row('staff_shift_roster_assignments', seeds[1].first.id)).toMatchObject({ tenant_id: fixtures[1].tenantId });
    expect(await row('staff_shift_roster_assignments', seeds[1].second.id)).toMatchObject({ tenant_id: fixtures[1].tenantId });
    expect((await owner.query('SELECT tenant_id,action FROM staff_shift_swap_request_audit WHERE tenant_id=ANY($1::uuid[])', [fixtures.map(f => f.tenantId)])).rows)
      .toEqual([{ tenant_id: fixtures[0].tenantId, action: 'cancelled' }]);
    const notices = (await owner.query('SELECT tenant_id,user_id FROM notifications WHERE tenant_id=ANY($1::uuid[]) ORDER BY user_id', [fixtures.map(f => f.tenantId)])).rows;
    expect(notices).toEqual([fixtures[0].actor.id, fixtures[0].staff.id].sort((a, b) => a - b).map(user_id => ({ tenant_id: fixtures[0].tenantId, user_id })));
    const audit = (await owner.query("SELECT before_snapshot FROM staff_shift_roster_assignment_audit WHERE roster_id=$1 AND action='updated'", [seeds[0].board.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].before_snapshot.tenant_id).toBe(fixtures[0].tenantId);
    expect(audit[0].before_snapshot.assignments).toHaveLength(2);
  });
});

it.each(['ADMIN', 'PATIENT'])('prescription detail denies a foreign tenant for %s without disclosure', async role => {
  const a = fixtures[0];
  const response = await call('get', `/prescriptions/${a.rxId}`, { actor: 1, role });
  expect([403, 404]).toContain(response.status);
  expect(JSON.stringify(response.body)).not.toContain(a.marker);
});
it.each(['ADMIN', 'PATIENT'])('prescription detail preserves own-tenant %s access and joined fields', async role => {
  const a = fixtures[0];
  const response = await call('get', `/prescriptions/${a.rxId}`, { role });
  expect({ status: response.status, body: response.body }).toMatchObject({ status: 200 });
  expect(response.body.data).toMatchObject({ id: a.rxId, tenant_id: a.tenantId, patient_name: a.patient.name, doctor_name: a.doctor.name, doctor_specialization: a.marker });
});
it('prescription detail refuses a foreign doctor join', async () => {
  const [a, b] = fixtures;
  await owner.query('UPDATE e_prescriptions SET doctor_id=$2 WHERE id=$1', [a.rxId, b.doctor.id]);
  const response = await call('get', `/prescriptions/${a.rxId}`);
  expect([403, 404]).toContain(response.status);
  expect(JSON.stringify(response.body)).not.toContain(b.marker);
});
it('the existing patient identity foreign key refuses a foreign patient association', async () => {
  const [a, b] = fixtures;
  await expect(owner.query('UPDATE e_prescriptions SET patient_id=$2,patient_uid=$3::uuid WHERE id=$1', [a.rxId, b.patient.id, b.patient.uid]))
    .rejects.toMatchObject({ code: '23503', constraint: 'fk_e_prescriptions_patient_identity_753' });
  expect(await row('e_prescriptions', a.rxId)).toMatchObject({ tenant_id: a.tenantId, patient_id: a.patient.id, patient_uid: a.patient.uid });
});
it('prescription detail excludes a foreign doctor profile without hiding the own prescription', async () => {
  const [a, b] = fixtures;
  await owner.query('UPDATE doctors SET user_id=$2 WHERE id=$1', [b.doctorId, a.doctor.id]);
  const response = await call('get', `/prescriptions/${a.rxId}`);
  expect(response.status).toBe(200);
  expect(response.body.data.doctor_specialization).toBe(a.marker);
  expect(JSON.stringify(response.body)).not.toContain(b.marker);
});
