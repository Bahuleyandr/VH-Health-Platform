// src/tests/infrastructureGateMountScope.test.js
//
// Regression pin for the dalekdefender 2026-08-21 production lockout:
// `requireProductionInfrastructureAdmin` was mounted as
//   app.use('/api/v1', requireProductionInfrastructureAdmin, infrastructureRoutes)
// Express runs mount middleware for EVERY '/api/v1/*' request — before knowing
// whether the router matches — so in production the admin-tier RBAC inside the
// gate returned `{ success:false, error:'Forbidden' }` for every non-admin role
// on the whole API (staff app, patient app, everything except SUPER_ADMIN).
// Dev/test never saw it because the gate no-ops outside production, so every
// CI lane stayed green.
//
// Two pins:
//  1. Structural — the gate must not exist at app level; it must ride each
//     infrastructure sub-mount (/debug, /api-docs, /version, /rbac).
//  2. Behavioral — the gate reads NODE_ENV per request, so we flip to
//     production for a request window and assert a DOCTOR token is NOT met
//     with the gate's Forbidden on a clinical route, while /version still is.

import request from 'supertest';
import app from '../app.js';
import infrastructureRouter from '../routes/infrastructure/index.js';
import { requireProductionInfrastructureAdmin } from '../middleware/infrastructureAccessMiddleware.js';
import { generateToken } from '../utils/jwtUtils.js';
import { ensureTestIdentity } from './testClient.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const TEST_TENANT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

const tokenFor = (role, id, claims = {}) => generateToken({
  uid: `55555555-5555-4555-8555-${String(id).padStart(12, '0')}`,
  id,
  role,
  tenant_id: TEST_TENANT_ID,
  ...claims,
});

// Authentication now fails closed when a token's subject does not resolve to a
// live identity row, and this suite synthesises its uids from an id rather than
// using fixed literals — so the subjects have to be seeded before any request,
// or every case 401s before reaching the gate it is testing.
const uidFor = (id) => `55555555-5555-4555-8555-${String(id).padStart(12, '0')}`;

beforeAll(async () => {
  for (const id of [5, 6100, 6200, 6300, 6400, 6500, 6501, 6600]) {
    await ensureTestIdentity(uidFor(id));
  }
});

const doctorToken = tokenFor('DOCTOR', 5);

const postWithToken = (path, token) => request(app)
  .post(path)
  .set('x-api-key', API_KEY)
  .set('x-forwarded-proto', 'https')
  .set('Authorization', `Bearer ${token}`)
  .send({});

const roleAssignmentPaths = [
  '/api/v1/rbac/assign-role',
  '/api/v1/rbac/bulk-assign',
];

function stackOf(routerLike) {
  const r = routerLike?.stack ? routerLike : (routerLike?.router ?? routerLike?._router);
  return r?.stack ?? [];
}

// Express 5 layers carry a `matchers` array (Express 4 exposed `regexp`).
function layerMatches(layer, path) {
  if (layer.regexp) return layer.regexp.test(path);
  if (Array.isArray(layer.matchers)) {
    return layer.matchers.some((m) => {
      try {
        return Boolean(m(path));
      } catch {
        return false;
      }
    });
  }
  return false;
}

