/**
 * Per-route patient-access guards for the /api/v1/pharmacy-orders and
 * /api/v1/pharmacy mounts (re-audit M: mount-level patientAccessGuard ran
 * before route match, so path-keyed subjects never resolved and the guard
 * decided nothing).
 *
 * Pins, with mocked prisma:
 *   (a) selectors resolve the subject from the identifier the handler uses,
 *       with an explicit tenant predicate, and never throw on junk input;
 *   (b) the guarded routes carry the guard (read off the router stacks);
 *   (c) list/queue/self routes are NOT patient-context-forced;
 *   (d) guard behavior end-to-end: enforce denies an unrelated pharmacist on
 *       a resolved subject, allows the admission-operational path and patient
 *       self-access, and passes subject-less (walk-in) rows on the role gate.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '33333333-3333-4333-8333-333333333333';
const OTHER_PATIENT_UID = '44444444-4444-4444-8444-444444444444';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const PATIENT_ID = 51;

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(async () => 1),
};

// Test-scripted DB state the prisma routing below serves.
const db = {
  orderRow: null, // row returned by the pharmacy-order selector join
  saleRow: null, // row returned by the counter-sale selector join
  patientRow: null, // row returned by accessDecisionService#patientByIdOrUid
  phoneRow: null, // row returned by the body-phone selector
  admissionRows: [], // relationship: admissions
  careTeamRows: [], // relationship: care team membership
};

function routePrisma(sql, ...args) {
  if (sql.includes('FROM pharmacy_orders po')) return db.orderRow ? [db.orderRow] : [];
  if (sql.includes('FROM pharmacy_counter_sales cs')) return db.saleRow ? [db.saleRow] : [];
  // Body-phone selector (REGEXP_REPLACE match, $2::text) vs
  // accessDecisionService#patientByIdOrUid ($2::int / $3::uuid).
  if (sql.includes('FROM users') && sql.includes('REGEXP_REPLACE')) {
    return db.phoneRow ? [db.phoneRow] : [];
  }
  if (sql.includes('FROM users') && sql.includes('$2::int IS NOT NULL AND id = $2::int')) {
    return db.patientRow ? [db.patientRow] : [];
  }
  // care_team first: the care-team relationship SQL embeds a FROM admissions
  // subquery, so the admissions check below would shadow it.
  if (sql.includes('care_team_members')) return db.careTeamRows;
  if (sql.includes('FROM admissions')) return db.admissionRows;
  return [];
}

let mode = 'enforce';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: async (_t, fn) => fn(prismaMock),
  setTenantTx: async (_t, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
  circuitBreakerStatus: () => ({}),
}));
jest.unstable_mockModule('../../services/security/careTeamEnforcement.js', () => ({
  CARE_TEAM_ENFORCEMENT_MODES: { OFF: 'off', SHADOW: 'shadow', ENFORCE: 'enforce' },
  resolveEnforcementModeForRequest: jest.fn(async () => mode),
  resolveEnforcementModeForTenant: jest.fn(async () => mode),
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));

// Controllers under the guarded routes — recorded, never exercised.
function handlerMock(name) {
  return jest.fn(async (_req, res) => res.status(200).json({ handler: name }));
}
const pharmacyOrderControllerMock = {
  placeOrder: handlerMock('placeOrder'),
  getMyOrders: handlerMock('getMyOrders'),
  getOrderQueue: handlerMock('getOrderQueue'),
  getPharmacySLADashboard: handlerMock('getPharmacySLADashboard'),
  confirmOrder: handlerMock('confirmOrder'),
  markPreparing: handlerMock('markPreparing'),
  dispatchOrder: handlerMock('dispatchOrder'),
  markDelivered: handlerMock('markDelivered'),
  markCounterDispensed: handlerMock('markCounterDispensed'),
  markUnavailable: handlerMock('markUnavailable'),
  cancelOrder: handlerMock('cancelOrder'),
  getOrderDetail: handlerMock('getOrderDetail'),
  getOrderDispensableContext: handlerMock('getOrderDispensableContext'),
  getDispenseLabel: handlerMock('getDispenseLabel'),
  getCatalog: handlerMock('getCatalog'),
  getCatalogAlternatives: handlerMock('getCatalogAlternatives'),
  getCatalogDispensableBatches: handlerMock('getCatalogDispensableBatches'),
  upsertCatalog: handlerMock('upsertCatalog'),
  removeCatalog: handlerMock('removeCatalog'),
  dispenseSubstitution: handlerMock('dispenseSubstitution'),
  requestSubstitutionWitnessApproval: jest.fn(async (input) => input),
  approveSubstitutionWitnessApproval: jest.fn(async (input) => input),
};
jest.unstable_mockModule('../../controllers/pharmacy/pharmacyOrderController.js', () => pharmacyOrderControllerMock);
const orderControllerMock = {
  placeOrder: handlerMock('legacyPlaceOrder'),
  getOrdersByUID: handlerMock('getOrdersByUID'),
  updateOrderStatus: handlerMock('updateOrderStatus'),
  getAllOrders: handlerMock('getAllOrders'),
};
jest.unstable_mockModule('../../controllers/pharmacy/orderController.js', () => orderControllerMock);
jest.unstable_mockModule('../../controllers/pharmacy/pharmacyVerificationController.js', () => ({
  verifyPharmacyOrder: handlerMock('verifyPharmacyOrder'),
  getPharmacyPackLabel: handlerMock('getPharmacyPackLabel'),
  default: {},
}));

// Counter-sale collaborators.
const getCounterSaleMock = jest.fn(async () => ({ id: 7 }));
jest.unstable_mockModule('../../services/pharmacy/counterSaleService.js', () => ({
  searchSellableItems: jest.fn(async () => []),
  requestCounterSaleWitnessApproval: jest.fn(async (input) => input),
  approveCounterSaleWitnessApproval: jest.fn(async (input) => input),
  createCounterSale: jest.fn(async (input) => input),
  listCounterSales: jest.fn(async () => []),
  getCounterSale: getCounterSaleMock,
  voidCounterSale: jest.fn(async (input) => input),
}));
jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  tenantOf: (req) => req.tenantId,
}));
jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: { authenticateControlledDispenseWitness: jest.fn() },
}));
jest.unstable_mockModule('../../services/pharmacy/controlledDispenseWitnessService.js', () => ({
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['DOCTOR'],
  CONTROLLED_DISPENSE_APPROVAL_SCOPES: { dispenseSubstitution: 'dispense_substitution' },
  createControlledDispenseWitnessApproval: jest.fn(),
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

// Sub-routers of the pharmacy barrel that are out of this fix's scope.
const stubRouter = () => ({ default: express.Router() });
jest.unstable_mockModule('../../routes/pharmacy/adminRoutes.js', stubRouter);
jest.unstable_mockModule('../../routes/pharmacy/inventoryRoutes.js', stubRouter);
jest.unstable_mockModule('../../routes/pharmacy/inventoryV2Routes.js', stubRouter);
jest.unstable_mockModule('../../routes/pharmacy/medicationRoutes.js', stubRouter);
jest.unstable_mockModule('../../routes/pharmacy/wardIndentRoutes.js', stubRouter);

const guards = await import('../../routes/pharmacy/pharmacyOrderPatientGuards.js');
const { default: orderRoutes } = await import('../../routes/pharmacy/orderRoutes.js');
const { default: counterSaleRoutes } = await import('../../routes/pharmacy/counterSaleRoutes.js');
const { default: substitutionWitnessRoutes } = await import('../../routes/pharmacy/dispenseSubstitutionWitnessRoutes.js');
const { default: pharmacyIndexRoutes } = await import('../../routes/pharmacy/index.js');

let actor;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = actor;
  req.tenantId = TENANT;
  req.id = 'req-guard-test';
  next();
});
app.use('/', pharmacyIndexRoutes);

beforeEach(() => {
  mode = 'enforce';
  actor = { id: 9, uid: ACTOR_UID, role: 'PHARMACY_STAFF', phone: '+919000090011' };
  db.orderRow = { id: PATIENT_ID, uid: PATIENT_UID };
  db.saleRow = null;
  db.patientRow = { id: PATIENT_ID, uid: PATIENT_UID };
  db.phoneRow = null;
  db.admissionRows = [];
  db.careTeamRows = [];
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...args) => routePrisma(sql, ...args));
  prismaMock.$executeRawUnsafe.mockClear();
  Object.values(pharmacyOrderControllerMock).forEach((fn) => fn.mockClear());
  Object.values(orderControllerMock).forEach((fn) => fn.mockClear());
  getCounterSaleMock.mockClear();
});

// ── (a) selectors ───────────────────────────────────────────────────────────

describe('selectors resolve the row the handler serves, tenant-scoped', () => {
  test('order selector queries pharmacy_orders by the same id with a tenant predicate', async () => {
    const selector = guards.selectOrderPatient((req) => req.params?.id);
    const row = await selector({ params: { id: '73' }, tenantId: TENANT });
    expect(row).toEqual({ id: PATIENT_ID, uid: PATIENT_UID });
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM pharmacy_orders po'));
    expect(call).toBeDefined();
    expect(call[0]).toContain('po.tenant_id = $1::uuid');
    expect(call[0]).toContain("p.role = 'PATIENT'");
    expect(call.slice(1)).toEqual([TENANT, 73]);
  });

  test('order selector returns null (no query, no throw) on junk id or missing tenant', async () => {
    const selector = guards.selectOrderPatient((req) => req.params?.id);
    await expect(selector({ params: { id: 'abc' }, tenantId: TENANT })).resolves.toBeNull();
    await expect(selector({ params: { id: '9999999999999' }, tenantId: TENANT })).resolves.toBeNull();
    await expect(selector({ params: {}, tenantId: TENANT })).resolves.toBeNull();
    await expect(selector({ params: { id: '7' } })).resolves.toBeNull();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('body-phone selector matches users by phone within the tenant', async () => {
    db.phoneRow = { id: PATIENT_ID, uid: PATIENT_UID };
    const row = await guards.selectPatientByBodyPhone({
      body: { phone: '+91 90000 90011' },
      tenantId: TENANT,
    });
    expect(row).toEqual({ id: PATIENT_ID, uid: PATIENT_UID });
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('REGEXP_REPLACE'));
    expect(call[0]).toContain('tenant_id = $1::uuid');
    expect(call[0]).toContain("role = 'PATIENT'");
    expect(call.slice(1)).toEqual([TENANT, '+91 90000 90011', '9000090011']);
  });

  test('counter-sale selector is bigint-safe and tenant-scoped', async () => {
    db.saleRow = { id: PATIENT_ID, uid: PATIENT_UID };
    const row = await guards.selectCounterSalePatient({
      params: { id: '9007199254740995' }, // above 2^53 — must survive as a digit string
      tenantId: TENANT,
    });
    expect(row).toEqual({ id: PATIENT_ID, uid: PATIENT_UID });
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM pharmacy_counter_sales cs'));
    expect(call[0]).toContain('cs.tenant_id = $1::uuid');
    expect(call.slice(1)).toEqual([TENANT, '9007199254740995']);
    await expect(guards.selectCounterSalePatient({ params: { id: '12abc' }, tenantId: TENANT }))
      .resolves.toBeNull();
  });
});

// ── (b)+(c) route pins ──────────────────────────────────────────────────────

function guardMetasFor(router, path, method) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods?.[method]);
  if (!layer) return null;
  return layer.route.stack
    .map((s) => (s.handle?.__wrappedFn ?? s.handle)?.__patientGuard)
    .filter(Boolean);
}

describe('router middleware chains carry the per-route guards', () => {
  const orderGuarded = [
    ['get', '/:id/detail'], ['get', '/:id/dispensable'], ['get', '/:id'],
    ['get', '/:id/label'], ['get', '/:id/receipt'], ['get', '/:id/pack-label'],
    ['post', '/:id/confirm'], ['post', '/:id/verify'], ['post', '/:id/preparing'],
    ['post', '/:id/dispatch'], ['post', '/:id/delivered'], ['post', '/:id/dispense-counter'],
    ['post', '/:id/dispense'], ['post', '/:id/unavailable'], ['post', '/:id/cancel'],
    ['put', '/:orderId/status'], ['post', '/'],
  ];
  test.each(orderGuarded)('orderRoutes %s %s carries a PHARMACY_ORDER guard without forced context', (method, path) => {
    const metas = guardMetasFor(orderRoutes, path, method);
    expect(metas).toEqual([expect.objectContaining({
      recordType: 'PHARMACY_ORDER',
      careTeamModeGoverned: true,
      requirePatientContext: false,
      hasSelector: true,
    })]);
  });

  test('orderRoutes /uid/:uid names its subject and forces patient context', () => {
    expect(guardMetasFor(orderRoutes, '/uid/:uid', 'get')).toEqual([
      expect.objectContaining({ recordType: 'PHARMACY_ORDER', requirePatientContext: true }),
    ]);
  });

  test.each([
    ['get', '/my'], ['get', '/queue'], ['get', '/sla'], ['get', '/'], ['post', '/place'],
  ])('orderRoutes %s %s (self/queue routes) is NOT patient-guarded', (method, path) => {
    expect(guardMetasFor(orderRoutes, path, method)).toEqual([]);
  });

  test('counter-sale rows and body-linked sales are guarded, never context-forced; lists are not guarded', () => {
    expect(guardMetasFor(counterSaleRoutes, '/:id', 'get')).toEqual([
      expect.objectContaining({ recordType: 'PHARMACY_ORDER', requirePatientContext: false }),
    ]);
    expect(guardMetasFor(counterSaleRoutes, '/:id/void', 'post')).toEqual([
      expect.objectContaining({ requirePatientContext: false }),
    ]);
    expect(guardMetasFor(counterSaleRoutes, '/', 'post')).toEqual([
      expect.objectContaining({ requirePatientContext: false }),
    ]);
    expect(guardMetasFor(counterSaleRoutes, '/witness-approvals', 'post')).toEqual([
      expect.objectContaining({ requirePatientContext: false }),
    ]);
    expect(guardMetasFor(counterSaleRoutes, '/', 'get')).toEqual([]);
    expect(guardMetasFor(counterSaleRoutes, '/items', 'get')).toEqual([]);
  });

  test('substitution witness request names its patient and forces context', () => {
    expect(guardMetasFor(substitutionWitnessRoutes, '/', 'post')).toEqual([
      expect.objectContaining({ recordType: 'PHARMACY_ORDER', requirePatientContext: true }),
    ]);
  });

  test('barrel dispense routes are guarded; catalog stays role-gated', () => {
    expect(guardMetasFor(pharmacyIndexRoutes, '/dispense', 'post')).toEqual([
      expect.objectContaining({ recordType: 'PHARMACY_ORDER', requirePatientContext: false }),
    ]);
    expect(guardMetasFor(pharmacyIndexRoutes, '/dispense-substitution', 'post')).toEqual([
      expect.objectContaining({ recordType: 'PHARMACY_ORDER', requirePatientContext: true }),
    ]);
    expect(guardMetasFor(pharmacyIndexRoutes, '/catalog', 'get')).toEqual([]);
    expect(guardMetasFor(pharmacyIndexRoutes, '/catalog', 'post')).toEqual([]);
  });
});

// ── (d) guard behavior through the real engine ──────────────────────────────

describe('order-detail guard decisions (enforce/shadow)', () => {
  test('enforce: pharmacist with no relationship to the order patient is denied before the handler', async () => {
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_ACCESS_DENIED');
    expect(pharmacyOrderControllerMock.getOrderDetail).not.toHaveBeenCalled();
    // The decision consumed the order-row selector (same id the handler uses).
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM pharmacy_orders po'));
    expect(call.slice(1)).toEqual([TENANT, 73]);
  });

  test('enforce: pharmacist reaches an ADMITTED patient through the admission-operational path', async () => {
    db.admissionRows = [{ id: 12 }];
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(200);
    expect(pharmacyOrderControllerMock.getOrderDetail).toHaveBeenCalledTimes(1);
  });

  // NOTE: PATIENT self-access is exercised on the prescription mount tests —
  // under the pharmacy mounts every subject-guarded route sits behind a
  // staff-only wrapAutoRBAC role list ('pharmacyLifecycleRoutes' /
  // 'pharmacyOrderRoutes' / 'pharmacyStaffOrderRoutes' exclude PATIENT), so
  // patients never reach these guards; their surface is /orders/place +
  // /orders/my, both self-scoped from the JWT and deliberately unguarded.
  test('enforce: pharmacist on the patient\'s active care team is allowed', async () => {
    db.careTeamRows = [{ care_team_id: 4 }];
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(200);
    expect(pharmacyOrderControllerMock.getOrderDetail).toHaveBeenCalledTimes(1);
  });

  test('enforce: a walk-in order with no registered patient passes on the role gate (context not forced)', async () => {
    db.orderRow = null;
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(200);
    expect(pharmacyOrderControllerMock.getOrderDetail).toHaveBeenCalledTimes(1);
  });

  test('shadow: an unrelated pharmacist still reaches the handler (decision logged, never blocked)', async () => {
    mode = 'shadow';
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(200);
    expect(pharmacyOrderControllerMock.getOrderDetail).toHaveBeenCalledTimes(1);
  });
});

describe('subject-forcing routes', () => {
  test('enforce: /orders/uid/:uid refuses when the uid resolves no patient in the tenant', async () => {
    db.patientRow = null;
    const res = await request(app).get(`/orders/uid/${OTHER_PATIENT_UID}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_CONTEXT_REQUIRED');
    expect(orderControllerMock.getOrdersByUID).not.toHaveBeenCalled();
  });

  test('enforce: /orders/uid/:uid decides from the path uid — admission-linked staff read allowed', async () => {
    db.admissionRows = [{ id: 12 }];
    const res = await request(app).get(`/orders/uid/${PATIENT_UID}`);
    expect(res.status).toBe(200);
    expect(orderControllerMock.getOrdersByUID).toHaveBeenCalledTimes(1);
    // The decision validated the SAME uid the handler serves, tenant-scoped.
    const validate = prismaMock.$queryRawUnsafe.mock.calls.find(
      ([sql]) => sql.includes('$2::int IS NOT NULL AND id = $2::int'),
    );
    expect(validate.slice(1)).toEqual([TENANT, null, PATIENT_UID]);
  });
});

describe('counter-sale rows', () => {
  test('anonymous sale (no registered patient) stays readable on the pharmacy role gate in enforce', async () => {
    db.saleRow = null;
    const res = await request(app).get('/counter-sales/7');
    expect(res.status).toBe(200);
    expect(getCounterSaleMock).toHaveBeenCalledTimes(1);
  });

  test('enforce: a sale linked to a registered, unrelated patient is denied', async () => {
    db.saleRow = { id: PATIENT_ID, uid: PATIENT_UID };
    const res = await request(app).get('/counter-sales/7');
    expect(res.status).toBe(403);
    expect(getCounterSaleMock).not.toHaveBeenCalled();
  });
});
