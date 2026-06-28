// Compliance indicators tenant scope (CAN-036).
//
// getComplianceIndicators ran its NABH/JCI counts over medication_administrations
// /e_prescriptions/prescription_safety_overrides/clinical_alerts with no tenant
// filter, blending other tenants' rows into one tenant's digest. Each count now
// filters on tenant_id. RLS is OFF in the test env, so this differential test
// proves the predicate: alerts seeded in tenant B do not change a tenant-A
// admin's totals, but do show up for a tenant-B admin.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MARKER = 'CAN036_TEST';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0036-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE alert_type = $1`, MARKER).catch(() => {});
}

async function seedCriticalAlert(tenantId) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_alerts (alert_type, severity, acknowledged, created_at, tenant_id)
     VALUES ($1, 'CRITICAL', false, NOW(), $2::uuid)`, MARKER, tenantId);
}

const criticalTotal = (body) => body.data?.unacknowledgedCriticalAlerts?.denominator ?? 0;

d('Compliance indicators tenant scope (CAN-036)', () => {
  beforeAll(async () => { await clean(); }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('alerts seeded in tenant B do not change a tenant-A admin report', async () => {
    const before = criticalTotal((await admin(TENANT_A).get('/api/v1/compliance/indicators')).body);
    await seedCriticalAlert(TENANT_B);
    await seedCriticalAlert(TENANT_B);
    await seedCriticalAlert(TENANT_B);
    const after = criticalTotal((await admin(TENANT_A).get('/api/v1/compliance/indicators')).body);
    expect(after).toBe(before); // tenant-B critical alerts must not leak into tenant A
  });

  it('a tenant-B admin sees its own seeded critical alerts', async () => {
    const res = await admin(TENANT_B).get('/api/v1/compliance/indicators');
    expect(res.statusCode).toBe(200);
    expect(criticalTotal(res.body)).toBeGreaterThanOrEqual(3);
  });
});
