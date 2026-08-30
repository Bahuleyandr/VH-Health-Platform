import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Controller-layer contract regression — pharmacyOrderController member of
// the relayAppError sweep, driven over HTTP through the REAL
// routes/pharmacy/orderRoutes.js mount (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// confirmOrder's operational branch relayed `err.details` with no 4th-arg
// code (dropping err.code entirely) behind the file's own
// `err && typeof err.statusCode === 'number'` predicate. The predicate is
// kept verbatim; the body now relays via responseHelper.relayAppError. The
// Postgres-constraint (23xxx → 400) branch and the generic-500 tail are kept
// byte-identical.

const prismaQueryMock = jest.fn();
const assertVerificationClearedMock = jest.fn(async () => {});
const assertVerificationClearedTxMock = jest.fn(async () => {});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQueryMock },
  setTenantTx: jest.fn(),
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(async () => 'key'),
  getSignedFileUrl: jest.fn(async () => 'https://r2.example/key'),
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../controllers/delivery/deliveryTrackingController.js', () => ({
  calculateETA: jest.fn(() => null),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  assertPharmacyCapForDispenseTx: jest.fn(async () => ({ message: null })),
  lockCounterFundingSubstitutionAuthorityTx: jest.fn(async () => ({})),
  lockPharmacyFundingAuthorityTx: jest.fn(async () => ({})),
  releasePharmacyCapReservationTx: jest.fn(async () => null),
  resolveAuthoritativeCounterFundingTx: jest.fn(async () => ({
    fundedAmount: 0,
    fundingSource: null,
    fundingReference: null,
  })),
  resolvePharmacyFundingPatientUidTx: jest.fn(async () => '11111111-1111-4111-8111-111111111111'),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  assertPharmacyFacilityGrant: jest.fn(async () => ({
    actor_uid: '11111111-1111-4111-8111-111111111111',
    actor_role: 'PHARMACY_STAFF',
  })),
  pharmacyFacilityActorFromRequest: jest.fn((req) => ({
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
  })),
  requestedPharmacyFacilityId: jest.fn(() => null),
  requireOrderFacility: jest.fn((order) => Number(order.facility_id || 7)),
  resolveOrderPharmacyFacility: jest.fn(async () => ({ id: 7 })),
  resolvePharmacyFacility: jest.fn(async () => ({ id: 7 })),
}));
jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  compensateTerminalPharmacyFundingAuthorityTx: jest.fn(async () => ({ status: 'compensated' })),
  materializePharmacyFundingAuthority: jest.fn(async () => ({ status: 'funded' })),
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitPharmacyOrderEvent: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  assertVerificationCleared: assertVerificationClearedMock,
  assertVerificationClearedTx: assertVerificationClearedTxMock,
  clinicalOrderItemsSha256: jest.fn(() => 'items-sha256'),
  ensurePackBarcode: jest.fn(async () => 'PACK-1'),
  verifyOrder: jest.fn(async () => ({})),
  getPackLabel: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/pharmacy/compositionFeatureService.js', () => ({
  isCompositionSearchEnabled: jest.fn(async () => false),
}));
jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  resolveCompositionIdentitiesByCatalogIds: jest.fn(async () => new Map()),
  enrichMedicationsWithComposition: jest.fn(async (_t, meds) => meds),
}));
jest.unstable_mockModule('../../../scripts/backfill-drug-compositions.mjs', () => ({
  enrichCatalogRowForWrite: jest.fn(async (row) => row),
}));

// Legacy sibling controller mounted by the same routes file.
jest.unstable_mockModule('../../controllers/pharmacy/orderController.js', () => ({
  placeOrder: jest.fn((_req, res) => res.status(200).json({})),
  getOrdersByUID: jest.fn((_req, res) => res.status(200).json({})),
  updateOrderStatus: jest.fn((_req, res) => res.status(200).json({})),
}));

