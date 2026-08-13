// src/tests/unit/staffAuthServiceCoverage.test.js
// Coverage-focused unit suite for StaffAuthService (roadmap B3.2). Drives the
// staff password login, PIN login, quick-login, device registration, lockout
// (account-wide + per-vantage PIN), session refresh/rotation, logout, admin
// force-logout / PIN reset, profile + password self-service, and the auth-log /
// activity-log helpers — exercising the happy path plus every AppError /
// validation / catch branch.
//
// Fully mocked — no DB. The service's internal `query()` helper routes reads
// (SELECT / WITH / RETURNING) to prisma.$queryRawUnsafe and writes
// (INSERT / UPDATE / DELETE without RETURNING) to prisma.$executeRawUnsafe, so
// we stub those with a SQL-pattern-matching implementation that is robust to
// call ordering. `createSession` calls prisma.$transaction directly with a tx
// object exposing the same two raw helpers, so the $transaction mock delegates
// the callback to the same prisma stub. Mirrors refreshStaffSession.test.js /
// staffAuthRowGuards.test.js conventions.

import { jest } from '@jest/globals';

// ── Mocks (before importing the service) ─────────────────────────────

const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
};
const mockSetTenantTx = jest.fn(async (_tenantId, fn) => fn(mockPrisma));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: mockSetTenantTx,
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGenerateToken = jest.fn().mockReturnValue('mock-token');
const mockVerifyToken = jest.fn();
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: mockGenerateToken,
  verifyToken: mockVerifyToken,
}));

const mockBcryptCompare = jest.fn();
const mockBcryptHash = jest.fn().mockResolvedValue('hashed-secret');
jest.unstable_mockModule('bcrypt', () => ({
  default: { compare: mockBcryptCompare, hash: mockBcryptHash },
}));

const mockIsTokenBlacklisted = jest.fn();
const mockBlacklistToken = jest.fn();
const mockRevokeAllUserTokens = jest.fn();
const mockPersistRevokeAllUserTokens = jest.fn().mockResolvedValue(1_700_000_000);
const mockPublishRevokeAllUserTokens = jest.fn().mockResolvedValue({ database: { persisted: true } });
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  getCurrentTokenEpoch: jest.fn().mockResolvedValue(0),
  isTokenBlacklisted: mockIsTokenBlacklisted,
  // staffAuthService.logoutStaff revokes the presented access token's jti, and
  // the all-device branch additionally revokes every token for the identity.
  blacklistToken: mockBlacklistToken,
  persistRevokeAllUserTokens: mockPersistRevokeAllUserTokens,
  publishRevokeAllUserTokens: mockPublishRevokeAllUserTokens,
  revokeAllUserTokens: mockRevokeAllUserTokens,
}));

const mockIssueAccess = jest.fn();
jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: mockIssueAccess,
}));

const mockGetDeviceType = jest.fn().mockResolvedValue('mobile');
jest.unstable_mockModule('../../services/auth/userActiveSession.js', () => ({
  getUserSessionDeviceType: mockGetDeviceType,
}));

const mockTrackFailedLogin = jest.fn();
jest.unstable_mockModule('../../utils/loginAnomalyDetector.js', () => ({
  trackFailedLogin: mockTrackFailedLogin,
}));

const mockLogSecurityEvent = jest.fn();
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: mockLogSecurityEvent,
}));

// ── Import after mocks ───────────────────────────────────────────────
const { StaffAuthService } = await import('../../services/auth/staffAuthService.js');

const REQ = { ip: '10.0.0.9', headers: { 'user-agent': 'jest-agent' } };
const INSTALLATION_ID = '33333333-3333-4333-8333-333333333333';
const STAFF_TENANT_ID = '22222222-2222-4222-8222-222222222222';

// A fully-populated staff row as returned by the password / PIN login SELECTs.
const STAFF_ROW = {
  id: 42,
  uid: 'staff-uuid-1',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  name: 'Dr Who',
  email: 'who@test.local',
  phone: '+15550001111',
  role: 'DOCTOR',
  encrypted_password: '$2b$10$hashedpw',
  employee_id: 'EMP1',
  department: 'Cardiology',
  position: 'Consultant',
  is_active: true,
  user_is_active: true,
  user_status: 'active',
  is_deleted: false,
  merged_into_uid: null,
  staff_is_active: true,
  shift_type: 'DAY',
  pin_hash: '$2b$10$hashedpin',
};

// ── SQL-pattern-matching prisma stub ─────────────────────────────────
// Tests configure `readRows` (an array of { match, rows } rules consulted in
// order for each $queryRawUnsafe call) and `writeRowCount` (default executed
// rows). A read with no matching rule returns []. RETURNING writes flow through
// $queryRawUnsafe per the service's query() routing, so they are matched here
// too via `rows`.
let readRules;
let defaultWriteCount;

function read(match, rows) {
  readRules.push({ match, rows });
}

function configurePrisma() {
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql) => {
    for (const rule of readRules) {
      if (rule.match.test(sql)) {
        return typeof rule.rows === 'function' ? rule.rows() : rule.rows;
      }
    }
    return [];
  });
  mockPrisma.$executeRawUnsafe.mockImplementation(async () => defaultWriteCount);
  // createSession runs inside prisma.$transaction; delegate the callback to the
  // same stub so its inner FOR UPDATE select + INSERT are observable.
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPersistRevokeAllUserTokens.mockReset().mockResolvedValue(1_700_000_000);
  mockPublishRevokeAllUserTokens.mockReset().mockResolvedValue({ database: { persisted: true } });
  readRules = [];
  defaultWriteCount = 1;
  mockIssueAccess.mockResolvedValue({ accessToken: 'fresh-access-token' });
  mockGenerateToken.mockReturnValue('mock-refresh-token');
  mockGetDeviceType.mockResolvedValue('mobile');
  mockSetTenantTx.mockReset();
  mockSetTenantTx.mockImplementation(async (_tenantId, fn) => fn(mockPrisma));
  configurePrisma();
});

