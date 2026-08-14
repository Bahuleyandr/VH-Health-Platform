// src/tests/data-export-gdpr.deep.test.js
//
// GDPR surface hardening (findings pass 2026-08-14, backend-HTTP P2):
//
//   1. GET /api/v1/data-export/my-data exports the patient's FULL record set
//      (appointments, health records, investigations, pharmacy, consents…) in
//      one response — the densest PHI read on the platform — yet the mount had
//      no route-level PHI access logging. It now carries
//      phiAccessLogger('DATA_EXPORT') like the sibling PHI mounts (/records,
//      /api/v1/patient), so every export lands in hipaa_access_log.
//
//   2. DELETE /api/v1/data-export/my-data (right to erasure) echoed the raw
//      driver `err.message` per skipped table in the response body (repo rule:
//      never expose err.message — a Postgres 42703 names the exact column and
//      relation, leaking schema detail to any authenticated patient). Skips now
//      return a generic reason; the real error is logged server-side.
//
// Runs against the REAL app + REAL database. The erasure leak is
// deterministic here: only `users` has a deleted_at column, so the other six
// whitelisted tables always take the catch branch that used to leak.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

async function createPatient(phoneSuffix) {
  const phone = `+9198993${phoneSuffix}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, role, registered_at, updated_at)
     VALUES ($1, 'PATIENT', NOW(), NOW())
     RETURNING uid, id, phone`,
    phone,
  );
  return rows[0];
}

async function cleanupPatient(uid) {
  if (!uid) return;
  await prisma.$executeRawUnsafe(
    'DELETE FROM hipaa_access_log WHERE actor_uid = $1::uuid OR subject_uid = $1::uuid OR accessed_by = $1::uuid',
    uid,
  ).catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM users WHERE uid = $1::uuid', uid).catch(() => {});
}

/** phiAccessLogger writes on res 'finish', fire-and-forget — poll briefly. */
async function findHipaaRow(uid, recordType, action, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  do {
    rows = await prisma.$queryRawUnsafe(
      `SELECT record_type, action, accessed_by, actor_uid, subject_uid
         FROM hipaa_access_log
        WHERE actor_uid = $1::uuid
          AND record_type = $2
          AND action = $3
        ORDER BY accessed_at DESC
        LIMIT 1`,
      uid, recordType, action,
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < deadline);
  return rows;
}

describe('GDPR data-export surface — PHI logging + erasure response hygiene', () => {
  let user;
  let token;

  beforeAll(async () => {
    user = await createPatient('71');
    token = generateTestToken('PATIENT', {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      tenant_id: DEFAULT_TENANT,
    });
  });

  afterAll(async () => {
    await cleanupPatient(user?.uid);
    await prisma.$disconnect().catch(() => {});
  });

  it('GET /my-data exports the record set AND writes a DATA_EXPORT row to hipaa_access_log', async () => {
    const res = await request(app)
      .get('/api/v1/data-export/my-data')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.profile).toMatchObject({ phone: user.phone });
    expect(Array.isArray(res.body.appointments)).toBe(true);
    expect(Array.isArray(res.body.consents)).toBe(true);

    // The full-record export must be HIPAA-audited: who, what, VIEW.
    const rows = await findHipaaRow(String(user.uid), 'DATA_EXPORT', 'VIEW');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_type: 'DATA_EXPORT',
      action: 'VIEW',
    });
    expect(String(rows[0].actor_uid)).toBe(String(user.uid));
  });

  it('DELETE /my-data never echoes raw driver errors for skipped tables (and still soft-deletes users)', async () => {
    const res = await request(app)
      .delete('/api/v1/data-export/my-data')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.details)).toBe(true);

    // Deterministic on this schema: only `users` carries deleted_at, so the
    // other whitelisted tables MUST appear as skipped — the exact branch that
    // used to echo `column "deleted_at" of relation "…" does not exist`.
    const skipped = res.body.details.filter((d) => d.skipped);
    expect(skipped.length).toBeGreaterThan(0);
    for (const entry of skipped) {
      expect(entry.reason).toBe('Table not eligible for soft deletion');
    }

    // No Postgres/Prisma error text anywhere in the response body.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/does not exist/i);
    expect(body).not.toMatch(/column\s+"/i);
    expect(body).not.toMatch(/relation\s+"/i);
    expect(body).not.toMatch(/prisma/i);

    // The erasure itself still works where the schema supports it.
    const usersEntry = res.body.details.find((d) => d.table === 'users');
    expect(usersEntry).toMatchObject({ table: 'users', affected: 1 });
    const [row] = await prisma.$queryRawUnsafe(
      'SELECT deleted_at FROM users WHERE uid = $1::uuid',
      String(user.uid),
    );
    expect(row.deleted_at).not.toBeNull();

    // And the erasure write is PHI-audited too (route-level DATA_EXPORT mount).
    const rows = await findHipaaRow(String(user.uid), 'DATA_EXPORT', 'DELETE');
    expect(rows).toHaveLength(1);
  });
});
