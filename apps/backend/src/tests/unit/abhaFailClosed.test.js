// ABHA fail-closed on gateway verification error (CAN-025).
//
// With ABDM enabled, registerABHA must NOT bind an ABHA when the gateway
// verification errors (was: swallow + proceed). An audited override env permits
// local-only linkage during a confirmed outage.
import { jest } from '@jest/globals';

// Set BEFORE importing the service: ABDM_CONFIG.enabled is read at module load,
// and the ABDM env gate (CAN-026) requires these when enabled.
process.env.ABDM_ENABLED = 'true';
process.env.ABDM_HIP_ID = 'test-hip';
process.env.ABDM_CALLBACK_SECRET = 'x'.repeat(64);
process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'true';
process.env.ABDM_CM_PUBLIC_KEY = 'test-cm-public-key';

const verifyABHA = jest.fn();
const queryRawUnsafe = jest.fn();
const mockPrisma = { $queryRawUnsafe: queryRawUnsafe };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenant: async (_t, fn) => fn(mockPrisma),
  setTenantTx: async (_t, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_c, _g, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));
jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({ default: { verifyABHA } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: abdmService } = await import('../../services/abdm/abdmService.js');

const TID = '00000000-0000-4000-8000-000000000001';
const PUID = 'c0de0025-0000-4000-8000-0000000007a1';

describe('ABHA fail-closed on gateway verification error (CAN-025)', () => {
  beforeEach(() => {
    queryRawUnsafe.mockReset();
    verifyABHA.mockReset();
    delete process.env.ABDM_ABHA_ALLOW_UNVERIFIED;
  });

  it('refuses to link when the ABDM gateway verification errors', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: PUID, name: 'P', phone: '+919000025001', tenant_id: TID }]) // patient lookup
      .mockResolvedValueOnce([]); // existing-abha check
    verifyABHA.mockRejectedValueOnce(new Error('gateway down'));

    await expect(abdmService.registerABHA(PUID, '12345678901234', 'p@abdm', { tenantId: TID }))
      .rejects.toMatchObject({ code: 'ABHA_VERIFICATION_FAILED' });
    expect(verifyABHA).toHaveBeenCalledTimes(1);
    // The UPDATE (a 3rd query) must NOT have run.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
