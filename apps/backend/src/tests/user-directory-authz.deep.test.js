// User directory authz (CAN-055).
//
// The user *directory* (GET /users, /users/:id, /role/:role, /search) is split
// from self-service (/profile, /me). PATIENT must NOT reach the directory but
// MUST keep self-service; broad non-admin staff get PII-masked rows.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const N = (p) => `+91${p}`;
const SUBJECT_UID = 'c0de0102-0001-4c0d-8c0d-c0de01020001';
const SUBJECT_PHONE = '9310000201';
const PATIENT_UID = 'c0de0102-0002-4c0d-8c0d-c0de01020002';
const PATIENT_PHONE = '9310000202';

function client(role, overrides) {
  const t = generateTestToken(role, { tenant_id: TENANT_ID, ...overrides });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { get: (p) => h(request(app).get(p)) };
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, SUBJECT_UID, PATIENT_UID).catch(() => {});
}

d('User directory authz (CAN-055)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at) VALUES
        ($1::uuid,$2,'Directory Subject','PATIENT',true,$5::uuid,NOW()),
        ($3::uuid,$4,'Snooping Patient','PATIENT',true,$5::uuid,NOW())`,
      SUBJECT_UID, N(SUBJECT_PHONE), PATIENT_UID, N(PATIENT_PHONE), TENANT_ID);
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);

  it('PATIENT cannot list the user directory', async () => {
    const res = await client('PATIENT', { uid: PATIENT_UID, phone: PATIENT_PHONE }).get('/api/v1/users/');
    expect(res.statusCode).toBe(403);
  });

  it('PATIENT cannot read an arbitrary user by id', async () => {
    const res = await client('PATIENT', { uid: PATIENT_UID, phone: PATIENT_PHONE })
      .get(`/api/v1/users/${SUBJECT_UID}`);
    expect(res.statusCode).toBe(403);
  });

  it('PATIENT keeps self-service /me', async () => {
    const res = await client('PATIENT', { uid: PATIENT_UID, phone: PATIENT_PHONE }).get('/api/v1/users/me');
    expect(res.statusCode).toBeLessThan(300);
  });

  it('GENERAL_STAFF can list but phone is masked', async () => {
    const res = await client('GENERAL_STAFF', { uid: 'c0de0102-0003-4c0d-8c0d-c0de01020003' })
      .get('/api/v1/users/?search=Directory%20Subject&limit=50');
    expect(res.statusCode).toBeLessThan(300);
    const rows = res.body?.data?.users ?? res.body?.data ?? [];
    const subject = rows.find((u) => u.uid === SUBJECT_UID);
    expect(subject).toBeDefined();
    expect(String(subject.phone)).toMatch(/\*\*\*\*$/); // masked
    expect(subject.address ?? null).toBeNull();          // stripped
  });

  it('ADMIN sees unmasked directory', async () => {
    const res = await client('ADMIN', { uid: 'c0de0102-0004-4c0d-8c0d-c0de01020004' })
      .get('/api/v1/users/?search=Directory%20Subject&limit=50');
    expect(res.statusCode).toBeLessThan(300);
    const rows = res.body?.data?.users ?? res.body?.data ?? [];
    const subject = rows.find((u) => u.uid === SUBJECT_UID);
    expect(subject).toBeDefined();
    expect(String(subject.phone)).toBe(N(SUBJECT_PHONE)); // unmasked for admin
  });

  it('GET /users/search resolves — not shadowed by /users/:identifier', async () => {
    // Regression: GET /search was registered AFTER GET /:identifier, so
    // "search" was captured as an identifier and the advanced-search endpoint
    // was unreachable (non-uuid identifier -> directory lookup miss).
    const res = await client('ADMIN', { uid: 'c0de0102-0004-4c0d-8c0d-c0de01020004' })
      .get('/api/v1/users/search?query=Directory%20Subject&limit=50');
    expect(res.statusCode).toBe(200);
    const users = res.body?.data?.users ?? [];
    expect(Array.isArray(users)).toBe(true);
    const subject = users.find((u) => u.uid === SUBJECT_UID);
    expect(subject).toBeDefined();
    expect(res.body?.data?.totalFound).toBeGreaterThanOrEqual(1);
  });

  it('GET /users/search returns an empty result set for a no-match query', async () => {
    const res = await client('ADMIN', { uid: 'c0de0102-0004-4c0d-8c0d-c0de01020004' })
      .get('/api/v1/users/search?query=zzz-no-such-user-zzz');
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.totalFound).toBe(0);
    expect(res.body?.data?.users).toEqual([]);
  });
});
