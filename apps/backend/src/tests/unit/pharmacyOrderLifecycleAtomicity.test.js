import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';

const prismaQuery = jest.fn();
const txQuery = jest.fn();
const txExecute = jest.fn();
const emitPharmacyOrderEvent = jest.fn();
const logAudit = jest.fn();
const success = jest.fn();
const error = jest.fn();
const relayAppError = jest.fn();
const setTenantTx = jest.fn();
const assertVerificationCleared = jest.fn();
const assertVerificationClearedTx = jest.fn();
const ensurePackBarcode = jest.fn();
const clinicalOrderItemsSha256 = jest.fn(() => 'items-sha256');
const assertPharmacyCapForDispenseTx = jest.fn();
const releasePharmacyCapReservationTx = jest.fn();
const substitutionFundingAuthorityLease = Object.freeze({
  kind: 'substitution-funding-authority-test-lease',
});
const lockCounterFundingSubstitutionAuthorityTx = jest.fn(
  async () => substitutionFundingAuthorityLease,
);
const resolveAuthoritativeCounterFundingTx = jest.fn();
const materializePharmacyFundingAuthority = jest.fn();
const compensateTerminalPharmacyFundingAuthorityTx = jest.fn();
const requestedPharmacyFacilityId = jest.fn(() => null);
const resolvePharmacyFacility = jest.fn();
const allocateOrderInventoryTx = jest.fn();
const applyAuthoritativeDeliveryAllocations = jest.fn((lines) => lines);
const applyOrderPrescriptionProjectionTx = jest.fn();
const resolveCounterDispenseAuthorityTx = jest.fn(async (_tx, { lines }) => lines);
const dispenseSubstitutionCommand = jest.fn();
const findDispenseSubstitutionReplay = jest.fn(async () => null);
const resolvePrescriptionLineIndexes = jest.fn(() => []);
// Delivery handoff dependencies. The outbox queue must hand back a durable id:
// markDelivered refuses to complete a delivery whose patient notice could not
// be queued (PHARMACY_DELIVERY_COMPLETION_NOTICE_REQUIRED).
const outboxQueue = jest.fn(async () => ({ id: 9001 }));
const recordPatientFeedRow = jest.fn(async () => ({ written: true, notificationId: 9101 }));
const appendPharmacyDeliveryCustodyEventTx = jest.fn(async () => ({ id: 1 }));

// Migration 752/753 wrapped every pharmacy lifecycle transaction in supporting
// authority statements that are not what these tests are about: tenant
// merge-stability and pharmacy-catalog advisory locks, the
// pharmacy_order_command_receipts idempotency probe, the
// patient/courier identity reads, and the catalog + facility-inventory reads
// that resolve a confirmation line. Each is answered
// here by statement identity with a faithful default row, so the ordinal
// fixtures below stay pinned to the pharmacy_orders / pharmacy_order_history
// statements every test actually asserts on. Each supporting mock still records
// its calls, so a test can assert the gate ran.
const lockQuery = jest.fn(async () => []);
const receiptQuery = jest.fn(async () => []);
const catalogQuery = jest.fn(async () => []);
const inventoryItemQuery = jest.fn(async () => []);
const identityQuery = jest.fn(async () => []);

const SUPPORTING_QUERY_KINDS = [
  [/pg_advisory_xact_lock/, () => lockQuery],
  [/FROM pharmacy_order_command_receipts/, () => receiptQuery],
  [/FROM pharmacy_catalog/, () => catalogQuery],
  [/FROM pharmacy_inventory_items/, () => inventoryItemQuery],
  [/FROM users/, () => identityQuery],
];

function supportingMockFor(sql) {
  const text = String(sql);
  const hit = SUPPORTING_QUERY_KINDS.find(([pattern]) => pattern.test(text));
  return hit ? hit[1]() : null;
}

const tx = {
  $queryRawUnsafe: (sql, ...args) => {
    const supporting = supportingMockFor(sql);
    return supporting ? supporting(sql, ...args) : txQuery(sql, ...args);
  },
  $executeRawUnsafe: txExecute,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQuery },
  setTenantTx,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(),
  getSignedFileUrl: jest.fn(),
}));

jest.unstable_mockModule('../../utils/responseHelper.js', () => ({
  success,
  error,
  relayAppError,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit }));

jest.unstable_mockModule('../../controllers/delivery/deliveryTrackingController.js', () => ({
  calculateETA: jest.fn(() => ({ estimated_mins: 35, distance_km: 8.5 })),
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  assertPharmacyCapForDispenseTx,
  lockCounterFundingSubstitutionAuthorityTx,
  lockPharmacyFundingAuthorityTx: jest.fn(async () => ({})),
  releasePharmacyCapReservationTx,
  resolveAuthoritativeCounterFundingTx,
  resolvePharmacyFundingPatientUidTx: jest.fn(async () => ACTOR_UID),
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  assertPharmacyFacilityGrant: jest.fn(async () => ({
    actor_uid: ACTOR_UID,
    actor_role: 'PHARMACY_STAFF',
  })),
  pharmacyFacilityActorFromRequest: jest.fn((request) => ({
    actorUid: request.user?.uid,
    actorRole: request.user?.role,
  })),
  requestedPharmacyFacilityId,
  requireOrderFacility: jest.fn((orderValue) => Number(orderValue.facility_id)),
  resolveOrderPharmacyFacility: jest.fn(async () => ({ id: 7 })),
  resolvePharmacyFacility,
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: outboxQueue },
  default: { queue: outboxQueue },
}));

