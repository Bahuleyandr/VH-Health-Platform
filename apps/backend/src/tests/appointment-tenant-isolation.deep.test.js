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
process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

const { default: prisma, pinSessionTimeZoneToUrl } = await import('../lib/prisma.js');
const { default: workflowRouter } = await import('../routes/appointment/appointmentWorkflowRoutes.js');
const { default: adminRouter } = await import('../routes/doctor/adminDoctorRoutes.js');
const { requireRole } = await import('../middleware/rbacMiddleware.js');
const { APPOINTMENT_ROUTE_ROLES, ADMIN_ROUTE_ROLES } = await import('../config/routeRolePolicy.js');
const owner = new pg.Client({ connectionString: pinSessionTimeZoneToUrl(ownerDatabaseUrl) });
const fixtures = [];
let today;
let foreignSlotId;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const fixture = fixtures[Number(req.get('x-test-actor') || 0)];
  const role = req.get('x-test-role') || 'ADMIN';
  const actor = role === 'DOCTOR' ? fixture.doctor : role === 'PATIENT' ? fixture.patient : fixture.actor;
  req.user = { id: actor.id, uid: actor.uid, phone: actor.phone, role };
  if (req.get('x-test-no-tenant') !== 'true') {
    req.tenantId = fixture.tenantId;
    req.user.tenant_id = fixture.tenantId;
  }
  next();
});
app.use('/api/v1/appointments', requireRole(...APPOINTMENT_ROUTE_ROLES), workflowRouter);
app.use('/api/v1/admin/doctors', requireRole(...ADMIN_ROUTE_ROLES), adminRouter);
app.use('/api/v1/doctors/admin', requireRole('ADMIN'), adminRouter);

function call(path, { actor = 0, role = 'ADMIN', noTenant = false, body } = {}) {
  const route = path.startsWith('/api/') ? path : `/api/v1/appointments${path}`;
  const req = body ? request(app).put(route).send(body) : request(app).get(route);
  return req.set('x-test-actor', String(actor)).set('x-test-role', role).set('x-test-no-tenant', String(noTenant));
}

async function populateAppointment(fixture, doctorId, time, department, visitType = 'NEW') {
  return (await owner.query(
    `INSERT INTO appointments (tenant_id, patient_id, phone, doctor_id, appointment_date,
       appointment_time, status, department, queue_id, visit_type, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::date, $6, 'CONFIRMED', $7, $8, $9, NOW()) RETURNING id`,
    [fixture.tenantId, fixture.patient.id, fixture.patient.phone, doctorId, today, time, department, fixture.queueId, visitType],
  )).rows[0].id;
}

async function doctorSnapshot(fixture) {
  const doctor = (await owner.query('SELECT name, specialty, department, intro, user_id FROM doctors WHERE id=$1', [fixture.doctorRowId])).rows[0];
  const user = (await owner.query('SELECT name, email, phone FROM users WHERE id=$1', [fixture.doctor.id])).rows[0];
  return { doctor, user };
}

async function assertPopulation() {
  for (const fixture of fixtures) {
    expect((await owner.query('SELECT tenant_id FROM doctors WHERE id=$1', [fixture.doctorRowId])).rows)
      .toEqual([{ tenant_id: fixture.tenantId }]);
    const rows = (await owner.query('SELECT tenant_id FROM appointments WHERE id=ANY($1::int[])', [[fixture.appointmentId, fixture.unassignedId]])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.tenant_id === fixture.tenantId)).toBe(true);
    expect((await owner.query('SELECT tenant_id FROM teleconsultations WHERE id=$1', [fixture.teleconsultId])).rows)
      .toEqual([{ tenant_id: fixture.tenantId }]);
  }
  expect((await owner.query('SELECT tenant_id, doctor_id, appointment_time FROM appointments WHERE id=$1', [foreignSlotId])).rows)
    .toEqual([{ tenant_id: fixtures[1].tenantId, doctor_id: fixtures[0].doctor.id, appointment_time: '09:30' }]);
}

