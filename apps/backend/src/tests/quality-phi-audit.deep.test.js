// Quality/infection-control PHI audit logging (CAN-035).
//
// The /api/v1/quality mount had no phiAccessLogger, so PHI access there left no
// patient-attributed breach-detection trail. With the logger mounted, accessing
// a patient-scoped quality endpoint writes a hipaa_access_log row.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const P_UID = 'c0de0135-0001-4c0d-8c0d-c0de01350001';

function admin() {
  const t = generateTestToken('ADMIN', { uid: 'c0de0135-00aa-4c0d-8c0d-c0de013500aa', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function waitForAudit(patientId, recordType, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM hipaa_access_log WHERE patient_id = $1 AND record_type = $2 LIMIT 1`,
      String(patientId), recordType);
    if (rows.length) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM hipaa_access_log WHERE patient_id = $1`, P_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, P_UID).catch(() => {});
}

d('Quality PHI audit logging (CAN-035)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid,'+919313500001','Quality Patient','PATIENT',true,$2::uuid,NOW())`,
      P_UID, TENANT_ID);
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);

  it('accessing a patient-scoped quality endpoint writes a PHI audit row', async () => {
    const res = await admin().get(`/api/v1/quality/incidents?patient_uid=${P_UID}`);
    // Either VIEW (2xx) or ACCESS_DENIED (403) — both must be audited; only a
    // 400/500 (non-PHI-decision) would legitimately skip logging.
    expect([400, 500]).not.toContain(res.statusCode);
    expect(await waitForAudit(P_UID, 'QUALITY')).toBe(true);
  });
});
