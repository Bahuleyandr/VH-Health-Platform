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

const API_KEY = process.env.API_KEY || 'test-api-key';

const doctorToken = generateToken({
  uid: '55555555-5555-4555-8555-555555555555',
  id: 5,
  role: 'DOCTOR',
});

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

  it('rides every infrastructure sub-mount', () => {
    const infraPaths = ['/debug', '/api-docs', '/version', '/rbac'];
    for (const path of infraPaths) {
      const gated = stackOf(infrastructureRouter).some(
        (layer) => layer.handle === requireProductionInfrastructureAdmin && layerMatches(layer, path),
      );
      expect({ path, gated }).toEqual({ path, gated: true });
    }
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
  });
});
