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
          if (typeof sql === 'string' && /SELECT\s+id,\s*scheduled_date::text\s+AS\s+scheduled_date,\s*scheduled_time::text\s+AS\s+scheduled_time\s+FROM\s+ot_schedules\b/i.test(sql)) {
            // Observe the connection after the real role/GUC preamble, before the lookup SQL.
            const evidence = await target.$queryRawUnsafe(
              `SELECT current_user::text AS database_role,
                      current_setting('app.current_tenant_id', true) AS tenant_id,
                      current_setting('row_security') AS row_security,
                      rolsuper, rolbypassrls,
                      pg_catalog.row_security_active('ot_schedules'::regclass) AS relation_rls
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
  'ANAESTHETIST',
  'ANESTHETIST',
  'CONSULTANT',
  'DOCTOR',
  'DUTY_DOCTOR',
  'INFECTION_CONTROL_OFFICER',
  'JUNIOR_DOCTOR',
  'NURSING_STAFF',
  'OT_INCHARGE',
  'OT_NURSE',
  'OT_STAFF',
  'QUALITY_OFFICER',
  'RESIDENT',
  'SUPER_ADMIN'
];
const DENIED = ['PATIENT','COMPLIANCE_OFFICER','DATA_PROTECTION_OFFICER','HR_STAFF','PHARMACY_INCHARGE','STORES_PURCHASE_INCHARGE'];

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

const PATH = '/api/v1/cssd/theatre-options';
const DATE = '2001-01-01';
const cases = [];
const people = [];
const SENSITIVE = 'Synthetic clinical disclosure canary';

describe('CSSD theatre directory through the production app', () => {
  beforeAll(async () => {
    await createScope();
    for (const tenantId of [TENANT_A, TENANT_B]) {
      const patient = randomUUID();
      const surgeon = randomUUID();
      for (const [uid, role] of [[patient, 'PATIENT'], [surgeon, 'DOCTOR']]) {
        people.push(uid);
        await ensureTestIdentity(uid, { role, tenantId });
      }
      const states = tenantId === TENANT_A
        ? ['scheduled', 'pre_op', 'in_progress', 'post_op', 'completed', 'cancelled', null, 'unknown']
        : ['scheduled'];
      for (const [index, status] of states.entries()) {
        const [row] = await prisma.$queryRawUnsafe(
          `INSERT INTO ot_schedules
           (tenant_id, patient_uid, surgeon, procedure_name, ot_room, post_op_notes,
            scheduled_date, scheduled_time, status, equipment_needed)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $8, $4, $5::date, $6::time, $7, '{}'::text[])
           RETURNING id, scheduled_date::text AS scheduled_date, scheduled_time::text AS scheduled_time`,
          tenantId, patient, surgeon, SENSITIVE, DATE, index === 2 ? null : '09:00:00', status,
          `${SENSITIVE} room ${index}`,
        );
        if (tenantId === TENANT_A && index < 3) cases.push(row);
      }
    }
  });

  afterAll(async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await prisma.$executeRawUnsafe('DELETE FROM ot_schedules WHERE tenant_id = $1::uuid', tenantId);
    }
    for (const uid of people) {
      await prisma.$executeRawUnsafe('DELETE FROM users WHERE uid = $1::uuid', uid);
    }
    await removeScope();
  });

  it('observes tenant scope on actual lookup transactions for both tenants', async () => {
    if (assertRuntimeRole) {
      expect(process.env.AUTH_ENFORCE_TENANT_RLS).toBe('true');
      expect(process.env.AUTH_TENANT_RLS_RUNTIME_ROLE).toBe('vhhealth_app');
    }
    for (const [role, tenantId] of [['QUALITY_OFFICER', TENANT_A], ['ADMIN', TENANT_B]]) {
      const start = runtimeRoleEvidence.length;
      const res = await client(role, tenantId).get(PATH).query({ date: DATE });
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
      process.stdout.write(`OPEN-18 ot_schedules scoped transaction evidence: ${JSON.stringify({
        verification_mode: assertRuntimeRole ? 'strict-rls' : 'tenant-scope',
        ...observations[0], observed_transactions: observations.length,
      })}\n`);
    }
  });

  it.each(ALLOWED)('serves only the three eligible states and exact fields to %s without an age cutoff', async role => {
    const res = await client(role).get(PATH).query({ date: DATE });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data).toEqual({ items: cases, next_cursor: null });
    expect(JSON.stringify(res.body)).not.toContain(SENSITIVE);
    const [source] = await prisma.$queryRawUnsafe(
      'SELECT procedure_name, patient_uid FROM ot_schedules WHERE tenant_id = $1::uuid AND id = $2::int',
      TENANT_A, cases[0].id,
    );
    expect(source.procedure_name).toBe(SENSITIVE);
    expect(JSON.stringify(res.body)).not.toContain(source.patient_uid);
  });

  it.each(DENIED)('denies direct lookup calls by %s', async role => {
    expect((await client(role).get(PATH).query({ date: DATE })).status).toBe(403);
  });

  it('rejects unauthenticated requests and preserves the source theatre role gate', async () => {
    expect((await request(app).get(PATH).query({ date: DATE }).set('x-api-key', API_KEY)).status).toBe(401);
    for (const role of ['INFECTION_CONTROL_OFFICER', 'QUALITY_OFFICER']) {
      expect((await client(role).get('/api/v1/theatre/today').query({ date: DATE })).status).toBe(403);
    }
  });

  it.each(DENIED.filter(role => role !== 'PATIENT'))('preserves the existing issue-write gate for %s', async role => {
    const res = await client(role).post('/api/v1/cssd/issues').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CSSD_BAD_ID');
  });

  it('does not grant a PATIENT write access using a directory case ID', async () => {
    const res = await client('PATIENT').post('/api/v1/cssd/issues')
      .send({ instrument_set_id: 1, ot_schedule_id: cases[0].id });
    expect(res.status).toBe(403);
  });

  it('rejects caller scope/date expansion and ignores an ordinary override header', async () => {
    for (const query of [{ tenant_id: TENANT_B }, { facility_id: 1 },
      { date: '2001-02-29' }, { q: SENSITIVE }, { limit: '201' }]) {
      const res = await client('QUALITY_OFFICER').get(PATH).query({ date: DATE, ...query });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_LOOKUP_QUERY');
    }
    const res = await client('QUALITY_OFFICER').get(PATH).query({ date: DATE }).set('x-tenant-id', TENANT_B);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual(cases);
  });

  it('paginates tied times and null times without omission, rejecting foreign/date/tampered cursors', async () => {
    let cursor;
    const collected = [];
    do {
      const res = await client('QUALITY_OFFICER').get(PATH)
        .query({ date: DATE, limit: '1', ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      collected.push(...res.body.data.items);
      expect(collected.length).toBeLessThanOrEqual(cases.length);
      cursor = res.body.data.next_cursor;
      if (cursor) {
        expect((await client('ADMIN', TENANT_B).get(PATH).query({ date: DATE, limit: '1', cursor })).status).toBe(400);
        expect((await client('ADMIN').get(PATH).query({ date: '2001-01-02', limit: '1', cursor })).status).toBe(400);
        expect((await client('ADMIN').get(PATH).query({ date: DATE, limit: '1', cursor: 'a' + cursor })).status).toBe(400);
      }
    } while (cursor);
    expect(collected).toEqual(cases);
    const empty = await client('ADMIN').get(PATH).query({ date: '2001-01-02' });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ items: [], next_cursor: null });
  });

  it('isolates an explicitly audited SUPER_ADMIN acting tenant', async () => {
    const res = await client('SUPER_ADMIN').get(PATH).query({ date: DATE })
      .set('x-tenant-id', TENANT_B).set('x-tenant-override-reason', 'Synthetic directory isolation check');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(cases.map(row => row.id)).not.toContain(res.body.data.items[0].id);
  });

  it('drops a cancelled or rescheduled case on refresh without creating an issue', async () => {
    const id = cases[0].id;
    try {
      await prisma.$executeRawUnsafe("UPDATE ot_schedules SET status = 'cancelled' WHERE id = $1::int AND tenant_id = $2::uuid", id, TENANT_A);
      expect((await client('ADMIN').get(PATH).query({ date: DATE })).body.data.items.some(row => row.id === id)).toBe(false);
      await prisma.$executeRawUnsafe("UPDATE ot_schedules SET status = 'scheduled', scheduled_date = '2001-01-02' WHERE id = $1::int AND tenant_id = $2::uuid", id, TENANT_A);
      expect((await client('ADMIN').get(PATH).query({ date: DATE })).body.data.items.some(row => row.id === id)).toBe(false);
      const [counts] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM set_issue_log WHERE tenant_id = $1::uuid', TENANT_A);
      expect(counts.count).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe("UPDATE ot_schedules SET status = 'scheduled', scheduled_date = $3::date WHERE id = $1::int AND tenant_id = $2::uuid", id, TENANT_A, DATE);
    }
  });
});
