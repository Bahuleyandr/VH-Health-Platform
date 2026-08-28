import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222';
const ROUTE = '/api/v1/pharmacy-orders/ward-indents/notification-coverage/recover';

const sweepWardIndentNotificationCoverage = jest.fn();
const logAudit = jest.fn();
const claimIdempotencyKey = jest.fn();
const finaliseIdempotencyKey = jest.fn();
const releaseIdempotencyKey = jest.fn();
const phiAccessMiddleware = jest.fn((_req, _res, next) => next());
const phiAccessLogger = jest.fn(() => phiAccessMiddleware);
const recordClinicalAuditEvent = jest.fn(() => Promise.resolve());
const logSecurityEvent = jest.fn();

jest.unstable_mockModule('../../services/ipd/wardIndentObligationService.js', () => ({
  sweepWardIndentNotificationCoverage,
}));

const ipdSupportExports = [
  'approveWardIndent',
  'approveWardIndentSubstitution',
  'cancelWardIndent',
  'closeWardIndent',
  'createWardIndent',
  'getWardIndent',
  'issueWardIndent',
  'listWardIndentInventoryCandidates',
  'listWardIndentPage',
  'markWardIndentShortSupply',
  'proposeWardIndentSubstitution',
  'receiveWardIndent',
  'reconcileWardIndent',
  'recordWardIndentControlledHandoff',
  'rejectWardIndent',
  'rejectWardIndentSubstitution',
  'reportWardIndentDiscrepancy',
  'requestWardIndentReturn',
  'reserveWardIndent',
];
jest.unstable_mockModule('../../services/ipd/ipdSupportService.js', () => (
  Object.fromEntries(ipdSupportExports.map((name) => [name, jest.fn()]))
));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('Tenant context required');
    return tenantId;
  },
  resolveTenantOrThrow: (req) => {
    if (!req?.tenantId) throw new Error('Tenant context required');
    return req.tenantId;
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent,
}));

jest.unstable_mockModule('../../services/idempotency/idempotencyService.js', () => ({
  claimIdempotencyKey,
  finaliseIdempotencyKey,
  hashRequestBody: (body) => JSON.stringify(body ?? {}),
  isValidIdempotencyKey: (key) => (
    typeof key === 'string'
    && /^[A-Za-z0-9_:.-]{1,200}$/.test(key)
  ),
  releaseIdempotencyKey,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit }));
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({ logSecurityEvent }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger,
}));
jest.unstable_mockModule('../../routes/pharmacy/wardIndentPatientGuards.js', () => ({
  wardIndentCreateGuard: () => (_req, _res, next) => next(),
  wardIndentListGuard: () => (_req, _res, next) => next(),
  wardIndentRowGuard: () => (_req, _res, next) => next(),
}));

const { default: router } = await import('../../routes/pharmacy/wardIndentRoutes.js');

function buildApp({
  role = 'PHARMACY_INCHARGE',
  deviceType = 'desktop',
  tenantId = TENANT,
  actorUid = ACTOR,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'ward-coverage-route-request';
    req.tenantId = tenantId;
    req.user = {
      uid: actorUid,
      role,
      rawRole: role,
      deviceType,
    };
    next();
  });
  app.use('/api/v1/pharmacy-orders/ward-indents', router);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  });
  return app;
}

const SUMMARY = Object.freeze({
  scanned: 6,
  recovered: 2,
  held: 1,
  awaitingRecipients: 3,
  recoveredTaskIds: [41, 42],
  heldTaskIds: [43],
  limit: 80,
});

beforeEach(() => {
  jest.clearAllMocks();
  sweepWardIndentNotificationCoverage.mockResolvedValue({ ...SUMMARY });
  logAudit.mockResolvedValue(undefined);
  claimIdempotencyKey.mockResolvedValue({ state: 'claimed', id: 71 });
  finaliseIdempotencyKey.mockResolvedValue(undefined);
  releaseIdempotencyKey.mockResolvedValue(undefined);
});

