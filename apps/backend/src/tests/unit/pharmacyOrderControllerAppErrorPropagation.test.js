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
// Scriptable: the delivery/dispense gates now run INSIDE the tenant
// transaction, so a test that needs one of them to refuse rejects the
// transaction itself.
const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQueryMock },
  setTenantTx: setTenantTxMock,
  // observability/reliabilityMetrics.js imports these statically, so the mock
  // has to carry them or the whole graph fails to link.
  setTenant: jest.fn(async (_tenantId, fn) => fn({ $queryRawUnsafe: prismaQueryMock })),
  // Healthy, closed breaker — callers read `.open` to decide whether the DB is
  // in fail-fast, and this suite exercises the reachable-DB path.
  circuitBreakerStatus: jest.fn(() => ({
    open: false,
    consecutiveFailures: 0,
    openedAt: null,
    resetInMs: 0,
    byTag: {},
  })),
  // Services reached through the controller assert their `tx` is a genuine
  // tenant-scoped (RLS-active) client and throw *_TX_REQUIRED otherwise. The
  // real registry is populated by setTenantTx, which is mocked out here, so
  // it answers true to keep those guards on their intended path — this suite
  // pins AppError propagation, not tenant-transaction provenance.
  isTenantTransactionClient: jest.fn(() => true),
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
  // Clear-probe shape: the real assert throws
  // PHARMACY_TERMINAL_FUNDING_PATIENT_AUTHORITY_UNRESOLVED when the order still
  // carries live funding, so resolving means "no live authority" — the path
  // that lets recovery proceed.
  assertNoLivePharmacyOrderFundingAuthorityTx: jest.fn(async (_tx, { orderId } = {}) => ({
    pharmacyOrderId: Number(orderId) || null,
    liveFundingAuthority: false,
  })),
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: jest.fn(async () => []),
  // The detail shape the controller destructures (.allergies/.patientResolved/
  // .sourcesFailed) to stamp allergy_status. Resolved patient + no failed
  // source is the 'verified' path, so a mocked order never reports a false
  // 'unavailable'.
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
jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  assertVerificationCleared: assertVerificationClearedMock,
  assertVerificationClearedTx: assertVerificationClearedTxMock,
  clinicalOrderItemsSha256: jest.fn(() => 'items-sha256'),
  clinicalCatalogAuthoritySha256Tx: jest.fn(async () => 'catalog-authority-sha256'),
  // Void advisory-lock helper — the real one only takes pg_advisory_xact_lock.
  lockPharmacyCatalogAuthorityTx: jest.fn(async () => {}),
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

const {
  default: pharmacyOrderRoutes,
  pharmacyDeliveryCompletionRoutes,
} = await import('../../routes/pharmacy/orderRoutes.js');

const app = express();
app.use(express.json());
let actorRole = 'PHARMACY_STAFF';
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { id: 7, uid: '11111111-1111-4111-8111-111111111111', role: actorRole };
  next();
});
// Delivery completion no longer lives on the orderRoutes barrel — it is its
// own router mounted by app.js at this exact path, behind a custody predicate.
// Mount it the way app.js does so the delivery tests below exercise the real
// chain rather than a path that now 404s.
app.use('/api/v1/pharmacy/orders/:id/delivered', pharmacyDeliveryCompletionRoutes);
app.use('/api/v1/pharmacy', pharmacyOrderRoutes);

beforeEach(() => {
  actorRole = 'PHARMACY_STAFF';
  prismaQueryMock.mockReset();
  assertVerificationClearedMock.mockReset();
  assertVerificationClearedMock.mockResolvedValue(undefined);
  assertVerificationClearedTxMock.mockReset();
  assertVerificationClearedTxMock.mockResolvedValue(undefined);
  setTenantTxMock.mockReset();
});

// A one-time patient handoff token: markDelivered requires 20-200 characters
// of handoff proof before it will open the tenant transaction.
const HANDOFF_TOKEN = 'handoff-token-0123456789abcdef';

describe('dispense verification gate preserves its machine-readable code', () => {
  // Delivery completion now consumes ONLY the staged custody package and the
  // patient handoff proof: cap_override is rejected as a forbidden field for
  // every caller, rather than being gated to pharmacy-incharge. Driving this
  // with DELIVERY_STAFF — a role that legitimately holds delivery custody —
  // makes the refusal provably about the FIELD and not about the actor, which
  // the previous role-gated 403 could not distinguish.
  test('no delivery-custody actor may smuggle a TPA cap override into completion', async () => {
    actorRole = 'DELIVERY_STAFF';
    prismaQueryMock.mockResolvedValueOnce([{ id: 71 }]); // exact custody row

    const response = await request(app)
      .post('/api/v1/pharmacy/orders/71/delivered')
      .set('Idempotency-Key', 'cap-override-authority-71')
      .send({
        handoff_token: HANDOFF_TOKEN,
        cap_override: true,
        cap_override_reason: 'Insurer enhancement is approved offline',
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('PHARMACY_DELIVERY_CALLER_AUTHORITY_FORBIDDEN');
    expect(response.body.details).toEqual({
      forbidden_fields: ['cap_override', 'cap_override_reason'],
    });
    // Refused before any gate ran. The single setTenantTx call is the
    // read-only command-replay probe that precedes the field check; the
    // mutating delivery transaction is never opened.
    expect(assertVerificationClearedMock).not.toHaveBeenCalled();
    expect(assertVerificationClearedTxMock).not.toHaveBeenCalled();
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
  });

  // markDelivered runs assertVerificationClearedTx INSIDE setTenantTx, so the
  // gate's refusal reaches the controller as a rejected tenant transaction.
  // First setTenantTx call is the command-replay lookup (no prior receipt);
  // the second is the transaction the gate refuses.
  test('PHARMACY_VERIFICATION_REQUIRED is returned at the envelope root', async () => {
    actorRole = 'DELIVERY_STAFF';
    prismaQueryMock.mockResolvedValueOnce([{ id: 71 }]); // exact custody row
    setTenantTxMock.mockResolvedValueOnce(null);
    setTenantTxMock.mockRejectedValueOnce(AppError.conflict(
      'Pharmacist clinical verification is required before dispense',
      'PHARMACY_VERIFICATION_REQUIRED',
      {
        clinical_verification_status: 'pending',
        verify_endpoint: '/api/v1/pharmacy/orders/71/verify',
      },
    ));

    const response = await request(app)
      .post('/api/v1/pharmacy/orders/71/delivered')
      .set('Idempotency-Key', 'verification-gate-71')
      .send({ handoff_token: HANDOFF_TOKEN });

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
      .set('Idempotency-Key', 'confirm-71')
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
      .set('Idempotency-Key', 'confirm-71')
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
      .set('Idempotency-Key', 'confirm-71')
      .send({ items_list: [], total_amount: 0 });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toBe(
      'Confirm rejected by database constraint fk_pharmacy_orders_patient',
    );
  });
});
