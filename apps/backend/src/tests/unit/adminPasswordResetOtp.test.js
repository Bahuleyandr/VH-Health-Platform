// src/tests/unit/adminPasswordResetOtp.test.js
// B0.3 / SEC-1: admin password-reset OTP must be hashed at rest, matched by
// user_id (not by plaintext equality), and locked after N failed attempts.
//
// Uses the REAL bcrypt (so we can prove the stored value is a hash and that
// compare succeeds/fails correctly) and a mocked prisma. No DB required.

import { jest } from '@jest/globals';
import bcrypt from 'bcrypt';

// ── Mocks (must be set up before importing the service) ──────────────

import mockPrisma from '../__mocks__/prisma.js';
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// loginSessionHelper pulls in websocket/redis at import — stub it so importing
// authService.js stays hermetic. adminResetPassword/adminForgotPassword don't
// use it anyway. generateRefreshToken is included because authService.js now
// statically imports it (ESM mock linking requires every named import to exist,
// even when unused on these code paths).
jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: jest.fn(),
  generateRefreshToken: jest.fn(),
}));

// firebaseAuthService (not exercised here, just needs to resolve)
jest.unstable_mockModule('../../services/auth/firebaseAuthService.js', () => ({
  authenticateWithFirebase: jest.fn(),
  completeUserProfile: jest.fn(),
  linkFirebaseAccount: jest.fn(),
  updateFcmToken: jest.fn(),
  revokeFirebaseSession: jest.fn(),
  verifyTokenStatus: jest.fn(),
  getHealthStatus: jest.fn(),
}));

// ── Import the service under test (after mocks) ─────────────────────
// NOTE: securityConfig is intentionally NOT mocked here so we exercise the real
// SECURITY_CONFIG.otp.maxAttemptsPerPhone that the password-reset lock now
// reads from (Item 2 — single source of truth for the OTP attempt cap).
const { AuthService } = await import('../../services/auth/authService.js');
const { SECURITY_CONFIG } = await import('../../config/securityConfig.js');

const ADMIN_UID = '550e8400-e29b-41d4-a716-446655440099';

// Make prisma.$transaction run the callback against a `tx` that delegates to
// the same mock model methods the test configures.
function wireTransaction() {
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
}

beforeEach(() => {
  jest.clearAllMocks();
  wireTransaction();
});

// ---------- adminForgotPassword ----------
describe('AuthService.adminForgotPassword', () => {
  it('stores a bcrypt HASH of the OTP, never the plaintext', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({
      uid: ADMIN_UID, username: 'root', email: 'root@test.local',
    });
    mockPrisma.password_reset_otps.create.mockResolvedValue({ id: 1 });

    const result = await AuthService.adminForgotPassword('root');

    expect(mockPrisma.password_reset_otps.create).toHaveBeenCalledTimes(1);
    const writtenData = mockPrisma.password_reset_otps.create.mock.calls[0][0].data;

    // The stored value must look like a bcrypt hash and must NOT equal the
    // returned plaintext OTP.
    expect(writtenData.otp).toMatch(/^\$2[aby]\$/);
    expect(writtenData.user_id).toBe(ADMIN_UID);

    // In non-development NODE_ENV the plaintext is not leaked in the response,
    // but the stored hash must still verify against the generated code. We can
    // recover the code only by confirming the hash is valid bcrypt: a 6-digit
    // string was hashed, so compare against the hash for any wrong code fails.
    expect(await bcrypt.compare('000000', writtenData.otp)).toBe(false);
  });

  it('throws when the admin does not exist', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(null);
    await expect(AuthService.adminForgotPassword('ghost')).rejects.toThrow('Admin not found');
  });
});

