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
const recordClinicalAuditEvent = jest.fn();
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent,
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

  it('mints a VERIFIED link when the gateway verification succeeds', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: PUID, name: 'P', phone: '+919000025001', tenant_id: TID }]) // patient lookup
      .mockResolvedValueOnce([]) // existing-abha check
      .mockResolvedValueOnce([{
        uid: PUID,
        abha_number: '12-3456-7890-1234',
        abha_address: 'p@abdm',
        abha_verification_status: 'verified',
        abha_verified_at: new Date('2026-08-10T00:00:00Z'),
      }]); // UPDATE
    verifyABHA.mockResolvedValueOnce({ verified: true });

    const result = await abdmService.registerABHA(PUID, '12345678901234', 'p@abdm', { tenantId: TID });

    expect(result.verification_status).toBe('verified');
    // The UPDATE stamps 'verified' + verified_at only on this gateway-success path.
    const updateArgs = queryRawUnsafe.mock.calls[2];
    expect(updateArgs[3]).toBe('verified');
    expect(recordClinicalAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ABHA_LINKED',
        metadata: expect.objectContaining({
          verification_status: 'verified',
          gateway_verification_ran: true,
        }),
      }),
      expect.anything(),
    );
  });

  it('the ABDM_ABHA_ALLOW_UNVERIFIED override links but mints PENDING, never verified', async () => {
    process.env.ABDM_ABHA_ALLOW_UNVERIFIED = 'true';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: PUID, name: 'P', phone: '+919000025001', tenant_id: TID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        uid: PUID,
        abha_number: '12-3456-7890-1234',
        abha_address: 'p@abdm',
        abha_verification_status: 'pending',
        abha_verified_at: null,
      }]);
    verifyABHA.mockRejectedValueOnce(new Error('gateway down'));

    const result = await abdmService.registerABHA(PUID, '12345678901234', 'p@abdm', { tenantId: TID });

    expect(result.verification_status).toBe('pending');
    const updateArgs = queryRawUnsafe.mock.calls[2];
    expect(updateArgs[3]).toBe('pending');
  });
});

describe('verifyLinkedAbha — promotion of a pending link (migration 653)', () => {
  beforeEach(() => {
    queryRawUnsafe.mockReset();
    verifyABHA.mockReset();
    recordClinicalAuditEvent.mockReset();
  });

  it('promotes a pending link to verified and writes the ABHA_VERIFIED audit row in the tx', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{
        uid: PUID,
        abha_number: '12-3456-7890-1234',
        abha_address: 'p@abdm',
        abha_verification_status: 'pending',
        abha_verified_at: null,
      }]) // patient lookup
      .mockResolvedValueOnce([{
        uid: PUID,
        abha_number: '12-3456-7890-1234',
        abha_address: 'p@abdm',
        abha_verification_status: 'verified',
        abha_verified_at: new Date('2026-08-10T00:00:00Z'),
      }]); // promotion UPDATE
    verifyABHA.mockResolvedValueOnce({ verified: true });

    const result = await abdmService.verifyLinkedAbha(PUID, { tenantId: TID });

    expect(result.verification_status).toBe('verified');
    expect(verifyABHA).toHaveBeenCalledWith('12-3456-7890-1234');
    expect(queryRawUnsafe.mock.calls[1][0]).toContain("abha_verification_status = 'pending'");
    expect(recordClinicalAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ABHA_VERIFIED',
        patientUid: PUID,
        tenantId: TID,
      }),
      expect.objectContaining({ db: expect.anything() }),
    );
  });

  it('is an idempotent no-op when the link is already verified', async () => {
    const verifiedAt = new Date('2026-08-01T00:00:00Z');
    queryRawUnsafe.mockResolvedValueOnce([{
      uid: PUID,
      abha_number: '12-3456-7890-1234',
      abha_address: null,
      abha_verification_status: 'verified',
      abha_verified_at: verifiedAt,
    }]);

    const result = await abdmService.verifyLinkedAbha(PUID, { tenantId: TID });

    expect(result).toEqual({
      linked: true,
      abhaNumber: '12-3456-7890-1234',
      abhaAddress: null,
      verification_status: 'verified',
      abha_verified_at: verifiedAt,
    });
    expect(verifyABHA).not.toHaveBeenCalled();
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('404s when no ABHA number is on file', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      uid: PUID,
      abha_number: null,
      abha_address: null,
      abha_verification_status: 'pending',
      abha_verified_at: null,
    }]);

    await expect(abdmService.verifyLinkedAbha(PUID, { tenantId: TID }))
      .rejects.toMatchObject({ code: 'ABHA_NOT_LINKED', statusCode: 404 });
    expect(verifyABHA).not.toHaveBeenCalled();
  });

  it('leaves the link pending (4xx) when the gateway does not verify the number', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      uid: PUID,
      abha_number: '12-3456-7890-1234',
      abha_address: null,
      abha_verification_status: 'pending',
      abha_verified_at: null,
    }]);
    verifyABHA.mockRejectedValueOnce(new Error('not found'));

    await expect(abdmService.verifyLinkedAbha(PUID, { tenantId: TID }))
      .rejects.toMatchObject({ code: 'ABHA_VERIFICATION_FAILED', statusCode: 400 });
    // Only the lookup ran — no promotion UPDATE.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('maps a lost verify race (another user verified the same number) to 409 ABHA_ALREADY_LINKED', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{
        uid: PUID,
        abha_number: '12-3456-7890-1234',
        abha_address: null,
        abha_verification_status: 'pending',
        abha_verified_at: null,
      }])
      .mockRejectedValueOnce({
        meta: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uniq_users_tenant_abha_number_canonical"',
        },
      });
    verifyABHA.mockResolvedValueOnce({ verified: true });

    await expect(abdmService.verifyLinkedAbha(PUID, { tenantId: TID }))
      .rejects.toMatchObject({ code: 'ABHA_ALREADY_LINKED', statusCode: 409 });
  });
});
