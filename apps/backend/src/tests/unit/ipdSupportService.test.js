// Unit coverage for the IPD support service (advance deposits / attendant
// passes / ward indents). The full happy paths exercise Postgres state
// machines, so this file focuses on the contract between the service and
// the Prisma client — specifically that the model accessors the service
// reaches for actually exist on the singleton (snake_case `attendant_passes`,
// not `attendantPass`). Past finding tracked here:
//   2026-05-10-inpatient-admission-admission-attendant-pass-list-500.

import { jest } from '@jest/globals';

const attendantPassesFindMany = jest.fn();
const attendantPassesUpdate = jest.fn();
const advanceDepositsAggregate = jest.fn();
const queryRawUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const txQueryRawUnsafeMock = jest.fn();
const txWardIndentFindFirstMock = jest.fn();
const txWardIndentFindUniqueMock = jest.fn();
const txWardIndentCreateMock = jest.fn();
const txWardIndentUpdateMock = jest.fn();
const txWardIndentItemUpdateMock = jest.fn();
const txClinicalOrderUpdateManyMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();
const txWardFindFirstMock = jest.fn();
const loadWardIndentCatalogClassificationsTxMock = jest.fn();
const loadMedicationCatalogAuthorityTxMock = jest.fn();

const __prismaDefaultMock = {
  attendant_passes: {
    findMany: attendantPassesFindMany,
    update: attendantPassesUpdate,
  },
  advance_deposits: {
    aggregate: advanceDepositsAggregate,
  },
  $queryRawUnsafe: queryRawUnsafeMock,
  $transaction: transactionMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => transactionMock(fn),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
  isTenantTransactionClient: (value) => value === __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: async () => ({ mode: 'shadow', sameTx: false, postCommit: true, skip: false }),
  resolveLedgerModeForTenant: async () => 'shadow',
}));

const initializeWardIndentWorkflowTxMock = jest.fn(async (_tx, { indent }) => indent);
const findWardIndentCreateReplayTxMock = jest.fn(async () => null);
const workflowStub = jest.fn();
jest.unstable_mockModule('../../services/ipd/wardIndentWorkflowService.js', () => ({
  WARD_INDENT_STATE_CONTRACT: {},
  wardIndentCommandKey: jest.fn(),
  findWardIndentCreateReplayTx: findWardIndentCreateReplayTxMock,
  initializeWardIndentWorkflowTx: initializeWardIndentWorkflowTxMock,
  loadMedicationCatalogAuthorityTx: loadMedicationCatalogAuthorityTxMock,
  loadWardIndentCatalogClassificationsTx: loadWardIndentCatalogClassificationsTxMock,
  reserveWardIndent: workflowStub,
  markWardIndentShortSupply: workflowStub,
  proposeWardIndentSubstitution: workflowStub,
  approveWardIndentSubstitution: workflowStub,
  rejectWardIndentSubstitution: workflowStub,
  approveWardIndent: workflowStub,
  rejectWardIndent: workflowStub,
  recordWardIndentControlledHandoff: workflowStub,
  issueWardIndent: workflowStub,
  receiveWardIndent: workflowStub,
  requestWardIndentReturn: workflowStub,
  reportWardIndentDiscrepancy: workflowStub,
  reconcileWardIndent: workflowStub,
  cancelWardIndent: workflowStub,
  closeWardIndent: workflowStub,
  listWardIndentPage: workflowStub,
  listWardIndents: workflowStub,
  getWardIndent: workflowStub,
  default: {},
}));

