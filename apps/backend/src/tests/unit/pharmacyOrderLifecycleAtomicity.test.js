import { jest } from '@jest/globals';

const prismaQuery = jest.fn();
const txQuery = jest.fn();
const txExecute = jest.fn();
const emitPharmacyOrderEvent = jest.fn();
const logAudit = jest.fn();
const success = jest.fn();
const error = jest.fn();
const setTenantTx = jest.fn();
const assertVerificationCleared = jest.fn();
const ensurePackBarcode = jest.fn();
const probePharmacyCap = jest.fn();
const shouldBlockDispense = jest.fn();

const tx = {
  $queryRawUnsafe: txQuery,
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
  relayAppError: jest.fn(),
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit }));

jest.unstable_mockModule('../../controllers/delivery/deliveryTrackingController.js', () => ({
  calculateETA: jest.fn(() => ({ estimated_mins: 35, distance_km: 8.5 })),
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  probePharmacyCap,
  shouldBlockDispense,
}));

jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitPharmacyOrderEvent,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  assertVerificationCleared,
  ensurePackBarcode,
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

const {
  placeOrder,
  confirmOrder,
  markPreparing,
  dispatchOrder,
  markDelivered,
  markCounterDispensed,
  markUnavailable,
  cancelOrder,
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
    delivery_type: 'delivery',
    created_at: new Date('2026-07-13T10:00:00Z'),
    updated_at: new Date('2026-07-13T10:05:00Z'),
    ...overrides,
  };
}

function assertAtomicEvent(eventType, actorRole = 'PHARMACY_STAFF') {
  expect(setTenantTx).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
  expect(emitPharmacyOrderEvent).toHaveBeenCalledWith(expect.objectContaining({
    db: tx,
    actorUid: ACTOR_UID,
    actorRole,
    eventType,
    order: expect.objectContaining({
      id: 71,
      tenant_id: TENANT_ID,
      patient_id: 91,
    }),
  }));
  const lastDomainWrite = txQuery.mock.invocationCallOrder.at(-1);
  const canonicalWrite = emitPharmacyOrderEvent.mock.invocationCallOrder.at(-1);
  expect(lastDomainWrite).toBeLessThan(canonicalWrite);
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
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(tx));
    emitPharmacyOrderEvent.mockResolvedValue({ id: 'canonical-1' });
    logAudit.mockResolvedValue(undefined);
    assertVerificationCleared.mockResolvedValue(undefined);
    ensurePackBarcode.mockResolvedValue('PACK-71');
    probePharmacyCap.mockResolvedValue({ message: null });
    shouldBlockDispense.mockReturnValue(false);
    txExecute.mockResolvedValue(1);
  });

  it.each([
    {
      name: 'place',
      eventType: 'pharmacy.order_created',
      arrange() {
        prismaQuery.mockResolvedValueOnce([{ name: 'Patient', phone: '+919000000001' }]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'PENDING', delivery_type: 'delivery' })])
          .mockResolvedValueOnce([]);
      },
      run: () => placeOrder(req({
        params: {},
        user: { id: 91, uid: ACTOR_UID, role: 'PATIENT' },
        body: { order_note: 'Prescription refill' },
      }), {}),
      actorRole: 'PATIENT',
    },
    {
      name: 'confirm',
      eventType: 'pharmacy.order_confirmed',
      arrange() {
        prismaQuery.mockResolvedValueOnce([order({ status: 'PENDING', phone: '+919000000001' })]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'CONFIRMED' })])
          .mockResolvedValueOnce([]);
      },
      run: () => confirmOrder(req({ body: { items_list: [], total_amount: 0 } }), {}),
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
      arrange() {
        prismaQuery.mockResolvedValueOnce([order({ status: 'PREPARING' })]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'DISPATCHED' })])
          .mockResolvedValueOnce([]);
      },
      run: () => dispatchOrder(req({ body: { delivery_person: 'Courier' } }), {}),
    },
    {
      name: 'deliver',
      eventType: 'pharmacy.order_delivered',
      arrange() {
        prismaQuery.mockResolvedValueOnce([{ patient_id: 91, total_amount: 0 }]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'DELIVERED', items_list: [] })])
          .mockResolvedValueOnce([]);
      },
      run: () => markDelivered(req(), {}),
    },
    {
      name: 'counter dispense',
      eventType: 'pharmacy.order_dispensed',
      arrange() {
        prismaQuery.mockResolvedValueOnce([{ patient_id: 91, items_list: [], total_amount: 0 }]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'PENDING', delivery_type: 'counter' })])
          .mockResolvedValueOnce([order({ status: 'DISPENSED', delivery_type: 'counter', payment_status: 'paid' })])
          .mockResolvedValueOnce([]);
      },
      run: () => markCounterDispensed(req({ body: { payment_mode: 'none' } }), {}),
    },
    {
      name: 'unavailable',
      eventType: 'pharmacy.order_unavailable',
      arrange() {
        prismaQuery.mockResolvedValueOnce([order({ status: 'CONFIRMED' })]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'UNAVAILABLE' })])
          .mockResolvedValueOnce([]);
      },
      run: () => markUnavailable(req({ body: { reason: 'Out of stock' } }), {}),
    },
    {
      name: 'cancel',
      eventType: 'pharmacy.order_cancelled',
      arrange() {
        prismaQuery.mockResolvedValueOnce([order({ status: 'PENDING' })]);
        txQuery
          .mockResolvedValueOnce([order({ status: 'CANCELLED' })])
          .mockResolvedValueOnce([]);
      },
      run: () => cancelOrder(req({ body: { cancellation_reason: 'Patient request' } }), {}),
    },
  ])('$name persists history before emitting the canonical event in the tenant transaction', async ({
    arrange,
    run,
    eventType,
    actorRole,
  }) => {
    arrange();
    await run();

    assertAtomicEvent(eventType, actorRole || 'PHARMACY_STAFF');
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
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'Failed to update order',
      500,
    );
  });

  it('does not write history or emit an event when the guarded update returns null', async () => {
    txQuery.mockResolvedValueOnce([]);

    await markPreparing(req(), {});

    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(emitPharmacyOrderEvent).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'Order not found or wrong status',
      400,
    );
  });
});
