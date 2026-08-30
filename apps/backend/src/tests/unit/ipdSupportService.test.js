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
const deriveAdvanceBalanceFromLedgerTxMock = jest.fn();
const raiseBillingRefundMock = jest.fn();

function captureThrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('Expected function to throw');
}

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

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  deriveAdvanceBalanceFromLedgerTx: deriveAdvanceBalanceFromLedgerTxMock,
  raiseRefund: raiseBillingRefundMock,
}));

jest.unstable_mockModule('../../utils/patientMergeStabilityLock.js', () => ({
  lockTenantPatientMergeStability: jest.fn(),
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  lockPharmacyFundingAuthorityTx: jest.fn(),
  resolvePharmacyFundingPatientUidTx: jest.fn(async (_tx, { patientUid }) => patientUid),
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
  deriveAdvanceBalanceFromLedgerTxMock.mockReset();
  raiseBillingRefundMock.mockReset();
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

describe('ipdSupportService IPD advance refund request normalization', () => {
  it('normalizes exact NUMERIC(10,2), mode, reason, body, and dynamic path', () => {
    const command = ipdSupportService.normalizeIpdAdvanceRefundRequest({
      parentDepositId: '42',
      refundAmount: '123.4',
      paymentMethod: ' cAsH ',
      paymentReference: '   ',
      notes: '  duplicate collection  ',
    });

    expect(command).toEqual({
      parentDepositId: 42,
      amount: '123.40',
      amountPaise: 12340,
      reason: 'duplicate collection',
      mode: 'CASH',
      idempotencyPath: '/api/v1/ipd/advance-deposits/42/refund',
      idempotencyBody: {
        action: 'raise_ipd_advance_refund',
        parent_deposit_id: '42',
        amount: '123.40',
        reason: 'duplicate collection',
        mode: 'CASH',
      },
    });
  });

  it.each(['card', 'UPI', 'online', 'bank_transfer'])(
    'fails closed for %s until the canonical electronic payout evidence path is used',
    (paymentMethod) => {
      const err = captureThrown(() => ipdSupportService.normalizeIpdAdvanceRefundRequest({
        parentDepositId: 42,
        refundAmount: '1.00',
        paymentMethod,
      }));
      expect(err).toMatchObject({
        statusCode: 409,
        code: 'IPD_ADVANCE_REFUND_MODE_RECONCILIATION_REQUIRED',
      });
    },
  );

  it('rejects caller text masquerading as payout evidence', () => {
    const err = captureThrown(() => ipdSupportService.normalizeIpdAdvanceRefundRequest({
      parentDepositId: 42,
      refundAmount: '1.00',
      paymentMethod: 'cheque',
      paymentReference: 'CHEQUE-ALREADY-PAID',
    }));
    expect(err).toMatchObject({
      statusCode: 400,
      code: 'IPD_ADVANCE_REFUND_PAYOUT_REFERENCE_FORBIDDEN',
    });
  });

  it.each(['1.001', '1e2', '-1', '0', '100000000.00'])(
    'rejects non-canonical refund amount %s',
    (refundAmount) => {
      expect(() => ipdSupportService.normalizeIpdAdvanceRefundRequest({
        parentDepositId: 42,
        refundAmount,
        paymentMethod: 'cash',
      })).toThrow();
    },
  );

  it('delegates a source-bound request to the governed billing refund service', async () => {
    const patientUid = '22222222-2222-4222-8222-222222222222';
    const actorUid = '33333333-3333-4333-8333-333333333333';
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      amount: '100.00',
      admission_id: 7,
      patient_uid: patientUid,
      is_refund: false,
      parent_deposit_id: null,
      purpose: 'admission_advance',
      receipt_number: 'RCT-202608-0001',
      payment_method: 'cash',
      payment_reference: null,
      collected_by: actorUid,
      collected_at: new Date('2026-08-30T12:00:00.000Z'),
      advance_id: 91,
    }]);
    raiseBillingRefundMock.mockResolvedValueOnce({
      id: 5,
      advance_id: 91,
      amount: '10.00',
      approval_status: 'PENDING',
    });

    const refund = await ipdSupportService.refundAdvanceDeposit({
      parentDepositId: 42,
      refundAmount: '10',
      paymentMethod: 'cash',
      notes: ' duplicate ',
      refundedBy: actorUid,
      tenantId: DEFAULT_TENANT_ID,
    });

    expect(refund).toMatchObject({ id: 5, approval_status: 'PENDING' });
    expect(raiseBillingRefundMock).toHaveBeenCalledWith(expect.objectContaining({
      patient_uid: patientUid,
      advance_id: 91,
      amount: '10.00',
      reason: 'duplicate',
      mode: 'CASH',
      expectedIdempotencyBody: {
        action: 'raise_ipd_advance_refund',
        parent_deposit_id: '42',
        amount: '10.00',
        reason: 'duplicate',
        mode: 'CASH',
      },
      idempotencyPath: '/api/v1/ipd/advance-deposits/42/refund',
      validateParentSourceTx: expect.any(Function),
    }));
  });

  it('revalidates that the requested cash rail matches the bound source rail', async () => {
    const patientUid = '22222222-2222-4222-8222-222222222222';
    const actorUid = '33333333-3333-4333-8333-333333333333';
    const collectedAt = new Date('2026-08-30T12:00:00.000Z');
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      amount: '100.00',
      admission_id: 7,
      patient_uid: patientUid,
      is_refund: false,
      parent_deposit_id: null,
      purpose: 'admission_advance',
      receipt_number: 'RCT-202608-0002',
      payment_method: 'card',
      payment_reference: 'CARD-ORIGIN-123',
      collected_by: actorUid,
      collected_at: collectedAt,
      advance_id: 91,
    }]);
    raiseBillingRefundMock.mockResolvedValueOnce({
      id: 6,
      advance_id: 91,
      amount: '10.00',
      approval_status: 'PENDING',
    });

    await ipdSupportService.refundAdvanceDeposit({
      parentDepositId: 42,
      refundAmount: '10.00',
      paymentMethod: 'cash',
      refundedBy: actorUid,
      tenantId: DEFAULT_TENANT_ID,
    });

    const { validateParentSourceTx } = raiseBillingRefundMock.mock.calls[0][0];
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
        source_id: 42,
        source_amount: '100.00',
        source_admission_id: 7,
        source_patient_uid: patientUid,
        source_is_refund: false,
        source_parent_deposit_id: null,
        source_receipt_number: 'RCT-202608-0002',
        source_payment_method: 'card',
        source_payment_reference: 'CARD-ORIGIN-123',
        source_purpose: 'admission_advance',
        source_collected_by: actorUid,
        source_collected_at: collectedAt,
      }]),
    };
    await expect(validateParentSourceTx({
      tx,
      tenantId: DEFAULT_TENANT_ID,
      advance: { id: 91 },
      storedPatientUid: patientUid,
      fundingPatientUid: patientUid,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IPD_ADVANCE_REFUND_MODE_RECONCILIATION_REQUIRED',
    });
  });

  it('lists the governed refund lifecycle without payout evidence', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 7,
      parent_deposit_id: 42,
      advance_id: 91,
      amount: '10.00',
      mode: 'CASH',
      approval_status: 'PENDING',
    }]);

    const refunds = await ipdSupportService.listAdmissionAdvanceRefundRequests(7, {
      tenantId: DEFAULT_TENANT_ID,
    });

    expect(refunds).toEqual([expect.objectContaining({
      id: 7,
      parent_deposit_id: 42,
      approval_status: 'PENDING',
    })]);
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toContain('mirror.ipd_advance_deposit_id AS parent_deposit_id');
    expect(sql).toContain('mirror.admission_id = $2::int');
    expect(sql).toContain('refund.approval_status');
    expect(sql).not.toContain('refund.reference');
    expect(sql).not.toContain('refund.payout_rail');
    expect(sql).not.toContain('refund.gateway_refund_id');
  });
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
  it('uses a settled mirror balance once and retains unmirrored legacy roots', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ total: '7500' }]);

    const balance = await ipdSupportService.getAdmissionDepositBalance(42);

    expect(balance).toBe(7500);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/root_state\.mirror_count = 0/);
    expect(sql).toMatch(/SUM\(advance\.balance\)/);
    expect(sql).toMatch(/advance\.tenant_id = \$2::uuid/);
    expect(sql).toMatch(/advance\.admission_id IS NULL/);
    expect(sql).toMatch(/WITH RECURSIVE admission_scope/);
    expect(sql).toMatch(/patient_uid_family\(uid\)/);
    expect(sql).toMatch(/predecessor\.merged_into_uid = family\.uid/);
    expect(sql).toMatch(/family\.uid = deposit\.patient_uid/);
    expect(sql).toMatch(/family\.uid = advance\.patient_uid/);
    expect(sql).not.toMatch(/deposit\.patient_uid = admission\.patient_uid/);
    expect(sql).not.toMatch(/advance\.patient_uid = admission\.patient_uid/);
    expect(sql).toMatch(/mirror\.ipd_advance_deposit_id = root\.id/);
    expect(sql).toMatch(/mirror\.patient_uid = root\.patient_uid/);
    expect(sql).toMatch(/mirror\.reference = 'IPD\/' \|\| root\.receipt_number/);
    expect(sql).toMatch(/mirror\.amount = root\.amount/);
    expect(sql).toMatch(/mirror\.ipd_advance_deposit_collected_at/);
    expect(sql).toMatch(/DATE_TRUNC\('milliseconds', mirror\.collected_at\)/);
    expect(sql).toMatch(/refund\.patient_uid IS DISTINCT FROM root\.patient_uid/);
    expect(sql).toMatch(/patient_matches_admission/);
  });

  it('returns the statement total when no independent advance remains', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ total: '3000' }]);
    expect(await ipdSupportService.getAdmissionDepositBalance(42)).toBe(3000);
  });

  it('fails closed when a receipt has ambiguous mirror evidence', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      total: '100',
      invalid_mirror_roots: 1,
    }]);
    await expect(ipdSupportService.getAdmissionDepositBalance(42))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'IPD_ADVANCE_BALANCE_EVIDENCE_INVALID',
      });
  });

  it.each([
    ['unauditable legacy deposit', { invalid_root_shapes: 1 }, { root_shapes: 1 }],
    ['unknown independent advance mode', { invalid_advance_rows: 1 }, { advance_rows: 1 }],
  ])('fails closed for %s evidence', async (_label, evidence, expectedDetails) => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ total: '100', ...evidence }]);
    await expect(ipdSupportService.getAdmissionDepositBalance(42))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'IPD_ADVANCE_BALANCE_EVIDENCE_INVALID',
        details: expect.objectContaining(expectedDetails),
      });
  });

  it('fails closed when the admission patient identity is not terminal', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      total: '100',
      invalid_patient_identity_rows: 1,
    }]);
    await expect(ipdSupportService.getAdmissionDepositBalance(42))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'IPD_ADVANCE_BALANCE_EVIDENCE_INVALID',
        details: expect.objectContaining({ patient_identity_rows: 1 }),
      });
  });

  it('fails closed rather than returning a partial money balance when the statement fails', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('table missing'));
    await expect(ipdSupportService.getAdmissionDepositBalance(42))
      .rejects.toThrow('table missing');
  });

  it('returns 0 when admissionId is missing (no DB hit)', async () => {
    expect(await ipdSupportService.getAdmissionDepositBalance(null)).toBe(0);
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