// =====================================================================
// _checkStaffLockout (shared, account-wide)
// =====================================================================
describe('_checkStaffLockout', () => {
  it('passes when failed-attempt count is below the limit', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '2' }]);
    await expect(StaffAuthService._checkStaffLockout('EMP1', REQ)).resolves.toBeUndefined();
    expect(mockLogSecurityEvent).not.toHaveBeenCalled();
  });

  it('throws + logs ACCOUNT_LOCKED when count is at/above the limit', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '5' }]);
    await expect(StaffAuthService._checkStaffLockout('EMP1', REQ, '/custom/path'))
      .rejects.toMatchObject({
        statusCode: 429,
        code: 'STAFF_LOGIN_RATE_LIMITED',
      });
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('ACCOUNT_LOCKED', expect.objectContaining({
      userName: 'EMP1',
      path: '/custom/path',
    }));
    expect(mockTrackFailedLogin).toHaveBeenCalledWith(REQ.ip, 'EMP1');
  });

  it('uses the default path and tolerates a missing req', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '9' }]);
    await expect(StaffAuthService._checkStaffLockout('EMP1')).rejects.toThrow('Account temporarily locked');
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('ACCOUNT_LOCKED', expect.objectContaining({
      path: '/api/v1/auth/staff/login',
    }));
  });
});

// =====================================================================
// _checkStaffPinLockout (two-tier)
// =====================================================================
describe('_checkStaffPinLockout', () => {
  it('passes when both vantage and global counts are below limits', async () => {
    let call = 0;
    read(/STAFF_PIN_LOGIN/, () => {
      call += 1;
      return [{ cnt: call === 1 ? '1' : '2' }]; // vantage, then global
    });
    await expect(StaffAuthService._checkStaffPinLockout('EMP1', REQ, 'dev-token')).resolves.toBeUndefined();
    expect(mockLogSecurityEvent).not.toHaveBeenCalled();
  });

  it('throws a per-device/IP lockout when the vantage count hits the limit', async () => {
    read(/STAFF_PIN_LOGIN/, [{ cnt: '5' }]); // first (vantage) call exceeds
    await expect(StaffAuthService._checkStaffPinLockout('EMP1', REQ, 'dev-token'))
      .rejects.toThrow('Too many failed PIN attempts from this device');
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('ACCOUNT_LOCKED', expect.objectContaining({
      path: '/api/v1/auth/staff/login-pin',
    }));
  });

  it('throws the account-wide backstop when global count hits 10x the limit', async () => {
    let call = 0;
    read(/STAFF_PIN_LOGIN/, () => {
      call += 1;
      return [{ cnt: call === 1 ? '0' : '60' }]; // vantage ok, global >= 50
    });
    await expect(StaffAuthService._checkStaffPinLockout('EMP1', REQ, null))
      .rejects.toThrow('Account temporarily locked');
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('ACCOUNT_LOCKED', expect.objectContaining({
      reason: expect.stringContaining('backstop'),
    }));
  });
});

// =====================================================================
// authenticateStaff (password login)
// =====================================================================
describe('authenticateStaff', () => {
  function happyReads() {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '0' }]);
    read(/FROM staff s\s+JOIN users u/, [STAFF_ROW]);
  }

  it('returns tokens + staff on a valid password', async () => {
    happyReads();
    mockBcryptCompare.mockResolvedValue(true);

    const result = await StaffAuthService.authenticateStaff('EMP1', 'pw', REQ, {
      deviceType: 'web',
      installationId: INSTALLATION_ID,
    });

    expect(result.accessToken).toBe('fresh-access-token');
    expect(result.refreshToken).toBe('mock-refresh-token');
    expect(result.staff).toMatchObject({ id: 42, employeeId: 'EMP1', role: 'DOCTOR' });
    expect(mockIssueAccess).toHaveBeenCalledWith(expect.objectContaining({
      userUid: 'staff-uuid-1',
      deviceType: 'web',
      tokenPayload: expect.objectContaining({ tenant_id: STAFF_TENANT_ID }),
    }));
    expect(mockSetTenantTx).toHaveBeenCalledWith(STAFF_TENANT_ID, expect.any(Function));
  });

  it('rejects an unknown employee ID', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '0' }]);
    read(/FROM staff s\s+JOIN users u/, []);
    await expect(StaffAuthService.authenticateStaff('NOPE', 'pw', REQ, {
      installationId: INSTALLATION_ID,
    }))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('LOGIN_FAILED', expect.objectContaining({
      reason: 'Invalid employee ID',
    }));
  });

  it('rejects a deactivated account', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '0' }]);
    read(/FROM staff s\s+JOIN users u/, [{ ...STAFF_ROW, staff_is_active: false }]);
    await expect(StaffAuthService.authenticateStaff('EMP1', 'pw', REQ, {
      installationId: INSTALLATION_ID,
    }))
      .rejects.toThrow('Account deactivated');
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('LOGIN_FAILED', expect.objectContaining({
      reason: 'Account deactivated',
    }));
  });

  it('rejects an RBAC-locked canonical user before password token issuance', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '0' }]);
    read(/FROM staff s\s+JOIN users u/, [{
      ...STAFF_ROW,
      user_is_active: false,
      user_status: 'inactive',
    }]);

    await expect(StaffAuthService.authenticateStaff('EMP1', 'pw', REQ, {
      installationId: INSTALLATION_ID,
    })).rejects.toThrow('Account deactivated');

    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('rejects a bad password', async () => {
    happyReads();
    mockBcryptCompare.mockResolvedValue(false);
    await expect(StaffAuthService.authenticateStaff('EMP1', 'wrong', REQ, {
      installationId: INSTALLATION_ID,
    }))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('LOGIN_FAILED', expect.objectContaining({
      reason: 'Invalid password',
    }));
  });

  it('propagates a lockout thrown by _checkStaffLockout (catch path)', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '5' }]);
    await expect(StaffAuthService.authenticateStaff('EMP1', 'pw', REQ, {
      installationId: INSTALLATION_ID,
    }))
      .rejects.toThrow('Account temporarily locked');
  });
});

