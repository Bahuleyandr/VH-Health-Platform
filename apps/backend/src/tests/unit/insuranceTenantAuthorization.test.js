import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

const queryRawUnsafeMock = jest.fn();
const mockPrisma = {
  $queryRawUnsafe: queryRawUnsafeMock,
  tpa_claims: { findFirst: jest.fn() },
  insurance_claims: { findFirst: jest.fn() },
  insurance_claim_caps: { findMany: jest.fn() },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { getClaimCaps, setClaimCaps, deleteCap, applyCapsToInvoiceLines } = await import('../../services/insurance/claimCapsService.js');
const { attachDocument, logCorrespondence } = await import('../../services/insurance/claimsService.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('insurance claim-cap and TPA child-object tenant authorization', () => {
  it('resolves claim caps only through a tenant-scoped parent claim', async () => {
    mockPrisma.tpa_claims.findFirst.mockResolvedValueOnce({
      id: 7,
      tenant_id: TENANT,
      patient_uid: PATIENT_UID,
    });
    mockPrisma.insurance_claims.findFirst.mockResolvedValueOnce(null);
    mockPrisma.insurance_claim_caps.findMany.mockResolvedValueOnce([]);

    await getClaimCaps(7, { tenantId: TENANT });

    expect(mockPrisma.tpa_claims.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7, tenant_id: TENANT },
    }));
    expect(mockPrisma.insurance_claim_caps.findMany).toHaveBeenCalledWith({
      where: { tpa_claim_id: 7 },
      orderBy: { category: 'asc' },
    });
  });

  it('denies claim caps when no parent claim exists in the tenant', async () => {
    mockPrisma.tpa_claims.findFirst.mockResolvedValueOnce(null);
    mockPrisma.insurance_claims.findFirst.mockResolvedValueOnce(null);

    await expect(getClaimCaps(7, { tenantId: TENANT })).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(mockPrisma.insurance_claim_caps.findMany).not.toHaveBeenCalled();
  });

  it('denies attaching a TPA document to a claim outside the tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(
      attachDocument({
        tenantId: TENANT,
        claim_id: 99,
        doc_type: 'final_bill',
        file_url: 'vh://billing/invoices/1/final-bill',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('FROM tpa_claims');
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(params).toEqual([99, TENANT]);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows correspondence when the parent preauth belongs to the tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 12 }])
      .mockResolvedValueOnce([{ id: 44, preauth_id: 12 }]);

    const row = await logCorrespondence({
      tenantId: TENANT,
      preauth_id: 12,
      direction: 'outbound',
      channel: 'email',
      subject: 'TPA query response',
      body: 'Requested documents sent.',
    });

    expect(row.id).toBe(44);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('FROM insurance_preauth');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('INSERT INTO tpa_claim_correspondence');
  });
});

describe('claim-cap fail-closed tenant guard (resolveClaimTarget requires tenantId)', () => {
  const expectGuard = { statusCode: 403, code: 'TENANT_SCOPE_REQUIRED' };

  it('rejects getClaimCaps when no tenant is supplied — and never probes the DB', async () => {
    await expect(getClaimCaps(7)).rejects.toMatchObject(expectGuard);
    expect(mockPrisma.tpa_claims.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.insurance_claims.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.insurance_claim_caps.findMany).not.toHaveBeenCalled();
  });

  it('rejects applyCapsToInvoiceLines when no tenant is supplied', async () => {
    await expect(
      applyCapsToInvoiceLines(7, [{ category: 'pharmacy', amount: 100 }]),
    ).rejects.toMatchObject(expectGuard);
    expect(mockPrisma.tpa_claims.findFirst).not.toHaveBeenCalled();
  });

  it('rejects setClaimCaps when no tenant is supplied (after payload validation)', async () => {
    await expect(
      setClaimCaps({ claimId: 7, caps: [{ category: 'pharmacy', max_amount: 100 }], actorUid: 'staff-1' }),
    ).rejects.toMatchObject(expectGuard);
    expect(mockPrisma.tpa_claims.findFirst).not.toHaveBeenCalled();
  });

  it('rejects deleteCap when no tenant is supplied', async () => {
    await expect(
      deleteCap({ claimId: 7, category: 'pharmacy', actorUid: 'staff-1' }),
    ).rejects.toMatchObject(expectGuard);
    expect(mockPrisma.tpa_claims.findFirst).not.toHaveBeenCalled();
  });
});
