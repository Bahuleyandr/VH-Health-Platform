// Generic upload by-key tenant scope (CAN-023).
//
// getFileByKey looked a file up by storage_key alone, so a key resolved any
// tenant's file — and the internal-admin bypass in canAccessGenericUpload then
// granted cross-tenant access. The lookup now filters on tenant_id. RLS is OFF
// in the test env, so this explicit predicate is what scopes the lookup: a
// tenant-A admin gets 404 for a tenant-B file, while a tenant-B admin finds it
// (here surfaced as 423, blocked by the pending scan — proves the row resolved).
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OWNER_B = 'c0de0023-00b0-4000-8000-0000000000b1';
const KEY = `uploads/${OWNER_B}/can023_secret.pdf`;

function admin(tenantId, uid) {
  const t = generateTestToken('ADMIN', { uid, tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM file_metadata WHERE storage_key = $1`, KEY).catch(() => {});
}

d('Upload by-key tenant scope (CAN-023)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can023-tenant-b', 'CAN-023 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO file_metadata
         (file_name, file_type, storage_key, storage_url, file_size,
          uploaded_by, scan_status, privacy_level, is_active, tenant_id, updated_at)
       VALUES ('can023_secret.pdf','application/pdf',$1,'r2://x',123,
               $2::uuid,'PENDING','RESTRICTED',TRUE,$3::uuid,NOW())`,
      KEY, OWNER_B, TENANT_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a tenant-A admin cannot resolve a tenant-B file by key (404)', async () => {
    const res = await admin(TENANT_A, 'c0de0023-00a0-4000-8000-0000000000a1').get(`/api/v1/upload/by-key/${KEY}`);
    expect(res.statusCode).toBe(404);
  });

  it('a tenant-B admin resolves the file (423, blocked by pending scan)', async () => {
    const res = await admin(TENANT_B, OWNER_B).get(`/api/v1/upload/by-key/${KEY}`);
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(423);
  });
});
