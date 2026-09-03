// src/tests/auditOverPermissiveRegression.test.js
//
// Pins for the 2026-08-22 audit's over-permissive findings — the inverse of
// the lockout class: roles that could reach PHI they have no duty to see.
//
//  OP-002: /api/v1/abdm/consent-requests (a named ABDM_PHI_PATH) was gated by
//          isStaff(), so 52 of 59 roles — drivers, security guards,
//          housekeeping, delivery staff — could list the tenant's
//          health-information consent requests.
//  OP-001: the clinical-AI discharge-compose surface rode the broad mount list
//          (which intentionally admits operational reviewers for OTHER
//          modules), exposing AI-composed discharge summaries to housekeeping/
//          HR/reception — while the ward-nurse tier that actually consumes
//          discharge packages was denied at the mount.

import request from 'supertest';
import app from '../app.js';
import { generateToken } from '../utils/jwtUtils.js';
import { ensureTestIdentity } from './testClient.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const tokenFor = (role, id) => generateToken({
  uid: `abababab-0000-4000-8000-${String(id).padStart(12, '0')}`,
  id,
  role,
});

// Authentication now fails closed when a token's subject does not resolve to a
// live identity row, and this suite synthesises its uids from an id rather than
// using fixed literals — so the subjects have to be seeded before any request,
// or every case 401s before reaching the gate it is testing.
const uidFor = (id) => `abababab-0000-4000-8000-${String(id).padStart(12, '0')}`;

beforeAll(async () => {
  for (const id of Array.from({ length: 100 }, (_, i) => 9900 + i)) {
    await ensureTestIdentity(uidFor(id));
  }
});

const get = (path, token) => request(app)
  .get(path)
  .set('x-api-key', API_KEY)
  .set('x-forwarded-proto', 'https')
  .set('Authorization', `Bearer ${token}`);

describe('ABDM consent requests are no longer roster-wide (OP-002)', () => {
  const denied = ['DRIVER', 'SECURITY', 'HOUSEKEEPING_STAFF', 'DELIVERY_STAFF', 'MAINTENANCE', 'BIOMEDICAL_STAFF'];
  const allowed = ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS', 'RECEPTIONIST', 'ADMISSION_OFFICER'];

  it.each(denied)('%s is refused', async (role) => {
    const res = await get('/api/v1/abdm/consent-requests', tokenFor(role, 9900 + denied.indexOf(role)));
    expect(res.status).toBe(403);
  });

  it.each(allowed)('%s still passes the role gate', async (role) => {
    const res = await get('/api/v1/abdm/consent-requests', tokenFor(role, 9950 + allowed.indexOf(role)));
    expect(res.status).not.toBe(403);
  });
});

describe('AI discharge-compose reads are discharge-summary-scoped (OP-001)', () => {
  const path = '/api/v1/clinical-ai/clinical/discharge-compose';
  const denied = ['HOUSEKEEPING_STAFF', 'BIOMEDICAL_STAFF', 'HR_STAFF', 'RECEPTIONIST'];
  // The ward-nurse tier both passes the (widened) mount and the per-route
  // discharge gate; DOCTOR was always allowed.
  const allowed = ['DOCTOR', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'IP_INCHARGE', 'NURSING_INCHARGE'];

  it.each(denied)('%s is refused', async (role) => {
    const res = await get(path, tokenFor(role, 9960 + denied.indexOf(role)));
    expect(res.status).toBe(403);
  });

  it.each(allowed)('%s is not rbac-denied', async (role) => {
    const res = await get(path, tokenFor(role, 9970 + allowed.indexOf(role)));
    expect(res.status).not.toBe(403);
  });

  it('other clinical-AI modules keep their operational reviewers (mount unchanged for them)', async () => {
    // Housekeeping remains a legitimate reviewer on non-discharge modules; the
    // mount must still admit it — only the discharge routes deny.
    const res = await get('/api/v1/clinical-ai/clinical/biomed-cmms/work-orders/my', tokenFor('BIOMEDICAL_STAFF', 9980));
    expect(res.status).not.toBe(403);
  });
});
