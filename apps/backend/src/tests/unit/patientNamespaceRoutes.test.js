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

function hasMountedMiddleware(mountPath, predicate) {
  const targetPath = `${mountPath}/__probe__`;
  return app.router.stack.some((layer) => {
    const matchesMount = layer.matchers?.some((matcher) => {
      const match = matcher(targetPath);
      return match?.path === mountPath;
    });
    return matchesMount && predicate(layer.handle);
  });
}

function firstExactMountIndex(mountPath) {
  const targetPath = `${mountPath}/__probe__`;
  return app.router.stack.findIndex((layer) =>
    layer.matchers?.some((matcher) => matcher(targetPath)?.path === mountPath),
  );
}

describe('patient self-service namespace', () => {
  it('mounts the mobile patient read routes under /api/v1/patient', () => {
    expect(hasMountedRoute('/api/v1/patient', '/appointments')).toBe(true);
    expect(hasMountedRoute('/api/v1/patient', '/records')).toBe(true);
    expect(hasMountedRoute('/api/v1/patient', '/prescriptions')).toBe(true);
  });
});

describe('staff patient lookup namespace', () => {
  it('logs PHI access for staff patient demographic search/create/update', () => {
    expect(
      hasMountedMiddleware(
        '/api/v1/patients',
        (handle) => handle?.phiRecordType === 'PATIENT_DEMOGRAPHICS',
      ),
    ).toBe(true);
  });

  it('logs PHI access for the global patient/doctor search surface', () => {
    expect(
      hasMountedMiddleware(
        '/api/v1/search',
        (handle) => handle?.phiRecordType === 'PATIENT_SEARCH',
      ),
    ).toBe(true);
  });
});

describe('staff workbench PHI namespaces', () => {
  it('logs appointment queue and OP booking PHI access', () => {
    expect(
      hasMountedMiddleware(
        '/api/v1/appointments',
        (handle) => handle?.phiRecordType === 'APPOINTMENT',
      ),
    ).toBe(true);
  });

  it('logs admission workbench and command-board PHI access', () => {
    expect(
      hasMountedMiddleware(
        '/api/v1/admissions',
        (handle) => handle?.phiRecordType === 'ADMISSION',
      ),
    ).toBe(true);
  });

  it('logs admission occupancy dashboard PHI access', () => {
    expect(
      hasMountedMiddleware(
        '/api/v1/admissions/occupancy',
        (handle) => handle?.phiRecordType === 'ADMISSION_OCCUPANCY',
      ),
    ).toBe(true);
  });

  it('logs billing v2 invoice and payment PHI access', () => {
    expect(
      hasMountedMiddleware(
        '/api/v1/billing/v2',
        (handle) => handle?.phiRecordType === 'BILLING_INVOICE',
      ),
    ).toBe(true);
  });

  it('mounts EMR timeline before the broad EMR gate so reception can open selected patients', () => {
    expect(firstExactMountIndex('/api/v1/emr/timeline')).toBeGreaterThan(-1);
    expect(firstExactMountIndex('/api/v1/emr')).toBeGreaterThan(-1);
    expect(firstExactMountIndex('/api/v1/emr/timeline')).toBeLessThan(
      firstExactMountIndex('/api/v1/emr'),
    );
  });

  it('mounts billing v2 before legacy billing so front-office requests reach the v2 gate', () => {
    expect(firstExactMountIndex('/api/v1/billing/v2')).toBeGreaterThan(-1);
    expect(firstExactMountIndex('/api/v1/billing')).toBeGreaterThan(-1);
    expect(firstExactMountIndex('/api/v1/billing/v2')).toBeLessThan(
      firstExactMountIndex('/api/v1/billing'),
    );
  });

  it('logs clinical AI clinical-use PHI access for Staff workbench routes', () => {
    expect(
      hasMountedMiddleware(
        '/api/v1/clinical-ai/clinical',
        (handle) => handle?.phiRecordType === 'CLINICAL_AI',
      ),
    ).toBe(true);
  });
});
