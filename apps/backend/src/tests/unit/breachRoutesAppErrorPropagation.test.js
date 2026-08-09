import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the compliance-breach member of the
// relayAppError sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// breachRoutes.js has four catch blocks guarded by `err.isOperational` whose
// operational branch called `error(res, err.message, err.statusCode)` with no
// 4th arg, dropping `err.code` and `err.details`. These are R6+R2 sites: the
// predicate is KEPT, the operational branch now relays via relayAppError, and
// the non-operational tail (logger + next(err)) stays byte-identical because
// this is a gateway surface where global-handler/Sentry visibility is
// deliberate. The tests pin both halves.

const getBreachTimelineMock = jest.fn();
const reportBreachMock = jest.fn();
const containBreachMock = jest.fn();

jest.unstable_mockModule('../../services/compliance/breachService.js', () => ({
  getBreaches: jest.fn(async () => ({ breaches: [], pagination: {} })),
  getBreachTimeline: getBreachTimelineMock,
  reportBreach: reportBreachMock,
  containBreach: containBreachMock,
  resolveBreach: jest.fn(async () => ({})),
  notifyRegulator: jest.fn(async () => ({})),
  notifyDataSubjects: jest.fn(async () => ({})),
  VALID_SEVERITIES: ['low', 'medium', 'high', 'critical'],
}));
jest.unstable_mockModule('../../services/compliance/dataProcessingActivityService.js', () => ({
  archiveDataProcessingActivity: jest.fn(async () => ({})),
  getDataProcessingActivity: jest.fn(async () => ({})),
  listDataProcessingActivities: jest.fn(async () => []),
  upsertDataProcessingActivity: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/compliance/certificationCockpitService.js', () => ({
  getCertificationCockpit: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/compliance/complianceDashboardService.js', () => ({
  getComplianceDashboard: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/compliance/numberingSeriesService.js', () => ({
  getNextNumber: jest.fn(async () => ({})),
  listNumberingSeries: jest.fn(async () => []),
  upsertNumberingSeries: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/compliance/dataRetentionPolicyService.js', () => ({
  archiveRetentionPolicy: jest.fn(async () => ({})),
  getRetentionForTable: jest.fn(async () => null),
  listDataRetentionPolicies: jest.fn(async () => []),
  upsertDataRetentionPolicy: jest.fn(async () => ({})),
}));
// securityAuditLogger (inside the requireRole denial path) imports the prisma
// singleton; stub it so the suite never touches a DB.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  prismaReadOnly: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
}));

const { default: breachRoutes } = await import('../../routes/compliance/breachRoutes.js');

const forwardedErrors = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // SUPER_ADMIN satisfies the router.use(requireRole(...ADMIN_ROUTE_ROLES))
  // gate that protects the breach lifecycle writes.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'SUPER_ADMIN' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/compliance', breachRoutes);
// Trailing error middleware standing in for the app's global error handler —
// the non-operational tail must still next(err) into it (R2 pin).
app.use((err, _req, res, _next) => {
  forwardedErrors.push(err);
  res.status(500).json({ globalHandler: true });
});

beforeEach(() => {
  getBreachTimelineMock.mockReset();
  reportBreachMock.mockReset();
  containBreachMock.mockReset();
  forwardedErrors.length = 0;
});

describe('breach routes operational branch surfaces AppError code + details', () => {
  test('GET /breach/:id — an AppError carrying code + details forwards both', async () => {
    getBreachTimelineMock.mockRejectedValueOnce(AppError.conflict(
      'Breach record is sealed pending regulator review',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/compliance/breach/12');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Breach record is sealed pending regulator review');
    // The bug: these assertions FAIL on the unmodified catch (both dropped).
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    // Operational errors are handled locally, never forwarded.
    expect(forwardedErrors).toHaveLength(0);
  });

  test('PUT /breach/:id/contain — code without details arrives at the root, no spurious details key', async () => {
    containBreachMock.mockRejectedValueOnce(AppError.notFound(
      'Breach not found for this tenant',
      'BREACH_NOT_FOUND',
    ));

    const response = await request(app)
      .put('/api/v1/compliance/breach/12/contain')
      .send({ containment_actions: 'Rotated credentials and revoked sessions' });

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('BREACH_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });

  test('POST /breach/report — operational AppError relays through the write surface', async () => {
    reportBreachMock.mockRejectedValueOnce(AppError.conflict(
      'A breach with this reference already exists',
      'BREACH_DUPLICATE',
    ));

    const response = await request(app)
      .post('/api/v1/compliance/breach/report')
      .send({
        title: 'Unauthorised PHI export',
        severity: 'high',
        description: 'Unauthorised PHI export detected on the reporting node',
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('BREACH_DUPLICATE');
  });

  test('POST /breach/report — rejects a string PHI flag before calling the service', async () => {
    const response = await request(app)
      .post('/api/v1/compliance/breach/report')
      .send({
        title: 'Unauthorised PHI export',
        severity: 'high',
        description: 'Unauthorised PHI export detected on the reporting node',
        phi_involved: 'false',
      });

    expect(response.statusCode).toBe(400);
    expect(reportBreachMock).not.toHaveBeenCalled();
  });
});

describe('breach routes non-operational tail still forwards to the global handler (R2)', () => {
  test('GET /breach/:id — a programming error is next(err)-forwarded, not relayed', async () => {
    const thrown = new Error("Cannot read properties of undefined (reading 'timeline_rows')");
    getBreachTimelineMock.mockRejectedValueOnce(thrown);

    const response = await request(app).get('/api/v1/compliance/breach/12');

    expect(response.statusCode).toBe(500);
    // The trailing error middleware answered — not the route's catch.
    expect(response.body).toEqual({ globalHandler: true });
    expect(forwardedErrors).toHaveLength(1);
    expect(forwardedErrors[0]).toBe(thrown);
  });
});
