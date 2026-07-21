// Roadmap E6 — result release rules + proxy access deep round-trip.
//
// Fresh sign-offs sit behind the auto-release delay; clinicians can hold
// (reason required) or release early; trends serve released-only numeric
// series; proxy access needs an active grant (consent trail) and every
// proxy read is audited.

import jwt from 'jsonwebtoken';
import request from 'supertest';
import prisma from '../lib/prisma.js';
import app from '../app.js';
import { authClient, API_KEY } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const NAME_A = 'E6TEST PortalPatient';
const NAME_B = 'E6TEST ProxyHolder';
const TENANT = '00000000-0000-4000-8000-000000000001';
const DOCTOR_UID = 'e6000000-0000-4000-8000-000000000001';

let patientA;
let patientB;
let freshResultId;
let agedResultId;
let heldResultId;
let grantId;
const pngSignature = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function patientClient(uid) {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret';
  const token = jwt.sign(
    { uid, id: 99, phone: '9876500000', role: 'PATIENT', deviceType: 'mobile' },
    secret,
    { expiresIn: '1h' },
  );
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM portal_proxy_grants WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))
       OR proxy_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`, NAME_A, NAME_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`, NAME_A, NAME_B,
  ).catch(() => {});
  // clinical_audit_events is append-only (C4 chain) — never deleted here.
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name IN ($1, $2)`, NAME_A, NAME_B).catch(() => {});
}

async function seedResult({ patientUid, testCode, name, value, signedHoursAgo, hold = false, released = null, performedDaysAgo = 0 }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (patient_uid, test_code, test_name, value_numeric, unit, reference_range, status,
        signed_off_at, release_hold, release_hold_reason, released_to_patient_at, performed_at, created_at)
     VALUES ($1::uuid, $2, $3, $4, 'g/dL', '13-17', 'final',
             NOW() - make_interval(hours => $5::int), $6, $7,
             $8::timestamptz, NOW() - make_interval(days => $9::int), NOW())
     RETURNING id`,
    patientUid, testCode, name, value, signedHoursAgo, hold,
    hold ? 'seeded hold' : null, released, performedDaysAgo,
  );
  return rows[0].id;
}

