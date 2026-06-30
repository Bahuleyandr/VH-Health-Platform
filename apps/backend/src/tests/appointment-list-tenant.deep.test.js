// Appointment list + completed-picker tenant scope (CAN-018).
//
// listAppointments (Prisma where-clause) and getRecentCompletedAppointments
// (raw SQL) queried appointments with no explicit tenant filter. The list now
// ANDs where.tenant_id and the picker ANDs a.tenant_id. RLS is OFF in the test
// env, so these explicit predicates are what scope the results: a tenant-A admin
// must not see tenant-B appointments.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const NAME_A = 'CAN018_A';
const NAME_B = 'CAN018_B';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0018-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE patient_name IN ($1,$2)`, NAME_A, NAME_B).catch(() => {});
}

async function seedAppt(tenantId, name, phone) {
  // Far-future date so the completed-picker (ORDER BY date DESC LIMIT 50) surfaces it.
  await prisma.$executeRawUnsafe(
    `INSERT INTO appointments (phone, patient_name, appointment_date, appointment_time, status, tenant_id, updated_at)
     VALUES ($1, $2, '2099-12-31', '10:00', 'COMPLETED', $3::uuid, NOW())`, phone, name, tenantId);
}

d('Appointment list + completed-picker tenant scope (CAN-018)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can018-tenant-b', 'CAN018 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await seedAppt(TENANT_A, NAME_A, '+919000018701');
    await seedAppt(TENANT_B, NAME_B, '+919000018702');
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('the appointment list excludes other-tenant rows', async () => {
    const res = await admin(TENANT_A).get('/api/v1/appointments/list?search=CAN018&limit=100');
    expect(res.statusCode).toBe(200);
    const names = (res.body.data?.appointments || []).map((a) => a.patient_name);
    expect(names).toContain(NAME_A);
    expect(names).not.toContain(NAME_B);
  });

  it('the completed-appointment picker excludes other-tenant rows', async () => {
    const res = await admin(TENANT_A).get('/api/v1/appointments/completed/recent?limit=100');
    expect(res.statusCode).toBe(200);
    const names = (res.body.data?.appointments || res.body.data || []).map((a) => a.patient_name);
    expect(names).toContain(NAME_A);
    expect(names).not.toContain(NAME_B);
  });
});
