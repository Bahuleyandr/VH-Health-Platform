// Monthly reward issuance hardening (CAN-034).
//
// POST /api/v1/rewards/issue-monthly creates discount-bearing reward records.
// It must be admin-gated at the route and write a batch audit entry.
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MONTH = '2099-01';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0134-0001-4c0d-8c0d-c0de01340001', tenant_id: TENANT_ID });
  return { post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE action = 'STEP_REWARDS_ISSUE_MONTHLY' AND resource_id = $1`, MONTH).catch(() => {});
}

d('Monthly reward issuance hardening (CAN-034)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0134-0001-4c0d-8c0d-c0de01340001', { tenantId: TENANT_ID });
  });
  beforeAll(async () => { await clean(); }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('PATIENT cannot issue monthly rewards', async () => {
    const res = await client('PATIENT').post('/api/v1/rewards/issue-monthly').send({ month_year: MONTH });
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN issuance succeeds and writes a batch audit row', async () => {
    const res = await client('ADMIN').post('/api/v1/rewards/issue-monthly').send({ month_year: MONTH });
    expect(res.statusCode).toBeLessThan(300);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM audit_logs WHERE action = 'STEP_REWARDS_ISSUE_MONTHLY' AND resource_id = $1 LIMIT 1`, MONTH);
    expect(rows.length).toBe(1);
  });
});