// Delivery custody now commits the patient inbox row its privacy-stripped push
// points at, inside the same transaction, and aborts when the row is not
// confirmed. That write resolves the recipient out of `users` and inserts into
// `notifications` — two more statements against the ordinal fixtures below,
// answering neither of them. It is supporting authority like the locks above,
// so it is doubled here with a confirmed receipt; that the call exists at all
// is what patientPushFeedRowCensus.test.js pins.
jest.unstable_mockModule('../../utils/notifications/patientNotificationFeed.js', () => ({
  recordPatientFeedNotification: recordPatientFeedRow,
  recordPatientFeedNotificationWithReceipt: recordPatientFeedRow,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyDeliveryCustodyService.js', () => ({
  appendPharmacyDeliveryCustodyEventTx,
  pharmacyDeliveryPackageEvidence: jest.fn((orderRow) => ({
    contract_version: Number(orderRow?.delivery_custody_contract_version) || 1,
    handoff_generation: Number(orderRow?.delivery_handoff_generation) || 1,
  })),
}));

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  compensateTerminalPharmacyFundingAuthorityTx,
  materializePharmacyFundingAuthority,
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
  emitPharmacyOrderEvent,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  assertVerificationCleared,
  assertVerificationClearedTx,
  clinicalOrderItemsSha256,
  ensurePackBarcode,
  // pharmacyOrderInventoryService imports both statically for the catalog
  // authority CAS migration 753 added: a sha256 the caller compares, and a
  // void advisory-lock helper (the real one only takes pg_advisory_xact_lock).
  clinicalCatalogAuthoritySha256Tx: jest.fn(async () => 'catalog-authority-sha256'),
  lockPharmacyCatalogAuthorityTx: jest.fn(async () => {}),
  verifyOrder: jest.fn(async () => ({})),
  getPackLabel: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/pharmacy/compositionFeatureService.js', () => ({
  isCompositionSearchEnabled: jest.fn(() => false),
}));

jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  resolveCompositionIdentitiesByCatalogIds: jest.fn(async () => new Map()),
}));

jest.unstable_mockModule('../../../scripts/backfill-drug-compositions.mjs', () => ({
  enrichCatalogRowForWrite: jest.fn((row) => row),
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyOrderInventoryService.js', () => ({
  allocateOrderInventoryTx,
  applyAuthoritativeDeliveryAllocations,
  applyOrderPrescriptionProjectionTx,
  resolveCounterDispenseAuthorityTx,
  createDispenseCommandIdentity: jest.fn(() => 'command-sha'),
  dispenseSubstitutionCommand,
  findDispenseSubstitutionReplay,
  resolvePrescriptionLineIndexes,
  substitutionWitnessPayload: jest.fn((body) => body),
}));

const {
  placeOrder,
  confirmOrder,
  markPreparing,
  dispatchOrder,
  markDelivered,
  markCounterDispensed,
  mergeDispensedItems,
  preserveBoundOrderLineIdentity,
  dispenseSubstitution,
  markUnavailable,
  cancelOrder,
  assignOrderFacility,
  getOrderDetail,
  getOrderQueue,
  resolveOrderLineIdentities,
} = await import('../../controllers/pharmacy/pharmacyOrderController.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '20000000-0000-4000-8000-000000000002';

function req(overrides = {}) {
  return {
    params: { id: '71' },
    body: {},
    query: {},
    tenantId: TENANT_ID,
    user: { id: 41, uid: ACTOR_UID, role: 'PHARMACY_STAFF' },
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 71,
    uid: '30000000-0000-4000-8000-000000000003',
    tenant_id: TENANT_ID,
    patient_id: 91,
    patient_name: 'Masked Test Patient',
    order_number: 'PO-71',
    status: 'CONFIRMED',
    total_amount: 0,
    items_list: [],
    facility_id: 7,
    inventory_authority_version: 1,
    clinical_verification_status: 'verified',
    delivery_type: 'delivery',
    created_at: new Date('2026-07-13T10:00:00Z'),
    updated_at: new Date('2026-07-13T10:05:00Z'),
    ...overrides,
  };
}

// The cleared-verification gate returns a provenance tuple, not void:
// markPreparing / dispatchOrder read verification.delivery_type off it to
// refuse a counter order in the delivery workflow, and the dispense paths read
// the medication + hash fields. A void stub made every caller dereference
// undefined.
// Capture-and-assert helper: the thrown AppError is returned so the test can
// pin its statusCode AND its machine-readable code. jest's toThrow() accepts
// only a message/class, which would leave the code unasserted.
function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it returned');
}

const CATALOG_ROWS = Object.freeze([
  { id: 17, name: 'Drug A', generic_name: 'drug-a', unit_price: 25 },
  { id: 18, name: 'Drug B', generic_name: 'drug-b', unit_price: 40 },
]);
const INVENTORY_ROWS = Object.freeze([
  { id: 5, catalog_id: 17, display_name: 'Drug A' },
  { id: 6, catalog_id: 18, display_name: 'Drug B' },
]);

const CLEARED_VERIFICATION = Object.freeze({
  enforced: true,
  status: 'verified',
  delivery_type: 'delivery',
  items_sha256: 'items-sha256',
  catalog_sha256: 'catalog-authority-sha256',
  active_therapy_sha256: 'active-therapy-sha256',
  knowledge_revision: 1,
  medications: [],
});

// ── Delivery custody fixture ───────────────────────────────────────────────
// Migration 753 made delivery completion consume a staged custody package: the
// order must be DISPATCHED and in_transit under contract v1, the one-time
// handoff token must hash to the stored sha256, every line must carry complete
// inventory evidence, and the funding projection must already be posted.
const COURIER_UID = '40000000-0000-4000-8000-000000000004';
const HANDOFF_TOKEN = 'handoff-token-0123456789abcdef';
const HANDOFF_SHA = createHash('sha256')
  .update(`${TENANT_ID}:71:${HANDOFF_TOKEN}`)
  .digest('hex');

function dispatchedOrder(overrides = {}) {
  return order({
    status: 'DISPATCHED',
    delivery_type: 'delivery',
    dispatched_at: new Date('2026-07-13T11:00:00Z'),
    delivery_custody_status: 'in_transit',
    delivery_custody_contract_version: 1,
    delivery_handoff_token_sha256: HANDOFF_SHA,
    delivery_handoff_generation: 1,
    delivery_handoff_consumed_at: null,
    delivery_assignee_uid: COURIER_UID,
    payment_status: 'paid',
    payment_metadata: {
      contract: 'pharmacy_delivery_funding_projection_v1',
      dispatch_command_sha256: 'dispatch-sha',
    },
    items_list: [{
      order_line_index: 0,
      catalog_id: 17,
      inventory_item_id: 5,
      ordered_qty: 1,
      quantity: 1,
      inventory_dispensed_quantity: 1,
      inventory_allocation_evidence: [{ movement_id: 501 }],
    }],
    ...overrides,
  });
}

