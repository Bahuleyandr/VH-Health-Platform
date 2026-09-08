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
// Queue predicates must protect the application role without automatic wrapping.
process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

const { default: prisma, pinSessionTimeZoneToUrl } = await import('../lib/prisma.js');
const owner = new pg.Client({ connectionString: pinSessionTimeZoneToUrl(ownerDatabaseUrl) });
const { default: investigationRouter } = await import('../routes/investigation/investigationRoutes.js');
const fixtures = [];
let catalogId;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const fixture = fixtures[Number(req.get('x-test-actor') || 0)];
  const patient = req.get('x-test-patient') === 'true';
  const actor = patient ? fixture.patient : fixture.actor;
  req.user = { id: actor.id, uid: actor.uid, role: patient ? 'PATIENT' : 'ADMIN', phone: actor.phone };
  if (req.get('x-test-no-tenant') !== 'true') {
    req.tenantId = fixture.tenantId;
    req.user.tenant_id = fixture.tenantId;
  }
  next();
});
app.use('/api/v1/investigations', investigationRouter);

function get(path, actor = 0, { noTenant = false, patient = false } = {}) {
  return request(app).get(`/api/v1/investigations${path}`)
    .set('x-test-actor', String(actor)).set('x-test-no-tenant', String(noTenant))
    .set('x-test-patient', String(patient));
}

async function assertPopulation() {
  for (const fixture of fixtures) {
    const rows = (await owner.query('SELECT id, tenant_id FROM investigations WHERE id = ANY($1::int[])',
      [[fixture.completedId, fixture.urgentId]])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.tenant_id === fixture.tenantId)).toBe(true);
    expect((await owner.query('SELECT tenant_id FROM investigation_bookings WHERE id = $1::bigint', [fixture.bookingId])).rows)
      .toEqual([{ tenant_id: fixture.tenantId }]);
  }
}

beforeAll(async () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import prisma, { ensureTenantRlsRuntimeRoleGrants } from './src/lib/prisma.js';
    try {
      const result = await ensureTenantRlsRuntimeRoleGrants();
      if (result.skipped || result.error) throw new Error('Runtime role bootstrap failed');
    } finally { await prisma.$disconnect(); }
  `], {
    env: { ...process.env, DATABASE_URL: ownerDatabaseUrl, DATABASE_READ_URL: ownerDatabaseUrl },
    stdio: 'pipe', timeout: 30000,
  });
  await owner.connect();
  const timezoneSql = "SELECT current_setting('TimeZone') AS timezone";
  expect((await owner.query(timezoneSql)).rows).toEqual(await prisma.$queryRawUnsafe(timezoneSql));
  catalogId = Number((await owner.query('INSERT INTO investigation_test_catalog (name) VALUES ($1) RETURNING id',
    [`RLS-INV-CATALOG-${randomUUID()}`])).rows[0].id);
  const sharedPhone = `+91${randomInt(6000000000, 9999999999)}`;
  for (const [index, label] of ['A', 'B'].entries()) {
    const fixture = { tenantId: randomUUID(), marker: `RLS-INV-${label}-${randomUUID()}` };
    fixtures.push(fixture);
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2)', [fixture.tenantId, fixture.marker]);
    for (const [key, role] of [['actor', 'ADMIN'], ['patient', 'PATIENT']]) {
      fixture[key] = (await owner.query(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, NOW()) RETURNING id, uid, phone, name`,
        [randomUUID(), fixture.tenantId, key === 'patient' ? sharedPhone : `+91${randomInt(6000000000, 9999999999)}`, `${fixture.marker}-${key}`, role],
      )).rows[0];
    }
    fixture.doctorId = (await owner.query(
      `INSERT INTO doctors (user_id, department, specialty, tenant_id, updated_at)
       VALUES ($1::int, 'Pathology', 'Pathology', $2::uuid, NOW()) RETURNING id`,
      [fixture.actor.id, fixture.tenantId],
    )).rows[0].id;
    for (const [key, status, priority] of [['completedId', 'COMPLETED', 'NORMAL'], ['urgentId', 'PENDING', 'URGENT']]) {
      fixture[key] = (await owner.query(
        `INSERT INTO investigations (patient_id, patient_uid, phone, tenant_id, test_name, status, priority,
           requested_by, requested_at, completed_at, result_uploaded_at, updated_at, created_at,
           results, structured_results, result_summary, notes, file_key)
         VALUES ($1::int, $2::uuid, $3, $4::uuid, $5, $6::text, $7, $8::uuid, NOW() - INTERVAL '1 day',
           CASE WHEN $6::text = 'COMPLETED' THEN NOW() ELSE NULL END,
           CASE WHEN $6::text = 'COMPLETED' THEN NOW() ELSE NULL END, NOW(), NOW(),
           '{"private":true}'::jsonb, '{"private":true}'::jsonb, 'private result', 'private notes', 'private-file') RETURNING id`,
        [fixture.patient.id, fixture.patient.uid, sharedPhone, fixture.tenantId, fixture.marker, status, priority, fixture.actor.uid],
      )).rows[0].id;
    }
    fixture.bookingId = (await owner.query(
      `INSERT INTO investigation_bookings (tenant_id, patient_id, patient_name, patient_phone, test_name,
         selected_tests, status, collection_type, notes)
       VALUES ($1::uuid, $2::int, $3::text, $4, $3::text, $5::int[], $6, 'home', $3::text) RETURNING id`,
      [fixture.tenantId, fixture.patient.id, fixture.marker, sharedPhone, [catalogId], index ? 'CONFIRMED' : 'BOOKED'],
    )).rows[0].id;
  }
}, 45000);

