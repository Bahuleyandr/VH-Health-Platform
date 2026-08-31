import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

const requireRoleMock = jest.fn((...roles) => {
  const middleware = (_req, _res, next) => next();
  middleware.allowedRoles = roles;
  return middleware;
});

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: requireRoleMock,
}));
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/sanitizeMiddleware.js', () => ({
  sanitizeAllBodyStrings: (_req, _res, next) => next(),
}));
jest.unstable_mockModule(
  '../../services/clinical/clinicalAlertDeliveryObligationService.js',
  () => ({
    getClinicalAlertRecoveryCase: jest.fn(),
    listClinicalAlertRecoveryCases: jest.fn(),
    retryClinicalAlertRecoveryCase: jest.fn(),
    supersedeClinicalAlertRecoveryCase: jest.fn(),
  }),
);

const { ADMIN_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');
const { default: router } = await import(
  '../../routes/admin/clinicalAlertDeliveryRecoveryRoutes.js'
);

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

describe('clinicalAlertDeliveryRecoveryRoutes', () => {
  test('reasserts only the platform-administrator role policy', () => {
    expect(ADMIN_ROUTE_ROLES).toEqual(['SUPER_ADMIN', 'ADMIN']);
    expect(requireRoleMock).toHaveBeenCalledTimes(1);
    expect(requireRoleMock).toHaveBeenCalledWith('SUPER_ADMIN', 'ADMIN');
  });

  test('exposes exact read, retry, and supersession operations', () => {
    expect(registeredRoutes(router)).toEqual([
      { path: '/recovery-cases', methods: ['get'] },
      { path: '/recovery-cases/:caseId', methods: ['get'] },
      { path: '/recovery-cases/:caseId/retry', methods: ['post'] },
      { path: '/recovery-cases/:caseId/supersede', methods: ['post'] },
    ]);
  });

  test('is mounted and documented without operator-supplied clinical intent', () => {
    const indexSource = readFileSync(
      new URL('../../routes/admin/index.js', import.meta.url),
      'utf8',
    );
    const routeSource = readFileSync(
      new URL('../../routes/admin/clinicalAlertDeliveryRecoveryRoutes.js', import.meta.url),
      'utf8',
    );
    const generatedSpec = JSON.parse(readFileSync(
      new URL('../../docs/openapi.json', import.meta.url),
      'utf8',
    ));

    expect(indexSource).toMatch(
      /router\.use\('\/clinical-alert-delivery',\s*clinicalAlertDeliveryRecoveryRoutes\)/,
    );
    expect(routeSource).toContain("fields.length !== 1 || fields[0] !== 'reason'");
    expect(routeSource).not.toMatch(/req\.body\.(recipient|payload|notification_intent)/);
    for (const path of [
      '/api/v1/admin/clinical-alert-delivery/recovery-cases',
      '/api/v1/admin/clinical-alert-delivery/recovery-cases/{caseId}',
      '/api/v1/admin/clinical-alert-delivery/recovery-cases/{caseId}/retry',
      '/api/v1/admin/clinical-alert-delivery/recovery-cases/{caseId}/supersede',
    ]) {
      expect(generatedSpec.paths[path]).toBeDefined();
    }
  });
});
