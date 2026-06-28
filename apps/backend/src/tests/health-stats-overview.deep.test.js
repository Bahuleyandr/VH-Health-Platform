// Health stats overview returns real aggregates (recorded_date/patient_id bug).
//
// getHealthStatistics queried non-existent columns (recorded_date, patient_id)
// on the file-upload `health_records` table, so every COUNT raised 42703 and the
// catch returned zeros (the endpoint never produced data). Fixed to created_at /
// phone with ::int casts (raw COUNT is BigInt → res.json would throw). This
// proves an ADMIN gets 200 with a populated, correctly-shaped aggregate.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const R1 = 'c0de0533-0000-4000-8000-0000000007a1';
const R2 = 'c0de0533-0000-4000-8000-0000000007a2';

function admin() {
  const t = generateTestToken('ADMIN', { uid: 'c0de0533-00d0-4000-8000-00000000d001', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM health_records WHERE uid IN ($1::uuid,$2::uuid)`, R1, R2).catch(() => {});
}

d('Health stats overview aggregate (recorded_date/patient_id fix)', () => {
  beforeAll(async () => {
    await clean();
    // Two recent records, two distinct patient phones, same record_type.
    await prisma.$executeRawUnsafe(
      `INSERT INTO health_records (uid, phone, record_type, file_name, file_type, file_key, file_size, privacy_level, tenant_id, created_at, updated_at) VALUES
        ($1::uuid,'+919000533701','lab_report','a.pdf','application/pdf','k/a.pdf',10,'private',$3::uuid,NOW(),NOW()),
        ($2::uuid,'+919000533702','lab_report','b.pdf','application/pdf','k/b.pdf',10,'private',$3::uuid,NOW(),NOW())`,
      R1, R2, TENANT_ID);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('ADMIN gets 200 with a populated, correctly-shaped aggregate', async () => {
    const res = await admin().get('/api/v1/health/stats/overview?days=30');
    expect(res.statusCode).toBe(200);
    const stats = res.body?.data?.statistics;
    expect(stats).toBeTruthy();
    // Shape
    expect(typeof stats.totals.total_records).toBe('number');
    expect(typeof stats.totals.unique_patients).toBe('number');
    expect(typeof stats.totals.recent_records).toBe('number');
    expect(Array.isArray(stats.by_type)).toBe(true);
    expect(Array.isArray(stats.daily_activity)).toBe(true);
    // Real data (not the catch-block zeros) — our two seeded records are counted.
    expect(stats.totals.total_records).toBeGreaterThanOrEqual(2);
    expect(stats.totals.recent_records).toBeGreaterThanOrEqual(2);
    expect(stats.by_type.some((r) => r.record_type === 'lab_report' && Number(r.count) >= 2)).toBe(true);
    // The controller fallback note must be absent (the service did not throw).
    expect(res.body?.data?.note).toBeUndefined();
  });
});