// Dispatch stages the delivery package in one transaction and takes courier
// custody in a second. Both read the order joined to an active PATIENT row, and
// the second re-proves the staged tuple (authority version, clinical item hash,
// total) before it will hand over custody.
function dispatchOrderRow(overrides = {}) {
  return order({
    status: 'PREPARING',
    delivery_type: 'delivery',
    total_amount: 0,
    patient_phone: '+919000000001',
    canonical_patient_phone: '+919000000001',
    patient_uid: '30000000-0000-4000-8000-000000000003',
    delivery_address: '12 Test Street',
    items_list: [{
      order_line_index: 0,
      catalog_id: 17,
      inventory_item_id: 5,
      ordered_qty: 1,
      quantity: 1,
      line_total: 0,
    }],
    ...overrides,
  });
}

function dispatchArrange() {
  txQuery
    // TX1: the staging read, then the staging write
    .mockResolvedValueOnce([dispatchOrderRow()])
    .mockResolvedValueOnce([dispatchOrderRow()])
    // TX2: the custody read, then the guarded DISPATCHED transition
    .mockResolvedValueOnce([dispatchOrderRow()])
    .mockResolvedValueOnce([dispatchOrderRow({ status: 'DISPATCHED' })])
    // the pharmacy_order_history row
    .mockResolvedValueOnce([]);
}

function dispatchRequest() {
  // Courier identity is resolved from delivery_assignee_uid; passing a
  // caller-supplied delivery_person is now refused outright
  // (PHARMACY_DELIVERY_CALLER_IDENTITY_FORBIDDEN).
  return req({ body: { delivery_assignee_uid: COURIER_UID } });
}

function deliverRequest() {
  return req({
    user: { id: 44, uid: COURIER_UID, role: 'DELIVERY_STAFF' },
    body: { handoff_token: HANDOFF_TOKEN },
  });
}

function deliverArrange() {
  txQuery
    // the FOR UPDATE custody read
    .mockResolvedValueOnce([dispatchedOrder()])
    // every allocation movement still resolves inside this tenant/facility
    .mockResolvedValueOnce([{ id: 501 }])
    // the guarded DELIVERED transition
    .mockResolvedValueOnce([dispatchedOrder({
      status: 'DELIVERED',
      delivery_custody_status: 'delivered',
    })])
    // the pharmacy_order_history row
    .mockResolvedValueOnce([]);
}

function assertAtomicEvent(eventType, actorRole = 'PHARMACY_STAFF', actorUid = ACTOR_UID) {
  expect(setTenantTx).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
  expect(emitPharmacyOrderEvent).toHaveBeenCalledWith(expect.objectContaining({
    db: tx,
    actorUid,
    actorRole,
    eventType,
    order: expect.objectContaining({
      id: 71,
      tenant_id: TENANT_ID,
      patient_id: 91,
    }),
  }));
  // The ordering this invariant is about is the state-transition write, not
  // "whatever statement ran last": migration 753's counter-dispense path stamps
  // the pack barcode AFTER the canonical event, still inside the same
  // transaction, so .at(-1) no longer identifies the right statement. Anchor on
  // the pharmacy_order_history row instead — naming the write is stronger than
  // trusting position, and it keeps the assertion true for every handler.
  const historyIndex = txQuery.mock.calls.findIndex(
    (call) => /INSERT INTO pharmacy_order_history/.test(String(call[0])),
  );
  expect(historyIndex).toBeGreaterThanOrEqual(0);
  const historyWrite = txQuery.mock.invocationCallOrder[historyIndex];
  const canonicalWrite = emitPharmacyOrderEvent.mock.invocationCallOrder.at(-1);
  expect(historyWrite).toBeLessThan(canonicalWrite);
}

