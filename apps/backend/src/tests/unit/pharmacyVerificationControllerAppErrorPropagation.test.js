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
  assertVerificationClearedTx: jest.fn(async () => {}),
  clinicalOrderItemsSha256: jest.fn(() => 'items-sha256'),
  ensurePackBarcode: jest.fn(async () => 'PACK-1'),
  // pharmacyOrderInventoryService imports both statically for the catalog
  // authority CAS: a sha256 string it compares, and a void advisory-lock
  // helper. The lock stub resolves undefined because the real one only takes
  // pg_advisory_xact_lock and returns nothing.
  clinicalCatalogAuthoritySha256Tx: jest.fn(async () => 'catalog-authority-sha256'),
  lockPharmacyCatalogAuthorityTx: jest.fn(async () => {}),
}));

// pharmacyOrderController shares the routes file — stub its module graph so
// the suite stays hermetic (prisma / R2 / canonical bridge etc.).
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenantTx: jest.fn(),
  // Services reached through the routes mount assert their `tx` is a genuine
  // tenant-scoped (RLS-active) client and throw *_TX_REQUIRED otherwise. The
  // real registry is populated by setTenantTx, which is stubbed here, so this
  // answers true to keep those guards on their intended path — the suite pins
  // AppError propagation, not tenant-transaction provenance.
  isTenantTransactionClient: jest.fn(() => true),
  // observability/reliabilityMetrics.js imports these statically, so the mock
  // has to carry them or the whole graph fails to link.
  setTenant: jest.fn(async (_tenantId, fn) => fn({ $queryRawUnsafe: jest.fn(async () => []) })),
  // Healthy, closed breaker — callers read `.open` to decide whether the DB is
  // in fail-fast, and this suite exercises the reachable-DB path.
  circuitBreakerStatus: jest.fn(() => ({
    open: false,
    consecutiveFailures: 0,
    openedAt: null,
    resetInMs: 0,
    byTag: {},
  })),
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
  releasePharmacyCapReservationTx: jest.fn(async () => null),
  resolveAuthoritativeCounterFundingTx: jest.fn(async () => ({
    fundedAmount: 0,
    fundingSource: null,
    fundingReference: null,
  })),
  // The remaining funding-lock exports billingV2Service / admissionService /
  // claimCapsService import statically. They are stubbed only so the routes
  // graph links; each keeps the real return shape so a code path that does
  // reach one is not handed a shape the caller cannot destructure.
  lockPharmacyFundingAdmissionTx: jest.fn(async (_tx, { admissionId, patientUid }) => ({
    id: Number(admissionId),
    patient_uid: patientUid,
    status: 'active',
  })),
  lockPharmacyFundingAuthorityTx: jest.fn(async () => {}),
  resolvePharmacyFundingPatientUidTx: jest.fn(
    async () => '11111111-1111-4111-8111-111111111111',
  ),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  requestedPharmacyFacilityId: jest.fn(() => null),
  requireOrderFacility: jest.fn((order) => Number(order.facility_id || 7)),
  resolvePharmacyFacility: jest.fn(async () => ({ id: 7 })),
  resolveOrderPharmacyFacility: jest.fn(async () => ({
    id: 7,
    facility_code: 'PH-7',
    display_name: 'Test Pharmacy',
  })),
  // Migration 752/753 made pharmacy facility custody grant-backed with NO
  // admin bypass, so every service in the orderRoutes graph now imports this
  // gate statically. The stub returns the real success tuple (admin_bypass
  // false included) rather than a bare truthy object, so a caller that reads
  // the grant sees the shape production hands it.
  assertPharmacyFacilityGrant: jest.fn(async () => ({
    actor_id: 1,
    actor_uid: '11111111-1111-4111-8111-111111111111',
    actor_role: 'PHARMACY_STAFF',
    actor_name: 'Test Pharmacist',
    facility_id: 7,
    grant_id: 1,
    admin_bypass: false,
  })),
  pharmacyFacilityActorFromRequest: jest.fn((req) => ({
    actorUid: req?.user?.uid ?? null,
    actorRole: req?.user?.role ?? null,
  })),
  // Kept a real Set, not a jest.fn(): callers do
  // `FACILITY_OPERATION_ROLES.has(role)` / spread it into a text[] bind, and a
  // function stub would throw or silently bind an empty role list.
  FACILITY_OPERATION_ROLES: new Set([
    'PHARMACY_STAFF',
    'PHARMACIST',
    'PHARMACY_INCHARGE',
    'STORES_PURCHASE_INCHARGE',
    'DELIVERY_STAFF',
    'ADMIN',
    'SUPER_ADMIN',
  ]),
  listPharmacyFacilityGrants: jest.fn(async () => []),
  grantPharmacyFacilityAuthority: jest.fn(async () => ({ id: 1 })),
  revokePharmacyFacilityAuthority: jest.fn(async () => ({ id: 1 })),
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: jest.fn(async () => []),
  // The detail shape pharmacyOrderController destructures (.allergies /
  // .patientResolved / .sourcesFailed) to stamp allergy_status. A resolved
  // patient with no failed source is the 'verified' path, so a mocked order
  // never reports a false 'unavailable'.
  getUnifiedActiveAllergiesDetailed: jest.fn(async () => ({
    allergies: [],
    sourcesFailed: [],
    patientResolved: true,
  })),
  // The severity pair stays faithful to the real module instead of being
  // stubbed. prescriptionSafetyCheck gates its hard allergy block on
  // `rankSeverity(severity) >= SEVERE_BLOCK_RANK`, and the real ranker is
  // fail-safe: a severity that is present but unparseable ranks as a blocker,
  // never as a warning. A flat stub would rank everything 0 and silently
  // disable that block for the whole suite.
  SEVERE_BLOCK_RANK: 4,
  rankSeverity: jest.fn((value) => {
    if (value == null) return 0;
    const key = String(value).trim().toUpperCase();
    if (!key || ['UNKNOWN', 'UNSPECIFIED', 'NONE', 'N/A', 'NA', 'NULL', 'NIL'].includes(key)) {
      return 0;
    }
    return {
      LIFE_THREATENING: 5,
      ANAPHYLAXIS: 5,
      CONTRAINDICATED: 4,
      SEVERE: 4,
      HIGH: 3,
      MODERATE: 2,
      MILD: 1,
    }[key] ?? 4;
  }),
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
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: ({ required }) => (req, res, next) => {
    if (required && !req.get('Idempotency-Key')) {
      return res.status(400).json({
        success: false,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required for this endpoint',
      });
    }
    return next();
  },
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
  test('verification and pack-label calls carry the authenticated request tenant', async () => {
    verifyOrderMock.mockResolvedValueOnce({ order: { id: 71 } });
    getPackLabelMock.mockResolvedValueOnce({ order_id: 71, pack_barcode: 'PACK-1' });

    await request(app)
      .post('/api/v1/pharmacy/71/verify')
      .set('Idempotency-Key', 'verify-tenant-71')
      .send({ decision: 'verified' });
    await request(app).get('/api/v1/pharmacy/71/pack-label');

    expect(verifyOrderMock).toHaveBeenCalledWith(71, expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
    }));
    expect(getPackLabelMock).toHaveBeenCalledWith(
      71,
      '00000000-0000-4000-8000-000000000001',
    );
  });

  test('AppError code + details reach the envelope root / details key', async () => {
    verifyOrderMock.mockRejectedValueOnce(AppError.conflict(
      'Order already carries a verification verdict',
      'PHARMACY_VERIFICATION_ALREADY_RECORDED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/pharmacy/71/verify')
      .set('Idempotency-Key', 'verify-app-error-71')
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
      .set('Idempotency-Key', 'verify-generic-error-71')
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

  test('verification rejects a missing durable idempotency key before the controller', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/71/verify')
      .send({ decision: 'verified' });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(verifyOrderMock).not.toHaveBeenCalled();
  });
});
