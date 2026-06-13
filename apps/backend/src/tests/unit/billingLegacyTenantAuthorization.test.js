import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

const mockPrisma = {
  invoices: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  insurance_claims: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn(async (callback) => callback(mockPrisma)),
};

// SEC-3: billingService now opens tenant-scoped reads/writes via setTenantTx
// when a tenantId is present. In this unit test we don't exercise real RLS —
// just run the callback with the mock client so the where-clause assertions
// below still apply (the tenant scoping is verified end-to-end in
// tenant-rls-interactive-tx.deep.test.js against a live DB).
const setTenantTx = jest.fn(async (_tenantId, callback) => callback(mockPrisma));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const billingService = (await import('../../services/billing/billingService.js')).default;

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.invoices.count.mockResolvedValue(0);
  mockPrisma.invoices.findMany.mockResolvedValue([]);
  mockPrisma.insurance_claims.count.mockResolvedValue(0);
  mockPrisma.insurance_claims.findMany.mockResolvedValue([]);
});

describe('legacy billing tenant authorization', () => {
  it('scopes patient invoice lists by patient_uid and tenant_id', async () => {
    await billingService.getPatientInvoices(PATIENT_UID, { limit: 10 }, { tenantId: TENANT });

    expect(mockPrisma.invoices.count).toHaveBeenCalledWith({
      where: {
        patient_uid: PATIENT_UID,
        tenant_id: TENANT,
      },
    });
    expect(mockPrisma.invoices.findMany.mock.calls[0][0].where).toMatchObject({
      patient_uid: PATIENT_UID,
      tenant_id: TENANT,
    });
  });

  it('scopes legacy insurance-claim lists by tenant_id even without a patient filter', async () => {
    await billingService.getInsuranceClaims({ limit: 10 }, { tenantId: TENANT });

    expect(mockPrisma.insurance_claims.count).toHaveBeenCalledWith({
      where: { tenant_id: TENANT },
    });
    expect(mockPrisma.insurance_claims.findMany.mock.calls[0][0].where).toMatchObject({
      tenant_id: TENANT,
    });
  });
});