describe('pharmacy order lifecycle canonical atomicity', () => {
  let immediateSpy;

  beforeAll(() => {
    immediateSpy = jest.spyOn(global, 'setImmediate').mockImplementation(() => ({ unref() {} }));
  });

  afterAll(() => {
    immediateSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // jest.clearAllMocks() clears recorded calls but NOT queued one-shot
    // values. Before migration 753 every arrange drained its own queue, so the
    // leak was invisible; now that each handler issues a different number of
    // statements, an unreached mockResolvedValueOnce survives into the next
    // test and silently feeds it another test's row. Reset the queue-carrying
    // mocks explicitly — their defaults are re-established below.
    [prismaQuery, txQuery, txExecute, emitPharmacyOrderEvent,
      ensurePackBarcode, findDispenseSubstitutionReplay,
      catalogQuery, inventoryItemQuery, identityQuery]
      .forEach((mock) => mock.mockReset());
    findDispenseSubstitutionReplay.mockResolvedValue(null);
    lockQuery.mockResolvedValue([]);
    receiptQuery.mockResolvedValue([]);
    // Governed, active catalog rows and exactly one facility inventory item per
    // catalog — the shape both confirmation resolvers demand before they will
    // price a line. Both filter on the bound id array the way the real
    // statements do, so a caller asking for one catalog never sees two rows
    // (which would trip the catalogs.length !== catalogIds.length guard).
    catalogQuery.mockImplementation(async (_sql, ...args) => {
      const ids = args.find((arg) => Array.isArray(arg)) || [];
      return CATALOG_ROWS.filter((row) => ids.includes(row.id));
    });
    inventoryItemQuery.mockImplementation(async (_sql, ...args) => {
      const ids = args.find((arg) => Array.isArray(arg)) || [];
      return INVENTORY_ROWS.filter((row) => ids.includes(row.catalog_id));
    });
    // The active patient / assigned courier identity reads. One row carrying
    // both column vocabularies, so the same default satisfies the patient
    // lookup (id/uid/name/phone) and the courier assignee lookup
    // (uid/id/user_name/staff_name/phone).
    identityQuery.mockResolvedValue([{
      id: 91,
      uid: ACTOR_UID,
      name: 'Masked Test Patient',
      user_name: 'Masked Test Patient',
      staff_name: 'Masked Test Patient',
      phone: '+919000000001',
      canonical_patient_phone: '+919000000001',
    }]);
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(tx));
    emitPharmacyOrderEvent.mockResolvedValue({ id: 'canonical-1' });
    logAudit.mockResolvedValue(undefined);
    assertVerificationCleared.mockResolvedValue(CLEARED_VERIFICATION);
    assertVerificationClearedTx.mockResolvedValue(CLEARED_VERIFICATION);
    ensurePackBarcode.mockResolvedValue('PACK-71');
    assertPharmacyCapForDispenseTx.mockResolvedValue({ message: null });
    releasePharmacyCapReservationTx.mockResolvedValue(null);
    compensateTerminalPharmacyFundingAuthorityTx.mockResolvedValue({ status: 'compensated' });
    materializePharmacyFundingAuthority.mockResolvedValue({ status: 'funded' });
    resolveAuthoritativeCounterFundingTx.mockResolvedValue({
      fundedAmount: 0,
      fundingSource: null,
      fundingReference: null,
    });
    resolvePharmacyFacility.mockResolvedValue({
      id: 7,
      facility_code: 'MAIN',
      display_name: 'Main Pharmacy',
    });
    allocateOrderInventoryTx.mockImplementation(async (_tx, { lines }) => ({
      lines,
      allocations: [],
    }));
    txExecute.mockResolvedValue(1);
    resolvePrescriptionLineIndexes.mockReturnValue([]);
  });

  it.each([
    {
      name: 'place',
      eventType: 'pharmacy.order_created',
      arrange() {
        // The patient identity read moved inside the tenant transaction
        // (identityQuery answers it); what stays on the ordinal queue is the
        // order INSERT and its history row.
        txQuery
          .mockResolvedValueOnce([order({ status: 'PENDING', delivery_type: 'delivery' })])
          .mockResolvedValueOnce([]);
      },
      run: () => placeOrder(req({
        params: {},
        user: { id: 91, uid: ACTOR_UID, role: 'PATIENT' },
        body: {
          order_note: 'Prescription refill',
          delivery_address: '12 Test Street',
          delivery_phone: '+919000000001',
        },
      }), {}),
      actorRole: 'PATIENT',
    },
    {
      name: 'confirm',
      eventType: 'pharmacy.order_confirmed',
      arrange() {
        prismaQuery.mockResolvedValueOnce([order({ status: 'PENDING', phone: '+919000000001' })]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'PENDING' })])
          // assertLinkedPrescriptionPatientAuthorityTx: no linked prescription,
          // so the order confirms through the manual/catalog path.
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([order({ status: 'CONFIRMED' })])
          .mockResolvedValueOnce([]);
      },
      // An empty items_list is now refused outright
      // (PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED): a manual/photo order has
      // to name at least one governed catalog line, priced from the catalog
      // row rather than from the caller's number.
      run: () => confirmOrder(req({
        body: {
          items_list: [{ order_line_index: 0, catalog_id: 17, quantity: 1 }],
          // Priced from the catalog row, not from the caller: a submitted total
          // that disagrees is refused as PHARMACY_ORDER_TOTAL_MISMATCH.
          total_amount: 25,
        },
      }), {}),
    },
    {
      name: 'prepare',
      eventType: 'pharmacy.order_preparing',
      arrange() {
        txQuery
          .mockResolvedValueOnce([order({ status: 'PREPARING' })])
          .mockResolvedValueOnce([]);
      },
      run: () => markPreparing(req(), {}),
    },
    {
      name: 'dispatch',
      eventType: 'pharmacy.order_dispatched',
      arrange: dispatchArrange,
      run: () => dispatchOrder(dispatchRequest(), {}),
    },
    {
      name: 'deliver',
      eventType: 'pharmacy.order_delivered',
      arrange: deliverArrange,
      run: () => markDelivered(deliverRequest(), {}),
      actorRole: 'DELIVERY_STAFF',
      // Delivery is completed by the assigned courier, not the pharmacy actor.
      actorUid: COURIER_UID,
    },
    {
      name: 'counter dispense',
      eventType: 'pharmacy.order_dispensed',
      arrange() {
        // Counter dispense refuses anything the verification tuple does not
        // report as a counter order, so the cleared gate has to say so.
        assertVerificationClearedTx.mockResolvedValue({
          ...CLEARED_VERIFICATION, delivery_type: 'counter',
        });
        txQuery
          .mockResolvedValueOnce([order({ status: 'PENDING', delivery_type: 'counter' })])
          .mockResolvedValueOnce([order({
            status: 'PENDING', delivery_type: 'counter', payment_mode: 'none',
          })])
          .mockResolvedValueOnce([order({
            status: 'PENDING', delivery_type: 'counter', payment_mode: 'none',
          })])
          .mockResolvedValueOnce([order({ status: 'DISPENSED', delivery_type: 'counter', payment_status: 'paid' })])
          .mockResolvedValueOnce([])
          // The pack barcode is stamped after the canonical event, still inside
          // the same transaction, and the handler reads the RETURNING row.
          .mockResolvedValueOnce([{ pack_barcode: 'VHMP-71-COUNTER1' }]);
      },
      run: () => markCounterDispensed(req({ body: { payment_mode: 'none' } }), {}),
    },
    {
      name: 'unavailable',
      eventType: 'pharmacy.order_unavailable',
      arrange() {
        txQuery
          .mockResolvedValueOnce([order({ status: 'CONFIRMED' })])
          .mockResolvedValueOnce([order({ status: 'UNAVAILABLE' })])
          .mockResolvedValueOnce([])
          // reopenLinkedPrescriptionRemainderTx: nothing to reopen.
          .mockResolvedValueOnce([]);
      },
      run: () => markUnavailable(req({ body: { reason: 'Out of stock' } }), {}),
    },
    {
      name: 'cancel',
      eventType: 'pharmacy.order_cancelled',
      arrange() {
        txQuery
          .mockResolvedValueOnce([order({ status: 'PENDING' })])
          .mockResolvedValueOnce([order({ status: 'CANCELLED' })])
          .mockResolvedValueOnce([])
          // reopenLinkedPrescriptionRemainderTx: nothing to reopen.
          .mockResolvedValueOnce([]);
      },
      run: () => cancelOrder(req({ body: { cancellation_reason: 'Patient request' } }), {}),
    },
  ])('$name persists history before emitting the canonical event in the tenant transaction', async ({
    arrange,
    run,
    eventType,
    actorRole,
    actorUid,
  }) => {
    arrange();
    await run();

    assertAtomicEvent(eventType, actorRole || 'PHARMACY_STAFF', actorUid || ACTOR_UID);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('propagates a canonical emitter failure out of the transaction and skips post-commit audit', async () => {
    let transactionRejected = false;
    setTenantTx.mockImplementation(async (_tenantId, callback) => {
      try {
        return await callback(tx);
      } catch (err) {
        transactionRejected = true;
        throw err;
      }
    });
    txQuery
      .mockResolvedValueOnce([order({ status: 'PREPARING' })])
      .mockResolvedValueOnce([]);
    emitPharmacyOrderEvent.mockRejectedValueOnce(new Error('canonical insert failed'));

    await markPreparing(req(), {});

    expect(transactionRejected).toBe(true);
    expect(success).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    // markPreparing was ported onto responseHelper.relayAppError, so a raw
    // emitter failure is relayed with the error itself rather than flattened to
    // a message + status pair. Asserting the thrown Error identity is stronger
    // than the old ('Failed to update order', 500) tuple: it proves the
    // canonical-insert failure is what reached the caller, and `error` staying
    // untouched proves nothing fell through to the generic 500 path.
    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'canonical insert failed' }),
      'Failed to update order',
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('does not write history or emit an event when the guarded update returns null', async () => {
    txQuery.mockResolvedValueOnce([]);

    await markPreparing(req(), {});

    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(emitPharmacyOrderEvent).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    // The guarded UPDATE returning no row is now a typed conflict relayed
    // through relayAppError. Pinning statusCode 409 + the machine-readable code
    // is strictly stronger than the old message/400 pair, which asserted
    // neither the code a client branches on nor the correct status class.
    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 409,
        code: 'PHARMACY_ORDER_PREPARING_WRONG_STATUS',
      }),
      'Failed to update order',
    );
    expect(error).not.toHaveBeenCalled();
  });

  // The original obligation was: a COMMITTED delivery must never be turned into
  // a 5xx by a best-effort pack-barcode call, so the response carried
  // pack_barcode_pending + a recovery endpoint. markDelivered no longer issues a
  // barcode at all — the pack label is a separate governed artefact — which
  // satisfies that obligation by construction. Pinning "no barcode call is made
  // on this path" is stronger than pinning the recovery payload: the failure
  // mode the recovery payload existed to absorb can no longer occur.
  it('commits delivery without any best-effort pack-barcode side effect', async () => {
    deliverArrange();

    await markDelivered(deliverRequest(), {});

    expect(ensurePackBarcode).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 71, status: 'DELIVERED' }),
      'Delivered',
    );
    expect(relayAppError).not.toHaveBeenCalled();
  });

  // Replay detection and the pack identity both moved INSIDE
  // dispenseSubstitutionCommand: the barcode is now written in the same
  // transaction as the movement and a failure to persist it aborts the command
  // (PHARMACY_PACK_BARCODE_PERSISTENCE_FAILED), so a replayed payload always
  // reports pack_barcode_pending: false. There is no controller-side replay
  // short-circuit and no best-effort barcode call left to fail. Pinning the
  // delegation contract and the transactional pack identity is stronger than
  // the old deferred-recovery payload, which allowed a committed dispense to
  // exist with no pack identity at all.
  it('delegates substitution dispense with exact command identity and a transactional pack barcode', async () => {
    const replayedPayload = {
      movement_id: 501,
      order_id: 71,
      prescription_id: 81,
      fulfilment_status: 'partial',
      pack_barcode: 'VHMP-71-COMMANDS',
      pack_barcode_pending: false,
    };
    dispenseSubstitutionCommand.mockResolvedValueOnce(replayedPayload);

    await dispenseSubstitution(req({
      body: { order_id: 71, prescription_id: 81 },
    }), {});

    expect(dispenseSubstitutionCommand).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      body: { order_id: 71, prescription_id: 81 },
      actorUid: ACTOR_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKeySha256: 'command-sha',
      contextResolver: expect.any(Function),
    }));
    expect(ensurePackBarcode).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(
      expect.anything(),
      replayedPayload,
      'Substitution dispensed',
    );
    expect(relayAppError).not.toHaveBeenCalled();
  });

  it('tenant- and facility-binds queue reads while surfacing legacy-null recovery only to authority roles', async () => {
    prismaQuery.mockResolvedValueOnce([order({
      status: 'PENDING',
      facility_id: null,
      facility_recovery_required: true,
      facility_recovery_target_id: 7,
    })]);

    await getOrderQueue(req({
      params: {},
      user: { id: 41, uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' },
    }), {});

    const [sql, tenantId, facilityId] = prismaQuery.mock.calls[0];
    expect(sql).toMatch(/po\.tenant_id=\$1::uuid/);
    expect(sql).toMatch(/po\.facility_id=\$2::int OR po\.facility_id IS NULL/);
    expect(sql).toMatch(/facility_recovery_required/);
    expect(sql).toMatch(/facility_recovery_target_id/);
    expect(sql).toMatch(/rx_link\.prescription_medications/);
    expect(sql).toMatch(/line_identity_recovery_required/);
    expect(sql).toMatch(/linked_prescription_count=1/);
    expect([tenantId, facilityId]).toEqual([TENANT_ID, 7]);
    expect(success).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ facility_recovery_required: true })],
      'Order queue',
    );
  });

  it('repairs every legacy line through an exact operator-supplied prescription mapping', async () => {
    const legacyLines = [
      { catalog_id: 17, name: 'Drug A', quantity: 2 },
      { catalog_id: 18, name: 'Drug B', quantity: 1 },
    ];
    const mappedLines = [
      { ...legacyLines[0], order_line_index: 0, prescription_line_index: 1 },
      { ...legacyLines[1], order_line_index: 1, prescription_line_index: 0 },
    ];
    const medications = [
      { catalog_id: 18, quantity: 1 },
      { catalog_id: 17, quantity: 2 },
    ];
    txQuery
      .mockResolvedValueOnce([order({ status: 'CONFIRMED', items_list: legacyLines })])
          // assertLinkedPrescriptionPatientAuthorityTx now reads the linkage
          // twice: the raw links, then the same links re-joined through the
          // order and an active same-tenant patient. Equal lengths is what
          // proves the prescription still resolves to the order's patient.
      .mockResolvedValueOnce([{ id: 81 }])
      .mockResolvedValueOnce([{ id: 81, status: 'ACTIVE', medications, revision: 1 }])
      .mockResolvedValueOnce([order({
        status: 'CONFIRMED',
        items_list: mappedLines,
        inventory_authority_version: 2,
        clinical_verification_status: 'pending',
      })])
      .mockResolvedValueOnce([]);

    await resolveOrderLineIdentities(req({
      body: {
        line_mappings: [
          { order_line_index: 0, prescription_line_index: 1 },
          { order_line_index: 1, prescription_line_index: 0 },
        ],
      },
      user: { id: 41, uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' },
    }), {});

    expect(setTenantTx).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(txQuery.mock.calls[0][0]).toMatch(
      /tenant_id=\$1::uuid AND id=\$2::int AND facility_id=\$3::int[\s\S]*FOR UPDATE/,
    );
    expect(txQuery.mock.calls[1][0]).toMatch(
      /FROM e_prescriptions ep[\s\S]*ep\.tenant_id=\$1::uuid AND ep\.pharmacy_order_id=\$2::int[\s\S]*FOR UPDATE/,
    );
    // The second linkage read is the authority proof, not a repeat: it re-joins
    // the same prescriptions through the order and an active, unmerged
    // same-tenant PATIENT row, and a shorter result is refused as
    // PHARMACY_ORDER_PRESCRIPTION_PATIENT_MISMATCH.
    expect(txQuery.mock.calls[2][0]).toMatch(
      /FROM e_prescriptions ep[\s\S]*JOIN pharmacy_orders po[\s\S]*JOIN users patient[\s\S]*patient\.role='PATIENT'[\s\S]*patient\.merged_into_uid IS NULL/,
    );
    // Only the identity pair crosses into the resolver now — the operator's
    // mapping can no longer carry line content, which is rebuilt from the
    // prescription and catalog below. Exact array equality is what proves
    // catalog_id / name / quantity did not ride along.
    expect(resolvePrescriptionLineIndexes).toHaveBeenCalledWith(
      [
        { order_line_index: 0, prescription_line_index: 1 },
        { order_line_index: 1, prescription_line_index: 0 },
      ],
      medications,
    );
    expect(txQuery.mock.calls[3][0]).toMatch(/items_list=\$3::jsonb/);
    expect(txQuery.mock.calls[3][0]).toMatch(
      /inventory_authority_version=inventory_authority_version\+1/,
    );
    expect(txQuery.mock.calls[3][0]).toMatch(/clinical_verification_safety_version=NULL/);
    // The persisted tuple is the authoritative rebuild: catalog name and price,
    // the prescription's ordered quantity, and the one active facility
    // inventory item for that catalog. Pinning it exactly is strictly stronger
    // than the old JSON.stringify(mappedLines) — that only proved the caller's
    // own lines were echoed back.
    expect(txQuery.mock.calls[3].slice(1)).toEqual([
      TENANT_ID,
      71,
      JSON.stringify([
        {
          order_line_index: 0,
          prescription_line_index: 1,
          catalog_id: 17,
          inventory_item_id: 5,
          name: 'Drug A',
          generic_name: 'drug-a',
          quantity: 2,
          qty: 2,
          ordered_qty: 2,
          dose: null,
          strength: null,
          form: null,
          frequency: null,
          route: null,
          days: null,
          instructions: null,
          price: 25,
          line_total: 50,
        },
        {
          order_line_index: 1,
          prescription_line_index: 0,
          catalog_id: 18,
          inventory_item_id: 6,
          name: 'Drug B',
          generic_name: 'drug-b',
          quantity: 1,
          qty: 1,
          ordered_qty: 1,
          dose: null,
          strength: null,
          form: null,
          frequency: null,
          route: null,
          days: null,
          instructions: null,
          price: 40,
          line_total: 40,
        },
      ]),
      7,
      // The authoritative total is recomputed from catalog price x prescribed
      // quantity (25*2 + 40*1) and bound alongside the lines, so a repair can
      // never leave the order's money out of step with its medication tuple.
      90,
    ]);
    expect(success).toHaveBeenCalledWith(
      expect.anything(),
      // The response echoes the UPDATE's RETURNING row, not the pre-read one:
      // the bumped authority version and the reset verification status are what
      // distinguish them, and they are the repair's real obligation — a
      // re-identified order must go back through pharmacist verification.
      // (The controller emits no `idempotent_replay` flag; the no-op case is
      // covered by its own `changed: false` branch, which never reaches this
      // UPDATE at all.)
      expect.objectContaining({
        items_list: mappedLines,
        inventory_authority_version: 2,
        clinical_verification_status: 'pending',
      }),
      'Prescription line identities resolved',
    );
  });

  it('rejects an incomplete legacy line mapping before any order mutation', async () => {
    const legacyLines = [
      { catalog_id: 17, name: 'Drug A', quantity: 2 },
      { catalog_id: 18, name: 'Drug B', quantity: 1 },
    ];
    txQuery
      .mockResolvedValueOnce([order({ status: 'CONFIRMED', items_list: legacyLines })])
          // assertLinkedPrescriptionPatientAuthorityTx now reads the linkage
          // twice: the raw links, then the same links re-joined through the
          // order and an active same-tenant patient. Equal lengths is what
          // proves the prescription still resolves to the order's patient.
      .mockResolvedValueOnce([{ id: 81 }])
      .mockResolvedValueOnce([{
        id: 81, status: 'ACTIVE', medications: legacyLines, revision: 1,
      }]);

    await resolveOrderLineIdentities(req({
      body: { line_mappings: [{ order_line_index: 0, prescription_line_index: 0 }] },
      user: { id: 41, uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' },
    }), {});

    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 422,
        code: 'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_INCOMPLETE',
      }),
      'Failed to resolve prescription line identities',
    );
    expect(resolvePrescriptionLineIndexes).not.toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalledTimes(3);
  });

  it('rejects duplicate order and prescription line targets during explicit repair', async () => {
    const legacyLines = [
      { catalog_id: 17, name: 'Drug A', quantity: 2 },
      { catalog_id: 17, name: 'Drug A', quantity: 2 },
    ];
    txQuery
      .mockResolvedValueOnce([order({ status: 'CONFIRMED', items_list: legacyLines })])
          // assertLinkedPrescriptionPatientAuthorityTx now reads the linkage
          // twice: the raw links, then the same links re-joined through the
          // order and an active same-tenant patient. Equal lengths is what
          // proves the prescription still resolves to the order's patient.
      .mockResolvedValueOnce([{ id: 81 }])
      .mockResolvedValueOnce([{
        id: 81, status: 'ACTIVE', medications: legacyLines, revision: 1,
      }]);

    await resolveOrderLineIdentities(req({
      body: {
        line_mappings: [
          { order_line_index: 0, prescription_line_index: 0 },
          { order_line_index: 0, prescription_line_index: 1 },
        ],
      },
      user: { id: 41, uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' },
    }), {});

    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 422,
        code: 'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_INVALID',
      }),
      'Failed to resolve prescription line identities',
    );
    expect(resolvePrescriptionLineIndexes).not.toHaveBeenCalled();

    jest.clearAllMocks();
    // Same one-shot-queue hazard as beforeEach: the first half of this test may
    // leave queued rows behind, and they would feed the re-arrange below.
    txQuery.mockReset();
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(tx));
    resolvePharmacyFacility.mockResolvedValue({ id: 7 });
    resolvePrescriptionLineIndexes.mockImplementationOnce(() => {
      const duplicateError = new Error('Duplicate prescription line identity');
      duplicateError.statusCode = 409;
      duplicateError.code = 'PHARMACY_ORDER_PRESCRIPTION_LINE_AMBIGUOUS';
      throw duplicateError;
    });
    txQuery
      .mockResolvedValueOnce([order({ status: 'CONFIRMED', items_list: legacyLines })])
          // assertLinkedPrescriptionPatientAuthorityTx now reads the linkage
          // twice: the raw links, then the same links re-joined through the
          // order and an active same-tenant patient. Equal lengths is what
          // proves the prescription still resolves to the order's patient.
      .mockResolvedValueOnce([{ id: 81 }])
      .mockResolvedValueOnce([{
        id: 81, status: 'ACTIVE', medications: legacyLines, revision: 1,
      }]);

    // Structurally valid mapping — a repeated prescription index is now refused
    // by the mapping validator itself (asserted above), so it can no longer
    // reach the resolver. This half pins the other half of the contract: an
    // ambiguity the RESOLVER raises is relayed unchanged, not swallowed.
    await resolveOrderLineIdentities(req({
      body: {
        line_mappings: [
          { order_line_index: 0, prescription_line_index: 0 },
          { order_line_index: 1, prescription_line_index: 1 },
        ],
      },
      user: { id: 41, uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' },
    }), {});

    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 409,
        code: 'PHARMACY_ORDER_PRESCRIPTION_LINE_AMBIGUOUS',
      }),
      'Failed to resolve prescription line identities',
    );
    expect(txQuery).toHaveBeenCalledTimes(3);
  });

  it('tenant- and facility-binds both order detail and history under RLS-bypassed mocks', async () => {
    prismaQuery
      .mockResolvedValueOnce([order()])
      .mockResolvedValueOnce([]);

    await getOrderDetail(req(), {});

    expect(prismaQuery.mock.calls[0][0]).toMatch(
      /WHERE id=\$1 AND tenant_id=\$2::uuid AND facility_id=\$3::int/,
    );
    expect(prismaQuery.mock.calls[0].slice(1)).toEqual([71, TENANT_ID, 7]);
    expect(prismaQuery.mock.calls[1][0]).toMatch(
      /WHERE order_id=\$1 AND tenant_id=\$2::uuid/,
    );
    expect(prismaQuery.mock.calls[1].slice(1)).toEqual([71, TENANT_ID]);
  });

  it('assigns a facility-null legacy order only inside the tenant transaction', async () => {
    txQuery
      .mockResolvedValueOnce([order({ facility_id: null, status: 'CONFIRMED' })])
      .mockResolvedValueOnce([order({ facility_id: 7, status: 'CONFIRMED' })])
      .mockResolvedValueOnce([]);

    await assignOrderFacility(req({
      body: { facility_id: 7 },
      user: { id: 41, uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' },
    }), {});

    expect(setTenantTx).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    // The actor identity now travels into the facility resolution: migration
    // 752/753 made pharmacy custody grant-backed with no admin bypass, so the
    // facility can only be resolved on behalf of a named actor and role.
    // Pinning both is strictly stronger than the previous three-key object,
    // which would still have passed had the identity been dropped.
    expect(resolvePharmacyFacility).toHaveBeenCalledWith(tx, {
      tenantId: TENANT_ID,
      actorUid: ACTOR_UID,
      actorRole: 'PHARMACY_INCHARGE',
      requestedFacilityId: 7,
      forUpdate: true,
    });
    expect(txQuery.mock.calls[0][0]).toMatch(/tenant_id=\$1::uuid AND id=\$2::int[\s\S]*FOR UPDATE/);
    expect(txQuery.mock.calls[1][0]).toMatch(/facility_id=\$3::int/);
    expect(txQuery.mock.calls[1][0]).toMatch(/WHERE tenant_id=\$1::uuid AND id=\$2::int AND facility_id IS NULL/);
    expect(txQuery.mock.calls[1][0]).toMatch(/inventory_authority_version=inventory_authority_version\+1/);
    expect(txQuery.mock.calls[1][0]).toMatch(/clinical_verification_status='pending'/);
    expect(txQuery.mock.calls[1].slice(1)).toEqual([TENANT_ID, 71, 7]);
  });

  it('does not let ordinary pharmacy staff claim a legacy facility-null order', async () => {
    await assignOrderFacility(req({ body: { facility_id: 7 } }), {});

    expect(setTenantTx).not.toHaveBeenCalled();
    expect(resolvePharmacyFacility).not.toHaveBeenCalled();
    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 403,
        code: 'PHARMACY_FACILITY_ASSIGNMENT_FORBIDDEN',
      }),
      'Failed to assign order facility',
    );
  });

  it.each([
    ['unavailable', markUnavailable, { reason: 'Remainder unavailable' }, 'UNAVAILABLE'],
    ['cancel', cancelOrder, { cancellation_reason: 'Patient declined remainder' }, 'CANCELLED'],
  ])('fails closed before a partially dispensed order can be closed as %s', async (
    _name,
    handler,
    body,
  ) => {
    txQuery
      .mockResolvedValueOnce([order({ status: 'PARTIALLY_DISPENSED' })]);

    await handler(req({ body }), {});

    expect(compensateTerminalPharmacyFundingAuthorityTx).not.toHaveBeenCalled();
    expect(txQuery.mock.calls[0][0]).toMatch(/tenant_id=\$2::uuid AND facility_id=\$3::int/);
    expect(txQuery.mock.calls[0].slice(1)).toEqual([71, TENANT_ID, 7]);
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 409,
        code: 'PHARMACY_TERMINAL_PARTIAL_DISPENSE_COMPENSATION_REQUIRED',
      }),
      expect.stringMatching(/Failed to (mark order unavailable|cancel order)/),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it('locks verification provenance before preparing mutates the order', async () => {
    txQuery
      .mockResolvedValueOnce([order({ status: 'PREPARING' })])
      .mockResolvedValueOnce([]);

    await markPreparing(req(), {});

    expect(assertVerificationClearedTx).toHaveBeenCalledWith(tx, {
      orderId: 71,
      tenantId: TENANT_ID,
    });
    expect(assertVerificationClearedTx.mock.invocationCallOrder[0])
      .toBeLessThan(txQuery.mock.invocationCallOrder[0]);
    expect(txQuery.mock.calls[0][0]).toMatch(/tenant_id=\$2::uuid AND facility_id=\$3::int/);
  });

  it('locks verification provenance before dispatch mutates the order', async () => {
    // The staging read finds nothing, so the flow stops at its first statement.
    // That is all this test needs: the verification gate must already have run,
    // and nothing may have been written.
    txQuery.mockResolvedValueOnce([]);

    await dispatchOrder(dispatchRequest(), {});

    expect(assertVerificationClearedTx).toHaveBeenCalledWith(tx, {
      orderId: 71,
      tenantId: TENANT_ID,
    });
    expect(assertVerificationClearedTx.mock.invocationCallOrder[0])
      .toBeLessThan(txQuery.mock.invocationCallOrder[0]);
    // The first statement is the tenant- and facility-bound custody read, joined
    // to an active PATIENT row. Pinning the join is stronger than the previous
    // bind-position match on the UPDATE: it proves dispatch cannot even LOOK at
    // an order outside this tenant/facility, or one whose patient is no longer
    // active, before it mutates anything.
    expect(txQuery.mock.calls[0][0]).toMatch(
      /pharmacy_order\.tenant_id=\$2::uuid[\s\S]*pharmacy_order\.facility_id=\$3::int/,
    );
    expect(txQuery.mock.calls[0][0]).toMatch(
      /JOIN users patient[\s\S]*patient\.role='PATIENT'[\s\S]*patient\.merged_into_uid IS NULL/,
    );
    expect(txQuery.mock.calls.some(
      (call) => /UPDATE pharmacy_orders/.test(String(call[0])),
    )).toBe(false);
  });

  it('blocks an explicit partial counter fill before funding or stock mutation', async () => {
    const originalItems = [
      { order_line_index: 0, catalog_id: 17, name: 'Drug A', quantity: 2 },
      { order_line_index: 1, catalog_id: 18, name: 'Drug B', quantity: 3 },
    ];
    // Counter dispense refuses anything the verification tuple does not report
    // as a counter order, so the cleared gate has to say so before the partial
    // -fill guard under test can be reached.
    assertVerificationClearedTx.mockResolvedValue({
      ...CLEARED_VERIFICATION, delivery_type: 'counter',
    });
    txQuery
      .mockResolvedValueOnce([order({
        status: 'CONFIRMED',
        delivery_type: 'counter',
        items_list: originalItems,
      })]);

    await markCounterDispensed(req({
      body: {
        dispensed_items: [{
          order_line_index: 0,
          catalog_id: 17,
          dispensed_quantity: 1,
        }],
        partial_dispense: true,
        partial_reason: 'Only one unit available',
        payment_mode: 'cash',
        amount_collected: 10,
      },
    }), {});

    expect(resolveCounterDispenseAuthorityTx).not.toHaveBeenCalled();
    expect(materializePharmacyFundingAuthority).not.toHaveBeenCalled();
    expect(allocateOrderInventoryTx).not.toHaveBeenCalled();
    expect(relayAppError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 409,
        code: 'PHARMACY_PARTIAL_DISPENSE_FUNDING_SPLIT_REQUIRED',
      }),
      'Failed to dispense order',
    );
  });
});

