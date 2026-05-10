import app from '../../app.js';

function hasMountedRoute(mountPath, routePath, method = 'get') {
  const targetPath = `${mountPath}${routePath}`;
  return app.router.stack.some((layer) => {
    const matchesMount = layer.matchers?.some((matcher) => {
      const match = matcher(targetPath);
      return match?.path === mountPath;
    });
    if (!matchesMount || !layer.handle?.stack) return false;
    return layer.handle.stack.some((routeLayer) =>
      routeLayer.route?.path === routePath &&
      routeLayer.route?.methods?.[method],
    );
  });
}

describe('patient self-service namespace', () => {
  it('mounts the mobile patient read routes under /api/v1/patient', () => {
    expect(hasMountedRoute('/api/v1/patient', '/appointments')).toBe(true);
    expect(hasMountedRoute('/api/v1/patient', '/records')).toBe(true);
    expect(hasMountedRoute('/api/v1/patient', '/prescriptions')).toBe(true);
  });
});
