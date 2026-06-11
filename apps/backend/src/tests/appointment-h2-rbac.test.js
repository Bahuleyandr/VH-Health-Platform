// Regression tests for audit finding H2 (2026-06-10).
// The appointment router's RBAC was dead code: wrapAutoRBAC was called with an
// empty route map (attaches nothing) and the app.js mount had no requireRole,
// so ANY authenticated user — including PATIENT — could read cross-patient
// data via /completed/recent, /pending, and the /admin/* surfaces.
//
// These tests prove:
//   1. PATIENT → 403 on /completed/recent, /pending, /admin/sla-dashboard,
//      /admin/audit-trail, /admin/documents (attack blocked).
//   2. Out-of-policy staff role (HOUSEKEEPING_STAFF) → 403 at the mount.
//   3. ADMIN → 200 on the admin surfaces (legitimate path intact).
//   4. RECEPTIONIST (staff) → 200 on /completed/recent and /pending.
//   5. PATIENT can still reach patient-appropriate routes
//      (GET /patient/:own_id).

import request from 'supertest';
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import app from '../app.js';

const PATIENT_UID = 'e2222222-2222-4222-8222-222222222e01';
const PATIENT_PHONE = '+919000090001';

function client(role, overrides = {}) {
  const token = generateTestToken(role, overrides);
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Appointment router RBAC — H2 regression', () => {
  let patientIntId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone = $1`, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID);
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'H2 RBAC Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE
    );
    patientIntId = rows[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone = $1`, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID);
  });

  const SENSITIVE_ROUTES = [
    '/api/v1/appointments/completed/recent',
    '/api/v1/appointments/pending',
    '/api/v1/appointments/admin/sla-dashboard',
    '/api/v1/appointments/admin/audit-trail',
    '/api/v1/appointments/admin/documents',
  ];

  test.each(SENSITIVE_ROUTES)('PATIENT → 403 on %s', async (route) => {
    const c = client('PATIENT', { uid: PATIENT_UID, id: patientIntId, phone: PATIENT_PHONE });
    const res = await c.get(route);
    expect(res.statusCode).toBe(403);
  });

  test('out-of-policy role (HOUSEKEEPING_STAFF) → 403 at the mount', async () => {
    const c = client('HOUSEKEEPING_STAFF');
    const res = await c.get('/api/v1/appointments/list');
    expect(res.statusCode).toBe(403);
  });

  test('ADMIN → 200 on /admin/sla-dashboard', async () => {
    const c = client('ADMIN');
    const res = await c.get('/api/v1/appointments/admin/sla-dashboard');
    expect(res.statusCode).toBe(200);
  });

  // NOTE: /admin/audit-trail and /admin/documents have PRE-EXISTING functional
  // bugs unrelated to this security fix (BigInt serialization in their raw
  // queries → 500 for every caller, found while adding these tests; tracked in
  // docs/PLATFORM_REMEDIATION_PLAN.md). The H2 assertion here is that RBAC
  // admits ADMIN (no 401/403) — strict 200 applies once those bugs are fixed.
  test.each([
    '/api/v1/appointments/admin/audit-trail',
    '/api/v1/appointments/admin/documents',
  ])('ADMIN passes RBAC on %s (no 401/403)', async (route) => {
    const c = client('ADMIN');
    const res = await c.get(route);
    expect([401, 403]).not.toContain(res.statusCode);
  });

  test('RECEPTIONIST → 200 on /completed/recent', async () => {
    const c = client('RECEPTIONIST');
    const res = await c.get('/api/v1/appointments/completed/recent');
    expect(res.statusCode).toBe(200);
  });

  test('RECEPTIONIST → 200 on /pending', async () => {
    const c = client('RECEPTIONIST');
    const res = await c.get('/api/v1/appointments/pending');
    expect(res.statusCode).toBe(200);
  });

  test('PATIENT can still read OWN appointments (legitimate path)', async () => {
    const c = client('PATIENT', { uid: PATIENT_UID, id: patientIntId, phone: PATIENT_PHONE });
    const res = await c.get(`/api/v1/appointments/patient/${patientIntId}`);
    expect(res.statusCode).toBe(200);
  });

  test('appointment admin sub-router (/admin/analytics) — PATIENT 403, ADMIN passes RBAC', async () => {
    const patient = client('PATIENT', { uid: PATIENT_UID, id: patientIntId, phone: PATIENT_PHONE });
    expect((await patient.get('/api/v1/appointments/admin/analytics')).statusCode).toBe(403);
    const admin = client('ADMIN');
    // PRE-EXISTING bug: /admin/analytics queries the dropped column
    // consultation_duration_minutes → 500 for every caller (tracked in
    // docs/PLATFORM_REMEDIATION_PLAN.md). RBAC admitting ADMIN is what H2
    // requires here; strict 200 applies once that query is fixed.
    expect([401, 403]).not.toContain((await admin.get('/api/v1/appointments/admin/analytics')).statusCode);
  });
});
