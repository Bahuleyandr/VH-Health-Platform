// Deep integration tests for the dependent-profile flow.
//
// Covers the surface added in `routes/user/dependentsRoutes.js` +
// `services/user/dependentsService.js` against the schema introduced by
// migration 202 (`users.guardian_user_id`, `users.is_minor`).
//
// Each test asserts exact status codes + row-level side effects on
// `users` and `audit_logs` rather than the [200, 500] hedge.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateTestToken } from './testClient.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const GUARDIAN_UID = 'b2222222-2222-4222-8222-222222222b01';
const GUARDIAN_PHONE = '9000020001';
const MINOR_A_UID = 'b2222222-2222-4222-8222-222222222b02';
const MINOR_A_PHONE = '9000020002';
const MINOR_B_UID = 'b2222222-2222-4222-8222-222222222b03';
const MINOR_B_PHONE = '9000020003';
const ADULT_UID = 'b2222222-2222-4222-8222-222222222b04';
const ADULT_PHONE = '9000020004';
const OTHER_GUARDIAN_UID = 'b2222222-2222-4222-8222-222222222b05';
const OTHER_GUARDIAN_PHONE = '9000020005';

function clientAs({ uid, id, role = 'PATIENT', phone = null }) {
  const token = generateTestToken(role, { uid, id, phone });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (path) => request(app).delete(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function withAuditBypass(fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    return fn(tx);
  });
}

