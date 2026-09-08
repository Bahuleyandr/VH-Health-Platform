import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';
import pg from 'pg';
import request from 'supertest';

const originalEnv = Object.fromEntries(
  ['DATABASE_URL', 'DATABASE_READ_URL', 'ALLOW_DEFAULT_TENANT', 'AUTH_ENFORCE_TENANT_RLS', 'AUTH_TENANT_RLS_RUNTIME_ROLE', 'AUTH_TENANT_RLS_TEST_ROLE']
    .map(key => [key, process.env[key]]),
);
const ownerDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const owner = new pg.Client({
  connectionString: ownerDatabaseUrl,
});
const applicationUrl = new URL(ownerDatabaseUrl);
applicationUrl.searchParams.set('options', [
  applicationUrl.searchParams.get('options'), '-c role=vhhealth_app',
].filter(Boolean).join(' '));
process.env.DATABASE_URL = applicationUrl.toString();
process.env.DATABASE_READ_URL = applicationUrl.toString();
process.env.ALLOW_DEFAULT_TENANT = 'false';
// The SQL predicates must protect the real application role even without ALS wrapping.
process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

const { default: prisma } = await import('../lib/prisma.js');
const { default: housekeepingRouter } = await import('../routes/housekeepingRoutes.js');
const fixtures = [];
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const fixture = fixtures[Number(req.get('x-test-actor') || 0)];
  req.user = { id: fixture.actor.id, uid: fixture.actor.uid, role: 'ADMIN' };
  if (req.get('x-test-no-tenant') !== 'true') {
    req.tenantId = fixture.tenantId;
    req.user.tenant_id = fixture.tenantId;
  }
  next();
});
app.use('/api/v1/housekeeping', housekeepingRouter);

function call(method, path, actor = 0, noTenant = false) {
  return request(app)[method](`/api/v1/housekeeping${path}`)
    .set('x-test-actor', String(actor))
    .set('x-test-no-tenant', String(noTenant));
}

async function readRow(table, id) {
  const { rows } = await owner.query(`SELECT row_to_json(r) AS row FROM ${table} r WHERE id = $1::int`, [id]);
  expect(rows).toHaveLength(1);
  return rows[0].row;
}

async function assertPopulation() {
  for (const fixture of fixtures) {
    for (const [table, id] of [
      ['housekeeping_logs', fixture.logId],
      ['housekeeping_floor_assignments', fixture.assignmentId],
      ['housekeeping_zones', fixture.zoneId],
      ['housekeeping_requests', fixture.requestId],
    ]) {
      expect((await readRow(table, id)).tenant_id).toBe(fixture.tenantId);
    }
  }
}

function expectNoDisclosure(response, fixture) {
  expect(response.body.data).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toContain(fixture.marker);
}

