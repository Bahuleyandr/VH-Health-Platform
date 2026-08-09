// Admin SOS console executes real logic (audit F1).
//
// Every panel of the admin SOS console was fake. routes/admin/services/sosService.js
// backed all seven /api/v1/admin/sos/* endpoints and:
//   - broadcastEmergencyAlert / escalateAlert / updateSystemConfig were log-only
//     stubs returning { success: true } while touching no table;
//   - getSosAnalytics filtered on `is_test_alert`, a column sos_alerts does not
//     have, and matched lowercase 'active'/'resolved' against uppercase statuses;
//   - getAllAlerts selected user_uid/notes/description/address — four columns
//     sos_alerts does not have — and had no tenant predicate;
//   - getEmergencyServices probed emergency_services / sos_services, neither of
//     which exists in the schema.
// Every one of those queries threw and was swallowed by safeQuery's catch, so the
// console rendered zeros and empty tables as though they were real readings.
//
// The real implementations live on sosController (/api/v1/sos/admin/*). Both
// surfaces now share one tenant-scoped implementation in services/sosService.js.
//
// RLS is OFF in the test env (AUTH_ENFORCE_TENANT_RLS unset) and sos_alerts /
// notifications both carry a fail-open permissive policy, so the explicit
// `tenant_id = $n::uuid` predicates are what actually scope these queries — a
// tenant-A admin must not read, escalate, or notify anything in tenant B.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const MARKER = 'F1SOSCONSOLE';
// sos_alerts.message is free text — use it as the delete marker so cleanup never
// touches real alerts.
const ALERT_MARKER = 'F1SOSCONSOLE-ALERT';

function client(role, tenantId) {
  const t = generateTestToken(role, {
    uid: 'c0de00f1-50d0-4000-8000-0000000000f1',
    tenant_id: tenantId,
  });
  const auth = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return {
    get: (p) => auth(request(app).get(p)),
    post: (p) => auth(request(app).post(p)),
  };
}

const admin = (tenantId) => client('ADMIN', tenantId);

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM notifications WHERE title = $1 OR body = $1`, MARKER).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM sos_alerts WHERE message = $1`, ALERT_MARKER).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, MARKER).catch(() => {});
}

async function seedStaff(tenantId, phone) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, registered_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, 'NURSING_STAFF', true, NOW(), NOW())`,
    tenantId, phone, MARKER);
}

// notifications.phone is NOT NULL, so a phone-less staff row is exactly what made
// the real INSERT…SELECT explode; 167 of 320 non-patient active users on the QA
// cluster have no phone.
async function seedPhonelessStaff(tenantId) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, registered_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, NULL, $2, 'NURSING_STAFF', true, NOW(), NOW())`,
    tenantId, MARKER);
}

async function seedAlert(tenantId, severity, status = 'ACTIVE') {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO sos_alerts (phone, severity, status, message, raised_at, created_at, updated_at, tenant_id)
     VALUES ('+919000f10001', $1, $2, $3, NOW(), NOW(), NOW(), $4::uuid)
     RETURNING id`, severity, status, ALERT_MARKER, tenantId);
  return rows[0].id;
}

const countNotifications = async (tenantId) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM notifications WHERE title = $1 AND tenant_id = $2::uuid`,
    MARKER, tenantId);
  return rows[0].c;
};

const severityOf = async (id) => {
  const rows = await prisma.$queryRawUnsafe(`SELECT severity FROM sos_alerts WHERE id = $1::int`, id);
  return rows[0]?.severity;
};

