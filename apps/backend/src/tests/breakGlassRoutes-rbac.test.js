// PHI-access break-glass endpoints — RBAC gate (HTTP, real app).
//
// CareTeam ABAC design §5 + §8 Q1. The activation/revocation/list endpoints
// must be reachable ONLY by the CURRENT break-glass-eligible roles
// (rolePolicyGraph.js:1389 phi.can_break_glass — SUPER_ADMIN / ADMIN / CMO /
// MEDICAL_SUPERINTENDENT), enforced via wrapAutoRBAC on the
// `patientAccessBreakGlassRoutes` config key.
//
// Proves:
//   1. Ineligible roles (PATIENT, DOCTOR, NURSING_STAFF) → 403 at the mount.
//   2. Eligible roles (ADMIN, CMO, MEDICAL_SUPERINTENDENT) PASS RBAC — they are
//      not 401/403'd. (A too-short reason then yields a deterministic 400 from
//      validation, which proves the request reached the handler past RBAC,
//      without needing DB patient fixtures.)

import request from 'supertest';
import { generateTestToken, API_KEY } from './testClient.js';
import app from '../app.js';

const BREAK_GLASS_PATH = '/api/v1/patient-access/break-glass';

function client(role, overrides = {}) {
  const token = generateTestToken(role, overrides);
  const auth = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  return {
    post: (p, body) => auth(request(app).post(p)).send(body),
    delete: (p) => auth(request(app).delete(p)),
    get: (p) => auth(request(app).get(p)),
  };
}

const INELIGIBLE_ROLES = ['PATIENT', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF'];
const ELIGIBLE_ROLES = ['ADMIN', 'CMO', 'MEDICAL_SUPERINTENDENT'];

describe('PHI break-glass endpoints — RBAC', () => {
  describe.each(INELIGIBLE_ROLES)('ineligible role %s', (role) => {
    test('POST activate → 403', async () => {
      const res = await client(role).post(BREAK_GLASS_PATH, {
        patient_uid: '11111111-1111-4111-8111-111111111111',
        reason: 'Emergency cross-team access for this patient',
      });
      expect(res.statusCode).toBe(403);
    });

    test('GET list → 403', async () => {
      const res = await client(role).get(BREAK_GLASS_PATH);
      expect(res.statusCode).toBe(403);
    });

    test('DELETE revoke → 403', async () => {
      const res = await client(role).delete(`${BREAK_GLASS_PATH}/1`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe.each(ELIGIBLE_ROLES)('eligible role %s', (role) => {
    test('POST activate PASSES RBAC (not 401/403)', async () => {
      // Deliberately too-short reason → handler returns 400 (validation),
      // which proves the request got PAST the RBAC gate to the handler.
      const res = await client(role).post(BREAK_GLASS_PATH, {
        patient_uid: '11111111-1111-4111-8111-111111111111',
        reason: 'short',
      });
      expect([401, 403]).not.toContain(res.statusCode);
      expect(res.statusCode).toBe(400);
    });

    test('GET list PASSES RBAC (not 401/403)', async () => {
      const res = await client(role).get(BREAK_GLASS_PATH);
      expect([401, 403]).not.toContain(res.statusCode);
    });
  });
});