// =====================================================================
// updateOwnProfile
// =====================================================================
describe('updateOwnProfile', () => {
  it('rejects forbidden HR-managed fields with 403', async () => {
    await expect(StaffAuthService.updateOwnProfile('uid', { role: 'ADMIN' }, REQ))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects unsupported fields with 400', async () => {
    await expect(StaffAuthService.updateOwnProfile('uid', { nickname: 'x' }, REQ))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an out-of-range name with 400', async () => {
    await expect(StaffAuthService.updateOwnProfile('uid', { name: 'a' }, REQ))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 404 when no row is updated', async () => {
    read(/UPDATE users[\s\S]*RETURNING/, []); // RETURNING => read path, 0 rows => rowCount 0
    await expect(StaffAuthService.updateOwnProfile('uid', { name: 'New Name' }, REQ))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('updates the display name and returns the profile', async () => {
    read(/UPDATE users[\s\S]*RETURNING/, [{ id: 42, uid: 'uid', name: 'New Name' }]);
    const out = await StaffAuthService.updateOwnProfile('uid', { name: '  New   Name ' }, REQ);
    expect(out.profile).toMatchObject({ name: 'New Name' });
  });
});

// =====================================================================
// changeOwnPassword
// =====================================================================
describe('changeOwnPassword', () => {
  it('requires both passwords (400)', async () => {
    await expect(StaffAuthService.changeOwnPassword('uid', '', 'new', REQ))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects identical old/new (400)', async () => {
    await expect(StaffAuthService.changeOwnPassword('uid', 'same', 'same', REQ))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 404 when the staff row is missing', async () => {
    read(/SELECT id, uid, role, encrypted_password/, []);
    await expect(StaffAuthService.changeOwnPassword('uid', 'old', 'new', REQ))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects an incorrect current password (401)', async () => {
    read(/SELECT id, uid, role, encrypted_password/, [{
      id: 42, uid: 'uid', encrypted_password: 'h', tenant_id: STAFF_TENANT_ID,
    }]);
    mockBcryptCompare.mockResolvedValue(false);
    await expect(StaffAuthService.changeOwnPassword('uid', 'old', 'new', REQ))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it('hashes + persists the new password on success', async () => {
    read(/SELECT id, uid, role, encrypted_password/, [{
      id: 42, uid: 'uid', encrypted_password: 'h', tenant_id: STAFF_TENANT_ID,
    }]);
    mockBcryptCompare.mockResolvedValue(true);
    const req = { ...REQ, user: { deviceType: 'web' } };
    const out = await StaffAuthService.changeOwnPassword('uid', 'old', 'newpw', req);
    expect(out).toEqual({ success: true });
    expect(mockBcryptHash).toHaveBeenCalledWith('newpw', 10);
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('uid', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'password_changed',
      notificationTenantId: STAFF_TENANT_ID,
    });
    expect(mockPublishRevokeAllUserTokens).toHaveBeenCalledWith(
      'uid', 1_700_000_000, { reason: 'password_changed' },
    );
  });

  it('does not report password-change success when durable revocation fails', async () => {
    read(/SELECT id, uid, role, encrypted_password/, [{
      id: 42,
      uid: 'uid',
      encrypted_password: 'h',
      tenant_id: STAFF_TENANT_ID,
    }]);
    mockBcryptCompare.mockResolvedValue(true);
    let passwordCommitted = false;
    mockSetTenantTx.mockImplementationOnce(async (_tenantId, callback) => {
      let stagedPassword = false;
      const tx = {
        ...mockPrisma,
        $executeRawUnsafe: jest.fn(async () => { stagedPassword = true; return 1; }),
      };
      const result = await callback(tx);
      passwordCommitted = stagedPassword;
      return result;
    });
    mockPersistRevokeAllUserTokens.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(StaffAuthService.changeOwnPassword('uid', 'old', 'newpw', REQ))
      .rejects.toThrow('durable store unavailable');
    expect(passwordCommitted).toBe(false);
    expect(mockPublishRevokeAllUserTokens).not.toHaveBeenCalled();
  });
});

// =====================================================================
// registerStaffDevice
// =====================================================================
describe('registerStaffDevice', () => {
  function authOk() {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '0' }]);
    read(/FROM staff s\s+JOIN users u/, [STAFF_ROW]);
    mockBcryptCompare.mockResolvedValue(true);
  }

  it('registers a device and returns device token + id', async () => {
    authOk();
    read(/SELECT device_id\s+FROM staff_devices/, [
      { device_id: '44444444-4444-4444-8444-444444444444' },
    ]);
    const out = await StaffAuthService.registerStaffDevice(
      'EMP1', 'pw', { name: 'Pixel 8', type: 'mobile', model: 'P8', os: 'Android', appVersion: '1.0' },
      REQ,
      {
        deviceType: 'mobile',
        installationId: INSTALLATION_ID,
      },
    );
    expect(out.deviceToken).toEqual(expect.any(String));
    expect(out.deviceId).toEqual(expect.any(String));
    expect(out.refreshToken).toBe('mock-refresh-token');
    expect(out.staff).toMatchObject({ employeeId: 'EMP1' });
    expect(mockBcryptCompare).toHaveBeenCalledTimes(1);
    const registeredCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
      ([sql]) => /INSERT INTO staff_devices/.test(sql),
    );
    expect(registeredCall).toBeDefined();
    expect(registeredCall.slice(1, 4)).toEqual([
      STAFF_TENANT_ID,
      42,
      'staff-uuid-1',
    ]);
  });

  it('rejects a sixth device before issuing or mutating login/registration state', async () => {
    authOk();
    read(/SELECT device_id\s+FROM staff_devices/, Array.from(
      { length: 5 },
      (_, index) => ({ device_id: `device-${index + 1}` }),
    ));
    await expect(StaffAuthService.registerStaffDevice(
      'EMP1',
      'pw',
      { name: 'X' },
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'STAFF_DEVICE_LIMIT_REACHED',
      });

    expect(mockBcryptCompare).toHaveBeenCalledTimes(1);
    expect(mockIssueAccess).not.toHaveBeenCalled();
    const preflightSql = mockPrisma.$queryRawUnsafe.mock.calls
      .map(([sql]) => String(sql))
      .join('\n');
    expect(preflightSql).toMatch(/pg_advisory_xact_lock/);
    expect(preflightSql).toMatch(/FROM staff_devices[\s\S]*FOR UPDATE/);
    const mutationSql = mockPrisma.$executeRawUnsafe.mock.calls
      .map(([sql]) => String(sql))
      .join('\n');
    expect(mutationSql).not.toMatch(/INSERT INTO user_devices/);
    expect(mutationSql).not.toMatch(/INSERT INTO staff_devices/);
    expect(mutationSql).not.toMatch(/INSERT INTO staff_auth_sessions/);
    expect(mutationSql).not.toMatch(/INSERT INTO auth_logs/);
    expect(mutationSql).not.toMatch(/INSERT INTO admin_activity_logs/);
    expect(mutationSql).not.toMatch(/UPDATE users SET last_sign_in_at/);
  });

  it('allows same-device re-registration when four other devices are active', async () => {
    authOk();
    read(/SELECT device_id\s+FROM staff_devices/, [
      { device_id: INSTALLATION_ID },
      ...Array.from(
        { length: 4 },
        (_, index) => ({ device_id: `other-device-${index + 1}` }),
      ),
    ]);

    const out = await StaffAuthService.registerStaffDevice(
      'EMP1',
      'pw',
      { deviceName: 'Re-enrolled ward device', platform: 'android' },
      REQ,
      { deviceType: 'mobile', installationId: INSTALLATION_ID },
    );

    expect(out).toMatchObject({
      accessToken: 'fresh-access-token',
      refreshToken: 'mock-refresh-token',
      deviceId: INSTALLATION_ID,
    });
    expect(mockBcryptCompare).toHaveBeenCalledTimes(1);
    expect(mockIssueAccess).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRawUnsafe.mock.calls.some(
      ([sql]) => /INSERT INTO staff_devices/.test(sql),
    )).toBe(true);
  });

  it('uses defaults when deviceInfo fields are absent', async () => {
    authOk();
    read(/SELECT device_id\s+FROM staff_devices/, []);
    const out = await StaffAuthService.registerStaffDevice(
      'EMP1',
      'pw',
      {},
      REQ,
      { installationId: INSTALLATION_ID },
    );
    expect(out.deviceId).toEqual(expect.any(String));
  });

  it('propagates an auth failure from the inner authenticateStaff (catch path)', async () => {
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '0' }]);
    read(/FROM staff s\s+JOIN users u/, []); // unknown employee
    await expect(StaffAuthService.registerStaffDevice(
      'NOPE',
      'pw',
      { name: 'X' },
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
  });
});