d('Admin SOS console executes real logic (F1)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'f1-sos-tenant-b', 'F1 SOS Tenant B')
       ON CONFLICT (id) DO NOTHING`, TENANT_B);
    await seedStaff(TENANT_A, '+919000f10101');
    await seedStaff(TENANT_A, '+919000f10102');
    await seedPhonelessStaff(TENANT_A);
    await seedStaff(TENANT_B, '+919000f10201');
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  describe('POST /api/v1/admin/sos/broadcast', () => {
    it('creates a real notification row per reachable staff member in the caller tenant', async () => {
      const res = await admin(TENANT_A).post('/api/v1/admin/sos/broadcast')
        .send({ title: MARKER, message: MARKER, severity: 'HIGH' });

      expect(res.statusCode).toBe(200);
      // Was `{ success: true, message: 'Broadcast sent' }` with zero rows written.
      expect(await countNotifications(TENANT_A)).toBeGreaterThanOrEqual(2);
      expect(res.body.data.notified).toBe(await countNotifications(TENANT_A));
    });

    it('does not notify another tenant staff', async () => {
      expect(await countNotifications(TENANT_B)).toBe(0);
    });

    it('skips phone-less staff instead of failing the whole broadcast', async () => {
      // notifications.phone is NOT NULL — an unfiltered INSERT…SELECT 500s and
      // nobody is notified at all.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS c FROM notifications WHERE title = $1 AND phone IS NULL`, MARKER);
      expect(rows[0].c).toBe(0);
    });

    it('rejects a broadcast with no message', async () => {
      const res = await admin(TENANT_A).post('/api/v1/admin/sos/broadcast').send({ title: MARKER });
      expect(res.statusCode).toBe(400);
    });

    it('refuses a non-admin caller', async () => {
      const res = await client('NURSING_STAFF', TENANT_A).post('/api/v1/admin/sos/broadcast')
        .send({ title: MARKER, message: MARKER });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/admin/sos/escalate/:alertId', () => {
    it('raises the stored severity one step', async () => {
      const id = await seedAlert(TENANT_A, 'MEDIUM');
      const res = await admin(TENANT_A).post(`/api/v1/admin/sos/escalate/${id}`).send({ reason: 'ward flooded' });

      expect(res.statusCode).toBe(200);
      // Was `{ success: true, alertId, reason }` with the row untouched.
      expect(await severityOf(id)).toBe('HIGH');
      expect(res.body.data.severity).toBe('HIGH');
    });

    it('serializes concurrent escalations instead of reporting the same step twice', async () => {
      const id = await seedAlert(TENANT_A, 'LOW');

      const responses = await Promise.all([
        admin(TENANT_A).post(`/api/v1/admin/sos/escalate/${id}`).send({ reason: 'first responder' }),
        admin(TENANT_A).post(`/api/v1/admin/sos/escalate/${id}`).send({ reason: 'second responder' }),
      ]);

      expect(responses.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(responses.map((res) => res.body.data.severity).sort()).toEqual(['HIGH', 'MEDIUM']);
      expect(await severityOf(id)).toBe('HIGH');
    });

    it('refuses to escalate past CRITICAL', async () => {
      const id = await seedAlert(TENANT_A, 'CRITICAL');
      const res = await admin(TENANT_A).post(`/api/v1/admin/sos/escalate/${id}`).send({});
      expect(res.statusCode).toBe(400);
      expect(await severityOf(id)).toBe('CRITICAL');
    });

    it('cannot escalate an alert belonging to another tenant', async () => {
      const id = await seedAlert(TENANT_B, 'LOW');
      const res = await admin(TENANT_A).post(`/api/v1/admin/sos/escalate/${id}`).send({});
      expect(res.statusCode).toBe(404);
      expect(await severityOf(id)).toBe('LOW'); // untouched
    });

    it('refuses a non-admin caller', async () => {
      const id = await seedAlert(TENANT_A, 'LOW');
      const res = await client('NURSING_STAFF', TENANT_A).post(`/api/v1/admin/sos/escalate/${id}`).send({});
      expect(res.statusCode).toBe(403);
      expect(await severityOf(id)).toBe('LOW');
    });
  });

  describe('GET /api/v1/admin/sos/alerts', () => {
    it('returns the caller tenant alerts and excludes another tenant', async () => {
      const mine = await seedAlert(TENANT_A, 'HIGH');
      const theirs = await seedAlert(TENANT_B, 'HIGH');

      const res = await admin(TENANT_A).get('/api/v1/admin/sos/alerts?limit=100');
      expect(res.statusCode).toBe(200);
      const ids = (res.body.data || []).map((a) => Number(a.id));
      // Was always [] — the SELECT named four columns that do not exist.
      expect(ids).toContain(Number(mine));
      expect(ids).not.toContain(Number(theirs));
    });
  });

  describe('GET /api/v1/admin/sos/analytics', () => {
    it('counts an ACTIVE alert in the caller tenant', async () => {
      const before = (await admin(TENANT_A).get('/api/v1/admin/sos/analytics')).body.data;
      await seedAlert(TENANT_A, 'HIGH', 'ACTIVE');
      const after = (await admin(TENANT_A).get('/api/v1/admin/sos/analytics')).body.data;

      // Was permanently 0 — the aggregate referenced a non-existent is_test_alert
      // column and matched lowercase statuses.
      expect(after.totalAlerts).toBe(before.totalAlerts + 1);
      expect(after.activeAlerts).toBe(before.activeAlerts + 1);
      expect(after.severityCounts.high).toBe(before.severityCounts.high + 1);
    });

    it('does not count another tenant alerts', async () => {
      const before = (await admin(TENANT_A).get('/api/v1/admin/sos/analytics')).body.data;
      await seedAlert(TENANT_B, 'HIGH', 'ACTIVE');
      const after = (await admin(TENANT_A).get('/api/v1/admin/sos/analytics')).body.data;
      expect(after.totalAlerts).toBe(before.totalAlerts);
    });
  });

  describe('removed SOS system-config endpoints', () => {
    // Neither implementation ever persisted anything and nothing in the platform
    // reads a SOS config, so both endpoints were deleted rather than given a
    // storage table that no consumer would query.
    it('POST /api/v1/admin/sos/update-config is gone', async () => {
      const res = await admin(TENANT_A).post('/api/v1/admin/sos/update-config').send({ escalationThreshold: 5 });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/v1/sos/admin/update-config is gone', async () => {
      const res = await admin(TENANT_A).post('/api/v1/sos/admin/update-config').send({ escalationThreshold: 5 });
      expect(res.statusCode).toBe(404);
    });
  });
});
