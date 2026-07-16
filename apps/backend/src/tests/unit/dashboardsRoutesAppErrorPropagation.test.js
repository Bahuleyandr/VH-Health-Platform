import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — admin-dashboards twin of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602 pattern).
//
// dashboardsRoutes.js wraps every handler in a local `wrap()` whose catch
// branch used to call `error(res, err.message, err.statusCode)` with no 4th
// arg (dropping `err.code` / `err.details` from the documented envelope) and
// to relay raw `err.message` on the generic 500. It now delegates to
// responseHelper.relayAppError with this file's generic 'Dashboard error'.
// These tests drive an endpoint over HTTP and assert the response body.

const getDailyOpsSnapshotMock = jest.fn();

// dashboardsRoutes default-imports the prisma singleton (passed through to
// resolveDoctorFilterId on /snapshot/opd-daily) — stub it so the unit test
// never touches a real client.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  prisma: {},
  prismaReadOnly: {},
  setTenant: async (_tenantId, fn) => fn({}),
  circuitBreakerStatus: () => ({}),
}));

jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorFilterId: jest.fn(async () => null),
}));

jest.unstable_mockModule('../../services/dashboards/snapshotService.js', () => ({
  getDailyOpsSnapshot: getDailyOpsSnapshotMock,
}));

jest.unstable_mockModule('../../services/dashboards/teleconsultOpsService.js', () => ({
  getTeleconsultOpsSnapshot: jest.fn(),
}));

jest.unstable_mockModule('../../services/dashboards/metabaseService.js', () => ({}));

jest.unstable_mockModule('../../services/dashboards/analyticsCatalogService.js', () => ({
  listDashboardCatalog: jest.fn(async () => []),
  listDatasetCatalog: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: dashboardsRoutes } = await import('../../routes/dashboards/dashboardsRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/dashboards', dashboardsRoutes);

beforeEach(() => {
  getDailyOpsSnapshotMock.mockReset();
});

describe('dashboards route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    getDailyOpsSnapshotMock.mockRejectedValueOnce(AppError.conflict(
      'Snapshot refresh already running for this tenant',
      'DASHBOARD_SNAPSHOT_REFRESH_IN_PROGRESS',
      { reason: 'refresh_lock' },
    ));

    const response = await request(app).get('/api/v1/dashboards/snapshot/daily-ops');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('DASHBOARD_SNAPSHOT_REFRESH_IN_PROGRESS');
    expect(response.body.details).toEqual({ reason: 'refresh_lock' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // Old wrap relayed `err.message || 'Dashboard error'` — internals leaked
    // on non-prod deployments where sanitize does not genericise 5xx.
    getDailyOpsSnapshotMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'bi_daily_ops')"),
    );

    const response = await request(app).get('/api/v1/dashboards/snapshot/daily-ops');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Dashboard error');
    expect(JSON.stringify(response.body)).not.toContain('Cannot read properties');
  });
});