describe('infrastructure admin gate mount scope', () => {
  it('is not mounted at app level (would gate the entire /api/v1 surface)', () => {
    const offenders = stackOf(app).filter(
      (layer) => layer.handle === requireProductionInfrastructureAdmin,
    );
    expect(offenders).toEqual([]);
  });

  it('rides every admin-only infrastructure sub-mount', () => {
    const infraPaths = ['/debug', '/api-docs', '/version'];
    for (const path of infraPaths) {
      const gated = stackOf(infrastructureRouter).some(
        (layer) => layer.handle === requireProductionInfrastructureAdmin && layerMatches(layer, path),
      );
      expect({ path, gated }).toEqual({ path, gated: true });
    }
  });

  it('does NOT ride /rbac — that router tiers its own access, and the mount gate denied the self-service policy reads to every non-admin role in production', () => {
    const gated = stackOf(infrastructureRouter).some(
      (layer) => layer.handle === requireProductionInfrastructureAdmin && layerMatches(layer, '/rbac'),
    );
    expect(gated).toBe(false);
  });

  describe('behavior with NODE_ENV=production (gate reads it per request)', () => {
    const savedNodeEnv = process.env.NODE_ENV;
    const savedRls = process.env.AUTH_ENFORCE_TENANT_RLS;

    beforeAll(() => {
      process.env.NODE_ENV = 'production';
      // Explicit false wins over the NODE_ENV=production default; keeps the
      // RLS auto-wrap out of a DB-less middleware test.
      process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
    });

    afterAll(() => {
      process.env.NODE_ENV = savedNodeEnv;
      if (savedRls === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
      else process.env.AUTH_ENFORCE_TENANT_RLS = savedRls;
    });

    it('does not intercept a clinical route for a DOCTOR', async () => {
      const res = await request(app)
        .get('/api/v1/wards')
        .set('x-api-key', API_KEY)
        .set('x-forwarded-proto', 'https')
        .set('Authorization', `Bearer ${doctorToken}`);
      // Pre-fix this was the gate's exact deny. Post-fix the request reaches
      // the real wards chain (whose own RBAC admits DOCTOR); without a DB it
      // may 500, which is fine — the pin is only that the gate never fires.
      expect({ status: res.status, error: res.body?.error }).not.toEqual({
        status: 403,
        error: 'Forbidden',
      });
    });

    it('still denies a DOCTOR on the infrastructure namespace', async () => {
      const res = await request(app)
        .get('/api/v1/version')
        .set('x-api-key', API_KEY)
        .set('x-forwarded-proto', 'https')
        .set('Authorization', `Bearer ${doctorToken}`);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    });

    it('lets a DOCTOR read the self-service rbac tier (the mount gate used to 403 this in production)', async () => {
      const res = await request(app)
        .get('/api/v1/rbac/my-role')
        .set('x-api-key', API_KEY)
        .set('x-forwarded-proto', 'https')
        .set('Authorization', `Bearer ${doctorToken}`);
      // The rbac router self-authenticates and tiers per route; without a DB
      // row this may 404/500, but it must never be the infra gate's bare deny.
      expect({ status: res.status, error: res.body?.error }).not.toEqual({
        status: 403,
        error: 'Forbidden',
      });
    });

    it.each(roleAssignmentPaths)('keeps HR_STAFF below the production role-mutation ceiling on %s', async (path) => {
      const res = await postWithToken(path, tokenFor('HR_STAFF', 6100));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    });

    it.each(roleAssignmentPaths)('lets ADMIN reach validation without requiring a SUPER_ADMIN MFA claim on %s', async (path) => {
      const res = await postWithToken(path, tokenFor('ADMIN', 6200));
      expect(res.status).toBe(400);
      expect(res.body.code).not.toBe('SUPER_ADMIN_MFA_REQUIRED');
    });

    it.each([
      ['missing', {}],
      ['false', { mfa: false }],
    ])('denies a SUPER_ADMIN with an %s MFA claim on both role-assignment routes', async (_label, claims) => {
      const token = tokenFor('SUPER_ADMIN', 6300, claims);
      for (const path of roleAssignmentPaths) {
        const res = await postWithToken(path, token);
        expect({ path, status: res.status, code: res.body?.code }).toEqual({
          path,
          status: 403,
          code: 'SUPER_ADMIN_MFA_REQUIRED',
        });
      }
    });

    it.each(roleAssignmentPaths)('lets a stepped-up SUPER_ADMIN reach validation on %s', async (path) => {
      const res = await postWithToken(path, tokenFor('SUPER_ADMIN', 6400, { mfa: true }));
      expect(res.status).toBe(400);
      expect(res.body.code).not.toBe('SUPER_ADMIN_MFA_REQUIRED');
    });

    it('applies the same SUPER_ADMIN step-up boundary to mass role mutation', async () => {
      const path = '/api/v1/rbac/admin/mass-role-update';
      const blocked = await postWithToken(path, tokenFor('SUPER_ADMIN', 6500, { mfa: false }));
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('SUPER_ADMIN_MFA_REQUIRED');

      const steppedUp = await postWithToken(path, tokenFor('SUPER_ADMIN', 6501, { mfa: true }));
      expect(steppedUp.status).toBe(400);
      expect(steppedUp.body.code).not.toBe('SUPER_ADMIN_MFA_REQUIRED');
    });
  });

  describe('behavior outside production', () => {
    const savedNodeEnv = process.env.NODE_ENV;

    beforeAll(() => {
      process.env.NODE_ENV = 'test';
    });

    afterAll(() => {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    });

    it.each(roleAssignmentPaths)('preserves the lower-environment HR_STAFF assignment path on %s', async (path) => {
      const res = await postWithToken(path, tokenFor('HR_STAFF', 6600));
      expect(res.status).toBe(400);
      expect(res.body.code).not.toBe('SUPER_ADMIN_MFA_REQUIRED');
    });
  });
});
