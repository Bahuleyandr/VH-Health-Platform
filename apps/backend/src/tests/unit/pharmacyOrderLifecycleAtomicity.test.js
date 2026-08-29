import { jest } from '@jest/globals';

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
  relayAppError,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit }));

jest.unstable_mockModule('../../controllers/delivery/deliveryTrackingController.js', () => ({
  calculateETA: jest.fn(() => ({ estimated_mins: 35, distance_km: 8.5 })),
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  assertPharmacyCapForDispenseTx,
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

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  compensateTerminalPharmacyFundingAuthorityTx,
  materializePharmacyFundingAuthority,
}));

jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitPharmacyOrderEvent,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  assertVerificationCleared,
  assertVerificationClearedTx,
  clinicalOrderItemsSha256,
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
    assertVerificationClearedTx.mockResolvedValue(undefined);
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
          .mockResolvedValueOnce([order({ status: 'PENDING' })])
          .mockResolvedValueOnce([])
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
        txQuery
          .mockResolvedValueOnce([order({ status: 'PENDING', delivery_type: 'counter' })])
          .mockResolvedValueOnce([order({
            status: 'PENDING', delivery_type: 'counter', payment_mode: 'none',
          })])
          .mockResolvedValueOnce([order({
            status: 'PENDING', delivery_type: 'counter', payment_mode: 'none',
          })])
          .mockResolvedValueOnce([order({ status: 'DISPENSED', delivery_type: 'counter', payment_status: 'paid' })])
          .mockResolvedValueOnce([]);
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

  it('returns committed delivery success with an explicit barcode recovery obligation', async () => {
    txQuery.mockResolvedValueOnce([order({
      status: 'DELIVERED',
      items_list: [],
    })]);
    ensurePackBarcode.mockRejectedValueOnce(new Error('barcode provider unavailable'));

    await markDelivered(req(), {});

    expect(success).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 71,
        status: 'DELIVERED',
        pack_barcode: null,
        pack_barcode_pending: true,
        pack_barcode_recovery_endpoint:
          '/api/v1/pharmacy-orders/orders/71/pack-label',
      }),
      'Delivered',
    );
    expect(relayAppError).not.toHaveBeenCalled();
  });

  it('returns committed substitution replay with barcode recovery instead of a retained 5xx', async () => {
    findDispenseSubstitutionReplay.mockResolvedValueOnce({
      movement_id: 501,
      order_id: 71,
      prescription_id: 81,
      fulfilment_status: 'partial',
    });
    ensurePackBarcode.mockRejectedValueOnce(new Error('barcode provider unavailable'));

    await dispenseSubstitution(req({
      body: { order_id: 71, prescription_id: 81 },
    }), {});

    expect(dispenseSubstitutionCommand).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        movement_id: 501,
        pack_barcode: null,
        pack_barcode_pending: true,
        pack_barcode_recovery_endpoint:
          '/api/v1/pharmacy-orders/orders/71/pack-label',
      }),
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
      .mockResolvedValueOnce([{ id: 81, medications }])
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
      /e_prescriptions[\s\S]*tenant_id=\$1::uuid AND pharmacy_order_id=\$2::int[\s\S]*FOR UPDATE/,
    );
    expect(resolvePrescriptionLineIndexes).toHaveBeenCalledWith(mappedLines, medications);
    expect(txQuery.mock.calls[2][0]).toMatch(/items_list=\$3::jsonb/);
    expect(txQuery.mock.calls[2][0]).toMatch(
      /inventory_authority_version=inventory_authority_version\+1/,
    );
    expect(txQuery.mock.calls[2][0]).toMatch(/clinical_verification_safety_version=NULL/);
    expect(txQuery.mock.calls[2].slice(1)).toEqual([
      TENANT_ID,
      71,
      JSON.stringify(mappedLines),
      7,
    ]);
    expect(success).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ items_list: mappedLines, idempotent_replay: false }),
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
      .mockResolvedValueOnce([{ id: 81, medications: legacyLines }]);

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
    expect(txQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate order and prescription line targets during explicit repair', async () => {
    const legacyLines = [
      { catalog_id: 17, name: 'Drug A', quantity: 2 },
      { catalog_id: 17, name: 'Drug A', quantity: 2 },
    ];
    txQuery
      .mockResolvedValueOnce([order({ status: 'CONFIRMED', items_list: legacyLines })])
      .mockResolvedValueOnce([{ id: 81, medications: legacyLines }]);

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
      .mockResolvedValueOnce([{ id: 81, medications: legacyLines }]);

    await resolveOrderLineIdentities(req({
      body: {
        line_mappings: [
          { order_line_index: 0, prescription_line_index: 0 },
          { order_line_index: 1, prescription_line_index: 0 },
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
    expect(txQuery).toHaveBeenCalledTimes(2);
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
    expect(resolvePharmacyFacility).toHaveBeenCalledWith(tx, {
      tenantId: TENANT_ID,
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
    prismaQuery.mockResolvedValueOnce([order({ status: 'PREPARING' })]);
    txQuery
      .mockResolvedValueOnce([order({ status: 'DISPATCHED' })])
      .mockResolvedValueOnce([]);

    await dispatchOrder(req({ body: { delivery_person: 'Courier' } }), {});

    expect(assertVerificationClearedTx).toHaveBeenCalledWith(tx, {
      orderId: 71,
      tenantId: TENANT_ID,
    });
    expect(assertVerificationClearedTx.mock.invocationCallOrder[0])
      .toBeLessThan(txQuery.mock.invocationCallOrder[0]);
    expect(prismaQuery.mock.calls[0][0]).toMatch(
      /tenant_id=\$2::uuid AND facility_id=\$3::int/,
    );
    expect(txQuery.mock.calls[0][0]).toMatch(/tenant_id=\$8::uuid AND facility_id=\$9::int/);
  });

  it('blocks an explicit partial counter fill before funding or stock mutation', async () => {
    const originalItems = [
      { order_line_index: 0, catalog_id: 17, name: 'Drug A', quantity: 2 },
      { order_line_index: 1, catalog_id: 18, name: 'Drug B', quantity: 3 },
    ];
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

    expect(preserveBoundOrderLineIdentity(authoritative, [
      { name: 'Caller replacement', qty: 99, price: 0 },
    ])).toEqual(authoritative);
  });
});