// =====================================================================
// quickLogin
// =====================================================================
describe('quickLogin', () => {
  const DEVICE_ROW = {
    internal_device_id: 7,
    staff_id: 42,
    device_id: INSTALLATION_ID,
    pin_hash: '$2b$10$pin',
    biometric_enabled: true,
    uid: 'staff-uuid-1',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    name: 'Dr Who',
    email: 'who@test.local',
    phone: '+1',
    role: 'DOCTOR',
    encrypted_password: 'h',
    employee_id: 'EMP1',
    department: 'Cardiology',
    position: 'Consultant',
    is_active: true,
    user_is_active: true,
    user_status: 'active',
    is_deleted: false,
    merged_into_uid: null,
    staff_is_active: true,
  };

  function deviceFound(overrides = {}) {
    read(/FROM staff_devices d\s+JOIN users u/, [{ ...DEVICE_ROW, ...overrides }]);
    read(/COUNT\(\*\) as cnt FROM auth_logs/, [{ cnt: '0' }]);
  }

  it('rejects an unknown/expired device token', async () => {
    read(/FROM staff_devices d\s+JOIN users u/, []);
    await expect(StaffAuthService.quickLogin(
      'bad',
      '1234',
      false,
      null,
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toThrow('Invalid or expired device token');
  });

  it('rejects a deactivated account', async () => {
    deviceFound({ staff_is_active: false });
    await expect(StaffAuthService.quickLogin(
      'tok',
      '1234',
      false,
      null,
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toThrow('Account deactivated');
  });

  it('rejects an RBAC-locked canonical user before quick-login token issuance', async () => {
    deviceFound({ user_is_active: false, user_status: 'inactive' });

    await expect(StaffAuthService.quickLogin(
      'tok',
      '1234',
      false,
      null,
      REQ,
      { installationId: INSTALLATION_ID },
    )).rejects.toThrow('Account deactivated');

    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('logs in with a valid PIN', async () => {
    deviceFound();
    mockBcryptCompare.mockResolvedValue(true);
    const out = await StaffAuthService.quickLogin(
      'tok',
      '1234',
      false,
      null,
      REQ,
      {
        deviceType: 'mobile',
        installationId: INSTALLATION_ID,
      },
    );
    expect(out.accessToken).toBe('fresh-access-token');
    expect(out.staff).toMatchObject({ employeeId: 'EMP1' });
  });

  it('rejects an invalid PIN', async () => {
    deviceFound();
    mockBcryptCompare.mockResolvedValue(false);
    await expect(StaffAuthService.quickLogin(
      'tok',
      '0000',
      false,
      null,
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toThrow('Invalid PIN');
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('LOGIN_FAILED', expect.objectContaining({
      reason: 'Invalid PIN (quick login)',
    }));
  });

  it('rejects when PIN is supplied but no pin_hash exists on the device', async () => {
    deviceFound({ pin_hash: null });
    await expect(StaffAuthService.quickLogin(
      'tok',
      '1234',
      false,
      null,
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toThrow('PIN not set for this device');
  });

  it('logs in via biometric when enabled', async () => {
    deviceFound();
    const out = await StaffAuthService.quickLogin(
      'tok',
      null,
      true,
      { lat: 1 },
      REQ,
      { installationId: INSTALLATION_ID },
    );
    expect(out.accessToken).toBe('fresh-access-token');
  });

  it('rejects biometric when not enabled for the device', async () => {
    deviceFound({ biometric_enabled: false });
    await expect(StaffAuthService.quickLogin(
      'tok',
      null,
      true,
      null,
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toThrow('Biometric not enabled for this device');
  });

  it('rejects when neither PIN nor biometric is provided', async () => {
    deviceFound();
    await expect(StaffAuthService.quickLogin(
      'tok',
      null,
      false,
      null,
      REQ,
      { installationId: INSTALLATION_ID },
    ))
      .rejects.toThrow('PIN or biometric required');
  });
});

// =====================================================================
// authenticateStaffWithPin
// =====================================================================
describe('authenticateStaffWithPin', () => {
  function pinLockoutOk() {
    // both vantage + global pin-lockout COUNTs return 0
    read(/STAFF_PIN_LOGIN/, [{ cnt: '0' }]);
  }

  it('rejects when no device token is supplied (403 / PIN_DEVICE_NOT_REGISTERED)', async () => {
    pinLockoutOk();
    await expect(StaffAuthService.authenticateStaffWithPin('EMP1', '1234', REQ, {
      installationId: INSTALLATION_ID,
    }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PIN_DEVICE_NOT_REGISTERED' });
  });

  it('rejects an unknown employee ID', async () => {
    pinLockoutOk();
    read(/FROM staff s\s+JOIN users u/, []);
    await expect(StaffAuthService.authenticateStaffWithPin('NOPE', '1234', REQ, {
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    }))
      .rejects.toThrow('Invalid employee ID or PIN');
  });

  it('rejects a deactivated account', async () => {
    pinLockoutOk();
    read(/FROM staff s\s+JOIN users u/, [{ ...STAFF_ROW, staff_is_active: false }]);
    await expect(StaffAuthService.authenticateStaffWithPin('EMP1', '1234', REQ, {
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    }))
      .rejects.toThrow('Account deactivated');
  });

  it('rejects an RBAC-locked canonical user before PIN token issuance', async () => {
    pinLockoutOk();
    read(/FROM staff s\s+JOIN users u/, [{
      ...STAFF_ROW,
      user_is_active: false,
      user_status: 'inactive',
    }]);

    await expect(StaffAuthService.authenticateStaffWithPin('EMP1', '1234', REQ, {
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    })).rejects.toThrow('Account deactivated');

    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('rejects when the device is not registered to this staff (403)', async () => {
    pinLockoutOk();
    read(/FROM staff s\s+JOIN users u/, [STAFF_ROW]);
    read(/SELECT id, pin_hash FROM staff_devices/, []); // device binding lookup empty
    await expect(StaffAuthService.authenticateStaffWithPin('EMP1', '1234', REQ, {
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PIN_DEVICE_NOT_REGISTERED' });
  });

  it('rejects when no PIN hash is set on the account', async () => {
    pinLockoutOk();
    read(/FROM staff s\s+JOIN users u/, [STAFF_ROW]);
    read(/SELECT id, pin_hash FROM staff_devices/, [{ id: 9, pin_hash: null }]);
    await expect(StaffAuthService.authenticateStaffWithPin('EMP1', '1234', REQ, {
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    }))
      .rejects.toThrow('PIN not set for this device');
  });

  it('rejects an invalid PIN', async () => {
    pinLockoutOk();
    read(/FROM staff s\s+JOIN users u/, [STAFF_ROW]);
    read(/SELECT id, pin_hash FROM staff_devices/, [{ id: 9, pin_hash: '$2b$10$pin' }]);
    mockBcryptCompare.mockResolvedValue(false);
    await expect(StaffAuthService.authenticateStaffWithPin('EMP1', '0000', REQ, {
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    }))
      .rejects.toThrow('Invalid employee ID or PIN');
  });

  it('logs in with a valid PIN on a registered device', async () => {
    pinLockoutOk();
    read(/FROM staff s\s+JOIN users u/, [STAFF_ROW]);
    read(/SELECT id, pin_hash FROM staff_devices/, [{ id: 9, pin_hash: '$2b$10$pin' }]);
    mockBcryptCompare.mockResolvedValue(true);
    const out = await StaffAuthService.authenticateStaffWithPin('EMP1', '1234', REQ, {
      deviceType: 'mobile',
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    });
    expect(out.accessToken).toBe('fresh-access-token');
    expect(out.refreshToken).toBe('mock-refresh-token');
    expect(out.staff).toMatchObject({ employeeId: 'EMP1' });
  });

  it('propagates a PIN lockout (catch path)', async () => {
    read(/STAFF_PIN_LOGIN/, [{ cnt: '5' }]); // vantage lockout
    await expect(StaffAuthService.authenticateStaffWithPin('EMP1', '1234', REQ, {
      deviceToken: 'dt',
      installationId: INSTALLATION_ID,
    }))
      .rejects.toThrow('Too many failed PIN attempts');
  });
});

// =====================================================================
// setupPin / toggleBiometric / _verifyDeviceOwnership
// =====================================================================
describe('setupPin', () => {
  it('hashes the PIN and updates the device', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT id, device_id/, [{ id: 7, device_id: INSTALLATION_ID }]);
    const out = await StaffAuthService.setupPin('uid', 'tok', '1234');
    expect(out).toEqual({
      success: true,
      message: 'PIN setup successfully',
      reauthenticationRequired: false,
    });
    expect(mockBcryptHash).toHaveBeenCalledWith('1234', 10);
  });

  it('revokes existing sessions when an enrolled PIN is replaced', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT id, device_id/, [{ id: 7, device_id: INSTALLATION_ID }]);
    read(/SELECT pin_hash\s+FROM staff_devices/, [{ pin_hash: 'old-pin-hash' }]);

    await StaffAuthService.setupPin('uid', 'tok', '5678');

    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('uid', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'pin_changed',
      notificationTenantId: STAFF_TENANT_ID,
    });
    expect(mockPublishRevokeAllUserTokens).toHaveBeenCalledWith(
      'uid', 1_700_000_000, { reason: 'pin_changed' },
    );
  });

  it('rolls back a PIN replacement when durable revocation fails', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT id, device_id/, [{ id: 7, device_id: INSTALLATION_ID }]);
    read(/SELECT pin_hash\s+FROM staff_devices/, [{ pin_hash: 'old-pin-hash' }]);
    let pinCommitted = false;
    mockSetTenantTx.mockImplementationOnce(async (_tenantId, callback) => {
      let stagedPin = false;
      const tx = {
        ...mockPrisma,
        $executeRawUnsafe: jest.fn(async () => { stagedPin = true; return 1; }),
      };
      const result = await callback(tx);
      pinCommitted = stagedPin;
      return result;
    });
    mockPersistRevokeAllUserTokens.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(StaffAuthService.setupPin('uid', 'tok', '5678'))
      .rejects.toThrow('durable store unavailable');
    expect(pinCommitted).toBe(false);
    expect(mockPublishRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('throws (catch path) when the user is not found', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, []);
    await expect(StaffAuthService.setupPin('uid', 'tok', '1234')).rejects.toThrow('Staff not found');
  });

  it('throws when the device is not owned by the user', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT id, device_id/, []);
    await expect(StaffAuthService.setupPin('uid', 'tok', '1234'))
      .rejects.toMatchObject({ statusCode: 404, code: 'STAFF_DEVICE_NOT_FOUND' });
  });
});

describe('toggleBiometric', () => {
  it('toggles biometric on a verified device', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT id, device_id/, [{ id: 7, device_id: INSTALLATION_ID }]);
    const out = await StaffAuthService.toggleBiometric('uid', 'tok', true);
    expect(out).toEqual({ success: true, biometricEnabled: true });
  });

  it('propagates ownership failures (catch path)', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, []);
    await expect(StaffAuthService.toggleBiometric('uid', 'tok', false))
      .rejects.toThrow('Staff not found');
  });
});

// =====================================================================
// refreshStaffSession (happy + branch coverage beyond the existing suite)
// =====================================================================
describe('refreshStaffSession', () => {
  const SESSION_ROW = {
    id: 5, staff_id: 42, uid: 'staff-uuid-1', name: 'Dr Who',
    email: 'who@test.local', role: 'DOCTOR', employee_id: 'EMP1', is_active: true,
    tenant_id: '22222222-2222-4222-8222-222222222222',
  };

  it('mints a new access token for a valid, non-revoked refresh token', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'good',
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    read(/FROM staff_auth_sessions s\s+JOIN users u/, [SESSION_ROW]);
    const out = await StaffAuthService.refreshStaffSession(
      'rt',
      null,
      INSTALLATION_ID,
      REQ,
    );
    expect(out.accessToken).toBe('fresh-access-token');
    expect(mockIssueAccess).toHaveBeenCalledWith(expect.objectContaining({ pushRevoked: false }));
  });

  it('rejects a deactivated account on refresh', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'good',
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    read(/FROM staff_auth_sessions s\s+JOIN users u/, [{ ...SESSION_ROW, is_active: false }]);
    await expect(StaffAuthService.refreshStaffSession(
      'rt',
      null,
      INSTALLATION_ID,
      REQ,
    ))
      .rejects.toThrow('Account deactivated');
  });

  it('rejects an invalid/expired refresh token (verifyToken → null)', async () => {
    mockVerifyToken.mockReturnValue(null);
    await expect(StaffAuthService.refreshStaffSession(
      'garbage',
      null,
      INSTALLATION_ID,
      REQ,
    ))
      .rejects.toThrow('Invalid or expired refresh token');
  });

  it('rejects a token whose type is not "refresh" (access-token replay guard)', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'staff-uuid-1', id: 42, role: 'DOCTOR', jti: 'j1' });
    await expect(StaffAuthService.refreshStaffSession(
      'access-token',
      null,
      INSTALLATION_ID,
      REQ,
    ))
      .rejects.toThrow('Invalid or expired refresh token');
    expect(mockIsTokenBlacklisted).not.toHaveBeenCalled();
  });

  it('rejects a blacklisted / revoked refresh token', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'revoked',
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(true);
    await expect(StaffAuthService.refreshStaffSession(
      'rt',
      null,
      INSTALLATION_ID,
      REQ,
    ))
      .rejects.toThrow('Token has been revoked');
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });

  it('rejects when a valid refresh token has no matching session row', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'staff-uuid-1',
      id: 42,
      role: 'DOCTOR',
      type: 'refresh',
      jti: 'good',
      stableDeviceId: INSTALLATION_ID,
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    read(/FROM staff_auth_sessions s\s+JOIN users u/, []); // session lookup empty
    await expect(StaffAuthService.refreshStaffSession(
      'rt',
      null,
      INSTALLATION_ID,
      REQ,
    ))
      .rejects.toThrow('Invalid or expired session');
    expect(mockIssueAccess).not.toHaveBeenCalled();
  });
});

