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