beforeAll(async () => {
  // Bootstrap through the canonical owner path before opening application-role sessions.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import prisma, { ensureTenantRlsRuntimeRoleGrants } from './src/lib/prisma.js';
    try {
      const result = await ensureTenantRlsRuntimeRoleGrants();
      if (result.skipped || result.error) throw new Error('Runtime role bootstrap failed');
    } finally { await prisma.$disconnect(); }
  `], {
    env: { ...process.env, DATABASE_URL: ownerDatabaseUrl, DATABASE_READ_URL: ownerDatabaseUrl },
    stdio: 'pipe',
    timeout: 30000,
  });
  await owner.connect();
  for (const label of ['A', 'B']) {
    const fixture = { tenantId: randomUUID(), marker: `RLS-HK-${label}-${randomUUID()}` };
    fixtures.push(fixture);
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2)',
      [fixture.tenantId, fixture.marker.toLowerCase()]);
    for (const [kind, role] of [['actor', 'ADMIN'], ['staff', 'HOUSEKEEPING_STAFF']]) {
      const { rows } = await owner.query(
        `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
         VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW()) RETURNING id, uid, name`,
        [randomUUID(), `98${randomInt(10000000, 99999999)}`, `${fixture.marker}-${kind}`, role, fixture.tenantId],
      );
      fixture[kind] = rows[0];
    }
    await owner.query(
      `INSERT INTO staff (user_id, employee_id, name, designation, department, position, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'Housekeeping Staff', $4, 'Housekeeping Staff', true, $5::uuid, NOW())`,
      [fixture.staff.uid, fixture.marker, fixture.staff.name, `${fixture.marker}-department`, fixture.tenantId],
    );
    fixture.zoneId = (await owner.query(
      `INSERT INTO housekeeping_zones (name, zone_type, floor, building, tenant_id)
       VALUES ($1, 'ward', '2', 'Main', $2::uuid) RETURNING id`,
      [`${fixture.marker}-zone`, fixture.tenantId],
    )).rows[0].id;
    fixture.logId = (await owner.query(
      `INSERT INTO housekeeping_logs (staff_id, staff_uid, zone_id, notes, tenant_id)
       VALUES ($1::int, $2::uuid, $3::int, $4, $5::uuid) RETURNING id`,
      [fixture.staff.id, fixture.staff.uid, fixture.zoneId, fixture.marker, fixture.tenantId],
    )).rows[0].id;
    fixture.assignmentId = (await owner.query(
      `INSERT INTO housekeeping_floor_assignments (staff_id, staff_uid, assigned_by, assigned_by_uid, floor, reason, tenant_id)
       VALUES ($1::int, $2::uuid, $3::int, $4::uuid, '2', $5, $6::uuid) RETURNING id`,
      [fixture.staff.id, fixture.staff.uid, fixture.actor.id, fixture.actor.uid, fixture.marker, fixture.tenantId],
    )).rows[0].id;
    fixture.requestId = (await owner.query(
      `INSERT INTO housekeeping_requests
         (requester_id, requester_uid, assigned_to, assigned_to_uid, zone_id, status,
          assigned_at, completed_at, description, tenant_id)
       VALUES ($1::int, $2::uuid, $3::int, $4::uuid, $5::int, 'completed',
               NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '5 minutes', $6, $7::uuid) RETURNING id`,
      [fixture.actor.id, fixture.actor.uid, fixture.staff.id, fixture.staff.uid, fixture.zoneId, fixture.marker, fixture.tenantId],
    )).rows[0].id;
  }
}, 45000);

beforeEach(async () => {
  for (const fixture of fixtures) {
    await owner.query(
      `UPDATE housekeeping_logs SET status = 'submitted', verified_by = NULL, verified_by_uid = NULL,
         verified_at = NULL, flag_reason = NULL, staff_id = $2::int, zone_id = $3::int WHERE id = $1::int`,
      [fixture.logId, fixture.staff.id, fixture.zoneId],
    );
    await owner.query(
      `UPDATE housekeeping_floor_assignments SET status = 'active', effective_to = NULL, zone_id = NULL,
         reason = $2 WHERE id = $1::int`, [fixture.assignmentId, fixture.marker],
    );
    await owner.query('UPDATE housekeeping_zones SET is_active = true WHERE id = $1::int', [fixture.zoneId]);
    await owner.query('UPDATE staff SET tenant_id = $2::uuid WHERE user_id = $1::uuid',
      [fixture.staff.uid, fixture.tenantId]);
  }
  await assertPopulation();
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    for (const fixture of fixtures) {
      for (const table of ['housekeeping_requests', 'housekeeping_floor_assignments', 'housekeeping_logs', 'housekeeping_zones', 'staff', 'users']) {
        await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, [fixture.tenantId]);
      }
      await owner.query('DELETE FROM audit_logs WHERE tenant_id = $1::uuid', [fixture.tenantId]);
      await owner.query('DELETE FROM tenants WHERE id = $1::uuid', [fixture.tenantId]);
    }
  } finally {
    await owner.end();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 45000);

test('all handler connections use the non-superuser, non-bypass application role', async () => {
  const [role] = await prisma.$queryRawUnsafe(
    `SELECT current_user AS name, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
  );
  expect(role).toEqual({ name: 'vhhealth_app', rolsuper: false, rolbypassrls: false });
});

describe.each([
  ['verifyLog', 'post', 'housekeeping_logs', 'logId', fixture => `/logs/${fixture.logId}/verify`, {}],
  ['endFloorAssignment', 'post', 'housekeeping_floor_assignments', 'assignmentId', fixture => `/delegation/assignments/${fixture.assignmentId}/end`, { reason: 'Ended by test' }],
  ['deleteZone', 'delete', 'housekeeping_zones', 'zoneId', fixture => `/zones/${fixture.zoneId}`, {}],
])('%s', (site, method, table, idKey, path, body) => {
  test('denies tenant B without changing or disclosing tenant A row', async () => {
    const fixture = fixtures[0];
    const before = await readRow(table, fixture[idKey]);
    const response = await call(method, path(fixture), 1).send(body);
    expect(response.status).toBe(404);
    expectNoDisclosure(response, fixture);
    expect(await readRow(table, fixture[idKey])).toEqual(before);
    if (site === 'deleteZone') {
      await owner.query('UPDATE housekeeping_floor_assignments SET zone_id = $2::int WHERE id = $1::int',
        [fixture.assignmentId, fixture.zoneId]);
      const busyZone = await call(method, path(fixture), 1).send(body);
      expect(busyZone.status).toBe(404);
      expectNoDisclosure(busyZone, fixture);
      expect(await readRow(table, fixture[idKey])).toEqual(before);
    }
  });

  test('allows tenant A to update its populated row', async () => {
    const fixture = fixtures[0];
    const response = await call(method, path(fixture)).send(body);
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(fixture[idKey]);
    const row = await readRow(table, fixture[idKey]);
    if (site === 'verifyLog') {
      expect(row.status).toBe('verified');
      expect(row.verified_by_uid).toBe(fixture.actor.uid);
    } else if (site === 'endFloorAssignment') {
      expect(row.status).toBe('ended');
      expect(row.reason).toBe(body.reason);
      expect(row.effective_to).not.toBeNull();
    } else {
      expect(row.is_active).toBe(false);
    }
  });

  test('refuses missing tenant context without changing or disclosing a row', async () => {
    const fixture = fixtures[0];
    const before = await readRow(table, fixture[idKey]);
    const response = await call(method, path(fixture), 0, true).send(body);
    expect(response.status).toBe(403);
    expectNoDisclosure(response, fixture);
    expect(await readRow(table, fixture[idKey])).toEqual(before);
  });
});