// =====================================================================
// logoutStaff
// =====================================================================
describe('logoutStaff', () => {
  it('throws when the staff user is not found', async () => {
    read(/SELECT id FROM users WHERE uid/, []);
    await expect(StaffAuthService.logoutStaff('uid', 'tok', REQ)).rejects.toThrow('Staff not found');
  });

  it('deletes the device-scoped session when a deviceToken resolves a device', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT device_id FROM staff_devices/, [{ device_id: 'dev-uuid' }]);
    const out = await StaffAuthService.logoutStaff('uid', 'tok', REQ);
    expect(out).toEqual({
      success: true,
      message: 'Logged out successfully',
      allDevices: false,
      // Device-scoped logout with no token claims supplied, so nothing was
      // revoked — and the result says so rather than implying otherwise.
      accessTokenRevoked: false,
    });
    expect(mockBlacklistToken).not.toHaveBeenCalled();
    expect(mockRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('still succeeds when the deviceToken matches no device', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT device_id FROM staff_devices/, []);
    const out = await StaffAuthService.logoutStaff('uid', 'tok', REQ);
    expect(out.success).toBe(true);
  });

  it('deletes all sessions when no deviceToken is given', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    const out = await StaffAuthService.logoutStaff('uid', null, REQ);
    expect(out.success).toBe(true);
  });

  // Audit follow-up P12. Deleting staff_auth_sessions kills the refresh
  // credential, but the access token already issued to the device stays valid
  // for the rest of its own exp unless its jti is blacklisted — which logout
  // never did, while reporting success.
  it('revokes the presented access token jti with a real expiry', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    const out = await StaffAuthService.logoutStaff('uid', null, REQ, {
      accessTokenJti: 'jti-123',
      accessTokenExpiresAt: expiresAt,
      sessionFamilyId: 'session-family-1',
      stableDeviceId: INSTALLATION_ID,
    });

    expect(out).toMatchObject({ success: true, accessTokenRevoked: true });
    expect(mockBlacklistToken).not.toHaveBeenCalled();
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('uid', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'logout',
      notificationTenantId: STAFF_TENANT_ID,
    });
  });

  // No deviceToken means every staff_auth_sessions row is deleted, so the
  // sibling devices' access tokens must die too — otherwise an "all devices"
  // logout leaves them usable until they expire on their own.
  it('revokes every token for the identity on an all-device logout', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);

    const out = await StaffAuthService.logoutStaff('uid', null, REQ);

    expect(out).toMatchObject({ allDevices: true, accessTokenRevoked: true });
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('uid', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'logout',
      notificationTenantId: STAFF_TENANT_ID,
    });
  });

  it('leaves other devices alone on a device-scoped logout', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT device_id FROM staff_devices/, [{ device_id: 'dev-uuid' }]);

    const out = await StaffAuthService.logoutStaff('uid', 'tok', REQ, {
      accessTokenJti: 'jti-123',
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(out).toMatchObject({ allDevices: false });
    expect(mockRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('fails loudly when the all-device revocation is not persisted', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    mockPersistRevokeAllUserTokens.mockRejectedValueOnce(new Error('no store accepted it'));

    await expect(
      StaffAuthService.logoutStaff('uid', null, REQ),
    ).rejects.toMatchObject({ statusCode: 503, code: 'REVOCATION_STORE_UNAVAILABLE' });
  });

  it('fails loudly with 503 when the revocation store refuses the write', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT device_id FROM staff_devices/, [{ device_id: 'dev-uuid' }]);
    mockBlacklistToken.mockRejectedValueOnce(new Error('no store accepted the entry'));

    await expect(
      StaffAuthService.logoutStaff('uid', 'device-token', REQ, {
        accessTokenJti: 'jti-123',
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'REVOCATION_STORE_UNAVAILABLE' });
  });
});