const ipdSupportService = (await import('../../services/ipd/ipdSupportService.js')).default;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  attendantPassesFindMany.mockReset();
  attendantPassesUpdate.mockReset();
  advanceDepositsAggregate.mockReset();
  queryRawUnsafeMock.mockReset();
  transactionMock.mockReset();
  txQueryRawUnsafeMock.mockReset();
  txWardIndentFindFirstMock.mockReset();
  txWardIndentFindUniqueMock.mockReset();
  txWardIndentCreateMock.mockReset();
  txWardIndentUpdateMock.mockReset();
  txWardIndentItemUpdateMock.mockReset();
  txClinicalOrderUpdateManyMock.mockReset();
  txWardFindFirstMock.mockReset();
  loadWardIndentCatalogClassificationsTxMock.mockReset();
  loadMedicationCatalogAuthorityTxMock.mockReset();
  sendStaffNotificationsMock.mockReset();
  initializeWardIndentWorkflowTxMock.mockClear();
  findWardIndentCreateReplayTxMock.mockClear();
  sendStaffNotificationsMock.mockResolvedValue({ notification_count: 1 });
  loadWardIndentCatalogClassificationsTxMock.mockImplementation(async (_tx, { catalogIds }) => (
    new Map((catalogIds || []).map((id) => [Number(id), {
      id: Number(id),
      name: `Catalog ${id}`,
      unit_price: 45,
      price: 45,
      is_active: true,
      is_medication_identity: true,
    }]))
  ));
  loadMedicationCatalogAuthorityTxMock.mockImplementation(async (_tx, { catalogIds }) => (
    new Map((catalogIds || []).map((id) => [Number(id), {
      id: Number(id),
      name: `Catalog ${id}`,
      unit_price: 45,
      price: 45,
      is_active: true,
      is_medication_identity: true,
    }]))
  ));
  transactionMock.mockImplementation(async (callback) => callback({
    $queryRawUnsafe: txQueryRawUnsafeMock,
    ward_indents: {
      findFirst: txWardIndentFindFirstMock,
      findUnique: txWardIndentFindUniqueMock,
      create: txWardIndentCreateMock,
      update: txWardIndentUpdateMock,
    },
    ward_indent_items: { update: txWardIndentItemUpdateMock },
    clinical_orders: { updateMany: txClinicalOrderUpdateManyMock },
    wards: { findFirst: txWardFindFirstMock },
  }));
});

describe('ipdSupportService.listAdmissionPasses', () => {
  it('queries attendant_passes (snake_case Prisma model) by admission_id, ordered by pass_index', async () => {
    attendantPassesFindMany.mockResolvedValueOnce([
      { id: 1, admission_id: 13, pass_index: 1, pass_number: 'AP-20260510-0001', status: 'active' },
      { id: 2, admission_id: 13, pass_index: 2, pass_number: 'AP-20260510-0002', status: 'active' },
    ]);

    const passes = await ipdSupportService.listAdmissionPasses(13);

    expect(attendantPassesFindMany).toHaveBeenCalledTimes(1);
    expect(attendantPassesFindMany).toHaveBeenCalledWith({
      where: { admission_id: 13, tenant_id: DEFAULT_TENANT_ID },
      orderBy: { pass_index: 'asc' },
    });
    expect(passes).toHaveLength(2);
    expect(passes[0].pass_number).toBe('AP-20260510-0001');
  });

  it('returns an empty array when no passes exist for the admission', async () => {
    attendantPassesFindMany.mockResolvedValueOnce([]);
    const passes = await ipdSupportService.listAdmissionPasses(9999);
    expect(passes).toEqual([]);
  });
});