beforeAll(async () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import prisma, { ensureTenantRlsRuntimeRoleGrants } from './src/lib/prisma.js';
    try {
      const result = await ensureTenantRlsRuntimeRoleGrants();
      if (result.skipped || result.error) throw new Error('Runtime role bootstrap failed');
    } finally { await prisma.$disconnect(); }
  `], { env: { ...process.env, DATABASE_URL: ownerDatabaseUrl, DATABASE_READ_URL: ownerDatabaseUrl }, stdio: 'pipe', timeout: 30000 });
  await owner.connect();
  const timezoneSql = "SELECT current_setting('TimeZone') AS timezone";
  expect((await owner.query(timezoneSql)).rows).toEqual(await prisma.$queryRawUnsafe(timezoneSql));
  today = (await owner.query("SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS day")).rows[0].day;
  const hours = Object.fromEntries(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    .map(day => [day, { start: '09:00', end: '10:00' }]));
  for (const label of ['A', 'B']) {
    const fixture = { tenantId: randomUUID(), marker: `RLS-APPT-${label}-${randomUUID()}` };
    fixtures.push(fixture);
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,$2,$2)', [fixture.tenantId, fixture.marker]);
    for (const [key, role] of [['actor', 'ADMIN'], ['patient', 'PATIENT'], ['doctor', 'DOCTOR']]) {
      fixture[key] = (await owner.query(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,true,NOW()) RETURNING id,uid,phone,name`,
        [randomUUID(), fixture.tenantId, `+91${randomInt(6000000000, 9999999999)}`, `${fixture.marker}-${key}`, role],
      )).rows[0];
    }
    fixture.departmentId = (await owner.query('INSERT INTO departments (tenant_id,name,updated_at) VALUES ($1::uuid,$2,NOW()) RETURNING id',
      [fixture.tenantId, fixture.marker])).rows[0].id;
    fixture.doctorRowId = (await owner.query(
      `INSERT INTO doctors (tenant_id,user_id,name,department,department_id,specialty,available_hours,is_active,updated_at)
       VALUES ($1::uuid,$2,$3,$4,$5,'General Medicine',$6::jsonb,true,NOW()) RETURNING id`,
      [fixture.tenantId, fixture.doctor.id, fixture.doctor.name, fixture.marker, fixture.departmentId, JSON.stringify(hours)],
    )).rows[0].id;
    fixture.queueId = (await owner.query(
      "INSERT INTO appointment_queues (tenant_id,queue_date,queue_label,department_name,status) VALUES ($1::uuid,$2::date,$3,$3,'open') RETURNING id",
      [fixture.tenantId, today, fixture.marker],
    )).rows[0].id;
    fixture.appointmentId = await populateAppointment(fixture, fixture.doctor.id, '09:00', fixture.marker, 'TELE');
    fixture.unassignedId = await populateAppointment(fixture, null, '10:00', fixture.marker);
    fixture.teleconsultId = Number((await owner.query(
      "INSERT INTO teleconsultations (tenant_id,appointment_id,status,updated_at) VALUES ($1::uuid,$2,'scheduled',NOW()) RETURNING id",
      [fixture.tenantId, fixture.appointmentId],
    )).rows[0].id);
    fixture.emergencyId = Number((await owner.query(
      `INSERT INTO emergency_visits (tenant_id,patient_uid,visit_number,arrival_at,triage_priority,chief_complaint)
       VALUES ($1::uuid,$2::uuid,$3::text,NOW(),'esi_2',$3::text) RETURNING id`,
      [fixture.tenantId, fixture.patient.uid, fixture.marker],
    )).rows[0].id);
    fixture.pregnancyId = Number((await owner.query(
      "INSERT INTO maternity_pregnancies (tenant_id,patient_uid,status,lmp_date) VALUES ($1::uuid,$2::uuid,'ongoing',$3::date - 90) RETURNING id",
      [fixture.tenantId, fixture.patient.uid, today],
    )).rows[0].id);
  }
  foreignSlotId = await populateAppointment(fixtures[1], fixtures[0].doctor.id, '09:30', `${fixtures[1].marker}-foreign-slot`);
}, 45000);