// =====================================================================
// listStaffDevices
// =====================================================================
describe('listStaffDevices', () => {
  it('throws when the staff user is not found', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, []);
    await expect(StaffAuthService.listStaffDevices('uid')).rejects.toThrow('Staff not found');
  });

  it('returns the bare array of device rows', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/FROM staff_devices/, [{ id: 'd1', deviceName: 'Pixel' }]);
    const out = await StaffAuthService.listStaffDevices('uid');
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([{ id: 'd1', deviceName: 'Pixel' }]);
  });
});

// =====================================================================
// removeDevice
// =====================================================================
describe('removeDevice', () => {
  it('revokes only an owned tenant-bound device and its sessions', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT id, device_name/, [{ id: 7, device_name: 'Ward tablet' }]);

    const out = await StaffAuthService.removeDevice('uid', INSTALLATION_ID, REQ);

    expect(out).toEqual({
      success: true,
      deviceId: INSTALLATION_ID,
      allSessionsRevoked: true,
      reauthenticationRequired: true,
    });
    expect(mockSetTenantTx).toHaveBeenCalledWith(STAFF_TENANT_ID, expect.any(Function));
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('uid', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'staff_device_removed',
      notificationTenantId: STAFF_TENANT_ID,
    });
    const sql = mockPrisma.$executeRawUnsafe.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('SET is_active = false');
    expect(sql).toContain('DELETE FROM staff_auth_sessions');
    expect(sql).toContain('tenant_id = $1::uuid');
  });

  it('rejects a device outside the authenticated owner and tenant', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);
    read(/SELECT id, device_name/, []);

    await expect(
      StaffAuthService.removeDevice('uid', INSTALLATION_ID, REQ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'STAFF_DEVICE_NOT_FOUND' });

    expect(mockPersistRevokeAllUserTokens).not.toHaveBeenCalled();
    const sql = mockPrisma.$executeRawUnsafe.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).not.toContain('SET is_active = false');
  });

  it('rejects a malformed installation id before mutating state', async () => {
    read(/SELECT id, tenant_id FROM users WHERE uid/, [{ id: 42, tenant_id: STAFF_TENANT_ID }]);

    await expect(
      StaffAuthService.removeDevice('uid', 'not-a-device-id', REQ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'STAFF_INSTALLATION_ID_INVALID' });

    expect(mockSetTenantTx).not.toHaveBeenCalled();
  });
});