d('Portal result release + proxy access — deep round-trip (roadmap E6)', () => {
  const doctor = authClient('DOCTOR', { uid: DOCTOR_UID });

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, status, is_active, is_deleted, updated_at)
       VALUES ($1::uuid, $2::uuid, '9887700001', 'E6TEST Release Doctor',
               'DOCTOR', 'active', true, false, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             role = EXCLUDED.role,
             status = EXCLUDED.status,
             is_active = true,
             is_deleted = false,
             deleted_at = NULL`,
      DOCTOR_UID,
      TENANT,
    );
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198877${String(Date.now() % 10000).padStart(4, '0')}`, NAME_A,
    );
    patientA = a[0].uid;
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198878${String(Date.now() % 10000).padStart(4, '0')}`, NAME_B,
    );
    patientB = b[0].uid;

    // Fresh sign-off (1h ago) → behind the 24h auto-release window.
    freshResultId = await seedResult({
      patientUid: patientA, testCode: 'E6HB', name: 'Haemoglobin', value: 13.1, signedHoursAgo: 1,
    });
    // Signed 48h ago, no explicit release → visible via elapsed delay.
    agedResultId = await seedResult({
      patientUid: patientA, testCode: 'E6HB', name: 'Haemoglobin', value: 12.4,
      signedHoursAgo: 48, performedDaysAgo: 30,
    });
    // Signed 48h ago but HELD → never visible while held.
    heldResultId = await seedResult({
      patientUid: patientA, testCode: 'E6CRP', name: 'CRP', value: 18, signedHoursAgo: 48, hold: true,
    });
    // Older released point for the trend series.
    await seedResult({
      patientUid: patientA, testCode: 'E6HB', name: 'Haemoglobin', value: 11.9,
      signedHoursAgo: 24 * 60, released: new Date(Date.now() - 59 * 24 * 3600 * 1000).toISOString(),
      performedDaysAgo: 60,
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID,
    ).catch(() => {});
    await prisma.$disconnect();
  });

  test('auto-release delay: fresh sign-offs are hidden, aged ones visible, held ones blocked', async () => {
    const res = await patientClient(patientA).get('/api/v1/portal/lab-results');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r) => r.id);
    expect(ids).toContain(agedResultId);
    expect(ids).not.toContain(freshResultId);
    expect(ids).not.toContain(heldResultId);

    const detailBlocked = await patientClient(patientA).get(`/api/v1/portal/lab-results/${freshResultId}`);
    expect(detailBlocked.status).toBe(404);
  });

  test('doctor releases a fresh result early; the patient sees it immediately', async () => {
    const rel = await doctor.post(`/api/v1/lab/release/${freshResultId}/release-now`).send({});
    expect(rel.status).toBe(200);

    const res = await patientClient(patientA).get('/api/v1/portal/lab-results');
    expect(res.body.data.map((r) => r.id)).toContain(freshResultId);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
       WHERE patient_uid = $1::uuid AND action = 'lab.result_released_early'`,
      patientA,
    );
    expect(audit.length).toBe(1);
  });

  test('hold requires a reason, blocks an already-visible result, unhold restores it', async () => {
    const noReason = await doctor.patch(`/api/v1/lab/release/${agedResultId}/hold`).send({ hold: true });
    expect(noReason.status).toBe(400);

    const hold = await doctor.patch(`/api/v1/lab/release/${agedResultId}/hold`).send({
      hold: true, reason: 'Discuss in person at follow-up',
    });
    expect(hold.status).toBe(200);

    let res = await patientClient(patientA).get('/api/v1/portal/lab-results');
    expect(res.body.data.map((r) => r.id)).not.toContain(agedResultId);

    const unhold = await doctor.patch(`/api/v1/lab/release/${agedResultId}/hold`).send({ hold: false });
    expect(unhold.status).toBe(200);

    res = await patientClient(patientA).get('/api/v1/portal/lab-results');
    expect(res.body.data.map((r) => r.id)).toContain(agedResultId);
  });

  test('patients cannot touch the staff release surface', async () => {
    const res = await patientClient(patientA).post(`/api/v1/lab/release/${heldResultId}/release-now`).send({});
    expect(res.status).toBe(403);
  });

  test('lab trends serve released-only numeric series with stats', async () => {
    const res = await patientClient(patientA).get('/api/v1/portal/lab-results/trends?test_code=E6HB&months=36');
    expect(res.status).toBe(200);
    const trend = res.body.data;
    expect(trend.count).toBe(3); // 11.9 (released), 12.4 (aged), 13.1 (early-released)
    expect(trend.points.map((p) => p.value)).toEqual([11.9, 12.4, 13.1]);
    expect(trend.min).toBe(11.9);
    expect(trend.max).toBe(13.1);
    expect(trend.latest.value).toBe(13.1);
    expect(trend.unit).toBe('g/dL');
  });

  test('proxy access requires an active grant; grants carry the consent trail', async () => {
    const blocked = await patientClient(patientB).get(`/api/v1/portal/lab-results?for_patient=${patientA}`);
    expect(blocked.status).toBe(403);

    const grant = await patientClient(patientA)
      .post('/api/v1/portal/proxy/grants')
      .field('proxy_uid', patientB)
      .field('relationship', 'son')
      .field('consent_method', 'written')
      .field('consent_ref', 'SIG-2026-0610-001')
      .attach('file', pngSignature, {
        filename: 'proxy-grant-signature.png',
        contentType: 'image/png',
      });
    expect(grant.status).toBe(200);
    grantId = grant.body.data.id;
    expect(String(grant.body.data.signature_sha256_hash || '')).toHaveLength(64);

    const grantRows = await prisma.$queryRawUnsafe(
      `SELECT signature_storage_key, signature_mime_type, signature_sha256_hash
         FROM portal_proxy_grants
        WHERE id = $1::int`,
      grantId,
    );
    expect(grantRows[0]).toMatchObject({
      signature_mime_type: 'image/png',
      signature_sha256_hash: grant.body.data.signature_sha256_hash,
    });
    expect(String(grantRows[0].signature_storage_key || '')).toContain('portal-proxy-grant-signatures/');

    const dup = await patientClient(patientA).post('/api/v1/portal/proxy/grants').send({
      proxy_uid: patientB, consent_method: 'otp',
    });
    expect(dup.status).toBe(409);

    const allowed = await patientClient(patientB).get(`/api/v1/portal/lab-results?for_patient=${patientA}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.map((r) => r.id)).toContain(agedResultId);

    const trendProxy = await patientClient(patientB).get(`/api/v1/portal/lab-results/trends?test_code=E6HB&for_patient=${patientA}`);
    expect(trendProxy.status).toBe(200);
    expect(trendProxy.body.data.count).toBe(3);

    const lists = await patientClient(patientB).get('/api/v1/portal/proxy/grants');
    expect(lists.body.data.held_by_me).toHaveLength(1);

    const accessAudit = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
       WHERE patient_uid = $1::uuid AND action = 'portal.proxy_access'`,
      patientA,
    );
    expect(accessAudit.length).toBeGreaterThanOrEqual(1);
  });

  test('revoking the grant cuts proxy access immediately', async () => {
    const revoke = await patientClient(patientA).post(`/api/v1/portal/proxy/grants/${grantId}/revoke`).send({
      reason: 'No longer needed',
    });
    expect(revoke.status).toBe(200);

    const blocked = await patientClient(patientB).get(`/api/v1/portal/lab-results?for_patient=${patientA}`);
    expect(blocked.status).toBe(403);

    const selfGrant = await patientClient(patientA).post('/api/v1/portal/proxy/grants').send({
      proxy_uid: patientA, consent_method: 'otp',
    });
    expect(selfGrant.status).toBe(400);
  });
});