// ---------- adminResetPassword ----------
describe('AuthService.adminResetPassword', () => {
  const NEW_PASSWORD = 'BrandNewPass1!';
  const VALID_OTP = '246813';

  async function seedAdminAndOtp({ attempts = 0, otpPlaintextForHash = VALID_OTP } = {}) {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: ADMIN_UID });
    const otpHash = await bcrypt.hash(otpPlaintextForHash, 6);
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({
      id: 77, otp: otpHash, attempts,
    });
    mockPrisma.admins.update.mockResolvedValue({});
    mockPrisma.password_reset_otps.update.mockResolvedValue({});
    // Phase 1 burns the OTP via a guarded updateMany (used=false → used=true).
    mockPrisma.password_reset_otps.updateMany.mockResolvedValue({ count: 1 });
    return otpHash;
  }

  it('fetches the OTP row by user_id only (never by otp value)', async () => {
    await seedAdminAndOtp();

    await AuthService.adminResetPassword('root', VALID_OTP, NEW_PASSWORD);

    const whereArg = mockPrisma.password_reset_otps.findFirst.mock.calls[0][0].where;
    expect(whereArg).toHaveProperty('user_id', ADMIN_UID);
    expect(whereArg).not.toHaveProperty('otp');
    expect(whereArg.used).toBe(false);
  });

  it('succeeds with the correct OTP within the window and marks it used', async () => {
    await seedAdminAndOtp();

    const result = await AuthService.adminResetPassword('root', VALID_OTP, NEW_PASSWORD);

    expect(result).toEqual({ message: 'Password reset successfully' });
    // password hash rotated
    expect(mockPrisma.admins.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uid: ADMIN_UID },
        data: expect.objectContaining({ password_changed_at: expect.any(Date) }),
      })
    );
    // OTP burned via the guarded updateMany (used=false → used=true)
    expect(mockPrisma.password_reset_otps.updateMany).toHaveBeenCalledWith({
      where: { id: 77, used: false },
      data: { used: true },
    });
  });

  it('rejects a wrong OTP and increments the attempt counter', async () => {
    await seedAdminAndOtp({ attempts: 0 });

    await expect(
      AuthService.adminResetPassword('root', '999999', NEW_PASSWORD)
    ).rejects.toThrow('Invalid or expired OTP');

    // attempts incremented to 1, NOT locked yet
    expect(mockPrisma.password_reset_otps.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { attempts: 1 },
    });
    // password must NOT have been changed
    expect(mockPrisma.admins.update).not.toHaveBeenCalled();
  });

  it('locks the OTP (marks used) on the 5th failed attempt', async () => {
    // attempts already at 4 → this failure makes 5 → lock
    await seedAdminAndOtp({ attempts: 4 });

    await expect(
      AuthService.adminResetPassword('root', '111111', NEW_PASSWORD)
    ).rejects.toThrow(/Too many invalid attempts/);

    expect(mockPrisma.password_reset_otps.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { attempts: 5, used: true },
    });
    expect(mockPrisma.admins.update).not.toHaveBeenCalled();
  });

  it('locks exactly at SECURITY_CONFIG.otp.maxAttemptsPerPhone (single source of truth)', async () => {
    // Item 2: the password-reset cap is no longer a hardcoded literal — it
    // reads from securityConfig. Drive the boundary off the config value so a
    // future config change keeps the lock in lock-step and a re-hardcode would
    // fail this test.
    const cap = SECURITY_CONFIG.otp.maxAttemptsPerPhone;
    expect(cap).toBeGreaterThanOrEqual(1);

    // One below the cap: a wrong code increments but must NOT lock.
    await seedAdminAndOtp({ attempts: cap - 2 });
    await expect(
      AuthService.adminResetPassword('root', '000001', NEW_PASSWORD)
    ).rejects.toThrow('Invalid or expired OTP');
    expect(mockPrisma.password_reset_otps.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { attempts: cap - 1 },
    });

    jest.clearAllMocks();
    wireTransaction();

    // At the cap: this failure reaches the cap and burns the OTP.
    await seedAdminAndOtp({ attempts: cap - 1 });
    await expect(
      AuthService.adminResetPassword('root', '000002', NEW_PASSWORD)
    ).rejects.toThrow(/Too many invalid attempts/);
    expect(mockPrisma.password_reset_otps.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { attempts: cap, used: true },
    });
  });

  it('still accepts a legacy PLAINTEXT OTP row during rollout', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: ADMIN_UID });
    // legacy row: otp stored as plaintext (no $2 prefix)
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({
      id: 88, otp: VALID_OTP, attempts: 0,
    });
    mockPrisma.admins.update.mockResolvedValue({});
    mockPrisma.password_reset_otps.update.mockResolvedValue({});

    const result = await AuthService.adminResetPassword('root', VALID_OTP, NEW_PASSWORD);
    expect(result).toEqual({ message: 'Password reset successfully' });
  });

  it('rejects when the OTP was consumed concurrently (burn race lost)', async () => {
    await seedAdminAndOtp();
    // Another concurrent reset already flipped used=true, so our guarded
    // updateMany matches 0 rows.
    mockPrisma.password_reset_otps.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      AuthService.adminResetPassword('root', VALID_OTP, NEW_PASSWORD)
    ).rejects.toThrow('Invalid or expired OTP');

    // Password must NOT be rotated when the OTP burn loses the race.
    expect(mockPrisma.admins.update).not.toHaveBeenCalled();
  });

  it('throws when there is no live OTP row', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: ADMIN_UID });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue(null);

    await expect(
      AuthService.adminResetPassword('root', VALID_OTP, NEW_PASSWORD)
    ).rejects.toThrow('Invalid or expired OTP');
  });
});