// =====================================================================
// adminForceLogout / adminResetPin
// =====================================================================
describe('admin methods', () => {
  it('adminForceLogout deletes sessions and logs activity', async () => {
    read(/WHERE s\.id = \$1/, [{ id: 42, uid: 'staff-uuid-1', tenant_id: STAFF_TENANT_ID }]);
    const out = await StaffAuthService.adminForceLogout(42, 'compromised', 'admin-uid', REQ);
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('staff-uuid-1', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'admin_force_logout',
      notificationTenantId: STAFF_TENANT_ID,
    });
    expect(out).toEqual({ success: true, message: 'Staff member logged out from all devices' });
  });

  it('adminResetPin nulls device PINs and reports affected count', async () => {
    read(/SELECT uid, tenant_id FROM users WHERE id/, [{
      uid: 'staff-uuid-1', tenant_id: STAFF_TENANT_ID,
    }]);
    read(/SELECT uid FROM users WHERE id/, [{ uid: 'staff-uuid-1' }]);
    read(/UPDATE staff_devices\s+SET pin_hash = NULL[\s\S]*RETURNING/, [{ id: 1 }, { id: 2 }]);
    const out = await StaffAuthService.adminResetPin(42, 'admin-uid', REQ);
    expect(out).toMatchObject({ success: true, devicesAffected: 2 });
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('staff-uuid-1', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'pin_reset',
      notificationTenantId: STAFF_TENANT_ID,
    });
    expect(mockPublishRevokeAllUserTokens).toHaveBeenCalledWith(
      'staff-uuid-1', 1_700_000_000, { reason: 'pin_reset' },
    );
  });

  it('rolls back an admin PIN reset when durable revocation fails', async () => {
    read(/SELECT uid, tenant_id FROM users WHERE id/, [{
      uid: 'staff-uuid-1', tenant_id: STAFF_TENANT_ID,
    }]);
    read(/SELECT uid FROM users WHERE id/, [{ uid: 'staff-uuid-1' }]);
    read(/UPDATE staff_devices\s+SET pin_hash = NULL[\s\S]*RETURNING/, [{ id: 1 }]);
    let pinResetCommitted = false;
    mockSetTenantTx.mockImplementationOnce(async (_tenantId, callback) => {
      let stagedReset = false;
      const tx = {
        ...mockPrisma,
        $queryRawUnsafe: jest.fn(async (sql, ...params) => {
          if (/UPDATE staff_devices\s+SET pin_hash = NULL/.test(sql)) stagedReset = true;
          return mockPrisma.$queryRawUnsafe(sql, ...params);
        }),
      };
      const result = await callback(tx);
      pinResetCommitted = stagedReset;
      return result;
    });
    mockPersistRevokeAllUserTokens.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(StaffAuthService.adminResetPin(42, 'admin-uid', REQ))
      .rejects.toThrow('durable store unavailable');
    expect(pinResetCommitted).toBe(false);
    expect(mockPublishRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('adminForceLogout surfaces DB errors (catch path)', async () => {
    read(/WHERE s\.id = \$1/, [{ id: 42, uid: 'staff-uuid-1', tenant_id: STAFF_TENANT_ID }]);
    mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('db down'));
    await expect(StaffAuthService.adminForceLogout(42, 'r', 'admin-uid', REQ)).rejects.toThrow('db down');
  });

  it('adminResetPin surfaces DB errors (catch path)', async () => {
    // The pin-reset UPDATE ... RETURNING flows through the read path (query()
    // routes RETURNING to $queryRawUnsafe); reject it to hit the catch block.
    mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('reset failed'));
    await expect(StaffAuthService.adminResetPin(42, 'admin-uid', REQ)).rejects.toThrow('reset failed');
  });
});