describe('counter dispense authoritative line identity', () => {
  const duplicateCatalogLines = [
    { catalog_id: 17, name: 'Drug A', quantity: 2 },
    { catalog_id: 17, name: 'Drug A', quantity: 3 },
  ];

  test('rejects a catalog match without a stable order line index', () => {
    let thrown;
    try {
      mergeDispensedItems(duplicateCatalogLines, [
        { catalog_id: 17, dispensed_quantity: 1 },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_ORDER_DISPENSE_LINE_INVALID',
    });
  });

  test('updates only the exact indexed line and rejects duplicate targeting', () => {
    const result = mergeDispensedItems(duplicateCatalogLines, [
      { order_line_index: 1, catalog_id: 17, dispensed_quantity: 2 },
    ]);

    expect(result.items[0]).toMatchObject({ dispensed_qty: 0 });
    expect(result.items[1]).toMatchObject({
      order_line_index: 1,
      ordered_qty: 3,
      dispensed_qty: 2,
    });
    let duplicateThrown;
    try {
      mergeDispensedItems(duplicateCatalogLines, [
        { order_line_index: 0, catalog_id: 17, dispensed_quantity: 1 },
        { order_line_index: 0, catalog_id: 17, dispensed_quantity: 1 },
      ]);
    } catch (error) {
      duplicateThrown = error;
    }
    expect(duplicateThrown).toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_ORDER_DISPENSE_LINE_DUPLICATE',
    });
  });
});

describe('prescription order confirmation line identity', () => {
  test('preserves producer-bound duplicate lines instead of accepting caller replacement', () => {
    const authoritative = [
      {
        order_line_index: 0,
        prescription_line_index: 0,
        catalog_id: 17,
        qty: 2,
      },
      {
        order_line_index: 1,
        prescription_line_index: 1,
        catalog_id: 17,
        qty: 3,
      },
    ];

    // A caller tuple that differs from the producer-bound one is now REFUSED
    // rather than silently ignored. That is strictly stronger: the caller
    // learns its write was rejected instead of believing it took effect, and
    // the typed code is what a client branches on.
    const thrown = thrownBy(() => preserveBoundOrderLineIdentity(authoritative, [
      { name: 'Caller replacement', qty: 99, price: 0 },
    ]));
    expect(thrown).toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_ORDER_ITEMS_IMMUTABLE',
    });

    // With nothing requested, the producer-bound tuple survives intact —
    // including the two lines that share catalog_id 17 and are distinguishable
    // only by their prescription line identity.
    expect(preserveBoundOrderLineIdentity(authoritative, undefined)).toEqual(authoritative);
  });
});
