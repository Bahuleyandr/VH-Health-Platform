// E2E public-key directory tenant scoping (CAN-038).
//
// GET /users/:id/public-key fetched by global numeric id with no tenant
// predicate, so peer keys / account existence were enumerable across tenants.
// The query is now tenant-scoped and the 404 is uniform (no existence oracle).
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001'; // platform default
const TENANT_B = 'c0de0107-0000-4c0d-8c0d-c0de01070000';
const KEY = Buffer.alloc(32).toString('base64'); // valid 44-char base64, 32 bytes

const Y_UID = 'c0de0107-0001-4c0d-8c0d-c0de01070001'; // tenant A, has key
const Z_UID = 'c0de0107-0002-4c0d-8c0d-c0de01070002'; // tenant A, no key
const X_UID = 'c0de0107-0003-4c0d-8c0d-c0de01070003'; // tenant B, has key
let yId; let zId; let xId;

function callerA() {
  const t = generateTestToken('PATIENT', { uid: 'c0de0107-00aa-4c0d-8c0d-c0de010700aa', tenant_id: TENANT_A });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid)`, Y_UID, Z_UID, X_UID).catch(() => {});
}

d('E2E public-key directory tenant scoping (CAN-038)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'pubkey-tenant-b', 'PubKey Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, e2e_public_key, e2e_key_updated_at, updated_at) VALUES
        ($1::uuid,'+919310000701','PK Y','PATIENT',true,$4::uuid,$6,NOW(),NOW()),
        ($2::uuid,'+919310000702','PK Z','PATIENT',true,$4::uuid,NULL,NULL,NOW()),
        ($3::uuid,'+919310000703','PK X','PATIENT',true,$5::uuid,$6,NOW(),NOW())`,
      Y_UID, Z_UID, X_UID, TENANT_A, TENANT_B, KEY);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid::text AS uid, id FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid)`, Y_UID, Z_UID, X_UID);
    for (const r of rows) {
      if (r.uid === Y_UID) yId = r.id;
      else if (r.uid === Z_UID) zId = r.id;
      else if (r.uid === X_UID) xId = r.id;
    }
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);

  it('same-tenant peer with a key returns 200', async () => {
    const res = await callerA().get(`/api/v1/users/${yId}/public-key`);
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.publicKey).toBe(KEY);
  });

  it('same-tenant peer without a key returns 404', async () => {
    const res = await callerA().get(`/api/v1/users/${zId}/public-key`);
    expect(res.statusCode).toBe(404);
  });

  it('nonexistent id returns the SAME 404 (no existence oracle)', async () => {
    const res = await callerA().get('/api/v1/users/99999999/public-key');
    expect(res.statusCode).toBe(404);
  });

  it('cross-tenant peer key is NOT disclosed (404 despite having a key)', async () => {
    const res = await callerA().get(`/api/v1/users/${xId}/public-key`);
    expect(res.statusCode).toBe(404);
  });
});
