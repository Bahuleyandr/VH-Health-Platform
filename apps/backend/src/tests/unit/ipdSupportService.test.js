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
  sendStaffNotificationsMock.mockReset();
  sendStaffNotificationsMock.mockResolvedValue({ notification_count: 1 });
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

describe('ipdSupportService.createWardIndentForClinicalMedicationOrder — catalog form matching (H D13)', () => {
  const ORDER_BASE = {
    id: 501,
    order_number: 'ORD-IPD-501',
    order_type: 'medication',
    encounter_id: '11111111-1111-4111-8111-111111111111',
    patient_uid: '22222222-2222-4222-8222-222222222222',
    ordered_by: '33333333-3333-4333-8333-333333333333',
  };
  const ADMISSION_ROW = {
    id: 42,
    tenant_id: '00000000-0000-4000-8000-000000000001',
    admission_ward: 'Ward A',
    encounter_id: ORDER_BASE.encounter_id,
    patient_uid: ORDER_BASE.patient_uid,
    ward_id: 7,
    ward_name: 'Ward A',
  };

  function mockIndentCreation(catalogRow) {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ADMISSION_ROW])
      .mockResolvedValueOnce(catalogRow ? [catalogRow] : []);
    txWardIndentFindFirstMock.mockResolvedValueOnce(null);
    txWardIndentCreateMock.mockImplementationOnce(async (payload) => ({
      id: 9001,
      ...payload.data,
      items: payload.data.items.create,
    }));
  }

  it('prefers an injectable Pantoprazole catalog row for IV medication orders', async () => {
    mockIndentCreation({
      id: 202,
      name: 'Pantoprazole 40mg Injection',
      unit_price: '45.00',
    });

    const indent = await ipdSupportService.createWardIndentForClinicalMedicationOrder({
      ...ORDER_BASE,
      route: 'iv',
      details: {
        medication_name: 'Pantoprazole',
        route: 'IV',
        dose: '40mg',
      },
    });

    const catalogCall = txQueryRawUnsafeMock.mock.calls[2];
    expect(catalogCall[3]).toBe('iv');
    expect(catalogCall[1]).toEqual(expect.arrayContaining(['%Pantoprazole%']));
    expect(indent.items[0]).toMatchObject({
      pharmacy_catalog_id: 202,
      item_name: 'Pantoprazole 40mg Injection',
      unit_price: 45,
    });
    expect(sendStaffNotificationsMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientRoles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
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

  it('maps NS/normal-saline IV fluid orders to the stocked IV-fluid catalog item', async () => {
    mockIndentCreation({
      id: 303,
      name: 'Normal Saline 0.9% 500ml',
      unit_price: '35.00',
    });

    const indent = await ipdSupportService.createWardIndentForClinicalMedicationOrder({
      ...ORDER_BASE,
      id: 502,
      order_number: 'ORD-IPD-502',
      route: 'iv',
      details: {
        medication_name: 'NS',
        route: 'IV infusion',
        dose: '500ml',
      },
    });

    const catalogCall = txQueryRawUnsafeMock.mock.calls[2];
    expect(catalogCall[1]).toEqual(expect.arrayContaining([
      '%NS%',
      '%Normal Saline%',
      '%Sodium Chloride%',
      '%Sodium Chloride 0.9%%',
    ]));
    expect(catalogCall[3]).toBe('iv');
    expect(catalogCall[4]).toBe(500);
    expect(indent.items[0]).toMatchObject({
      pharmacy_catalog_id: 303,
      item_name: 'Normal Saline 0.9% 500ml',
      unit_price: 35,
    });
  });

  it('does not resend pharmacy notifications for an existing linked ward indent', async () => {
    txQueryRawUnsafeMock.mockResolvedValueOnce([{ id: 777 }]);
    txWardIndentFindUniqueMock.mockResolvedValueOnce({
      id: 777,
      indent_number: 'WI-EXISTING',
      items: [{ item_name: 'Ceftriaxone 1g Injection' }],
    });

    const indent = await ipdSupportService.createWardIndentForClinicalMedicationOrder({
      ...ORDER_BASE,
      id: 503,
      order_number: 'ORD-IPD-503',
      route: 'iv',
      details: {
        medication_name: 'Ceftriaxone 1 g',
        route: 'IV',
        dose: '1 g',
      },
    });

    expect(indent.id).toBe(777);
    expect(txWardIndentFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 777 },
      include: { items: true },
    });
    expect(sendStaffNotificationsMock).not.toHaveBeenCalled();
  });

  // The ward-indent lifecycle (approve/reject/issue/receive) has no caller in
  // any client — staff Flutter, patient Flutter and the admin console all lack
  // one, and the only Dart bindings are dead generated chopper stubs. Until a
  // working surface ships, the alert must not page: HIGH puts the row on the
  // staff Safety Center's 15-minute escalation ladder that nobody can clear.
  describe('pharmacy dispatch alert gate (no ward-indent surface yet)', () => {
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
      mockIndentCreation({ id: 404, name: 'Paracetamol 500mg Tablet', unit_price: '2.00' });

      await ipdSupportService.createWardIndentForClinicalMedicationOrder({
        ...ORDER_BASE,
        id: 504,
        order_number: 'ORD-IPD-504',
        details: { medication_name: 'Paracetamol', route: 'oral', dose: '500mg' },
      });

      expect(sendStaffNotificationsMock).toHaveBeenCalledTimes(1);
      const payload = sendStaffNotificationsMock.mock.calls[0][0];
      // Still delivered — the alert names the drug and the ward and is the only
      // system-generated pharmacy signal for an inpatient order.
      expect(payload.type).toBe('WARD_PHARMACY_INDENT');
      expect(payload.recipientRoles).toEqual(['PHARMACY_STAFF', 'PHARMACY_INCHARGE']);
      // ...but not as a page, and not instructing a screen that does not exist.
      expect(payload.priority).toBe('LOW');
      expect(payload.title).toBe('Ward drug indent recorded');
      expect(payload.body).toContain('no dispensing screen for ward indents yet');
      expect(payload.body).not.toContain('Please review the pharmacy ward indent for dispensing');
      expect(payload.data.dispatch_surface_available).toBe(false);
    });

    it('restores the HIGH dispatch alert when the operator flips the flag on', async () => {
      process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED = 'true';
      mockIndentCreation({ id: 405, name: 'Paracetamol 500mg Tablet', unit_price: '2.00' });

      await ipdSupportService.createWardIndentForClinicalMedicationOrder({
        ...ORDER_BASE,
        id: 505,
        order_number: 'ORD-IPD-505',
        details: { medication_name: 'Paracetamol', route: 'oral', dose: '500mg' },
      });

      const payload = sendStaffNotificationsMock.mock.calls[0][0];
      expect(payload.priority).toBe('HIGH');
      expect(payload.title).toBe('Ward drug indent requested');
      expect(payload.body).toContain('Please review the pharmacy ward indent for dispensing');
      expect(payload.data.dispatch_surface_available).toBe(true);
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

describe('ipdSupportService.issueWardIndent controlled classification', () => {
  const ACTOR = '11111111-1111-4111-8111-111111111111';

  function approvedIndent(items) {
    txWardIndentFindFirstMock.mockResolvedValueOnce({
      id: 77,
      status: 'approved',
      items,
    });
  }

  it('fails closed before writes when the catalog row is missing from this tenant', async () => {
    approvedIndent([{
      id: 91,
      pharmacy_catalog_id: 44,
      item_name: 'Unlinked catalog item',
      quantity_requested: 2,
    }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(ipdSupportService.issueWardIndent({
      indentId: 77,
      issuedBy: ACTOR,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CONTROLLED_CLASSIFICATION_UNRESOLVED',
      statusCode: 409,
    });
    const [sql, tenantId, catalogId] = txQueryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('FROM pharmacy_catalog pc');
    expect(sql).toContain('i.tenant_id = pc.tenant_id');
    expect(sql).toContain('pc.tenant_id = $1::uuid');
    expect([tenantId, catalogId]).toEqual([DEFAULT_TENANT_ID, 44]);
    expect(txWardIndentItemUpdateMock).not.toHaveBeenCalled();
    expect(txWardIndentUpdateMock).not.toHaveBeenCalled();
  });

  it('fails closed before writes when a same-tenant catalog row has no inventory link', async () => {
    approvedIndent([{
      id: 91,
      pharmacy_catalog_id: 44,
      item_name: 'Unlinked catalog item',
      quantity_requested: 2,
    }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([{
      catalog_id: 44,
      linked_item_count: 0,
      is_controlled: false,
    }]);

    await expect(ipdSupportService.issueWardIndent({
      indentId: 77,
      issuedBy: ACTOR,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CONTROLLED_CLASSIFICATION_UNRESOLVED',
      statusCode: 409,
    });
    expect(txWardIndentItemUpdateMock).not.toHaveBeenCalled();
    expect(txWardIndentUpdateMock).not.toHaveBeenCalled();
  });

  it('blocks a positively classified controlled catalog line before writes', async () => {
    approvedIndent([{
      id: 91,
      pharmacy_catalog_id: 44,
      item_name: 'Controlled catalog item',
      quantity_requested: 2,
    }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([{
      catalog_id: 44,
      linked_item_count: 1,
      is_controlled: true,
    }]);

    await expect(ipdSupportService.issueWardIndent({
      indentId: 77,
      issuedBy: ACTOR,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({ code: 'WARD_INDENT_CONTROLLED_ITEM_BLOCKED' });
    expect(txWardIndentItemUpdateMock).not.toHaveBeenCalled();
  });

  it('fails closed on a positive free-text line without a catalog id', async () => {
    approvedIndent([{
      id: 92,
      pharmacy_catalog_id: null,
      item_name: 'Free-text ward supply',
      quantity_requested: 3,
    }]);
    await expect(ipdSupportService.issueWardIndent({
      indentId: 77,
      issuedBy: ACTOR,
      tenantId: DEFAULT_TENANT_ID,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CONTROLLED_CLASSIFICATION_UNRESOLVED',
      statusCode: 409,
    });
    expect(txQueryRawUnsafeMock).not.toHaveBeenCalled();
    expect(txWardIndentItemUpdateMock).not.toHaveBeenCalled();
    expect(txWardIndentUpdateMock).not.toHaveBeenCalled();
  });
});
