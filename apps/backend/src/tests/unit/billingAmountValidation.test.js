// BE-M5 regression: billing money guards must not be NaN-bypassable.
//
// `Number('abc') <= 0` is false (every NaN comparison is), so a non-numeric
// amount used to sail past the positive-amount guard AND the over-payment /
// refund-headroom bound checks, and Postgres `numeric` accepts NaN — wedging
// recomputeInvoicePaymentStateTx and the discharge billing gate. Every entry
// point that accepts a caller-supplied amount must reject non-finite input
// with a 400 BEFORE touching the database.

import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
  isTenantTransactionClient: (value) => value === mockPrisma,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: async () => ({ mode: 'shadow', sameTx: false, postCommit: true, skip: false }),
  resolveLedgerModeForTenant: async () => 'shadow',
}));

const { collectPayment, collectAdvance, settleAdvance, raiseRefund } =
  await import('../../services/billing/billingV2Service.js');

const TENANT = '22222222-2222-4222-8222-222222222222';
const PATIENT = '11111111-1111-4111-8111-111111111111';

// Values that pass `Number(x) <= 0` because NaN/Infinity comparisons lie,
// plus plain non-positive values the guard must keep rejecting.
const NON_FINITE_AMOUNTS = ['abc', NaN, 'NaN', Infinity, 'Infinity', -Infinity, undefined];
const NON_POSITIVE_AMOUNTS = [0, -5, '-5', '0'];

const ENTRY_POINTS = [
  ['collectPayment', (amount) => collectPayment({
    invoice_id: 3, amount, mode: 'CASH', shift: 'GENERAL', tenantId: TENANT,
  })],
  ['collectAdvance', (amount) => collectAdvance({
    patient_uid: PATIENT, amount, mode: 'CASH', tenantId: TENANT,
  })],
  ['settleAdvance', (amount) => settleAdvance({
    tenantId: TENANT, advance_id: 1, invoice_id: 3, amount,
  })],
  ['raiseRefund', (amount) => raiseRefund({
    patient_uid: PATIENT, invoice_id: 3, amount, reason: 'test', mode: 'CASH', tenantId: TENANT,
  })],
];

describe('billing v2 amount validation (BE-M5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe.each(ENTRY_POINTS)('%s', (_name, call) => {
    it.each(NON_FINITE_AMOUNTS.map((a) => [a]))(
      'rejects non-finite amount %p with 400 and writes no row',
      async (amount) => {
        await expect(call(amount)).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('finite'),
        });
        expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
        expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
      },
    );

    it.each(NON_POSITIVE_AMOUNTS.map((a) => [a]))(
      'rejects non-positive amount %p with 400 and writes no row',
      async (amount) => {
        await expect(call(amount)).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('> 0'),
        });
        expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
        expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
      },
    );

    it('rejects sub-paisa precision with 400 and writes no row', async () => {
      await expect(call('10.999')).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('2 decimal places'),
      });
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  it('passes valid amounts through to the next guard (not rejected as invalid)', async () => {
    // CASH without a shift trips the CASH_PAYMENT_REQUIRES_SHIFT guard, which
    // sits AFTER the amount guard — reaching it proves a valid amount passed.
    await expect(collectPayment({
      invoice_id: 3, amount: '2300.50', mode: 'CASH', tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'CASH_PAYMENT_REQUIRES_SHIFT' });
  });

  it('tolerates float representation dust on a 2dp amount', async () => {
    // 0.1 + 0.2 === 0.30000000000000004 — must count as 2dp, not be rejected.
    await expect(collectPayment({
      invoice_id: 3, amount: 0.1 + 0.2, mode: 'CASH', tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'CASH_PAYMENT_REQUIRES_SHIFT' });
  });
});