beforeEach(assertPopulation);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    for (const fixture of fixtures) {
      for (const table of ['investigation_bookings', 'investigations', 'doctors', 'users']) {
        await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, [fixture.tenantId]);
      }
      await owner.query('DELETE FROM audit_logs WHERE tenant_id = $1::uuid', [fixture.tenantId]);
      await owner.query('DELETE FROM tenants WHERE id = $1::uuid', [fixture.tenantId]);
    }
    await owner.query('DELETE FROM investigation_test_catalog WHERE id = $1::bigint', [catalogId]);
  } finally {
    await owner.end();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 45000);

it('uses the application role even for bare singleton SQL', async () => {
  const queries = jest.spyOn(pg.Client.prototype, 'query');
  try {
    const [role] = await prisma.$queryRawUnsafe('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(role).toEqual({ role: 'vhhealth_app', rolsuper: false, rolbypassrls: false });
    expect(queries).toHaveBeenCalled();
  } finally { queries.mockRestore(); }
});

describe.each(['false', 'true'])('missing tenant with ALLOW_DEFAULT_TENANT=%s', (allowDefault) => {
  it.each(['/uid/:uid', '/my', '/sla-dashboard', '/bookings/queue'])('refuses %s before any SQL', async (path) => {
    const previous = process.env.ALLOW_DEFAULT_TENANT;
    process.env.ALLOW_DEFAULT_TENANT = allowDefault;
    const queries = jest.spyOn(pg.Client.prototype, 'query');
    try {
      const response = await get(path.replace(':uid', fixtures[0].patient.uid), 0, { noTenant: true, patient: path === '/my' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
      expect(queries).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore();
      process.env.ALLOW_DEFAULT_TENANT = previous;
    }
  });
});

describe('UID list and count', () => {
  it('denies tenant B access to tenant A UID', async () => {
    const response = await get(`/uid/${fixtures[0].patient.uid}`, 1);
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(fixtures[0].marker);
  });
  it('returns tenant A rows, matching pagination and joined names', async () => {
    const response = await get(`/uid/${fixtures[0].patient.uid}?limit=1`);
    expect(response.status).toBe(200);
    expect(response.body.data.investigations).toHaveLength(1);
    expect(response.body.data.pagination.total).toBe(2);
    expect(response.body.data.investigations[0]).toMatchObject({ patient_name: fixtures[0].patient.name, doctor_id: fixtures[0].doctorId });
  });
  it('refuses missing tenant context', async () => {
    const response = await get('/my', 0, { patient: true, noTenant: true });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
  });
  it('keeps the patient self-service alias scoped when two tenants share a phone', async () => {
    const response = await get('/my', 1, { patient: true });
    expect(response.status).toBe(200);
    expect(response.body.data.investigations.map(row => row.id).sort()).toEqual([fixtures[1].completedId, fixtures[1].urgentId].sort());
    expect(response.body.data.pagination.total).toBe(2);
    expect(JSON.stringify(response.body)).not.toContain(fixtures[0].marker);
  });
  it('stores the audit in the actual tenant column', async () => {
    const response = await get('/my', 1, { patient: true });
    expect(response.status).toBe(200);
    const rows = (await owner.query("SELECT tenant_id, actor_uid, subject_uid FROM audit_logs WHERE action = 'investigations-uid-lookup' AND uid = $1::uuid", [fixtures[1].patient.uid])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.tenant_id === fixtures[1].tenantId && row.actor_uid === fixtures[1].patient.uid && row.subject_uid === fixtures[1].patient.uid)).toBe(true);
  });
  it('preserves malformed UID and patient ownership errors', async () => {
    expect((await get('/uid/not-a-uuid')).status).toBe(400);
    expect((await get(`/uid/${fixtures[1].patient.uid}`, 0, { patient: true })).status).toBe(403);
  });
  it.each(['patient_uid', 'patient_id', 'uid', 'phone'])('retains %s-only legacy or integration identity', async (identity) => {
    const fixture = fixtures[0];
    const id = (await owner.query(
      `INSERT INTO investigations (phone, patient_uid, patient_id, uid, tenant_id, test_name, updated_at)
       VALUES ($1, $2::uuid, $3::int, $4::uuid, $5::uuid, 'identity-control', NOW()) RETURNING id`,
      [identity === 'phone' ? fixture.patient.phone : '+910000000000', identity === 'patient_uid' ? fixture.patient.uid : null,
        identity === 'patient_id' ? fixture.patient.id : null, identity === 'uid' ? fixture.patient.uid : null, fixture.tenantId],
    )).rows[0].id;
    try {
      const response = await get('/my', 0, { patient: true });
      expect(response.status).toBe(200);
      expect(response.body.data.investigations.map(row => row.id)).toContain(id);
      expect(response.body.data.pagination.total).toBe(3);
    } finally { await owner.query('DELETE FROM investigations WHERE id = $1::int', [id]); }
  });
  it('excludes conflicting linked identity even when the phone matches', async () => {
    const fixture = fixtures[0];
    const id = (await owner.query(
      `INSERT INTO investigations (phone, patient_uid, patient_id, tenant_id, test_name, updated_at)
       VALUES ($1, $2::uuid, $3::int, $4::uuid, 'conflicting-identity', NOW()) RETURNING id`,
      [fixture.patient.phone, fixture.patient.uid, fixture.actor.id, fixture.tenantId],
    )).rows[0].id;
    try {
      const response = await get('/my', 0, { patient: true });
      expect(response.status).toBe(200);
      expect(response.body.data.investigations.map(row => row.id)).not.toContain(id);
      expect(response.body.data.pagination.total).toBe(2);
    } finally { await owner.query('DELETE FROM investigations WHERE id = $1::int', [id]); }
  });
});

describe.each(['summary', 'by_status', 'by_priority', 'urgent_pending', 'recent_completed'])('SLA %s statement', (field) => {
  function expectOwn(data, fixture) {
    if (field === 'summary') expect(Number(data.total)).toBe(2);
    else if (field === 'by_status' || field === 'by_priority') expect(data.reduce((sum, row) => sum + Number(row.count), 0)).toBe(2);
    else {
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe(field === 'urgent_pending' ? fixture.urgentId : fixture.completedId);
      expect(data[0].patient_name).toBe(fixture.patient.name);
      for (const key of ['results', 'structured_results', 'result_summary', 'file_key', 'notes']) expect(data[0]).not.toHaveProperty(key);
    }
  }
  it('excludes tenant A rows for tenant B', async () => {
    const response = await get('/sla-dashboard', 1, { patient: true });
    expect(response.status).toBe(200);
    expectOwn(response.body.data[field], fixtures[1]);
  });
  it('returns tenant A positive control', async () => {
    const response = await get('/sla-dashboard');
    expect(response.status).toBe(200);
    expectOwn(response.body.data[field], fixtures[0]);
  });
  it('refuses missing tenant before querying', async () => {
    const response = await get('/sla-dashboard', 0, { noTenant: true });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
  });
});

it('preserves own SLA rows while foreign joined patient and requester metadata stay null', async () => {
  const [own, foreign] = fixtures;
  await owner.query('UPDATE investigations SET patient_id = $2::int, requested_by = $3::uuid WHERE id = $1::int',
    [own.urgentId, foreign.patient.id, foreign.actor.uid]);
  try {
    const response = await get('/sla-dashboard');
    expect(response.status).toBe(200);
    expect(response.body.data.urgent_pending).toHaveLength(1);
    expect(response.body.data.urgent_pending[0]).toMatchObject({
      id: own.urgentId, patient_name: null, patient_phone: null,
      requested_by_name: null, requested_by_role: null, doctor_name: null, doctor_id: null,
    });
  } finally {
    await owner.query('UPDATE investigations SET patient_id = $2::int, requested_by = $3::uuid WHERE id = $1::int',
      [own.urgentId, own.patient.id, own.actor.uid]);
  }
});

it('keeps date filters on SLA aggregates and preserves independent recent and urgent windows', async () => {
  const response = await get('/sla-dashboard?from_date=2000-01-01&to_date=2000-01-02');
  expect(response.status).toBe(200);
  expect(Number(response.body.data.summary.total)).toBe(0);
  expect(response.body.data.by_status).toEqual([]);
  expect(response.body.data.by_priority).toEqual([]);
  expect(response.body.data.recent_completed.map(row => row.id)).toEqual([fixtures[0].completedId]);
  expect(response.body.data.urgent_pending.map(row => row.id)).toEqual([fixtures[0].urgentId]);
});

describe('booking queue', () => {
  it('denies tenant B the populated tenant A booked queue', async () => {
    const response = await get('/bookings/queue?status=BOOKED', 1);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
  it('returns tenant A bookings with global catalog names and existing filters', async () => {
    const [{ day }] = await prisma.$queryRawUnsafe(
      'SELECT DATE(created_at)::text AS day FROM investigation_bookings WHERE id = $1::bigint', fixtures[0].bookingId,
    );
    const response = await get(`/bookings/queue?status=BOOKED&collection_type=home&from_date=${day}&to_date=${day}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(String(response.body.data[0].id)).toBe(String(fixtures[0].bookingId));
    expect(response.body.data[0].test_names).toHaveLength(1);
    expect(response.body.data[0].slip_photo_url).toBeNull();
  });
  it('retains the existing patient-role route and confirmed filter', async () => {
    const response = await get('/bookings/queue?status=CONFIRMED', 1, { patient: true });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(String(response.body.data[0].id)).toBe(String(fixtures[1].bookingId));
  });
  it('refuses missing tenant context', async () => {
    const response = await get('/bookings/queue', 0, { noTenant: true });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
  });
});
