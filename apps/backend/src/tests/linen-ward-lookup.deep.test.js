import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';

const assertRuntimeRole = process.env.OPEN18_ASSERT_RUNTIME_ROLE === '1';
if (assertRuntimeRole && (
  process.env.AUTH_ENFORCE_TENANT_RLS !== 'true'
  || process.env.AUTH_TENANT_RLS_RUNTIME_ROLE !== 'vhhealth_app'
)) {
  throw new Error('OPEN18_ASSERT_RUNTIME_ROLE=1 requires AUTH_ENFORCE_TENANT_RLS=true and AUTH_TENANT_RLS_RUNTIME_ROLE=vhhealth_app');
}
const actualPrisma = await import('../lib/prisma.js');
const prisma = actualPrisma.default;
const runtimeRoleEvidence = [];

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrisma,
  setTenant: (tenantId, fn, options) => actualPrisma.setTenant(tenantId, tx => {
    const observed = new Proxy(tx, {
      get(target, property) {
        if (property !== '$queryRawUnsafe') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args) => {
          const sql = args[0];
          if (typeof sql === 'string' && /SELECT\s+id,\s*name\s+FROM\s+wards\b/i.test(sql)) {
            // Observe the connection after the real role/GUC preamble, before the lookup SQL.
            const evidence = await target.$queryRawUnsafe(
              `SELECT current_user::text AS database_role,
                      current_setting('app.current_tenant_id', true) AS tenant_id,
                      current_setting('row_security') AS row_security,
                      rolsuper, rolbypassrls,
                      pg_catalog.row_security_active('wards'::regclass) AS relation_rls
                 FROM pg_roles WHERE rolname = current_user`,
            );
            expect(evidence).toHaveLength(1);
            expect(evidence[0].tenant_id).toBe(tenantId);
            expect(evidence[0].database_role).toEqual(expect.any(String));
            expect(evidence[0].database_role.length).toBeGreaterThan(0);
            if (assertRuntimeRole) {
              expect(evidence).toEqual([{
                database_role: 'vhhealth_app', tenant_id: tenantId, row_security: 'on',
                rolsuper: false, rolbypassrls: false, relation_rls: true,
              }]);
            }
            expect(args[1]).toBe(tenantId);
            runtimeRoleEvidence.push(evidence[0]);
          }
          return target.$queryRawUnsafe(...args);
        };
      },
    });
    return fn(observed);
  }, options),
}));

const { default: app } = await import('../app.js');
const { API_KEY, authClient, ensureTestIdentity } = await import('./testClient.js');

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const identities = new Map();
const ALLOWED = [
  'ADMIN',
  'ADMISSION_OFFICER',
  'CONSULTANT',
  'DOCTOR',
  'DUTY_DOCTOR',
  'HOUSEKEEPING_INCHARGE',
  'HOUSEKEEPING_STAFF',
  'ICU_INCHARGE',
  'ICU_NURSE',
  'ICU_STAFF',
  'IPD_COUNSELLOR',
  'IP_INCHARGE',
  'IP_STAFF_NURSE',
  'JUNIOR_DOCTOR',
  'NURSING_INCHARGE',
  'NURSING_STAFF',
  'PHARMACY_INCHARGE',
  'RESIDENT',
  'SENIOR_DOCTOR',
  'STORES_PURCHASE_INCHARGE',
  'SUPER_ADMIN'
];
const DENIED = ['PATIENT','HR_STAFF'];

function client(role, tenantId = TENANT_A) {
  return authClient(role, { uid: identities.get(`${role}:${tenantId}`), tenant_id: tenantId, permissions: [] });
}

async function createScope() {
  for (const id of [TENANT_A, TENANT_B]) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3)',
      id, 'lookup-' + id, 'Synthetic lookup tenant',
    );
  }
  const subjects = [...new Set([...ALLOWED, ...DENIED])].map(role => [role, TENANT_A]);
  subjects.push(['ADMIN', TENANT_B]);
  for (const [role, tenantId] of subjects) {
    const uid = randomUUID();
    identities.set(`${role}:${tenantId}`, uid);
    await ensureTestIdentity(uid, { role, tenantId });
  }
}

async function removeScope() {
  for (const uid of identities.values()) {
    await prisma.$executeRawUnsafe('DELETE FROM users WHERE uid = $1::uuid', uid);
  }
  for (const id of [TENANT_A, TENANT_B]) {
    await prisma.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', id);
  }
}

const PATH = '/api/v1/linen-laundry/wards';
const wards = [];
const facilities = [];