// =====================================================================
// token generators
// =====================================================================
describe('token generators', () => {
  it('generateAccessToken signs the int id + uid + role', () => {
    StaffAuthService.generateAccessToken({ id: 42, uid: 'u', role: 'DOCTOR' });
    expect(mockGenerateToken).toHaveBeenCalledWith(
      { id: 42, uid: 'u', role: 'DOCTOR' }, expect.any(String)
    );
  });

  it('generateRefreshToken stamps type:refresh + 30d + the mint-time token_epoch (R1)', async () => {
    await StaffAuthService.generateRefreshToken(
      { id: 42, uid: 'u', role: 'DOCTOR' },
      INSTALLATION_ID,
      0,
      'staff-session-family',
    );
    expect(mockGenerateToken).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'refresh',
        token_epoch: 0,
        stableDeviceId: INSTALLATION_ID,
        sessionFamilyId: 'staff-session-family',
      }),
      '30d'
    );
  });

  it('generateDeviceToken returns a 64-char hex string', () => {
    const tok = StaffAuthService.generateDeviceToken();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =====================================================================
// createSession (concurrent-session eviction inside $transaction)
// =====================================================================
describe('createSession', () => {
  it('inserts a session without eviction when under the concurrent limit', async () => {
    read(/SELECT id\s+FROM staff_auth_sessions/, [{ id: 1 }]); // 1 active < limit
    await StaffAuthService.createSession(
      42,
      STAFF_TENANT_ID,
      INSTALLATION_ID,
      'sess-token',
      REQ,
    );
    expect(mockSetTenantTx).toHaveBeenCalledWith(STAFF_TENANT_ID, expect.any(Function));
    // INSERT runs via the tx ($executeRawUnsafe); no DELETE eviction expected.
    const executed = mockPrisma.$executeRawUnsafe.mock.calls.map((c) => c[0]).join('\n');
    expect(executed).toContain('INSERT INTO staff_auth_sessions');
    expect(executed).not.toContain('DELETE FROM staff_auth_sessions');
  });

  it('evicts the oldest sessions when at/over the concurrent limit', async () => {
    read(/SELECT id\s+FROM staff_auth_sessions/, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    await StaffAuthService.createSession(
      42,
      STAFF_TENANT_ID,
      INSTALLATION_ID,
      'sess-token',
      { ip: '' },
    );
    const executed = mockPrisma.$executeRawUnsafe.mock.calls.map((c) => c[0]).join('\n');
    expect(executed).toContain('DELETE FROM staff_auth_sessions');
    expect(executed).toContain('INSERT INTO staff_auth_sessions');
  });
});

// =====================================================================
// revokeAllSessions
// =====================================================================
describe('revokeAllSessions', () => {
  it('durably revokes the identity before deleting all staff sessions', async () => {
    read(/SELECT uid, tenant_id FROM users WHERE id/, [{ uid: 'staff-uuid-1', tenant_id: STAFF_TENANT_ID }]);
    mockPrisma.$executeRawUnsafe.mockResolvedValueOnce(3);
    const out = await StaffAuthService.revokeAllSessions(42);
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('staff-uuid-1', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'admin_force_logout',
      notificationTenantId: STAFF_TENANT_ID,
    });
    expect(out).toEqual({ revokedCount: 3 });
  });
});

// =====================================================================
// logAuthAttempt / logActivity — success + swallowed-error branches
// =====================================================================
describe('log helpers swallow DB errors', () => {
  it('logAuthAttempt inserts a row on the happy path', async () => {
    await StaffAuthService.logAuthAttempt('EMP1', 'STAFF_LOGIN', true, null, 'password', REQ, 'devinfo');
    const executed = mockPrisma.$executeRawUnsafe.mock.calls.map((c) => c[0]).join('\n');
    expect(executed).toContain('INSERT INTO auth_logs');
  });

  it('logAuthAttempt swallows a DB error (never throws)', async () => {
    mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('insert failed'));
    await expect(StaffAuthService.logAuthAttempt('EMP1', 'STAFF_LOGIN', false, 'r', 'password', REQ))
      .resolves.toBeUndefined();
  });

  it('logActivity inserts a row on the happy path', async () => {
    await StaffAuthService.logActivity('uid', 'STAFF_LOGOUT', 'desc', REQ, { x: 1 });
    const executed = mockPrisma.$executeRawUnsafe.mock.calls.map((c) => c[0]).join('\n');
    expect(executed).toContain('INSERT INTO admin_activity_logs');
  });

  it('logActivity swallows a DB error (never throws)', async () => {
    mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('insert failed'));
    await expect(StaffAuthService.logActivity('uid', 'A', 'd', REQ)).resolves.toBeUndefined();
  });
});

// =====================================================================
// getTodayAttendance / getAttendanceHistory
// =====================================================================
describe('getTodayAttendance', () => {
  it('returns the empty status when no staffUid is given', async () => {
    const out = await StaffAuthService.getTodayAttendance(null);
    expect(out).toMatchObject({ isCheckedIn: false, status: 'not-checked-in' });
  });

  it('returns the empty status when no attendance row exists', async () => {
    read(/FROM staff_attendance sa/, []);
    const out = await StaffAuthService.getTodayAttendance('uid');
    expect(out.status).toBe('not-checked-in');
  });

  it('reports checked-in when there is a check-in but no check-out', async () => {
    read(/FROM staff_attendance sa/, [{
      id: 1, check_in_time: new Date(), check_out_time: null,
      local_check_in_time: '2026-06-13T09:00:00.000',
    }]);
    const out = await StaffAuthService.getTodayAttendance('uid');
    expect(out).toMatchObject({ isCheckedIn: true, status: 'checked-in' });
  });

  it('reports checked-out when a check-out exists', async () => {
    read(/FROM staff_attendance sa/, [{
      id: 1, check_in_time: new Date(), check_out_time: new Date(),
    }]);
    const out = await StaffAuthService.getTodayAttendance('uid');
    expect(out.status).toBe('checked-out');
  });
});

describe('getAttendanceHistory', () => {
  it('returns an empty page when no staffUid is given', async () => {
    const out = await StaffAuthService.getAttendanceHistory(null, {});
    expect(out).toEqual({ items: [], total: 0, page: 1, limit: 30 });
  });

  it('applies both date filters and returns items + total', async () => {
    read(/SELECT COUNT\(\*\)::int AS total/, [{ total: 2 }]);
    read(/FROM staff_attendance sa/, [{ id: 1 }, { id: 2 }]);
    const out = await StaffAuthService.getAttendanceHistory('uid', {
      startDate: '2026-06-01', endDate: '2026-06-13', page: 2, limit: 50,
    });
    expect(out).toMatchObject({ total: 2, page: 2, limit: 50 });
    expect(out.items).toHaveLength(2);
  });

  it('defaults to the last-30-days window when no dates are supplied', async () => {
    read(/SELECT COUNT\(\*\)::int AS total/, [{ total: 0 }]);
    read(/FROM staff_attendance sa/, []);
    const out = await StaffAuthService.getAttendanceHistory('uid', {});
    expect(out.total).toBe(0);
    const historySql = mockPrisma.$queryRawUnsafe.mock.calls
      .map((c) => c[0]).find((s) => /FROM staff_attendance sa/.test(s));
    expect(historySql).toContain("NOW() - INTERVAL '30 days'");
  });
});
