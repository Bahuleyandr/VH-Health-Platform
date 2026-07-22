// Regression guard for Sol Ultra audit #21: mfaVerifySetup used a read-then-write
// (pre-check totp_enabled, then unconditional update), so a concurrent or
// replayed setup-confirm could both pass the check and the second write would
// overwrite the first-enrolled SUPER_ADMIN factor. The false->true transition
// must be atomic (state predicate in the write) and reject a lost race.
import { jest } from '@jest/globals';

const findUniqueMock = jest.fn();
const updateManyMock = jest.fn();
const __prismaDefault = { admins: { findUnique: findUniqueMock, updateMany: updateManyMock } };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefault,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_t, fn) => fn(__prismaDefault),
  setTenant: async (_t, fn) => fn(__prismaDefault),
  prismaReadOnly: __prismaDefault,
  circuitBreakerStatus: () => ({}),
}));
jest.unstable_mockModule('../../utils/totpUtils.js', () => ({
  verifyTotp: jest.fn().mockResolvedValue(true),
  encryptSecret: jest.fn(),
  decryptSecret: jest.fn(),
  generateTotpSetup: jest.fn(),
  generateBackupCodes: jest.fn(),
  generateChallengeToken: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { mfaVerifySetup } = await import('../../controllers/auth/adminAuthController.js');

function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateManyMock.mockReset();
  findUniqueMock.mockResolvedValue({ totp_secret_encrypted: 'enc', totp_enabled: false });
});

describe('mfaVerifySetup atomic enable (Sol Ultra #21)', () => {
  it('enables MFA via a totp_enabled=false-conditional write', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    const res = makeRes();
    await mfaVerifySetup({ user: { uid: 'admin-1' }, body: { code: '123456' } }, res);
    expect(res.statusCode).toBe(200);
    // The state predicate must be part of the write.
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ totp_enabled: false }),
    }));
  });

  it('rejects a replay / lost race (0 rows updated) with 409, no success', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    const res = makeRes();
    await mfaVerifySetup({ user: { uid: 'admin-1' }, body: { code: '123456' } }, res);
    expect(res.statusCode).toBe(409);
  });
});
