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
  probePharmacyCap: jest.fn(async () => ({ message: null })),
  shouldBlockDispense: jest.fn(() => false),
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitPharmacyOrderEvent: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  assertVerificationCleared: jest.fn(async () => {}),
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
jest.unstable_mockModule('../../validators/pharmacy/orderValidators.js', () => ({
  placeOrderValidation: (_req, _res, next) => next(),
  updateOrderStatusValidation: (_req, _res, next) => next(),
  uidParamValidation: (_req, _res, next) => next(),
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
