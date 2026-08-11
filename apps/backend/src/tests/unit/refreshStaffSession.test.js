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

const mockVerifyToken = jest.fn();
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: jest.fn().mockReturnValue('mock-token'),
  verifyToken: mockVerifyToken,
}));

const mockIsTokenBlacklisted = jest.fn();
const mockBlacklistToken = jest.fn();
const mockRevokeAllUserTokens = jest.fn();
const mockGetCurrentTokenEpoch = jest.fn();
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  getCurrentTokenEpoch: mockGetCurrentTokenEpoch,
  isTokenBlacklisted: mockIsTokenBlacklisted,
  // staffAuthService.logoutStaff revokes the presented access token's jti, and
  // the all-device branch additionally revokes every token for the identity.
  blacklistToken: mockBlacklistToken,
  persistRevokeAllUserTokens: jest.fn(),
  publishRevokeAllUserTokens: jest.fn(),
  revokeAllUserTokens: mockRevokeAllUserTokens,
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
const INSTALLATION_ID = '33333333-3333-4333-8333-333333333333';

// A valid session row returned by the staff_auth_sessions lookup.
const SESSION_ROW = {
  id: 5,
  staff_id: 42,
  uid: 'staff-uuid-1',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  name: 'Dr Who',
  email: 'who@test.local',
  role: 'DOCTOR',
  employee_id: 'EMP1',
  is_active: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIssueAccess.mockResolvedValue({ accessToken: 'fresh-access-token' });
  mockGetCurrentTokenEpoch.mockResolvedValue(0);
  // Default: the session lookup + last_activity update succeed.
  mockPrisma.$queryRawUnsafe.mockResolvedValue([SESSION_ROW]);
  mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
});

describe('StaffAuthService.refreshStaffSession — B0.4 token-type + blacklist', () => {
  it('rejects an ACCESS token (no type:refresh claim)', async () => {
    // Access tokens are minted without a `type` claim.
    mockVerifyToken.mockReturnValue({ uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', jti: 'j1' });

    await expect(
      StaffAuthService.refreshStaffSession(
        'an-access-token',
        null,
        INSTALLATION_ID,
        REQ,
      ),
    ).rejects.toThrow('Invalid or expired refresh token');

    // Must reject BEFORE touching the DB or minting a token.
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('rejects a blacklisted / revoked refresh token', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'revoked-jti',
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(true);

    await expect(
      StaffAuthService.refreshStaffSession(
        'a-revoked-refresh-token',
        null,
        INSTALLATION_ID,
        REQ,
      ),
    ).rejects.toThrow('Token has been revoked');

    expect(mockIsTokenBlacklisted).toHaveBeenCalledWith('revoked-jti');
    // No new token minted for a revoked refresh token.
    expect(mockIssueAccess).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects when the signature is invalid (verifyToken → null)', async () => {
    mockVerifyToken.mockReturnValue(null);

    await expect(
      StaffAuthService.refreshStaffSession(
        'garbage',
        null,
        INSTALLATION_ID,
        REQ,
      ),
    ).rejects.toThrow('Invalid or expired refresh token');
  });

  it('accepts a valid, non-revoked refresh token and mints a new access token', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'good-jti',
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);

    const result = await StaffAuthService.refreshStaffSession(
      'a-valid-refresh-token',
      null,
      INSTALLATION_ID,
      REQ,
    );

    expect(mockIsTokenBlacklisted).toHaveBeenCalledWith('good-jti');
    expect(mockIssueAccess).toHaveBeenCalledTimes(1);
    // refresh rotation must not push a self-revoke event
    expect(mockIssueAccess.mock.calls[0][0]).toEqual(
      expect.objectContaining({ pushRevoked: false, userUid: 'staff-uuid-1' })
    );
    expect(result.accessToken).toBe('fresh-access-token');
  });

  it('R1: rejects a refresh token minted under an OLDER token_epoch (retained across logout/revoke-all)', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'clean-jti',
      token_epoch: 0, // minted before the revoke-all bumped the epoch
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    mockGetCurrentTokenEpoch.mockResolvedValue(1);

    await expect(
      StaffAuthService.refreshStaffSession(
        'a-retained-refresh-token',
        null,
        INSTALLATION_ID,
        REQ,
      ),
    ).rejects.toThrow('Token has been revoked');

    expect(mockGetCurrentTokenEpoch).toHaveBeenCalledWith('staff-uuid-1');
    // Refused at ISSUANCE — nothing minted, even though the session row survived.
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('R1: a legacy refresh token (no epoch claim) still works while the identity was never revoked', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'good-jti',
      // no token_epoch claim — minted before this feature shipped
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    mockGetCurrentTokenEpoch.mockResolvedValue(0);

    const result = await StaffAuthService.refreshStaffSession(
      'a-legacy-refresh-token',
      null,
      INSTALLATION_ID,
      REQ,
    );
    expect(result.accessToken).toBe('fresh-access-token');
  });

  it('rejects a valid refresh token after the staff account is deprovisioned', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'good-jti',
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ ...SESSION_ROW, is_active: false }]);

    await expect(
      StaffAuthService.refreshStaffSession(
        'a-valid-refresh-token',
        null,
        INSTALLATION_ID,
        REQ,
      ),
    ).rejects.toThrow('Account deactivated');

    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('rejects a token whose type claim is something other than refresh', async () => {
    // e.g. a token explicitly typed 'access' must not pass the refresh gate.
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', type: 'access', jti: 'j2',
    });

    await expect(
      StaffAuthService.refreshStaffSession(
        'typed-access-token',
        null,
        INSTALLATION_ID,
        REQ,
      ),
    ).rejects.toThrow('Invalid or expired refresh token');

    expect(mockIsTokenBlacklisted).not.toHaveBeenCalled();
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });
});
