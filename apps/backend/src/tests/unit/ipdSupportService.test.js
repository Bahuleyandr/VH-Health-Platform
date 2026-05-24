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

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    attendant_passes: {
      findMany: attendantPassesFindMany,
      update: attendantPassesUpdate,
    },
    advance_deposits: {
      aggregate: advanceDepositsAggregate,
    },
    $queryRawUnsafe: queryRawUnsafeMock,
    $transaction: transactionMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ipdSupportService = (await import('../../services/ipd/ipdSupportService.js')).default;

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
  transactionMock.mockImplementation(async (callback) => callback({
    $queryRawUnsafe: txQueryRawUnsafeMock,
    ward_indents: {
      findFirst: txWardIndentFindFirstMock,
      findUnique: txWardIndentFindUniqueMock,
      create: txWardIndentCreateMock,
    },
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
      where: { admission_id: 13 },
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
      where: { admission_id: 42 },
      _sum: { amount: true },
    });
    // The billing_advances mirror probe must scope by admission_id OR
    // (admission_id IS NULL AND patient_uid match AND collected_at <=
    // admission.admitted_at) — preserving deferred deposits.
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/FROM billing_advances/);
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
});