// Route-wrapper middleware chain — pass-throughs keep the test hermetic.
jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  default: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/auditLogger.js', () => ({
  auditLogger: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  dynamicRoleRateLimiter: (_req, _res, next) => next(),
  getRateLimiter: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/identityValidator.js', () => ({
  validateUID: (_req, _res, next) => next(),
  validatePhone: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/sanitizeMiddleware.js', () => ({
  sanitizePharmacyFields: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  validateFileContent: (_req, _res, next) => next(),
  validatePatientUpload: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../validators/pharmacy/orderValidators.js', () => ({
  placeOrderValidation: (_req, _res, next) => next(),
  updateOrderStatusValidation: (_req, _res, next) => next(),
  uidParamValidation: (_req, _res, next) => next(),
}));

// Per-route patient guards (re-audit M mount fix) — pass-through: this suite
// pins controller AppError propagation, not access decisions.
jest.unstable_mockModule('../../routes/pharmacy/pharmacyOrderPatientGuards.js', () => ({
  pharmacyOrderGuard: () => (_req, _res, next) => next(),
  selectOrderPatient: () => async () => null,
  selectPatientByBodyPhone: async () => null,
  selectCounterSalePatient: async () => null,
  selectPatientFromBodyUid: () => null,
  tenantOf: (req) => req.tenantId ?? null,
}));

const { default: pharmacyOrderRoutes } = await import('../../routes/pharmacy/orderRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { id: 7, uid: '11111111-1111-4111-8111-111111111111', role: 'PHARMACY_STAFF' };
  next();
});
app.use('/api/v1/pharmacy', pharmacyOrderRoutes);

beforeEach(() => {
  prismaQueryMock.mockReset();
  assertVerificationClearedMock.mockReset();
  assertVerificationClearedMock.mockResolvedValue(undefined);
});

describe('dispense verification gate preserves its machine-readable code', () => {
  test('ordinary pharmacy staff cannot authorise a TPA cap override', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/71/delivered')
      .set('Idempotency-Key', 'cap-override-authority-71')
      .send({
        cap_override: true,
        cap_override_reason: 'Insurer enhancement is approved offline',
      });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe('TPA_PHARMACY_CAP_OVERRIDE_FORBIDDEN');
    expect(assertVerificationClearedMock).not.toHaveBeenCalled();
  });

  test('PHARMACY_VERIFICATION_REQUIRED is returned at the envelope root', async () => {
    assertVerificationClearedMock.mockRejectedValueOnce(AppError.conflict(
      'Pharmacist clinical verification is required before dispense',
      'PHARMACY_VERIFICATION_REQUIRED',
      {
        clinical_verification_status: 'pending',
        verify_endpoint: '/api/v1/pharmacy/orders/71/verify',
      },
    ));

    const response = await request(app)
      .post('/api/v1/pharmacy/71/delivered')
      .set('Idempotency-Key', 'verification-gate-71')
      .send({});

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('PHARMACY_VERIFICATION_REQUIRED');
    expect(response.body.details).toEqual({
      clinical_verification_status: 'pending',
      verify_endpoint: '/api/v1/pharmacy/orders/71/verify',
    });
    expect(response.body.details).not.toHaveProperty('code');
  });
});

describe('confirmOrder catch relays AppError code + details (predicate kept)', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    prismaQueryMock.mockRejectedValueOnce(AppError.conflict(
      'Order was already confirmed by another pharmacist',
      'PHARMACY_ORDER_ALREADY_CONFIRMED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/pharmacy/71/confirm')
      .send({ items_list: [], total_amount: 0 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Order was already confirmed by another pharmacist');
    expect(response.body.code).toBe('PHARMACY_ORDER_ALREADY_CONFIRMED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    prismaQueryMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'order_rows')"),
    );

    const response = await request(app)
      .post('/api/v1/pharmacy/71/confirm')
      .send({ items_list: [], total_amount: 0 });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to confirm order');
    expect(response.body.message).not.toMatch(/order_rows/);
  });

  test('the Postgres 23xxx constraint branch stays intact (400 with constraint name)', async () => {
    prismaQueryMock.mockRejectedValueOnce(Object.assign(
      new Error('insert or update on table violates constraint'),
      { code: '23503', constraint: 'fk_pharmacy_orders_patient' },
    ));

    const response = await request(app)
      .post('/api/v1/pharmacy/71/confirm')
      .send({ items_list: [], total_amount: 0 });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toBe(
      'Confirm rejected by database constraint fk_pharmacy_orders_patient',
    );
  });
});
