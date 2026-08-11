import { jest } from '@jest/globals';

const findUnique = jest.fn();
const update = jest.fn();
const transaction = jest.fn();
const persistRevokeAllUserTokens = jest.fn();
const publishRevokeAllUserTokens = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { admins: { findUnique, update }, $transaction: transaction },
}));
jest.unstable_mockModule('bcrypt', () => ({
  default: { compare: jest.fn().mockResolvedValue(true), hash: jest.fn() },
}));
jest.unstable_mockModule('../../utils/totpUtils.js', () => ({
  verifyTotp: jest.fn().mockResolvedValue(true),
  generateTotpSetup: jest.fn(),
  generateBackupCodes: jest.fn(),
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  persistRevokeAllUserTokens,
  publishRevokeAllUserTokens,
}));
jest.unstable_mockModule('../../services/auth/authService.js', () => ({
  AuthService: class {},
}));
jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: class {},
}));
jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  generateRefreshToken: jest.fn(),
  issueAccessTokenAndClaimSession: jest.fn(),
  resolveTenantIdForUid: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { mfaDisable } = await import('../../controllers/auth/adminAuthController.js');

let mfaEnabled;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  findUnique.mockResolvedValue({
    password_hash: 'hash',
    totp_enabled: true,
    totp_secret_encrypted: 'encrypted-secret',
  });
  update.mockResolvedValue({});
  mfaEnabled = true;
  transaction.mockImplementation(async (callback) => {
    let stagedMfaEnabled = mfaEnabled;
    const tx = {
      admins: {
        update: async (args) => {
          update(args);
          stagedMfaEnabled = args.data.totp_enabled;
          return {};
        },
      },
    };
    const result = await callback(tx);
    mfaEnabled = stagedMfaEnabled;
    return result;
  });
  persistRevokeAllUserTokens.mockResolvedValue(1_700_000_000);
  publishRevokeAllUserTokens.mockResolvedValue({ database: { persisted: true } });
});

it('revokes all sessions after disabling the enrolled second factor', async () => {
  const res = response();
  await mfaDisable({
    user: { uid: 'admin-1' },
    body: { currentPassword: 'correct', code: '123456' },
  }, res);

  expect(res.statusCode).toBe(200);
  expect(persistRevokeAllUserTokens).toHaveBeenCalledWith('admin-1', {
    client: expect.objectContaining({ admins: expect.any(Object) }),
    requireEvidence: true,
    reason: 'mfa_disabled',
  });
  expect(mfaEnabled).toBe(false);
  expect(publishRevokeAllUserTokens).toHaveBeenCalledWith(
    'admin-1', 1_700_000_000, { reason: 'mfa_disabled' },
  );
});

it('does not report MFA-disable success when durable revocation fails', async () => {
  persistRevokeAllUserTokens.mockRejectedValueOnce(new Error('durable store unavailable'));
  const res = response();

  await mfaDisable({
    user: { uid: 'admin-1' },
    body: { currentPassword: 'correct', code: '123456' },
  }, res);

  expect(res.statusCode).toBe(500);
  expect(res.body?.success).toBe(false);
  expect(mfaEnabled).toBe(true);
  expect(publishRevokeAllUserTokens).not.toHaveBeenCalled();
});
