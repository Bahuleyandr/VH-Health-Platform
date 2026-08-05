import { jest } from '@jest/globals';

const requireRoleMock = jest.fn((...roles) => {
  const middleware = (_req, _res, next) => next();
  middleware.allowedRoles = roles;
  return middleware;
});

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: requireRoleMock,
}));

jest.unstable_mockModule('../../controllers/downtime/externalRecoveryOperabilityController.js', () => ({
  authorizeResume: (_req, res) => res.status(200).json({ action: 'resume' }),
  listWorkbench: (_req, res) => res.status(200).json({ action: 'workbench' }),
  registerOffset: (_req, res) => res.status(200).json({ action: 'register' }),
}));

const { ADMIN_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');
const { default: router } = await import('../../routes/admin/externalRecoveryOperabilityRoutes.js');

function registeredRoutes(expressRouter) {
  return expressRouter.stack
    .filter(layer => layer.route)
    .map(layer => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods)
        .filter(method => layer.route.methods[method])
        .sort(),
    }));
}

describe('externalRecoveryOperabilityRoutes', () => {
  it('reasserts the exact platform-admin RBAC set at this command surface', () => {
    expect(ADMIN_ROUTE_ROLES).toEqual(['SUPER_ADMIN', 'ADMIN']);
    expect(requireRoleMock).toHaveBeenCalledTimes(1);
    expect(requireRoleMock).toHaveBeenCalledWith('SUPER_ADMIN', 'ADMIN');
  });

  it('exposes only the per-item workbench, registration, and resume commands', () => {
    expect(registeredRoutes(router)).toEqual([
      { path: '/workbench', methods: ['get'] },
      { path: '/offsets', methods: ['post'] },
      { path: '/offsets/:offsetId/resume-authorizations', methods: ['post'] },
    ]);
    const paths = registeredRoutes(router).map(route => route.path);
    expect(paths).not.toContain('/offsets/resume-authorizations');
    expect(paths.some(path => path.includes('bulk'))).toBe(false);
    expect(paths.some(path => path.includes('activate'))).toBe(false);
  });
});
