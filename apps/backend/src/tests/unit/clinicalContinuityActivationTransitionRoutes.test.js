import { jest } from '@jest/globals';

const requireRoleMock = jest.fn((...roles) => {
  const middleware = (_req, _res, next) => next();
  middleware.allowedRoles = roles;
  return middleware;
});

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: requireRoleMock,
}));

jest.unstable_mockModule(
  '../../controllers/downtime/clinicalContinuityActivationTransitionController.js',
  () => ({
    countersignAdvance: (_req, res) => res.status(200).json({ action: 'countersign' }),
    createAdvanceIntent: (_req, res) => res.status(200).json({ action: 'intent' }),
    getState: (_req, res) => res.status(200).json({ action: 'state' }),
    haltActivation: (_req, res) => res.status(200).json({ action: 'halt' }),
  }),
);

const { ALL_STAFF_MESSAGING_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');
const { default: router } = await import(
  '../../routes/downtime/clinicalContinuityActivationTransitionRoutes.js'
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

describe('clinicalContinuityActivationTransitionRoutes', () => {
  test('admits authenticated staff only before exact roster authorization', () => {
    expect(requireRoleMock).toHaveBeenCalledTimes(1);
    expect(requireRoleMock).toHaveBeenCalledWith(...ALL_STAFF_MESSAGING_ROUTE_ROLES);
  });

  test('exposes state, two authenticated advance steps, and one-key halt', () => {
    expect(registeredRoutes(router)).toEqual([
      { path: '/facilities/:facilityId/state', methods: ['get'] },
      { path: '/facilities/:facilityId/advance-intents', methods: ['post'] },
      {
        path: '/facilities/:facilityId/advance-intents/:intentEventId/countersign',
        methods: ['post'],
      },
      { path: '/facilities/:facilityId/halt', methods: ['post'] },
    ]);
  });
});
