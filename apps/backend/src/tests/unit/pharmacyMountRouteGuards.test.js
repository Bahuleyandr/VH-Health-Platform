/**
 * Per-route patient-access guards for the /api/v1/pharmacy-orders and
 * /api/v1/pharmacy mounts (re-audit M: mount-level patientAccessGuard ran
 * before route match, so path-keyed subjects never resolved and the guard
 * decided nothing).
 *
 * Pins, with mocked prisma:
 *   (a) selectors resolve the subject from the identifier the handler uses,
 *       with an explicit tenant predicate, and never throw: junk input, an
 *       unknown or out-of-tenant order, and a resolvable order carrying no
 *       patient_id owner (phone is contact data, not ownership authority)
 *       all resolve to null, because patientAccessGuard answers 500
 *       PATIENT_ACCESS_CHECK_FAILED on any selector throw;
 *   (b) the guarded routes carry the guard (read off the router stacks), and
 *       the routes this train retired are gone from the router;
 *   (c) list/queue/self routes are NOT patient-context-forced;
 *   (d) guard behavior end-to-end: enforce denies an unrelated pharmacist on
 *       a resolved subject, allows the admission-operational path and patient
 *       self-access, and refuses an order whose owner cannot be resolved;
 *   (e) the delivery-custody routers exported for app.js's EXACT mounts carry
 *       their own mount-level requireRole (+ custody predicate) rather than a
 *       patient guard.
 *
 * SCOPE LIMIT — this suite mocks the controllers and builds its own express
 * apps; it never imports app.js. It therefore pins what the ROUTERS declare.
 * The mount paths the delivery routers are attached to below MIRROR app.js's
 * exact full-path mounts (`/api/v1/pharmacy-orders/orders/assigned`,
 * `.../orders/:id/delivered`, `.../orders/:id/delivery-handoff/reissue`,
 * `.../orders/:id/delivery-return/{request,complete}`) so the mergeParams
 * `:id` plumbing is exercised; the mounts themselves are pinned in app.js's
 * own contract tests, not here.
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
  orderRow: null, // row returned by the pharmacy-order selector LEFT JOIN
  saleRow: null, // row returned by the counter-sale selector join
  patientRow: null, // row returned by accessDecisionService#patientByIdOrUid
  phoneRow: null, // row returned by the body-phone selector
  admissionRows: [], // relationship: admissions
  careTeamRows: [], // relationship: care team membership
  deliveryCustodyRows: [], // rows returned by requireExactDeliveryCustody
};

function routePrisma(sql, ...args) {
  // requireExactDeliveryCustody aliases the table `orders`; the patient
  // selector aliases it `po` — keep the custody branch first so the two
  // never shadow one another.
  if (sql.includes('FROM pharmacy_orders orders')) return db.deliveryCustodyRows;
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
  assignOrderFacility: handlerMock('assignOrderFacility'),
  resolveOrderLineIdentities: handlerMock('resolveOrderLineIdentities'),
  confirmOrder: handlerMock('confirmOrder'),
  markPreparing: handlerMock('markPreparing'),
  dispatchOrder: handlerMock('dispatchOrder'),
  getDeliveryAssignees: handlerMock('getDeliveryAssignees'),
  getAssignedDeliveries: handlerMock('getAssignedDeliveries'),
  markDelivered: handlerMock('markDelivered'),
  reissueDeliveryHandoff: handlerMock('reissueDeliveryHandoff'),
  requestDeliveryReturn: handlerMock('requestDeliveryReturn'),
  completeDeliveryReturn: handlerMock('completeDeliveryReturn'),
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
  preflightSubstitutionWitnessApproval: jest.fn(async (input) => input),
  approveSubstitutionWitnessApproval: jest.fn(async (input) => input),
};
jest.unstable_mockModule('../../controllers/pharmacy/pharmacyOrderController.js', () => pharmacyOrderControllerMock);
// The legacy order controller is down to its single surviving read after this
// train retired the legacy create and the generic status mutation.
const orderControllerMock = {
  getOrdersByUID: handlerMock('getOrdersByUID'),
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
  preflightCounterSaleWitnessApproval: jest.fn(async (input) => input),
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
jest.unstable_mockModule('../../services/pharmacy/pharmacyOrderInventoryService.js', () => ({
  requestOrderControlledWitnessApproval: jest.fn(async (input) => input),
  preflightOrderControlledWitnessApproval: jest.fn(async (input) => input),
  approveOrderControlledWitnessApproval: jest.fn(async (input) => input),
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
const orderRoutesModule = await import('../../routes/pharmacy/orderRoutes.js');
const { default: orderRoutes } = orderRoutesModule;
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

// Delivery-custody app — mirrors app.js's exact full-path mounts (see the
// SCOPE LIMIT note at the top of this file). Each router carries its own
// mount-level requireRole, so these mounts add no role gate of their own.
const deliveryApp = express();
deliveryApp.use(express.json());
deliveryApp.use((req, _res, next) => {
  req.user = actor;
  req.tenantId = TENANT;
  req.id = 'req-delivery-test';
  next();
});
deliveryApp.use('/orders/assigned', orderRoutesModule.pharmacyAssignedDeliveryRoutes);
deliveryApp.use('/orders/:id/delivered', orderRoutesModule.pharmacyDeliveryCompletionRoutes);
deliveryApp.use('/orders/:id/delivery-handoff/reissue', orderRoutesModule.pharmacyDeliveryHandoffReissueRoutes);
deliveryApp.use('/orders/:id/delivery-return/request', orderRoutesModule.pharmacyDeliveryReturnRequestRoutes);
deliveryApp.use('/orders/:id/delivery-return/complete', orderRoutesModule.pharmacyDeliveryReturnCompletionRoutes);
// Mirrors app.js's global error handler for the AppError-shaped refusals
// requireExactDeliveryCustody raises. AppError carries `statusCode`, and
// errorHandlerMiddleware reads that name only — mirroring `err.status` here
// answered 500 for every refusal and hid the custody code behind it.
deliveryApp.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({ success: false, code: err.code ?? null });
});

beforeEach(() => {
  mode = 'enforce';
  actor = { id: 9, uid: ACTOR_UID, role: 'PHARMACY_STAFF', phone: '+919000090011' };
  // Order 73 exists and is owned by a registered, active PATIENT.
  db.orderRow = { order_id: 73, id: PATIENT_ID, uid: PATIENT_UID };
  db.saleRow = null;
  db.patientRow = { id: PATIENT_ID, uid: PATIENT_UID };
  db.phoneRow = null;
  db.admissionRows = [];
  db.careTeamRows = [];
  db.deliveryCustodyRows = [];
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

  test('order selector binds ownership to patient_id on a live identity — never to the order phone', async () => {
    const selector = guards.selectOrderPatient((req) => req.params?.id);
    await selector({ params: { id: '73' }, tenantId: TENANT });
    const [sql] = prismaMock.$queryRawUnsafe.mock.calls.find(([s]) => s.includes('FROM pharmacy_orders po'));
    // LEFT JOIN so an unowned order still proves the ORDER exists.
    expect(sql).toContain('LEFT JOIN users p');
    expect(sql).toContain('p.id = po.patient_id');
    // Phone is contact data, never durable ownership authority.
    expect(sql).not.toContain('po.phone');
    // Retired/merged/deleted identities are not owners.
    expect(sql).toContain('p.is_active=TRUE');
    expect(sql).toContain("p.status='active'");
    expect(sql).toContain('p.is_deleted=FALSE');
    expect(sql).toContain('p.merged_into_uid IS NULL');
  });

  test('order selector returns null for an order that exists with no resolvable patient owner', async () => {
    db.orderRow = { order_id: 73, id: null, uid: null };
    const selector = guards.selectOrderPatient((req) => req.params?.id);
    await expect(selector({ params: { id: '73' }, tenantId: TENANT })).resolves.toBeNull();
  });

  // A miss resolves null and must NOT throw. patientAccessGuard's catch treats
  // any selector throw as a broken authorization engine and answers 500
  // PATIENT_ACCESS_CHECK_FAILED without ever reading err.statusCode, so a 404
  // raised here would turn every unknown order id into a 500 and lose the
  // guard's decision row entirely. Null lets the guard refuse cleanly (403
  // PATIENT_CONTEXT_REQUIRED under enforce) with the attempt recorded.
  test('order selector resolves null — never throws — for an order id that names no row in the tenant', async () => {
    db.orderRow = null;
    const selector = guards.selectOrderPatient((req) => req.params?.id);
    await expect(selector({ params: { id: '73' }, tenantId: TENANT })).resolves.toBeNull();
    // The null is a real miss, not an early bail: the tenant-scoped lookup ran
    // and bound this id.
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM pharmacy_orders po'));
    expect(call).toBeDefined();
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
    ['get', '/:id/detail'], ['get', '/:id/dispensable'], ['get', '/:id/delivery-assignees'],
    ['get', '/:id'], ['get', '/:id/label'], ['get', '/:id/receipt'], ['get', '/:id/pack-label'],
    ['post', '/:id/confirm'], ['post', '/:id/verify'], ['post', '/:id/assign-facility'],
    ['post', '/:id/resolve-line-identities'], ['post', '/:id/preparing'],
    ['post', '/:id/controlled-dispense/witness-approvals'],
    ['post', '/:id/controlled-dispense/witness-approvals/:approvalId/approve'],
    ['post', '/:id/dispatch'], ['post', '/:id/dispense-counter'],
    ['post', '/:id/dispense'], ['post', '/:id/unavailable'], ['post', '/:id/cancel'],
  ];
  test.each(orderGuarded)('orderRoutes %s %s carries a PHARMACY_ORDER guard that forces patient context', (method, path) => {
    const metas = guardMetasFor(orderRoutes, path, method);
    expect(metas).toEqual([expect.objectContaining({
      recordType: 'PHARMACY_ORDER',
      careTeamModeGoverned: true,
      requirePatientContext: true,
      hasSelector: true,
    })]);
  });

  test('orderRoutes /uid/:uid names its subject and forces patient context', () => {
    expect(guardMetasFor(orderRoutes, '/uid/:uid', 'get')).toEqual([
      expect.objectContaining({ recordType: 'PHARMACY_ORDER', requirePatientContext: true }),
    ]);
  });

  // Retired by this train: the generic status mutation and the legacy
  // body-phone create both bypassed the facility-bound, verified Inventory V2
  // lifecycle, and delivery completion moved to its own exact mount.
  test.each([
    ['put', '/:orderId/status'],
    ['post', '/'],
    ['post', '/:id/delivered'],
  ])('orderRoutes no longer declares %s %s', (method, path) => {
    expect(guardMetasFor(orderRoutes, path, method)).toBeNull();
  });

  test('orderRoutes declares no PUT route at all', () => {
    const putLayers = orderRoutes.stack.filter((l) => l.route?.methods?.put);
    expect(putLayers).toEqual([]);
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
  // 'pharmacyOrderRoutes' exclude PATIENT), so patients never reach these
  // guards; their surface is /orders/place + /orders/my, both self-scoped
  // from the JWT and deliberately unguarded.
  test('enforce: pharmacist on the patient\'s active care team is allowed', async () => {
    db.careTeamRows = [{ care_team_id: 4 }];
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(200);
    expect(pharmacyOrderControllerMock.getOrderDetail).toHaveBeenCalledTimes(1);
  });

  test('enforce: an order with no resolvable patient owner is refused, not waved through', async () => {
    db.orderRow = { order_id: 73, id: null, uid: null };
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_CONTEXT_REQUIRED');
    expect(pharmacyOrderControllerMock.getOrderDetail).not.toHaveBeenCalled();
  });

  test('shadow: an unrelated pharmacist still reaches the handler (decision logged, never blocked)', async () => {
    mode = 'shadow';
    const res = await request(app).get('/orders/73');
    expect(res.status).toBe(200);
    expect(pharmacyOrderControllerMock.getOrderDetail).toHaveBeenCalledTimes(1);
  });

  test('shadow: an unowned order is not blocked either (shadow never refuses)', async () => {
    mode = 'shadow';
    db.orderRow = { order_id: 73, id: null, uid: null };
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

// ── (e) delivery-custody routers (exact mounts in app.js) ───────────────────

describe('delivery-custody routers are role-gated at their own mount', () => {
  test('the exported role lists are exactly the three custody tiers', () => {
    expect(orderRoutesModule.PHARMACY_DELIVERY_ASSIGNED_ROLES).toEqual(['DELIVERY_STAFF']);
    expect(orderRoutesModule.PHARMACY_DELIVERY_CUSTODY_ROLES)
      .toEqual(['DELIVERY_STAFF', 'PHARMACY_INCHARGE']);
    expect(orderRoutesModule.PHARMACY_DELIVERY_INCHARGE_ROLES).toEqual(['PHARMACY_INCHARGE']);
  });

  test.each([
    ['pharmacyAssignedDeliveryRoutes', 'get'],
    ['pharmacyDeliveryCompletionRoutes', 'post'],
    ['pharmacyDeliveryHandoffReissueRoutes', 'post'],
    ['pharmacyDeliveryReturnRequestRoutes', 'post'],
    ['pharmacyDeliveryReturnCompletionRoutes', 'post'],
  ])('%s declares exactly one %s "/" route and carries no patient guard', (exportName, method) => {
    // One '/' route per router is what makes an EXACT app.js mount possible;
    // the :id it needs arrives through mergeParams (pinned behaviourally by
    // the custody-predicate test below, which reads order 73 off the mount).
    const router = orderRoutesModule[exportName];
    const routes = router.stack.filter((l) => l.route).map((l) => l.route);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/');
    expect(routes[0].methods[method]).toBe(true);
    expect(guardMetasFor(router, '/', method)).toEqual([]);
  });

  test('assigned deliveries: DELIVERY_STAFF passes the mount role gate, pharmacy staff does not', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'DELIVERY_STAFF' };
    const allowed = await request(deliveryApp).get('/orders/assigned');
    expect(allowed.status).toBe(200);
    expect(pharmacyOrderControllerMock.getAssignedDeliveries).toHaveBeenCalledTimes(1);

    actor = { id: 9, uid: ACTOR_UID, role: 'PHARMACY_STAFF' };
    const denied = await request(deliveryApp).get('/orders/assigned');
    expect(denied.status).toBe(403);
    expect(pharmacyOrderControllerMock.getAssignedDeliveries).toHaveBeenCalledTimes(1);
  });

  test('delivered: the custody predicate is exact — tenant, order, DISPATCHED, in-transit, unconsumed handoff, active facility grant', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'DELIVERY_STAFF' };
    db.deliveryCustodyRows = [{ id: 73 }];
    const res = await request(deliveryApp).post('/orders/73/delivered').send({});
    expect(res.status).toBe(200);
    expect(pharmacyOrderControllerMock.markDelivered).toHaveBeenCalledTimes(1);

    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM pharmacy_orders orders'));
    expect(call).toBeDefined();
    expect(call[0]).toContain('orders.tenant_id=$1::uuid');
    expect(call[0]).toContain('orders.id=$2::int');
    expect(call[0]).toContain("orders.status='DISPATCHED'");
    expect(call[0]).toContain("orders.delivery_custody_status='in_transit'");
    expect(call[0]).toContain('orders.delivery_handoff_consumed_at IS NULL');
    expect(call[0]).toContain('JOIN pharmacy_staff_facility_grants facility_grant');
    expect(call[0]).toContain("facility_grant.status='active'");
    expect(call[0]).toContain('facility_grant.revoked_at IS NULL');
    // :id reaches the router through mergeParams from the exact mount path.
    expect(call.slice(1)).toEqual([TENANT, 73, ACTOR_UID, 'DELIVERY_STAFF']);
  });

  test('delivered: no matching custody row refuses with the custody code, not the handler', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'DELIVERY_STAFF' };
    db.deliveryCustodyRows = [];
    const res = await request(deliveryApp).post('/orders/73/delivered').send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PHARMACY_DELIVERY_CUSTODY_NOT_FOUND');
    expect(pharmacyOrderControllerMock.markDelivered).not.toHaveBeenCalled();
  });

  test('delivered: a role outside the custody tier is refused before the custody query runs', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'PHARMACY_STAFF' };
    db.deliveryCustodyRows = [{ id: 73 }];
    const res = await request(deliveryApp).post('/orders/73/delivered').send({});
    expect(res.status).toBe(403);
    expect(pharmacyOrderControllerMock.markDelivered).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM pharmacy_orders orders')))
      .toBeUndefined();
  });

  test('return request rides the same custody predicate as delivery completion', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'DELIVERY_STAFF' };
    db.deliveryCustodyRows = [{ id: 73 }];
    const allowed = await request(deliveryApp).post('/orders/73/delivery-return/request').send({});
    expect(allowed.status).toBe(200);
    expect(pharmacyOrderControllerMock.requestDeliveryReturn).toHaveBeenCalledTimes(1);

    db.deliveryCustodyRows = [];
    const refused = await request(deliveryApp).post('/orders/73/delivery-return/request').send({});
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('PHARMACY_DELIVERY_CUSTODY_NOT_FOUND');
    expect(pharmacyOrderControllerMock.requestDeliveryReturn).toHaveBeenCalledTimes(1);
  });

  test('handoff reissue and return completion are PHARMACY_INCHARGE-only and skip the custody predicate', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'DELIVERY_STAFF' };
    const reissueDenied = await request(deliveryApp).post('/orders/73/delivery-handoff/reissue').send({});
    expect(reissueDenied.status).toBe(403);
    const completeDenied = await request(deliveryApp).post('/orders/73/delivery-return/complete').send({});
    expect(completeDenied.status).toBe(403);

    actor = { id: 9, uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' };
    const reissue = await request(deliveryApp).post('/orders/73/delivery-handoff/reissue').send({});
    expect(reissue.status).toBe(200);
    expect(pharmacyOrderControllerMock.reissueDeliveryHandoff).toHaveBeenCalledTimes(1);
    const complete = await request(deliveryApp).post('/orders/73/delivery-return/complete').send({});
    expect(complete.status).toBe(200);
    expect(pharmacyOrderControllerMock.completeDeliveryReturn).toHaveBeenCalledTimes(1);

    // Neither incharge-only surface consults the in-transit custody row.
    expect(prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM pharmacy_orders orders')))
      .toBeUndefined();
  });
});