describe('ward-indent notification-coverage operator recovery route', () => {
  test.each([
    'PHARMACIST',
    'NURSING_STAFF',
    'IP_STAFF_NURSE',
    'ICU_NURSE',
    'DOCTOR',
  ])('denies non-senior role %s before claiming or sweeping', async (role) => {
    const response = await request(buildApp({ role }))
      .post(ROUTE)
      .set('Idempotency-Key', `coverage-denied-${role}`)
      .send({ limit: 10 });

    expect(response.status).toBe(403);
    expect(claimIdempotencyKey).not.toHaveBeenCalled();
    expect(sweepWardIndentNotificationCoverage).not.toHaveBeenCalled();
    expect(logSecurityEvent).toHaveBeenCalledWith(
      'PERMISSION_DENIED',
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  test('denies mobile posture before claiming or sweeping', async () => {
    const response = await request(buildApp({ deviceType: 'mobile' }))
      .post(ROUTE)
      .set('Idempotency-Key', 'coverage-mobile-denied')
      .send({ limit: 10 });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CLINICAL_WRITE_DESKTOP_ONLY');
    expect(claimIdempotencyKey).not.toHaveBeenCalled();
    expect(sweepWardIndentNotificationCoverage).not.toHaveBeenCalled();
    expect(recordClinicalAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      actorUid: ACTOR,
      action: 'mobile_clinical_write.denied',
    }));
  });

  test('requires a stable Idempotency-Key before sweeping', async () => {
    const response = await request(buildApp()).post(ROUTE).send({ limit: 10 });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Idempotency-Key header is required for this endpoint');
    expect(claimIdempotencyKey).not.toHaveBeenCalled();
    expect(sweepWardIndentNotificationCoverage).not.toHaveBeenCalled();
  });

  test('binds tenant and actor to authentication and returns the full governed summary', async () => {
    const response = await request(buildApp())
      .post(ROUTE)
      .set('Idempotency-Key', 'coverage-operator-run-1')
      .send({
        limit: '80',
        tenant_id: OTHER_TENANT,
        actor_uid: OTHER_ACTOR,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: 'Ward indent notification coverage recovery completed',
      data: SUMMARY,
      requestId: 'ward-coverage-route-request',
    });
    expect(sweepWardIndentNotificationCoverage).toHaveBeenCalledTimes(1);
    expect(sweepWardIndentNotificationCoverage).toHaveBeenCalledWith({
      tenantId: TENANT,
      actorUid: ACTOR,
      limit: 80,
    });
    expect(claimIdempotencyKey).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      userUid: ACTOR,
      requestKey: 'coverage-operator-run-1',
      requestMethod: 'POST',
      requestPath: ROUTE,
    }));
    expect(phiAccessMiddleware).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      'WARD_INDENT_NOTIFICATION_COVERAGE_RECOVERY_RUN',
      {
        scanned: 6,
        recovered: 2,
        held: 1,
        awaiting_recipients: 3,
        bounded_limit: 80,
      },
      {
        resource: 'ward_indent_notification_coverage',
        resourceId: 'coverage-operator-run-1',
      },
    );
  });

  test('replays the cached response without sweeping or auditing twice', async () => {
    const app = buildApp();
    const key = 'coverage-operator-replay-1';
    const first = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', key)
      .send({ limit: 80 });
    expect(first.status).toBe(200);

    claimIdempotencyKey.mockResolvedValueOnce({
      state: 'replay',
      response_status: first.status,
      response_body: first.body,
    });
    const replay = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', key)
      .send({ limit: 80 });

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(sweepWardIndentNotificationCoverage).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  test.each([0, -1, 101, 1.5, 'not-a-limit'])(
    'rejects out-of-contract limit %p',
    async (limit) => {
      const response = await request(buildApp())
        .post(ROUTE)
        .set('Idempotency-Key', `coverage-invalid-limit-${String(limit)}`)
        .send({ limit });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('WARD_INDENT_COVERAGE_RECOVERY_LIMIT_INVALID');
      expect(sweepWardIndentNotificationCoverage).not.toHaveBeenCalled();
    },
  );
});