beforeEach(assertPopulation);
afterAll(async () => {
  await prisma.$disconnect();
  try {
    const tenants = fixtures.map(f => f.tenantId);
    for (const table of ['teleconsultations', 'appointments', 'appointment_queues', 'emergency_visits', 'maternity_pregnancies', 'doctors', 'departments', 'users']) {
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

it('uses the application role for actual SQL', async () => {
  const spy = jest.spyOn(pg.Client.prototype, 'query');
  try {
    expect(await prisma.$queryRawUnsafe('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
      .toEqual([{ role: 'vhhealth_app', rolsuper: false, rolbypassrls: false }]);
    expect(spy).toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

describe.each(['false', 'true'])('missing tenant with ALLOW_DEFAULT_TENANT=%s', allowDefault => {
  it.each(['/queue/today', '/queue/today/mine', '/doctors/options', '/slots', '/api/v1/admin/doctors/:id/profile', '/api/v1/doctors/admin/:id/profile'])
    ('refuses %s before SQL', async path => {
      const previous = process.env.ALLOW_DEFAULT_TENANT;
      process.env.ALLOW_DEFAULT_TENANT = allowDefault;
      const spy = jest.spyOn(pg.Client.prototype, 'query');
      try {
        const route = path === '/slots' ? `${path}?doctor_id=${fixtures[0].doctor.id}&date=${today}` : path.replace(':id', fixtures[0].doctorRowId);
        const response = await call(route, { noTenant: true, ...(path.includes('/profile') ? { body: { name: 'No tenant' } } : {}) });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); process.env.ALLOW_DEFAULT_TENANT = previous; }
    });
});

describe('today queue and helper statements', () => {
  it('denies tenant B the populated tenant A department queue', async () => {
    const response = await call(`/queue/today?department=${fixtures[0].marker}`, { actor: 1 });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
  it('shows tenant A its assigned and unassigned queue with own enrichment', async () => {
    const fixture = fixtures[0];
    const response = await call(`/queue/today?department=${fixture.marker}`);
    expect(response.status).toBe(200);
    expect(response.body.data.map(row => row.id).sort()).toEqual([fixture.appointmentId, fixture.unassignedId].sort());
    const row = response.body.data.find(r => r.id === fixture.appointmentId);
    expect(row).toMatchObject({ patient_name: fixture.patient.name, doctor_display_name: fixture.doctor.name,
      queue_label: fixture.marker, emergency_visit_id: fixture.emergencyId, pregnancy_id: fixture.pregnancyId,
      triage_priority: 'esi_2', is_emergent: true, teleconsultation_id: fixture.teleconsultId });
    expect(row.gestational_age).toBeDefined();
  });
  it.each(['/queue/today', '/queue/today/mine'])('preserves the doctor assignment and department filter on %s', async path => {
    const response = await call(`${path}?doctor_id=${fixtures[1].doctor.id}`, { role: 'DOCTOR' });
    expect(response.status).toBe(200);
    expect(response.body.data.map(row => row.id).sort()).toEqual([fixtures[0].appointmentId, fixtures[0].unassignedId].sort());
  });
  it('does not disclose foreign joined metadata from inconsistent references', async () => {
    const [a, b] = fixtures;
    await owner.query('UPDATE appointments SET patient_id=$1,doctor_id=$2,queue_id=$3 WHERE id=$4', [b.patient.id, b.doctor.id, b.queueId, a.appointmentId]);
    try {
      const response = await call(`/queue/today?department=${a.marker}`);
      expect(response.status).toBe(200);
      const row = response.body.data.find(r => r.id === a.appointmentId);
      expect(row).toMatchObject({ patient_name: null, patient_phone: null, doctor_display_name: null,
        specialization: null, queue_label: null, emergency_visit_id: null, pregnancy_id: null });
      expect(JSON.stringify(row)).not.toContain(b.marker);
    } finally {
      await owner.query('UPDATE appointments SET patient_id=$1,doctor_id=$2,queue_id=$3 WHERE id=$4', [a.patient.id, a.doctor.id, a.queueId, a.appointmentId]);
    }
  });
  it('ignores foreign emergency, pregnancy and teleconsult rows linked to its patient or appointment', async () => {
    const [a, b] = fixtures;
    await owner.query('UPDATE emergency_visits SET patient_uid=$1::uuid,arrival_at=NOW()+INTERVAL \'1 minute\' WHERE id=$2', [a.patient.uid, b.emergencyId]);
    await owner.query('UPDATE maternity_pregnancies SET patient_uid=$1::uuid,created_at=NOW()+INTERVAL \'1 minute\' WHERE id=$2', [a.patient.uid, b.pregnancyId]);
    await owner.query("UPDATE teleconsultations SET appointment_id=$1,status='in_progress' WHERE id=$2", [a.appointmentId, b.teleconsultId]);
    try {
      const response = await call(`/queue/today?department=${a.marker}`);
      expect(response.status).toBe(200);
      expect(response.body.data.find(r => r.id === a.appointmentId)).toMatchObject({
        emergency_visit_id: a.emergencyId, pregnancy_id: a.pregnancyId, teleconsultation_id: a.teleconsultId,
      });
    } finally {
      await owner.query('UPDATE emergency_visits SET patient_uid=$1::uuid WHERE id=$2', [b.patient.uid, b.emergencyId]);
      await owner.query('UPDATE maternity_pregnancies SET patient_uid=$1::uuid WHERE id=$2', [b.patient.uid, b.pregnancyId]);
      await owner.query("UPDATE teleconsultations SET appointment_id=$1,status='scheduled' WHERE id=$2", [b.appointmentId, b.teleconsultId]);
    }
  });
});

describe('doctor options list and count', () => {
  it('denies tenant B the populated tenant A roster', async () => {
    const response = await call(`/doctors/options?search=${fixtures[0].marker}`, { actor: 1, role: 'PATIENT' });
    expect(response.status).toBe(200);
    expect(response.body.data.doctors).toEqual([]);
    expect(response.body.data.pagination.total).toBe(0);
  });
  it('lets a tenant A patient find a bookable doctor with matching count and filters', async () => {
    const a = fixtures[0];
    const response = await call(`/doctors/options?search=${a.marker}&department=${a.marker}&specialty=Medicine&ageRange=adult&limit=1`, { role: 'PATIENT' });
    expect(response.status).toBe(200);
    expect(response.body.data.doctors).toHaveLength(1);
    expect(response.body.data.doctors[0]).toMatchObject({ id: a.doctor.id, user_id: a.doctor.id, doctor_row_id: a.doctorRowId, name: a.doctor.name });
    expect(response.body.data.pagination.total).toBe(1);
  });
});

describe('available slot doctor lookup and booked statement', () => {
  it.each(['doctorRowId', 'userId'])('denies tenant B a populated tenant A doctor by %s', async kind => {
    const id = kind === 'userId' ? fixtures[0].doctor.id : fixtures[0].doctorRowId;
    const response = await call(`/slots?doctor_id=${id}&date=${today}`, { actor: 1, role: 'PATIENT' });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(fixtures[0].marker);
  });
  it.each(['doctorRowId', 'userId'])('preserves tenant A own booked slot and schedule by %s', async kind => {
    const a = fixtures[0];
    const id = kind === 'userId' ? a.doctor.id : a.doctorRowId;
    const response = await call(`/slots?doctor_id=${id}&date=${today}`, { role: 'PATIENT' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ doctor_user_id: a.doctor.id, doctor_name: a.doctor.name, total_slots: 2 });
    expect(response.body.data.slots.find(row => row.time === '09:00')).toEqual({ time: '09:00', available: false });
  });
  it('excludes tenant B bookings linked to the tenant A doctor', async () => {
    const response = await call(`/slots?doctor_id=${fixtures[0].doctor.id}&date=${today}`, { role: 'PATIENT' });
    expect(response.status).toBe(200);
    expect(response.body.data.slots.find(row => row.time === '09:30')).toEqual({ time: '09:30', available: true });
  });
});

describe.each(['/api/v1/admin/doctors', '/api/v1/doctors/admin'])('admin profile at %s', prefix => {
  it('denies tenant B and leaves both populated tenant A rows unchanged', async () => {
    const a = fixtures[0];
    const before = await doctorSnapshot(a);
    const response = await call(`${prefix}/${a.doctorRowId}/profile`, { actor: 1, body: { name: 'Foreign overwrite', email: 'foreign@example.invalid', phone: '+919100000001', specialization: 'Foreign specialty' } });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(a.marker);
    expect(await doctorSnapshot(a)).toEqual(before);
  });
  it('updates both tenant A profile and user fields', async () => {
    const a = fixtures[0];
    const before = await doctorSnapshot(a);
    try {
      const response = await call(`${prefix}/${a.doctor.id}/profile`, { body: { name: `${a.marker}-updated`, email: 'own@example.invalid', specialization: 'Updated specialty' } });
      expect(response.status).toBe(200);
      expect(response.body.data.doctor.id).toBe(a.doctorRowId);
      expect((await doctorSnapshot(a)).doctor).toMatchObject({ name: `${a.marker}-updated`, specialty: 'Updated specialty' });
      expect((await doctorSnapshot(a)).user).toMatchObject({ name: `${a.marker}-updated`, email: 'own@example.invalid' });
    } finally {
      await owner.query('UPDATE doctors SET name=$1,specialty=$2 WHERE id=$3', [before.doctor.name, before.doctor.specialty, a.doctorRowId]);
      await owner.query('UPDATE users SET name=$1,email=$2 WHERE id=$3', [before.user.name, before.user.email, a.doctor.id]);
    }
  });
});

it('preserves legacy doctor profiles with no user row', async () => {
  const a = fixtures[0];
  const id = (await owner.query('INSERT INTO doctors (tenant_id,name,department,is_active,updated_at) VALUES ($1::uuid,$2,$2,true,NOW()) RETURNING id', [a.tenantId, a.marker])).rows[0].id;
  try {
    const response = await call(`/api/v1/admin/doctors/${id}/profile`, { body: { name: 'Legacy updated', bio: 'Legacy profile' } });
    expect(response.status).toBe(200);
    expect((await owner.query('SELECT name,intro,user_id FROM doctors WHERE id=$1', [id])).rows)
      .toEqual([{ name: 'Legacy updated', intro: 'Legacy profile', user_id: null }]);
  } finally { await owner.query('DELETE FROM doctors WHERE id=$1', [id]); }
});

it('does not overwrite or disclose a foreign user linked to an own-tenant doctor profile', async () => {
  const [a, b] = fixtures;
  const before = (await owner.query('SELECT name,email,phone FROM users WHERE id=$1', [b.patient.id])).rows;
  await owner.query('UPDATE doctors SET user_id=$1 WHERE id=$2', [b.patient.id, a.doctorRowId]);
  try {
    const response = await call(`/api/v1/admin/doctors/${a.doctorRowId}/profile`, { body: { name: 'Own profile edit', email: 'must-not-cross@example.invalid' } });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(b.marker);
    expect((await owner.query('SELECT name,email,phone FROM users WHERE id=$1', [b.patient.id])).rows).toEqual(before);
  } finally {
    await owner.query('UPDATE doctors SET user_id=$1,name=$2 WHERE id=$3', [a.doctor.id, a.doctor.name, a.doctorRowId]);
  }
});