describe('ipdSupportService.getAdmissionDepositBalance — deferred-advance mirror (H D61)', () => {
  it('sums advance_deposits AND deferred (pre-admit) billing_advances', async () => {
    advanceDepositsAggregate.mockResolvedValueOnce({ _sum: { amount: '5000' } });
    queryRawUnsafeMock.mockResolvedValueOnce([{ total: '2500' }]);

    const balance = await ipdSupportService.getAdmissionDepositBalance(42);

    // 5,000 from advance_deposits + 2,500 deferred billing_advances = 7,500.
    // Previously returned only 5,000 (or 0 if the deposit was deferred-only),
    // forcing the discharge cashier to ask for re-payment.
    expect(balance).toBe(7500);
    expect(advanceDepositsAggregate).toHaveBeenCalledWith({
      where: { admission_id: 42, tenant_id: DEFAULT_TENANT_ID },
      _sum: { amount: true },
    });
    // The billing_advances mirror probe must scope by admission_id OR
    // (admission_id IS NULL AND patient_uid match AND collected_at <=
    // admission.admitted_at) — preserving deferred deposits.
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/FROM billing_advances/);
    expect(sql).toMatch(/ba\.tenant_id = \$2::uuid/);
    expect(sql).toMatch(/admission_id IS NULL/);
    expect(sql).toMatch(/ba\.patient_uid = a\.patient_uid/);
  });

  it('returns just the advance_deposits total when the deferred mirror is empty', async () => {
    advanceDepositsAggregate.mockResolvedValueOnce({ _sum: { amount: '3000' } });
    queryRawUnsafeMock.mockResolvedValueOnce([{ total: '0' }]);
    expect(await ipdSupportService.getAdmissionDepositBalance(42)).toBe(3000);
  });

  it('falls back to advance_deposits-only when the deferred mirror query throws', async () => {
    advanceDepositsAggregate.mockResolvedValueOnce({ _sum: { amount: '1000' } });
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('table missing'));
    // Must never throw — the cashier needs a number even if the mirror
    // is unavailable on under-migrated tenants.
    expect(await ipdSupportService.getAdmissionDepositBalance(42)).toBe(1000);
  });

  it('returns 0 when admissionId is missing (no DB hit)', async () => {
    expect(await ipdSupportService.getAdmissionDepositBalance(null)).toBe(0);
    expect(advanceDepositsAggregate).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('ipdSupportService.createWardIndent — medication-order binding', () => {
  const REQUESTER_UID = '33333333-3333-4333-8333-333333333333';
  const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
  const ENCOUNTER_ID = '11111111-1111-4111-8111-111111111111';
  const ADMISSION = {
    id: 42,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    status: 'admitted',
    ward_id: 7,
    ward_name: 'Ward A',
  };

  it('rejects a free-form pharmacy line before any inventory-bearing write', async () => {
    await expect(ipdSupportService.createWardIndent({
      admissionId: 42,
      indentType: 'pharmacy',
      items: [{ pharmacy_catalog_id: 202, quantity_requested: 1, unit: 'vial' }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_REQUIRED',
    });
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it('rejects an order-bound line when admission_id is omitted', async () => {
    await expect(ipdSupportService.createWardIndent({
      patientUid: PATIENT_UID,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: 202,
        clinical_order_id: 501,
        quantity_requested: 1,
        unit: 'vial',
      }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'WARD_INDENT_ADMISSION_REQUIRED',
    });
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it('rejects a medication catalog masquerading as consumables', async () => {
    await expect(ipdSupportService.createWardIndent({
      indentType: 'consumables',
      items: [{ pharmacy_catalog_id: 202, quantity_requested: 1, unit: 'vial' }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_REQUIRED',
    });
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it.each(['lama', '', 'unknown'])('rejects a manual indent admission in status %p', async (status) => {
    txQueryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER_ID,
      status,
      ward_id: 7,
      ward_name: 'Ward A',
    }]);

    await expect(ipdSupportService.createWardIndent({
      admissionId: 42,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: 202,
        clinical_order_id: 501,
        quantity_requested: 1,
        unit: 'vial',
      }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_ADMISSION_INACTIVE',
    });
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it('rejects a bound medication order whose encounter_id is NULL', async () => {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([ADMISSION])
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([{
        id: 501,
        patient_uid: PATIENT_UID,
        encounter_id: null,
        order_type: 'medication',
        status: 'ordered',
        verified_by: null,
        verified_at: null,
        details: {
          medication_name: 'Pantoprazole',
          catalog_id: 202,
          quantity_requested: 1,
          unit: 'vial',
        },
      }]);
    txWardFindFirstMock.mockResolvedValueOnce({ name: 'Ward A' });

    await expect(ipdSupportService.createWardIndent({
      admissionId: 42,
      wardId: 7,
      patientUid: PATIENT_UID,
      encounterId: ENCOUNTER_ID,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: 202,
        clinical_order_id: 501,
        quantity_requested: 1,
        unit: 'vial',
      }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'WARD_INDENT_CLINICAL_ORDER_ENCOUNTER_MISMATCH',
      details: {
        clinical_order_id: 501,
        clinical_order_encounter_id: null,
        admission_encounter_id: ENCOUNTER_ID,
      },
    });
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it('derives exact patient, encounter, ward, type, catalog, quantity, and unit context', async () => {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([ADMISSION])
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([{
        id: 501,
        patient_uid: PATIENT_UID,
        encounter_id: ENCOUNTER_ID,
        order_type: 'medication',
        status: 'ordered',
        verified_by: null,
        verified_at: null,
        details: {
          medication_name: 'Pantoprazole',
          catalog_id: 202,
          quantity_requested: 1,
          unit: 'vial',
        },
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ locked: 1 }]);
    txWardFindFirstMock.mockResolvedValueOnce({ name: 'Ward A' });
    txWardIndentFindFirstMock.mockResolvedValueOnce(null);
    txWardIndentCreateMock.mockImplementationOnce(async ({ data }) => ({
      id: 9001,
      ...data,
      items: data.items.create,
    }));

    const indent = await ipdSupportService.createWardIndent({
      admissionId: 42,
      wardId: 7,
      patientUid: PATIENT_UID,
      encounterId: ENCOUNTER_ID,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: 202,
        clinical_order_id: 501,
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    });

    expect(indent).toMatchObject({
      ward_id: 7,
      admission_id: 42,
      encounter_id: ENCOUNTER_ID,
      patient_uid: PATIENT_UID,
      indent_type: 'pharmacy',
    });
    expect(indent.items[0]).toMatchObject({
      pharmacy_catalog_id: 202,
      clinical_order_id: 501,
      quantity_requested: 1,
      unit: 'vial',
    });
  });

  it('relocks and classifies a catalog derived from the authoritative clinical order', async () => {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([ADMISSION])
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([{
        id: 501,
        patient_uid: PATIENT_UID,
        encounter_id: ENCOUNTER_ID,
        order_type: 'medication',
        status: 'ordered',
        verified_by: null,
        verified_at: null,
        details: {
          medication_name: 'Pantoprazole',
          catalog_id: 202,
          quantity_requested: 1,
          unit: 'vial',
        },
      }]);
    txWardFindFirstMock.mockResolvedValueOnce({ name: 'Ward A' });
    loadWardIndentCatalogClassificationsTxMock.mockResolvedValueOnce(new Map());
    loadMedicationCatalogAuthorityTxMock.mockRejectedValueOnce(
      Object.assign(new Error('inactive catalog'), {
        statusCode: 409,
        code: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_UNAVAILABLE',
      }),
    );

    await expect(ipdSupportService.createWardIndent({
      admissionId: 42,
      wardId: 7,
      patientUid: PATIENT_UID,
      encounterId: ENCOUNTER_ID,
      indentType: 'pharmacy',
      items: [{
        clinical_order_id: 501,
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_UNAVAILABLE',
    });
    expect(loadMedicationCatalogAuthorityTxMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        tenantId: DEFAULT_TENANT_ID,
        catalogIds: [202],
        lock: true,
        unavailableCode: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_UNAVAILABLE',
        classificationCode: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_CLASSIFICATION_MISMATCH',
      },
    );
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it('maps a concurrent unique-link race to the canonical already-linked conflict', async () => {
    const clinicalOrder = {
      id: 501,
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER_ID,
      order_type: 'medication',
      status: 'ordered',
      verified_by: null,
      verified_at: null,
      details: {
        medication_name: 'Pantoprazole',
        catalog_id: 202,
        quantity_requested: 1,
        unit: 'vial',
      },
    };
    const firstTx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([ADMISSION])
        .mockResolvedValueOnce([{ uid: PATIENT_UID }])
        .mockResolvedValueOnce([clinicalOrder])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ locked: 1 }]),
      pharmacy_catalog: {
        findMany: jest.fn().mockResolvedValueOnce([{
          id: 202,
          name: 'Pantoprazole 40mg Injection',
          unit_price: 45,
          price: 45,
        }]),
      },
      ward_indents: {
        findFirst: jest.fn().mockResolvedValueOnce(null),
        create: jest.fn().mockRejectedValueOnce(Object.assign(new Error('unique'), {
          code: 'P2002',
        })),
      },
      wards: { findFirst: jest.fn().mockResolvedValueOnce({ name: 'Ward A' }) },
    };
    const existingTx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
        clinical_order_id: 501,
        ward_indent_id: 9001,
        indent_number: 'WI-EXISTING',
      }]),
    };
    transactionMock
      .mockImplementationOnce(async (callback) => callback(firstTx))
      .mockImplementationOnce(async (callback) => callback(existingTx));

    await expect(ipdSupportService.createWardIndent({
      patientUid: PATIENT_UID,
      admissionId: 42,
      wardId: 7,
      encounterId: ENCOUNTER_ID,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: 202,
        clinical_order_id: 501,
        quantity_requested: 1,
        unit: 'vial',
      }],
      requestedBy: REQUESTER_UID,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
      details: {
        clinical_order_id: 501,
        ward_indent_id: 9001,
        indent_number: 'WI-EXISTING',
      },
    });
  });
});

describe('ipdSupportService.createWardIndentForClinicalMedicationOrder — locked order binding', () => {
  const ORDER_BASE = {
    id: 501,
    order_number: 'ORD-IPD-501',
    order_type: 'medication',
    encounter_id: '11111111-1111-4111-8111-111111111111',
    patient_uid: '22222222-2222-4222-8222-222222222222',
    ordered_by: '33333333-3333-4333-8333-333333333333',
    tenant_id: DEFAULT_TENANT_ID,
  };
  const ADMISSION_ROW = {
    id: 42,
    tenant_id: '00000000-0000-4000-8000-000000000001',
    admission_ward: 'Ward A',
    encounter_id: ORDER_BASE.encounter_id,
    patient_uid: ORDER_BASE.patient_uid,
    ward_id: 7,
    ward_name: 'Ward A',
    status: 'admitted',
  };

  function canonicalOrder(overrides = {}) {
    return {
      ...ORDER_BASE,
      route: 'iv',
      details: {
        medication_name: 'Pantoprazole',
        catalog_id: 202,
        quantity_requested: 6,
        unit: 'vial',
      },
      ...overrides,
    };
  }

  function mockIndentCreation(catalogRow, currentOrder) {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{
        ...currentOrder,
        status: 'ordered',
        order_type: 'medication',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ADMISSION_ROW]);
    loadMedicationCatalogAuthorityTxMock.mockResolvedValueOnce(new Map(
      catalogRow ? [[Number(catalogRow.id), {
        ...catalogRow,
        is_active: catalogRow.is_active ?? true,
        is_medication_identity: catalogRow.is_medication_identity ?? true,
      }]] : [],
    ));
    txWardIndentFindFirstMock.mockResolvedValueOnce(null);
    txWardIndentCreateMock.mockImplementationOnce(async (payload) => ({
      id: 9001,
      ...payload.data,
      items: payload.data.items.create,
    }));
  }

  it('binds catalog, quantity, and unit directly from the locked order', async () => {
    const order = canonicalOrder();
    mockIndentCreation({
      id: 202,
      name: 'Pantoprazole 40mg Injection',
      unit_price: '45.00',
    }, order);

    const indent = await ipdSupportService.createWardIndentForClinicalMedicationOrder(order);

    expect(loadMedicationCatalogAuthorityTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: DEFAULT_TENANT_ID,
        catalogIds: [202],
        lock: true,
      }),
    );
    expect(indent.items[0]).toMatchObject({
      pharmacy_catalog_id: 202,
      item_name: 'Pantoprazole 40mg Injection',
      quantity_requested: 6,
      unit: 'vial',
      unit_price: 45,
    });
    expect(sendStaffNotificationsMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientRoles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST'],
      type: 'WARD_PHARMACY_INDENT',
      relatedId: 9001,
      data: expect.objectContaining({
        source: 'ip_drug_chart',
        clinical_order_id: 501,
        order_number: 'ORD-IPD-501',
        medication_name: 'Pantoprazole',
      }),
    }));
  });

  it('rejects a stale snapshot when a correction wins before the locked re-read', async () => {
    const stale = canonicalOrder();
    const corrected = canonicalOrder({
      details: {
        medication_name: 'Pantoprazole',
        catalog_id: 303,
        quantity_requested: 2,
        unit: 'ampoule',
      },
    });
    txQueryRawUnsafeMock.mockResolvedValueOnce([{ ...corrected, status: 'ordered' }]);

    await expect(
      ipdSupportService.createWardIndentForClinicalMedicationOrder(stale),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_CONTEXT_CHANGED',
    });
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it.each(['lama', '', 'unknown'])('rejects an auto-indent admission in status %p', async (status) => {
    const order = canonicalOrder();
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ ...order, status: 'ordered' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ADMISSION_ROW, status }]);

    await expect(
      ipdSupportService.createWardIndentForClinicalMedicationOrder(order),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_ADMISSION_INACTIVE',
      details: { admission_id: 42, status: status || null },
    });
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it('maps an auto-create unique-link race to the canonical existing indent reference', async () => {
    const order = canonicalOrder();
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ ...order, status: 'ordered' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ADMISSION_ROW])
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{
        clinical_order_id: 501,
        ward_indent_id: 9001,
        indent_number: 'WI-EXISTING',
      }]);
    txWardIndentFindFirstMock.mockResolvedValueOnce(null);
    txWardIndentCreateMock.mockRejectedValueOnce(Object.assign(new Error('unique'), {
      code: '23505',
    }));

    await expect(
      ipdSupportService.createWardIndentForClinicalMedicationOrder(order),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
      details: {
        clinical_order_id: 501,
        ward_indent_id: 9001,
        indent_number: 'WI-EXISTING',
      },
    });
  });

  it('rejects auto-materialization when the locked catalog is not medication authority', async () => {
    const order = canonicalOrder();
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ ...order, status: 'ordered' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ADMISSION_ROW]);
    loadMedicationCatalogAuthorityTxMock.mockRejectedValueOnce(
      Object.assign(new Error('not medication'), {
        statusCode: 409,
        code: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_CLASSIFICATION_MISMATCH',
      }),
    );

    await expect(
      ipdSupportService.createWardIndentForClinicalMedicationOrder(order),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_CLASSIFICATION_MISMATCH',
    });
    expect(loadMedicationCatalogAuthorityTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: DEFAULT_TENANT_ID,
        catalogIds: [202],
        lock: true,
      }),
    );
    expect(txWardIndentCreateMock).not.toHaveBeenCalled();
  });

  it('does not resend pharmacy notifications for an existing linked ward indent', async () => {
    const order = canonicalOrder({ id: 503, order_number: 'ORD-IPD-503' });
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ ...order, status: 'ordered' }])
      .mockResolvedValueOnce([{ id: 777 }]);
    txWardIndentFindUniqueMock.mockResolvedValueOnce({
      id: 777,
      indent_number: 'WI-EXISTING',
      items: [{ item_name: 'Ceftriaxone 1g Injection' }],
    });

    const indent = await ipdSupportService.createWardIndentForClinicalMedicationOrder(order);

    expect(indent.id).toBe(777);
    expect(txWardIndentFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 777 },
      include: { items: true },
    });
    expect(sendStaffNotificationsMock).not.toHaveBeenCalled();
  });

  // Source availability is not operator activation. Until the Staff workbench
  // and matching backend are activated together, the alert must not page:
  // HIGH puts the row on the Safety Center's escalation ladder.
  describe('pharmacy dispatch alert activation gate', () => {
    const ORIGINAL_FLAG = process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED;

    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) {
        delete process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED;
      } else {
        process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED = ORIGINAL_FLAG;
      }
    });

    it('informs pharmacy at LOW priority with the manual-fallback body by default', async () => {
      delete process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED;
      const order = canonicalOrder({
        id: 504,
        order_number: 'ORD-IPD-504',
        route: 'oral',
        details: {
          medication_name: 'Paracetamol',
          catalog_id: 404,
          quantity_requested: 10,
          unit: 'tablet',
        },
      });
      mockIndentCreation(
        { id: 404, name: 'Paracetamol 500mg Tablet', unit_price: '2.00' },
        order,
      );

      await ipdSupportService.createWardIndentForClinicalMedicationOrder(order);

      expect(sendStaffNotificationsMock).toHaveBeenCalledTimes(1);
      const payload = sendStaffNotificationsMock.mock.calls[0][0];
      // Still delivered — the alert names the drug and the ward and is the only
      // system-generated pharmacy signal for an inpatient order.
      expect(payload.type).toBe('WARD_PHARMACY_INDENT');
      expect(payload.recipientRoles).toEqual([
        'PHARMACY_STAFF',
        'PHARMACY_INCHARGE',
        'PHARMACIST',
      ]);
      // ...but not as a page or as dispatch authority before activation.
      expect(payload.priority).toBe('LOW');
      expect(payload.title).toBe('Ward drug indent recorded');
      expect(payload.body).toContain('not activated for this release');
      expect(payload.body).toContain('do not treat this informational alert as dispatch authority');
      expect(payload.body).not.toContain('Please review the pharmacy ward indent for dispensing');
      expect(payload.data.dispatch_surface_available).toBe(false);
      expect(payload.data).not.toHaveProperty('route');
      expect(payload.data).not.toHaveProperty('action_label');
    });

    it('restores the HIGH dispatch alert when the operator flips the flag on', async () => {
      process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED = 'true';
      const order = canonicalOrder({
        id: 505,
        order_number: 'ORD-IPD-505',
        route: 'oral',
        details: {
          medication_name: 'Paracetamol',
          catalog_id: 405,
          quantity_requested: 10,
          unit: 'tablet',
        },
      });
      mockIndentCreation(
        { id: 405, name: 'Paracetamol 500mg Tablet', unit_price: '2.00' },
        order,
      );

      await ipdSupportService.createWardIndentForClinicalMedicationOrder(order);

      const payload = sendStaffNotificationsMock.mock.calls[0][0];
      expect(payload.priority).toBe('HIGH');
      expect(payload.title).toBe('Ward drug indent requested');
      expect(payload.body).toContain('Please review the pharmacy ward indent for dispensing');
      expect(payload.data.dispatch_surface_available).toBe(true);
      expect(payload.data.route).toBe('/pharmacy?tab=ward-indents&indent_id=9001');
      expect(payload.data.action_label).toBe('Open ward indent');
    });

    it('reads the gate at call time and only accepts an explicit true', () => {
      delete process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED;
      expect(ipdSupportService.wardIndentDispatchSurfaceEnabled()).toBe(false);
      process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED = '1';
      expect(ipdSupportService.wardIndentDispatchSurfaceEnabled()).toBe(false);
      process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED = 'TRUE';
      expect(ipdSupportService.wardIndentDispatchSurfaceEnabled()).toBe(true);
    });
  });
});
