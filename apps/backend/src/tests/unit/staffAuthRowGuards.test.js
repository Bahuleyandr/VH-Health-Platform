// src/tests/unit/staffAuthRowGuards.test.js
// Regression guard for the pg-wrapper bugs in staffAuthService. The internal
// `query()` helper returns a pg-style wrapper `{ rows, rowCount }`, NOT a bare
// array. Two distinct misuses of that wrapper are covered here:
//
//   1. "No rows" guards that checked `.length` directly on the wrapper —
//      always `undefined`, so `wrapper.length === 0` is always false. The
//      guard never fired, execution fell through, and `wrapper.rows[0]`
//      (undefined) was dereferenced — throwing a confusing
//      `Cannot read properties of undefined` TypeError instead of the
//      intended clean domain error. (refreshStaffSession, quickLogin)
//
//   2. A list method that returned the whole wrapper instead of `.rows`, so
//      the API responded with `{ devices: { rows: [...], rowCount } }`
//      instead of the array the client casts to `List`. (listStaffDevices)
//
// Fully mocked — no DB. `query()` delegates to prisma.$queryRawUnsafe (reads)
// / $executeRawUnsafe (writes), so we stub those, mirroring
// refreshStaffSession.test.js.

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

beforeEach(() => {
  jest.clearAllMocks();
  mockIssueAccess.mockResolvedValue({ accessToken: 'fresh-access-token' });
  // Default: every read returns ZERO rows, every write reports 0 affected.
  // `query()` wraps these as `{ rows: [], rowCount: 0 }`.
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  mockPrisma.$executeRawUnsafe.mockResolvedValue(0);
});

describe('staffAuthService — pg-wrapper "no rows" guards fire cleanly', () => {
  it('refreshStaffSession: a valid refresh token with no matching session row throws "Invalid or expired session" (not a TypeError)', async () => {
    // Genuine, non-revoked refresh token...
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', type: 'refresh', jti: 'good-jti',
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    // ...but the session lookup finds nothing (expired/revoked/never existed).
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    const promise = StaffAuthService.refreshStaffSession('a-valid-refresh-token', null, REQ);

    await expect(promise).rejects.toThrow('Invalid or expired session');
    // The bug surfaced as a TypeError from dereferencing rows[0]; make sure
    // we are NOT seeing that.
    await expect(promise).rejects.not.toThrow(TypeError);
    // Guard must fire before minting any token.
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('quickLogin: an unknown / expired device token throws "Invalid or expired device token" (not a TypeError)', async () => {
    // The device lookup returns zero rows.
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    const promise = StaffAuthService.quickLogin('unknown-device-token', '1234', false, null, REQ);

    await expect(promise).rejects.toThrow('Invalid or expired device token');
    await expect(promise).rejects.not.toThrow(TypeError);
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });
});

describe('staffAuthService — pg-wrapper return shape', () => {
  it('listStaffDevices returns the array of device rows, not the { rows, rowCount } wrapper', async () => {
    const DEVICE_ROWS = [
      { id: 'device-1', deviceName: 'Pixel 8', biometricEnabled: true },
      { id: 'device-2', deviceName: 'iPad', biometricEnabled: false },
    ];
    // listStaffDevices issues two reads in order — the users lookup, then the
    // staff_devices SELECT — both via $queryRawUnsafe.
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 42 }])    // SELECT id FROM users ...
      .mockResolvedValueOnce(DEVICE_ROWS);    // SELECT ... FROM staff_devices ...

    const result = await StaffAuthService.listStaffDevices('staff-uuid-1');

    // The controller wraps this as `{ devices }` and the staff app reads
    // `data['devices'] as List`, so the service must return a bare array —
    // returning the pg wrapper `{ rows, rowCount }` breaks that cast.
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(DEVICE_ROWS);
    expect(result).toHaveLength(2);
  });
});