describe('Linen ward directory through the production app', () => {
  beforeAll(async () => {
    await createScope();
    for (const code of ['first', 'second']) {
      const [facility] = await prisma.$queryRawUnsafe(
        `INSERT INTO facilities (tenant_id, facility_code, display_name)
         VALUES ($1::uuid, $2, $3) RETURNING id`, TENANT_A, code, 'Synthetic facility',
      );
      facilities.push(facility.id);
    }
    for (const [index, facilityId] of [...facilities, null].entries()) {
      const [ward] = await prisma.$queryRawUnsafe(
        `INSERT INTO wards (tenant_id, facility_id, name, total_beds)
         VALUES ($1::uuid, $2::int, $3, 987) RETURNING id, name`,
        TENANT_A, facilityId, `Lookup ${index}`,
      );
      wards.push(ward);
    }
    await prisma.$executeRawUnsafe(
      "INSERT INTO wards (tenant_id, name) VALUES ($1::uuid, 'Foreign ward canary')", TENANT_B,
    );
  });

  afterAll(async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await prisma.$executeRawUnsafe('DELETE FROM wards WHERE tenant_id = $1::uuid', tenantId);
    }
    for (const id of facilities) {
      await prisma.$executeRawUnsafe('DELETE FROM facilities WHERE id = $1::int AND tenant_id = $2::uuid', id, TENANT_A);
    }
    await removeScope();
  });

  it('observes tenant scope on actual lookup transactions for both tenants', async () => {
    if (assertRuntimeRole) {
      expect(process.env.AUTH_ENFORCE_TENANT_RLS).toBe('true');
      expect(process.env.AUTH_TENANT_RLS_RUNTIME_ROLE).toBe('vhhealth_app');
    }
    for (const [role, tenantId] of [['STORES_PURCHASE_INCHARGE', TENANT_A], ['ADMIN', TENANT_B]]) {
      const start = runtimeRoleEvidence.length;
      const res = await client(role, tenantId).get(PATH);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      const observations = runtimeRoleEvidence.slice(start);
      expect(observations.length).toBeGreaterThan(0);
      for (const observation of observations) {
        expect(observation.tenant_id).toBe(tenantId);
        expect(observation.database_role).toEqual(expect.any(String));
        expect(observation.database_role.length).toBeGreaterThan(0);
        if (assertRuntimeRole) {
          expect(observation).toEqual({
            database_role: 'vhhealth_app', tenant_id: tenantId, row_security: 'on',
            rolsuper: false, rolbypassrls: false, relation_rls: true,
          });
        }
      }
      process.stdout.write(`OPEN-18 wards scoped transaction evidence: ${JSON.stringify({
        verification_mode: assertRuntimeRole ? 'strict-rls' : 'tenant-scope',
        ...observations[0], observed_transactions: observations.length,
      })}\n`);
    }
  });

  it.each(ALLOWED)('serves exact ward identities to %s, across facilities and without prior linen activity', async role => {
    const res = await client(role).get(PATH);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data).toEqual({ items: wards, next_cursor: null });
    expect(JSON.stringify(res.body)).not.toContain('Foreign ward canary');
  });

  it.each(DENIED)('denies direct calls by %s', async role => {
    expect((await client(role).get(PATH)).status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get(PATH).set('x-api-key', API_KEY)).status).toBe(401);
  });

  it('keeps the rich source route denied to the stores role', async () => {
    expect((await client('STORES_PURCHASE_INCHARGE').get('/api/v1/wards')).status).toBe(403);
  });

  it('rejects caller-supplied scope and ignores an ordinary user header override', async () => {
    for (const query of [{ tenant_id: TENANT_B }, { facility_id: facilities[0] }]) {
      const res = await client('STORES_PURCHASE_INCHARGE').get(PATH).query(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_LOOKUP_QUERY');
    }
    const res = await client('STORES_PURCHASE_INCHARGE').get(PATH).set('x-tenant-id', TENANT_B);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual(wards);
  });

  it('scopes an explicit SUPER_ADMIN acting tenant without a cross-tenant bypass', async () => {
    const res = await client('SUPER_ADMIN').get(PATH)
      .set('x-tenant-id', TENANT_B).set('x-tenant-override-reason', 'Synthetic directory isolation check');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].name).toBe('Foreign ward canary');
  });

  it('paginates without omission and binds cursors to scope and search', async () => {
    let cursor;
    const collected = [];
    do {
      const res = await client('STORES_PURCHASE_INCHARGE').get(PATH)
        .query({ limit: '1', ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      collected.push(...res.body.data.items);
      expect(collected.length).toBeLessThanOrEqual(wards.length);
      cursor = res.body.data.next_cursor;
      if (cursor) {
        expect((await client('ADMIN', TENANT_B).get(PATH).query({ limit: '1', cursor })).status).toBe(400);
        expect((await client('ADMIN').get(PATH).query({ limit: '1', cursor, q: 'different' })).status).toBe(400);
      }
    } while (cursor);
    expect(collected).toEqual(wards);
    const empty = await client('ADMIN').get(PATH).query({ q: 'no matching ward' });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ items: [], next_cursor: null });
  });

  it('removes a deleted selection on refresh without creating linen state', async () => {
    const [temporary] = await prisma.$queryRawUnsafe(
      "INSERT INTO wards (tenant_id, name) VALUES ($1::uuid, 'Temporary lookup ward') RETURNING id", TENANT_A,
    );
    expect((await client('ADMIN').get(PATH)).body.data.items.some(row => row.id === temporary.id)).toBe(true);
    await prisma.$executeRawUnsafe('DELETE FROM wards WHERE id = $1::int AND tenant_id = $2::uuid', temporary.id, TENANT_A);
    expect((await client('ADMIN').get(PATH)).body.data.items.some(row => row.id === temporary.id)).toBe(false);
    const [counts] = await prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM linen_laundry_cycles WHERE tenant_id = $1::uuid', TENANT_A,
    );
    expect(counts.count).toBe(0);
    expect((await client('PATIENT').post('/api/v1/linen-laundry/cycles').send({ ward_id: wards[0].id })).status).toBe(403);
  });
});
