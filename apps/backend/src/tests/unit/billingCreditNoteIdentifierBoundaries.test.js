import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const tx = { $queryRawUnsafe: queryRawUnsafe };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: tx,
  isTenantTransactionClient: (value) => value === tx,
  pickTenantClient: () => tx,
  runTenantScopedTransaction: async (_client, _tenantId, callback) => callback(tx),
  setTenant: async (_tenantId, callback) => callback(tx),
  setTenantTx: async (_tenantId, callback) => callback(tx),
}));

const { getBillingCreditNote } = await import(
  '../../services/billing/billingCreditNoteService.js'
);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryRawUnsafe.mockReset();
});

describe('billing credit-note identifier boundaries', () => {
  test.each([
    '0',
    '01',
    '9223372036854775808',
  ])('rejects invalid signed-64 credit-note id %s before SQL', async (id) => {
    await expect(getBillingCreditNote(id, { tenantId: TENANT_ID }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('passes the signed-64 maximum to PostgreSQL without Number coercion', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(getBillingCreditNote('9223372036854775807', {
      tenantId: TENANT_ID,
    })).resolves.toBeNull();
    expect(queryRawUnsafe.mock.calls[0][2]).toBe(9_223_372_036_854_775_807n);
  });
});
