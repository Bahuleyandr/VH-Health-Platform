// Patient-scoped ABHA status endpoint (audit F12).
//
// The patient app had no self-scoped way to ask "am I already linked?", so it
// called the staff/admin `/abdm/patient-by-abha/:abhaNumber` lookup — passing
// the patient's PHONE where an ABHA number was expected. That 403s for the
// PATIENT role, the app swallowed the 403, and "My ABHA" therefore rendered the
// registration form for every patient including already-linked ones, inviting a
// duplicate ABHA registration.
//
// GET /api/v1/abdm/my-abha derives identity from the JWT only. This proves:
//   - a linked patient gets linked:true + their own linkage
//   - an unlinked patient gets an honest 200 linked:false (NOT a 404)
//   - the response is tenant-scoped by an explicit predicate
//   - anonymous callers get 401
//   - the staff-only lookup still 403s patients (left untouched by the fix)
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import request from 'supertest';
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT_ID = '00000000-0000-4000-8000-0000000000f2';

const LINKED_UID = 'f12a0000-0000-4000-8000-00000000000a';
const UNLINKED_UID = 'f12a0000-0000-4000-8000-00000000000b';
const LINKED_PHONE = '+919000120001';
const UNLINKED_PHONE = '+919000120002';
const ABHA_NUMBER = '12345678901234';
const ABHA_ADDRESS = 'f12patient@abdm';

function patientClient(uid, { tenantId = TENANT_ID } = {}) {
  const token = generateTestToken('PATIENT', { uid, tenant_id: tenantId });
  return request(app)
    .get('/api/v1/abdm/my-abha')
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    LINKED_UID, UNLINKED_UID,
  ).catch(() => {});
}

d('Patient-scoped ABHA status endpoint (audit F12)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, abha_number, abha_address, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'F12 Linked Patient', 'PATIENT', true, $4, $5, NOW())`,
      LINKED_UID, TENANT_ID, LINKED_PHONE, ABHA_NUMBER, ABHA_ADDRESS,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'F12 Unlinked Patient', 'PATIENT', true, NOW())`,
      UNLINKED_UID, TENANT_ID, UNLINKED_PHONE,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('a linked patient sees their own ABHA linkage', async () => {
    const res = await patientClient(LINKED_UID);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      linked: true,
      abhaNumber: ABHA_NUMBER,
      abhaAddress: ABHA_ADDRESS,
    });
  });

  test('an unlinked patient gets an honest 200 linked:false, not a 404', async () => {
    const res = await patientClient(UNLINKED_UID);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      linked: false,
      abhaNumber: null,
      abhaAddress: null,
    });
  });

  test('the linkage is tenant-scoped — the same uid under another tenant is not found', async () => {
    const res = await patientClient(LINKED_UID, { tenantId: OTHER_TENANT_ID });

    expect(res.statusCode).toBe(404);
    // and it must not leak the linkage in the error payload
    expect(JSON.stringify(res.body)).not.toContain(ABHA_NUMBER);
  });

  test('an anonymous caller is rejected', async () => {
    const res = await request(app)
      .get('/api/v1/abdm/my-abha')
      .set('x-api-key', API_KEY);

    expect(res.statusCode).toBe(401);
  });

  test('the staff-only lookup still refuses a patient (unchanged by this fix)', async () => {
    const token = generateTestToken('PATIENT', { uid: LINKED_UID, tenant_id: TENANT_ID });
    const res = await request(app)
      .get(`/api/v1/abdm/patient-by-abha/${ABHA_NUMBER}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(403);
  });
});
