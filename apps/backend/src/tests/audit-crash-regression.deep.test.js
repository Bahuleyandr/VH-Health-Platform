// src/tests/audit-crash-regression.deep.test.js
//
// Pins for the 2026-08-22 audit's "screens that can never work" batch: every
// endpoint here previously failed on EVERY call with a parse-time SQL error
// (wrong column, wrong table, LIKE on an array, DISTINCT vs computed ORDER BY)
// or a mis-mapped error class. None of them had a test that executed the SQL —
// the unit suites mock prisma, which is exactly how they shipped green.
//
// The pin for the SQL class is "the query executes": parse-time errors fail on
// empty tables, so a status below 500 against the CI database proves the fix
// regardless of seed data.

import request from 'supertest';
import app from '../app.js';
import { generateToken } from '../utils/jwtUtils.js';
import { ensureTestIdentity } from './testClient.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const tokenFor = (role, id) => generateToken({
  uid: `eeeeeeee-0000-4000-8000-${String(id).padStart(12, '0')}`,
  id,
  role,
});

// Authentication now fails closed when a token's subject does not resolve to a
// live identity row, and this suite synthesises its uids from an id rather than
// using fixed literals — so the subjects have to be seeded before any request,
// or every case 401s before reaching the gate it is testing.
const uidFor = (id) => `eeeeeeee-0000-4000-8000-${String(id).padStart(12, '0')}`;

beforeAll(async () => {
  for (const id of [9500, 9501, 9502, 9503]) {
    await ensureTestIdentity(uidFor(id));
  }
});

const adminToken = tokenFor('ADMIN', 9500);
const doctorToken = tokenFor('DOCTOR', 9501);
const biomedToken = tokenFor('BIOMEDICAL_STAFF', 9502);

const get = (path, token) => request(app)
  .get(path)
  .set('x-api-key', API_KEY)
  .set('x-forwarded-proto', 'https')
  .set('Authorization', `Bearer ${token}`);

describe('2026-08-22 audit: always-500 endpoints execute their SQL again', () => {
  const cases = [
    // [name, path, token] — previously a guaranteed 5xx for every caller.
    ['departments available-now (LIKE on text[] column, 42883)', '/api/v1/departments/available/now', doctorToken],
    ['biomed my work orders (SELECT DISTINCT vs computed ORDER BY, 42P10)', '/api/v1/clinical-ai/clinical/biomed-cmms/work-orders/my', biomedToken],
    ['FHIR MedicationRequest (nonexistent pharmacy_orders.urgent, 42703)', '/api/v1/fhir/MedicationRequest', doctorToken],
    ['FHIR DiagnosticReport (nonexistent investigations.ordered_at, 42703)', '/api/v1/fhir/DiagnosticReport', doctorToken],
    ['pharmacy analytics (nonexistent pharmacy_orders.urgent, 42703)', '/api/v1/pharmacy/analytics', adminToken],
    ['admin OTP active sessions (nonexistent otp_sessions.used/ip_address)', '/api/v1/auth/admin/otp/active-sessions', adminToken],
    ['admin OTP security alerts (success/ip_address live on otp_logs)', '/api/v1/auth/admin/otp/security-alerts', adminToken],
    ['user admin analytics (nonexistent users.last_login, 42703)', '/api/v1/users/admin/analytics', adminToken],
    ['user admin dashboard (nonexistent users.last_login, 42703)', '/api/v1/users/admin/dashboard', adminToken],
    ['feedback report (ambiguous phone after tenant join, 42702)', '/api/v1/feedback/report', adminToken],
  ];

  it.each(cases)('%s', async (_name, path, token) => {
    const res = await get(path, token);
    expect(res.status).toBeLessThan(500);
  });
});

describe('2026-08-22 audit: error-class and route-shadowing pins', () => {
  it('HR export-report without report_type is a 400, not a 500', async () => {
    const res = await get('/api/v1/staff/hr/export-report', adminToken);
    expect(res.status).toBe(400);
  });

  it('GET /staff/attendance reaches the legacy literal, not the /:identifier wildcard', async () => {
    const res = await get('/api/v1/staff/attendance', doctorToken);
    expect(res.status).toBe(200);
    expect(res.body?.message).toBe('Attendance system operational');
  });

  it('GET /staff/roll-call reaches the legacy literal, not the /:identifier wildcard', async () => {
    const res = await get('/api/v1/staff/roll-call', doctorToken);
    expect(res.status).toBe(200);
    expect(res.body?.message).toBe('Roll-call system operational');
  });

  it('a token with no admins row gets 404 from /auth/admin/profile, not 500', async () => {
    const res = await get('/api/v1/auth/admin/profile', doctorToken);
    expect(res.status).toBe(404);
  });
});

describe('2026-08-22 audit: ward-indent tenant plumbing (production-only failure)', () => {
  // requireTenantId falls back to the default tenant outside production, which
  // is why the missing tenantId shipped green. The resolver reads NODE_ENV per
  // request, so flip it for this block only. AUTH_ENFORCE_TENANT_RLS must be
  // pinned false alongside it: production defaults the RLS auto-wrap ON, whose
  // setTenant transactions leave the pool in a state that hangs the shared
  // teardown's $disconnect past its 5s hook budget.
  const savedEnv = process.env.NODE_ENV;
  const savedRls = process.env.AUTH_ENFORCE_TENANT_RLS;
  beforeAll(() => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
  });
  afterAll(() => {
    process.env.NODE_ENV = savedEnv;
    if (savedRls === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedRls;
  });

  it('listIndents resolves tenant context under production rules', async () => {
    const res = await request(app)
      .get('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('x-forwarded-proto', 'https')
      .set('Authorization', `Bearer ${generateToken({
        uid: 'eeeeeeee-0000-4000-8000-000000009503',
        id: 9503,
        role: 'PHARMACY_STAFF',
        tenant_id: '00000000-0000-4000-8000-000000000001',
      })}`);
    // Pre-fix this was 403 "Tenant context required" for every caller.
    expect(res.status).toBeLessThan(403);
  });
});
