import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const TENANT = '20000000-0000-4000-8000-000000000001';
const ACTOR = '20000000-0000-4000-8000-000000000002';

const orderFindFirstMock = jest.fn();
const actorFindFirstMock = jest.fn();
const retryMarMock = jest.fn();
const verifyOrderMock = jest.fn();
let idempotencyInvocations = 0;
let cachedResponse = null;

const { ACCESS_POLICY_CODES } = await import('../../services/security/accessPolicyRegistry.js');

function passThrough() {
  return (_req, _res, next) => next();
}

jest.unstable_mockModule('../../config/routeWrapper.js', () => ({
  wrapAutoRBAC: jest.fn()
}));
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: passThrough,
  patientAccessGuardForResource: passThrough
}));
jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  enforceStaffClinicalWriteDevicePosture: passThrough(),
  rejectMobileClinicalWrite: passThrough()
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (req, res, next) => {
    idempotencyInvocations += 1;
    if (cachedResponse) return res.status(cachedResponse.status).json(cachedResponse.body);
    req.idempotencyClaim = {
      id: 'cached-claim',
      requestKey: req.get('idempotency-key'),
      requestBodyHash: 'cached-fingerprint'
    };
    return next();
  }
}));
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest: jest.fn(async () => ({ allowed: true })),
  patientAccessErrorPayload: jest.fn(() => ({ success: false }))
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    clinical_orders: { findFirst: orderFindFirstMock },
    users: { findFirst: actorFindFirstMock }
  }
}));
jest.unstable_mockModule('../../services/emr/orderEntryService.js', () => ({
  canVerifyMedicationOrderRole: role =>
    ['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST'].includes(
      String(role || '').toUpperCase()
    ),
  canVerifyClinicalOrderType: (role, orderType) =>
    ['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST'].includes(
      String(role || '').toUpperCase()
    ) && orderType === 'medication',
  canTerminalMedicationOrderRole: role =>
    ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'].includes(
      String(role || '').toUpperCase()
    ),
  retryMedicationOrderMarScheduling: retryMarMock,
  verifyOrder: verifyOrderMock
}));
jest.unstable_mockModule('../../services/emr/orderSetGovernanceService.js', () => ({}));
jest.unstable_mockModule('../../services/emr/orderSetContentStudioSettingsService.js', () => ({
  isContentStudioEnabled: jest.fn(async () => false),
  setContentStudioEnabled: jest.fn()
}));
jest.unstable_mockModule('../../services/idempotency/idempotencyService.js', () => ({
  hashRequestBody: jest.fn(() => 'request-hash')
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn()
}));

const { default: orderRouter } = await import('../../routes/emr/orderRoutes.js');

function mountedOrderApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'authority-route-request';
    req.user = { uid: ACTOR, role, deviceType: 'desktop' };
    req.tenantId = TENANT;
    next();
  });
  app.use('/emr', orderRouter);
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message
    })
  );
  return app;
}

describe('mounted clinical-order authority before receipt replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    idempotencyInvocations = 0;
    cachedResponse = null;
    orderFindFirstMock.mockResolvedValue({ order_type: 'medication' });
    retryMarMock.mockResolvedValue({ order_id: 41, status: 'scheduled' });
    verifyOrderMock.mockResolvedValue({ id: 41, status: 'verified' });
  });

  test.each([
    ['inactive', null],
    ['deleted', null],
    ['role-changed', { role: 'NURSING_STAFF' }]
  ])('MAR recovery denies a %s actor before an exact cached response', async (_case, actor) => {
    actorFindFirstMock.mockResolvedValue(actor);
    cachedResponse = {
      status: 200,
      body: { success: true, data: { order_id: 41, status: 'scheduled' } }
    };
    const response = await request(mountedOrderApp('DOCTOR'))
      .post('/emr/orders/41/retry-mar-scheduling')
      .set('Idempotency-Key', 'mar-recovery-cached')
      .send({});
    expect(response.statusCode).toBe(403);
    expect(idempotencyInvocations).toBe(0);
    expect(retryMarMock).not.toHaveBeenCalled();
  });

  test.each([
    ['inactive', null],
    ['deleted', null],
    ['role-changed', { role: 'NURSING_STAFF' }]
  ])('verification denies a %s actor before an exact cached response', async (_case, actor) => {
    actorFindFirstMock.mockResolvedValue(actor);
    cachedResponse = {
      status: 200,
      body: { success: true, data: { id: 41, status: 'verified' } }
    };
    const response = await request(mountedOrderApp('PHARMACY_STAFF'))
      .put('/emr/orders/41/verify')
      .set('Idempotency-Key', 'verify-cached')
      .send({});
    expect(response.statusCode).toBe(403);
    expect(idempotencyInvocations).toBe(0);
    expect(verifyOrderMock).not.toHaveBeenCalled();
  });

  test('active authoritative actors reach the transaction with the receipt claim', async () => {
    actorFindFirstMock.mockResolvedValue({ role: 'DOCTOR' });
    const recovery = await request(mountedOrderApp('DOCTOR'))
      .post('/emr/orders/41/retry-mar-scheduling')
      .set('Idempotency-Key', 'mar-recovery-live')
      .send({});
    expect(recovery.statusCode).toBe(200);
    expect(retryMarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        orderId: 41,
        actorUid: ACTOR,
        commandKey: 'mar-recovery-live',
        httpIdempotencyClaimId: 'cached-claim'
      })
    );

    actorFindFirstMock.mockResolvedValue({ role: 'PHARMACY_STAFF' });
    const verification = await request(mountedOrderApp('PHARMACY_STAFF'))
      .put('/emr/orders/41/verify')
      .set('Idempotency-Key', 'verify-live')
      .send({});
    expect(verification.statusCode).toBe(200);
    expect(verifyOrderMock).toHaveBeenCalledWith(
      41,
      ACTOR,
      expect.objectContaining({
        tenantId: TENANT,
        actorRole: 'PHARMACY_STAFF',
        idempotencyKey: 'verify-live',
        httpIdempotencyClaimId: 'cached-claim'
      })
    );
  });
});
