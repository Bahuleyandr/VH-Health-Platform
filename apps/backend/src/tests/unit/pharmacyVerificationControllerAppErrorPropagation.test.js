import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Controller-layer contract regression — pharmacyVerificationController
// member of the relayAppError sweep, driven over HTTP through the REAL
// routes/pharmacy/orderRoutes.js mount (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// handleFailure()'s AppError branch used `err.details ?? { code: err.code }`
// (the R3 family): err.code was dropped whenever details existed and
// otherwise nested under `details.code`. Ported to
// responseHelper.relayAppError.

const verifyOrderMock = jest.fn();
const getPackLabelMock = jest.fn();

jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  verifyOrder: verifyOrderMock,
  getPackLabel: getPackLabelMock,
  assertVerificationCleared: jest.fn(async () => {}),
  ensurePackBarcode: jest.fn(async () => 'PACK-1'),
}));

// pharmacyOrderController shares the routes file — stub its module graph so
// the suite stays hermetic (prisma / R2 / canonical bridge etc.).
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
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
  verifyOrderMock.mockReset();
  getPackLabelMock.mockReset();
});

describe('pharmacy verification handleFailure() relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    verifyOrderMock.mockRejectedValueOnce(AppError.conflict(
      'Order already carries a verification verdict',
      'PHARMACY_VERIFICATION_ALREADY_RECORDED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/pharmacy/71/verify')
      .send({ decision: 'verified' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Order already carries a verification verdict');
    expect(response.body.code).toBe('PHARMACY_VERIFICATION_ALREADY_RECORDED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    verifyOrderMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'verification_rows')"),
    );

    const response = await request(app)
      .post('/api/v1/pharmacy/71/verify')
      .send({ decision: 'verified' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to verify pharmacy order');
    expect(response.body.message).not.toMatch(/verification_rows/);
  });

  test('pack-label endpoint keeps its own per-context generic', async () => {
    getPackLabelMock.mockRejectedValueOnce(
      new Error("Cannot read properties of null (reading 'barcode')"),
    );

    const response = await request(app).get('/api/v1/pharmacy/71/pack-label');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to build pack label');
    expect(response.body.message).not.toMatch(/barcode/);
  });
});