async function purgeDependentAuditLogs(uids) {
  await withAuditBypass(async (tx) => {
    for (const uid of uids) {
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE uid = $1::uuid OR resource_id = $1::text`, uid,
      );
    }
  });
}

describe('User dependents — deep integration', () => {
  let guardianId;
  let otherGuardianId;
  let minorAId;
  let minorBId;
  let adultId;
  let guardian;
  let otherGuardian;

  beforeAll(async () => {
    // Tear down any leftovers in FK-safe order. The audit_logs purge has
    // to come before users because the audit row's uid column references
    // the same Uuid values we're about to recycle.
    const allUids = [
      GUARDIAN_UID, OTHER_GUARDIAN_UID, MINOR_A_UID, MINOR_B_UID, ADULT_UID,
    ];
    await purgeDependentAuditLogs(allUids);
    // Reset any prior guardian_user_id pointers before we delete the row
    // they reference; otherwise the FK ON DELETE SET NULL fires fine,
    // but resetting here keeps the DELETE clean.
    await prisma.$executeRawUnsafe(
      `UPDATE users SET guardian_user_id = NULL WHERE uid = ANY($1::uuid[])`,
      allUids,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids,
    );

    // Guardian (adult).
    const gRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Deep Dep Guardian', 'PATIENT', true, false, NOW())
       RETURNING id`,
      GUARDIAN_UID, GUARDIAN_PHONE,
    );
    guardianId = gRows[0].id;

    // Second, unrelated guardian — used for the "already linked to someone
    // else" conflict path.
    const ogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Deep Dep Other Guardian', 'PATIENT', true, false, NOW())
       RETURNING id`,
      OTHER_GUARDIAN_UID, OTHER_GUARDIAN_PHONE,
    );
    otherGuardianId = ogRows[0].id;

    // Two minors that the guardian can link.
    const m1 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Deep Dep Minor A', 'PATIENT', true, true, NOW())
       RETURNING id`,
      MINOR_A_UID, MINOR_A_PHONE,
    );
    minorAId = m1[0].id;

    const m2 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Deep Dep Minor B', 'PATIENT', true, true, NOW())
       RETURNING id`,
      MINOR_B_UID, MINOR_B_PHONE,
    );
    minorBId = m2[0].id;

    // An adult patient — must NOT be linkable as a dependent under the
    // is_minor gate.
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Deep Dep Adult', 'PATIENT', true, false, NOW())
       RETURNING id`,
      ADULT_UID, ADULT_PHONE,
    );
    adultId = a[0].id;

    guardian = clientAs({ uid: GUARDIAN_UID, id: guardianId, phone: GUARDIAN_PHONE });
    otherGuardian = clientAs({ uid: OTHER_GUARDIAN_UID, id: otherGuardianId, phone: OTHER_GUARDIAN_PHONE });
  });

  afterAll(async () => {
    const allUids = [
      GUARDIAN_UID, OTHER_GUARDIAN_UID, MINOR_A_UID, MINOR_B_UID, ADULT_UID,
    ];
    await purgeDependentAuditLogs(allUids);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET guardian_user_id = NULL WHERE uid = ANY($1::uuid[])`,
      allUids,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids,
    );
    await prisma.$disconnect();
  });

  test('GET /users/dependents returns empty list when nothing linked', async () => {
    const res = await guardian.get('/api/v1/users/dependents');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.dependents)).toBe(true);
    expect(res.body.data.dependents).toEqual([]);
  });

  test('POST /users/dependents/link — links a minor by UID and writes audit', async () => {
    const res = await guardian
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: MINOR_A_UID, relationship: 'parent' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.dependent.uid).toBe(MINOR_A_UID);
    expect(res.body.data.dependent.is_minor).toBe(true);
    expect(res.body.data.dependent.guardian_relationship).toBe('parent');
    // Phone is masked on the wire.
    expect(res.body.data.dependent.phone).not.toBe(MINOR_A_PHONE);

    const row = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id, guardian_relationship FROM users WHERE id = $1`,
      minorAId,
    );
    expect(row[0].guardian_user_id).toBe(guardianId);
    expect(row[0].guardian_relationship).toBe('parent');

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action, resource_id FROM audit_logs
        WHERE uid = $1::uuid AND action = 'DEPENDENT_LINKED'
        ORDER BY created_at DESC LIMIT 1`,
      GUARDIAN_UID,
    );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].resource_id).toBe(MINOR_A_UID);
  });

  test('POST /users/dependents/link — idempotent when re-linking the same pair', async () => {
    const res = await guardian
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: MINOR_A_UID });
    // Same row gets returned without throwing CONCURRENT_LINK / ALREADY_LINKED.
    expect(res.status).toBe(201);
    expect(res.body.data.dependent.uid).toBe(MINOR_A_UID);
  });

  test('POST /users/dependents/link — links a minor by phone too', async () => {
    const res = await guardian
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: MINOR_B_PHONE });
    expect(res.status).toBe(201);
    expect(res.body.data.dependent.uid).toBe(MINOR_B_UID);

    const row = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id FROM users WHERE id = $1`, minorBId,
    );
    expect(row[0].guardian_user_id).toBe(guardianId);
  });

  test('GET /users/dependents — returns both linked minors', async () => {
    const res = await guardian.get('/api/v1/users/dependents');
    expect(res.status).toBe(200);
    const uids = res.body.data.dependents.map((d) => d.uid).sort();
    expect(uids).toContain(MINOR_A_UID);
    expect(uids).toContain(MINOR_B_UID);
    expect(uids).not.toContain(ADULT_UID);
  });

  test('POST /users/dependents/link — refuses to link an adult', async () => {
    const res = await guardian
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: ADULT_UID });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/minor/i);

    const row = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id FROM users WHERE id = $1`, adultId,
    );
    expect(row[0].guardian_user_id).toBeNull();
  });

  test('POST /users/dependents/link — refuses to self-link', async () => {
    const res = await guardian
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: GUARDIAN_UID });
    // Self is non-minor, so the minor-gate fires before the self-link
    // check; both are 400s, which is what we care about. The point is the
    // guardian's own row must not be linked to itself.
    expect(res.status).toBe(400);

    const row = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id FROM users WHERE id = $1`, guardianId,
    );
    expect(row[0].guardian_user_id).toBeNull();
  });

  test('POST /users/dependents/link — conflict when minor already has different guardian', async () => {
    const res = await otherGuardian
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: MINOR_A_UID });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);

    // Linkage is unchanged.
    const row = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id FROM users WHERE id = $1`, minorAId,
    );
    expect(row[0].guardian_user_id).toBe(guardianId);
  });

  test('POST /users/dependents/link — rejects unknown identifier', async () => {
    const res = await guardian
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: '+919999999999' });
    expect(res.status).toBe(404);
  });

  test('DELETE /users/dependents/:id — unlinks and writes audit', async () => {
    const res = await guardian.delete(`/api/v1/users/dependents/${minorAId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id FROM users WHERE id = $1`, minorAId,
    );
    expect(row[0].guardian_user_id).toBeNull();

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action, resource_id FROM audit_logs
        WHERE uid = $1::uuid AND action = 'DEPENDENT_UNLINKED'
        ORDER BY created_at DESC LIMIT 1`,
      GUARDIAN_UID,
    );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].resource_id).toBe(MINOR_A_UID);
  });

  test('DELETE /users/dependents/:id — IDOR-blocks unlink by non-owner', async () => {
    // otherGuardian has no linkage to minor B (still owned by guardian)
    // and must get a 404 (we deliberately don't disclose existence).
    const res = await otherGuardian.delete(`/api/v1/users/dependents/${minorBId}`);
    expect(res.status).toBe(404);

    const row = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id FROM users WHERE id = $1`, minorBId,
    );
    expect(row[0].guardian_user_id).toBe(guardianId);
  });
});