describe('getAllCleaningLogs list and count', () => {
  test('denies tenant B the populated tenant A log and count', async () => {
    const response = await call('get', '/logs', 1).query({ staff_id: fixtures[0].staff.id });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ logs: [], total: 0 });
    expect(JSON.stringify(response.body)).not.toContain(fixtures[0].marker);
  });

  test('returns tenant A log, joined details and the filtered pagination count', async () => {
    const fixture = fixtures[0];
    const response = await call('get', '/logs').query({ staff_id: fixture.staff.id, zone_id: fixture.zoneId, status: 'submitted', limit: 1 });
    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.logs).toHaveLength(1);
    expect(response.body.data.logs[0]).toMatchObject({ id: fixture.logId, staff_name: fixture.staff.name, department: `${fixture.marker}-department`, zone_name: `${fixture.marker}-zone`, verified_by_name: null });
    const page = await call('get', '/logs').query({ staff_id: fixture.staff.id, limit: 1, offset: 1 });
    expect(page.status).toBe(200);
    expect(page.body.data).toEqual({ logs: [], total: 1 });
  });

  test('refuses missing tenant context', async () => {
    const response = await call('get', '/logs', 0, true);
    expect(response.status).toBe(403);
    expectNoDisclosure(response, fixtures[0]);
  });

  test('keeps an owning log while hiding foreign joined details', async () => {
    const [a, b] = fixtures;
    await owner.query('UPDATE housekeeping_logs SET zone_id = $2::int, verified_by = $3::int WHERE id = $1::int',
      [a.logId, b.zoneId, b.actor.id]);
    await owner.query('UPDATE staff SET tenant_id = $2::uuid WHERE user_id = $1::uuid', [a.staff.uid, b.tenantId]);
    const response = await call('get', '/logs').query({ staff_id: a.staff.id });
    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.logs).toHaveLength(1);
    expect(response.body.data.logs[0]).toMatchObject({ id: a.logId, staff_name: a.staff.name, department: null, zone_name: null, verified_by_name: null });
    expect(JSON.stringify(response.body)).not.toContain(b.marker);
  });
});

describe('getHousekeepingStats top-staff leaderboard', () => {
  test('denies tenant B the populated tenant A leaderboard row', async () => {
    const response = await call('get', '/stats', 1);
    expect(response.status).toBe(200);
    expect(response.body.data.top_staff.map(row => row.id)).toEqual([fixtures[1].staff.id]);
    expect(JSON.stringify(response.body.data.top_staff)).not.toContain(fixtures[0].marker);
  });

  test('returns tenant A own completed work and staff identity', async () => {
    const response = await call('get', '/stats');
    expect(response.status).toBe(200);
    expect(response.body.data.top_staff).toHaveLength(1);
    expect(response.body.data.top_staff[0]).toMatchObject({ id: fixtures[0].staff.id, name: fixtures[0].staff.name, completions: 1 });
  });

  test('refuses missing tenant context', async () => {
    const response = await call('get', '/stats', 0, true);
    expect(response.status).toBe(403);
    expectNoDisclosure(response, fixtures[0]);
  });
});

test('deleteZone preserves the own-tenant busy-zone guard', async () => {
  const fixture = fixtures[0];
  await owner.query('UPDATE housekeeping_floor_assignments SET zone_id = $2::int WHERE id = $1::int',
    [fixture.assignmentId, fixture.zoneId]);
  const before = await readRow('housekeeping_zones', fixture.zoneId);
  const own = await call('delete', `/zones/${fixture.zoneId}`);
  expect(own.status).toBe(409);
  expect(await readRow('housekeeping_zones', fixture.zoneId)).toEqual(before);
});

test('verifyLog preserves flagging, repeat verification and response fields', async () => {
  const fixture = fixtures[0];
  const flagged = await call('post', `/logs/${fixture.logId}/verify`).send({ flag_reason: 'Needs repeat cleaning' });
  expect(flagged.status).toBe(200);
  expect(flagged.body.data).toMatchObject({ id: fixture.logId, status: 'flagged', flag_reason: 'Needs repeat cleaning' });
  const verified = await call('post', `/logs/${fixture.logId}/verify`).send({});
  expect(verified.status).toBe(200);
  expect(verified.body.data).toMatchObject({ id: fixture.logId, status: 'verified', flag_reason: null });
});

test('endFloorAssignment preserves an omitted reason and rejects an already-ended assignment', async () => {
  const fixture = fixtures[0];
  const ended = await call('post', `/delegation/assignments/${fixture.assignmentId}/end`).send({});
  expect(ended.status).toBe(200);
  expect(ended.body.data.reason).toBe(fixture.marker);
  const repeated = await call('post', `/delegation/assignments/${fixture.assignmentId}/end`).send({});
  expect(repeated.status).toBe(404);
});
