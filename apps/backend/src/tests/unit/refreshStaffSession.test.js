// src/tests/unit/refreshStaffSession.test.js
// B0.4 / SEC-2: StaffAuthService.refreshStaffSession must
//   1. reject anything that isn't a genuine refresh token (no access tokens),
//   2. reject a blacklisted/revoked refresh token (logout/rotation bypass),
//   3. still accept a valid, non-revoked refresh token.
//
// Fully mocked — no DB. The service's internal `query()` helper delegates to
// prisma.$queryRawUnsafe (reads) / $executeRawUnsafe (writes), so we stub those.

import { jest } from '@jest/globals';

// ── Mocks (before importing the service) ─────────────────────────────

const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: mockPrisma }));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockVerifyToken = jest.fn();
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: jest.fn().mockReturnValue('mock-token'),
  verifyToken: mockVerifyToken,
}));

const mockIsTokenBlacklisted = jest.fn();
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isTokenBlacklisted: mockIsTokenBlacklisted,
}));

const mockIssueAccess = jest.fn();
jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: mockIssueAccess,
}));

jest.unstable_mockModule('../../services/auth/userActiveSession.js', () => ({
  getUserSessionDeviceType: jest.fn().mockResolvedValue('mobile'),
}));

jest.unstable_mockModule('../../utils/loginAnomalyDetector.js', () => ({
  trackFailedLogin: jest.fn(),
}));
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: jest.fn(),
}));

// ── Import after mocks ───────────────────────────────────────────────
const { StaffAuthService } = await import('../../services/auth/staffAuthService.js');

const REQ = { ip: '127.0.0.1', headers: { 'user-agent': 'jest' } };

// A valid session row returned by the staff_auth_sessions lookup.
const SESSION_ROW = {
  id: 5,
  staff_id: 42,
  uid: 'staff-uuid-1',
  name: 'Dr Who',
  email: 'who@test.local',
  role: 'DOCTOR',
  employee_id: 'EMP1',
  is_active: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIssueAccess.mockResolvedValue({ accessToken: 'fresh-access-token' });
  // Default: the session lookup + last_activity update succeed.
  mockPrisma.$queryRawUnsafe.mockResolvedValue([SESSION_ROW]);
  mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
});

describe('StaffAuthService.refreshStaffSession — B0.4 token-type + blacklist', () => {
  it('rejects an ACCESS token (no type:refresh claim)', async () => {
    // Access tokens are minted without a `type` claim.
    mockVerifyToken.mockReturnValue({ uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', jti: 'j1' });

    await expect(
      StaffAuthService.refreshStaffSession('an-access-token', null, REQ)
    ).rejects.toThrow('Invalid or expired refresh token');

    // Must reject BEFORE touching the DB or minting a token.
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('rejects a blacklisted / revoked refresh token', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', type: 'refresh', jti: 'revoked-jti',
    });
    mockIsTokenBlacklisted.mockResolvedValue(true);

    await expect(
      StaffAuthService.refreshStaffSession('a-revoked-refresh-token', null, REQ)
    ).rejects.toThrow('Token has been revoked');

    expect(mockIsTokenBlacklisted).toHaveBeenCalledWith('revoked-jti');
    // No new token minted for a revoked refresh token.
    expect(mockIssueAccess).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects when the signature is invalid (verifyToken → null)', async () => {
    mockVerifyToken.mockReturnValue(null);

    await expect(
      StaffAuthService.refreshStaffSession('garbage', null, REQ)
    ).rejects.toThrow('Invalid or expired refresh token');
  });

  it('accepts a valid, non-revoked refresh token and mints a new access token', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', type: 'refresh', jti: 'good-jti',
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);

    const result = await StaffAuthService.refreshStaffSession('a-valid-refresh-token', null, REQ);

    expect(mockIsTokenBlacklisted).toHaveBeenCalledWith('good-jti');
    expect(mockIssueAccess).toHaveBeenCalledTimes(1);
    // refresh rotation must not push a self-revoke event
    expect(mockIssueAccess.mock.calls[0][0]).toEqual(
      expect.objectContaining({ pushRevoked: false, userUid: 'staff-uuid-1' })
    );
    expect(result.accessToken).toBe('fresh-access-token');
  });

  it('rejects a token whose type claim is something other than refresh', async () => {
    // e.g. a token explicitly typed 'access' must not pass the refresh gate.
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', type: 'access', jti: 'j2',
    });

    await expect(
      StaffAuthService.refreshStaffSession('typed-access-token', null, REQ)
    ).rejects.toThrow('Invalid or expired refresh token');

    expect(mockIsTokenBlacklisted).not.toHaveBeenCalled();
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });
});
