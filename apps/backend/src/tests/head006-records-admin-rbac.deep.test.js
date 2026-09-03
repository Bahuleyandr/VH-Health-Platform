// HEAD-006: medical-record ADMIN routes (analytics / HIPAA audit / delete) were
// mounted via an inert wrapAutoRBAC(adminRoutes, 'adminRecordRoutes') no-op (the
// subrouter is passed as the first arg with no route map, so NO role middleware
// is attached) and then mounted raw at '/'. They were therefore gated only by
// the broad RECORD_ROUTE_ROLES parent mount — so a non-admin record-capable role
// (e.g. MEDICAL_RECORDS) could read record analytics / the HIPAA audit and
// soft-delete a medical record by id. The three admin-only routes are now gated
// inline with requireRole('ADMIN','SUPER_ADMIN'); the patient-scoped /export/*
// routes keep their existing patientAccessGuard and are unaffected.
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000001';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0b06-00d0-4000-8000-00000000d001', tenant_id: TENANT });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`),
    del: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`),
  };
}

d('HEAD-006 record admin RBAC', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0b06-00d0-4000-8000-00000000d001', { tenantId: TENANT });
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('a non-admin record role (MEDICAL_RECORDS) is denied the admin routes (403)', async () => {
    expect((await client('MEDICAL_RECORDS').get('/api/v1/records/admin/analytics')).statusCode).toBe(403);
    expect((await client('MEDICAL_RECORDS').get('/api/v1/records/admin/hipaa-audit')).statusCode).toBe(403);
    expect((await client('MEDICAL_RECORDS').del('/api/v1/records/999999?reason=test+cleanup')).statusCode).toBe(403);
  });

  it('an ADMIN reaches the admin routes (not 403)', async () => {
    expect((await client('ADMIN').get('/api/v1/records/admin/analytics')).statusCode).not.toBe(403);
    expect((await client('ADMIN').get('/api/v1/records/admin/hipaa-audit')).statusCode).not.toBe(403);
    // Non-existent id → admin passes the role gate (404/400/200, just not 403).
    expect((await client('ADMIN').del('/api/v1/records/999999?reason=test+cleanup')).statusCode).not.toBe(403);
  });
});
