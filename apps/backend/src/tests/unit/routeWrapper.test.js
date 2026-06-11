import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';

describe('wrapAutoRBAC fail-closed policy', () => {
  const handler = (_req, res) => res.status(204).end();

  it('throws during registration when a route uses an unknown RBAC config key', () => {
    const router = express.Router();

    expect(() => wrapAutoRBAC(router, 'missingSecurityPolicy', {
      get: [['/sensitive', handler]],
    })).toThrow(/Missing RBAC config key: missingSecurityPolicy/);
  });

  it('throws when protected route entries map to an explicitly empty role list', () => {
    const router = express.Router();

    expect(() => wrapAutoRBAC(router, 'authRoutes', {
      get: [['/must-not-use-empty-policy', handler]],
    })).toThrow(/has no roles for protected routes/);
  });

  it('allows configured wrapper keys that only wrap an already-mounted module shell', () => {
    const router = express.Router();

    expect(() => wrapAutoRBAC(router, 'authenticationModule', {}, {
      requireUID: false,
      requirePhone: false,
    })).not.toThrow();
  });
});
