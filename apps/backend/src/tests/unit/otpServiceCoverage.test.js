// src/tests/unit/otpServiceCoverage.test.js
//
// Coverage-focused unit suite for the database-backed OTP service (roadmap
// B3.2). This is a companion to src/tests/unit/otpService.test.js (which covers
// generateOTP / checkDailyLimit / checkResendCooldown / verifyOtp happy+invalid
// paths). It deliberately drives the previously-uncovered surface:
//   - requestOtp: daily-limit gate, resend-cooldown gate, the success path, and
//     both dev-mode branches (devOtp echo + dev logging).
//   - storeOTP: hashed-OTP creation + plaintext return.
//   - logActivity: happy insert + swallowed-DB-error branch.
//   - getHealthStatus: healthy aggregation + degraded catch.
//   - verifyOtp: the bcrypt-hashed-OTP comparison branch (the existing suite
//     only exercises legacy plaintext).
//
// Fully mocked — prisma (local mock so this file owns otp_sessions/otp_logs),
// bcrypt, phoneUtils, otpConfig, logger, responseCodes. No DB / network, so the
// suite is deterministic and parallel-safe. Mirrors the authServiceCoverage /
// staffAuthServiceCoverage conventions (mock prisma default + the tenant
// helpers).

import { jest } from '@jest/globals';

// ── Local prisma mock (self-contained) ───────────────────────────────
const mockPrisma = {
  otp_sessions: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  otp_logs: { create: jest.fn(), count: jest.fn() },
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

// bcrypt — hash returns a deterministic sentinel; compare is configurable.
const mockBcryptHash = jest.fn().mockResolvedValue('$2b$06$hashed-otp');
const mockBcryptCompare = jest.fn();
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: mockBcryptHash, compare: mockBcryptCompare },
}));

// phoneUtils — deterministic pass-through normalizer.
jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (phone) => {
    if (!phone) return null;
    let n = String(phone).replace(/[^\d+]/g, '');
    if (n.length === 10 && !n.startsWith('+')) n = '+91' + n;
    else if (n.startsWith('91') && n.length === 12) n = '+' + n;
    else if (!n.startsWith('+') && n.length > 10) n = '+' + n;
    return n;
  },
}));

jest.unstable_mockModule('../../utils/logMasking.js', () => ({
  maskPhoneForLog: (p) => `masked:${p}`,
}));

// otpConfig — mutable devMode so we can flip it per-test. The default below is
// the production posture (devMode off).
const OTP_CONFIG = {
  length: 6,
  expirationMinutes: 5,
  maxAttempts: 3,
  resendCooldownMinutes: 1,
  dailyLimit: 10,
  devMode: false,
  purposes: {
    LOGIN: 'login', REGISTER: 'register', RESET_PASSWORD: 'reset_password',
    VERIFY_PHONE: 'verify_phone', GENERAL: 'general', ADMIN_OVERRIDE: 'admin_override',
  },
};
const OTP_ERRORS = {
  EXPIRED: 'OTP has expired',
  INVALID: 'Invalid OTP',
  MAX_ATTEMPTS: 'Maximum verification attempts exceeded',
  NOT_FOUND: 'OTP not found or already used',
  DAILY_LIMIT: 'Daily OTP limit exceeded',
  COOLDOWN: 'Please wait before requesting another OTP',
};
jest.unstable_mockModule('../../config/otpConfig.js', () => ({ OTP_CONFIG, OTP_ERRORS }));

jest.unstable_mockModule('../../config/responseCodes.js', () => ({
  HTTP_STATUS: { BAD_REQUEST: 400, TOO_MANY_REQUESTS: 429 },
}));

// ── Import after mocks ───────────────────────────────────────────────
const {
  requestOtp,
  storeOTP,
  logActivity,
  getHealthStatus,
  verifyOtp,
  generateOTP,
} = await import('../../services/auth/otpService.js');

const REQ = {
  headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'jest-agent' },
  connection: { remoteAddress: '10.0.0.1' },
};

beforeEach(() => {
  jest.clearAllMocks();
  OTP_CONFIG.devMode = false;
  mockBcryptHash.mockResolvedValue('$2b$06$hashed-otp');
});

// =====================================================================
// requestOtp — gates + success + dev mode
// =====================================================================
describe('requestOtp', () => {
  it('throws 429 when the daily limit is exceeded (and logs the failure)', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(10); // == dailyLimit → over
    mockPrisma.otp_logs.create.mockResolvedValue({});

    await expect(requestOtp('9876543210', 'login', null, REQ)).rejects.toMatchObject({
      message: OTP_ERRORS.DAILY_LIMIT,
      statusCode: 429,
    });
    expect(mockPrisma.otp_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'request', success: false, failure_reason: 'daily_limit_exceeded' }),
      }),
    );
  });

  it('throws 429 when the resend cooldown is still active', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(0);            // daily ok
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({ created_at: new Date() }); // cooldown active
    mockPrisma.otp_logs.create.mockResolvedValue({});

    await expect(requestOtp('9876543210', 'login', null, REQ)).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(mockPrisma.otp_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failure_reason: 'resend_cooldown' }) }),
    );
  });

  it('stores + returns OTP metadata on the success path (no devOtp in prod mode)', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(0);             // daily ok
    mockPrisma.otp_sessions.findFirst.mockResolvedValue(null);  // no cooldown
    mockPrisma.otp_sessions.create.mockResolvedValue({ id: 99 });
    mockPrisma.otp_logs.create.mockResolvedValue({});

    const res = await requestOtp('9876543210', 'login', 'user-7', REQ);

    expect(res).toMatchObject({
      phone: '+919876543210',
      purpose: 'login',
      otpSent: true,
      sessionId: 99,
      expiresInMinutes: 5,
      attemptsAllowed: 3,
    });
    expect(res.devOtp).toBeUndefined();
    // OTP must be hashed before storage; plaintext never persisted.
    expect(mockBcryptHash).toHaveBeenCalled();
    expect(mockPrisma.otp_sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ otp: '$2b$06$hashed-otp', user_id: 'user-7' }) }),
    );
  });

  it('echoes devOtp + uses the dev-logging branch when devMode is on', async () => {
    OTP_CONFIG.devMode = true;
    mockPrisma.otp_logs.count.mockResolvedValue(0);
    mockPrisma.otp_sessions.findFirst.mockResolvedValue(null);
    mockPrisma.otp_sessions.create.mockResolvedValue({ id: 1 });
    mockPrisma.otp_logs.create.mockResolvedValue({});

    const res = await requestOtp('9876543210', 'login', null, REQ);

    // devMode generateOTP returns the fixed '123456'.
    expect(res.devOtp).toBe('123456');
  });
});

// =====================================================================
// storeOTP
// =====================================================================
describe('storeOTP', () => {
  it('hashes the OTP, persists the session, and returns the plaintext + id', async () => {
    mockPrisma.otp_sessions.create.mockResolvedValue({ id: 55 });

    const out = await storeOTP('+919876543210', 'login', 'user-1');

    expect(out.sessionId).toBe(55);
    expect(out.otp).toMatch(/^\d{6}$/);    // plaintext returned to caller
    expect(out.expiresAt).toBeInstanceOf(Date);
    expect(mockBcryptHash).toHaveBeenCalledWith(out.otp, 6);
    expect(mockPrisma.otp_sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phone: '+919876543210', otp: '$2b$06$hashed-otp', attempts: 0, verified: false }),
      }),
    );
  });

  it('defaults user_id to null when none is supplied', async () => {
    mockPrisma.otp_sessions.create.mockResolvedValue({ id: 1 });
    await storeOTP('+919876543210', 'login');
    expect(mockPrisma.otp_sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ user_id: null }) }),
    );
  });
});

// =====================================================================
// logActivity — happy + swallowed error
// =====================================================================
describe('logActivity', () => {
  it('inserts an otp_logs row using the forwarded IP + user-agent', async () => {
    mockPrisma.otp_logs.create.mockResolvedValue({});
    await logActivity('+919876543210', 'login', 'verify', true, null, REQ);
    expect(mockPrisma.otp_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'verify', success: true, ip_address: '203.0.113.7', user_agent: 'jest-agent',
        }),
      }),
    );
  });

  it('falls back to remoteAddress + null UA when headers are absent', async () => {
    mockPrisma.otp_logs.create.mockResolvedValue({});
    await logActivity('+919876543210', 'login', 'request', false, 'x', { connection: { remoteAddress: '10.0.0.2' } });
    expect(mockPrisma.otp_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ip_address: '10.0.0.2', user_agent: null }) }),
    );
  });

  it('swallows a DB error and never throws', async () => {
    mockPrisma.otp_logs.create.mockRejectedValue(new Error('insert failed'));
    await expect(logActivity('+919876543210', 'login', 'verify', true, null, REQ)).resolves.toBeUndefined();
  });
});

// =====================================================================
// getHealthStatus — healthy + degraded
// =====================================================================
describe('getHealthStatus', () => {
  it('aggregates active/recent OTP counts and reports healthy', async () => {
    mockPrisma.otp_sessions.count.mockResolvedValue(4);
    mockPrisma.otp_logs.count
      .mockResolvedValueOnce(12)   // recentRequests
      .mockResolvedValueOnce(9);   // recentVerifications

    const res = await getHealthStatus();

    expect(res).toMatchObject({
      status: 'healthy',
      activeOtps: 4,
      recentRequests: 12,
      recentVerifications: 9,
    });
    expect(res.config).toMatchObject({ expirationMinutes: 5, maxAttempts: 3, dailyLimit: 10 });
  });

  it('returns degraded when a count query throws', async () => {
    mockPrisma.otp_sessions.count.mockRejectedValue(new Error('db down'));
    mockPrisma.otp_logs.count.mockResolvedValue(0);
    const res = await getHealthStatus();
    expect(res.status).toBe('degraded');
    expect(res.message).toMatch(/temporarily unavailable/);
  });
});

// =====================================================================
// verifyOtp — bcrypt-hashed branch (legacy plaintext is in otpService.test.js)
// =====================================================================
describe('verifyOtp — hashed OTP comparison', () => {
  const phone = '+919876543210';

  it('succeeds when bcrypt.compare matches a hashed stored OTP', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 7, otp: '$2b$06$storedhash', expires_at: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 0, user_id: 'user-9',
    });
    mockPrisma.otp_sessions.update.mockResolvedValue({});
    mockPrisma.otp_logs.create.mockResolvedValue({});
    mockBcryptCompare.mockResolvedValue(true);

    const res = await verifyOtp(phone, '123456', 'login', REQ);

    expect(res.valid).toBe(true);
    expect(res.userId).toBe('user-9');
    expect(mockBcryptCompare).toHaveBeenCalledWith('123456', '$2b$06$storedhash');
    expect(mockPrisma.otp_sessions.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { verified: true } });
  });

  it('fails (with attemptsLeft) when bcrypt.compare rejects a hashed OTP', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 8, otp: '$2b$06$storedhash', expires_at: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 1, user_id: null,
    });
    mockPrisma.otp_sessions.update.mockResolvedValue({});
    mockPrisma.otp_logs.create.mockResolvedValue({});
    mockBcryptCompare.mockResolvedValue(false);

    const res = await verifyOtp(phone, '000000', 'login', REQ);

    expect(res.valid).toBe(false);
    expect(res.reason).toBe(OTP_ERRORS.INVALID);
    expect(res.attemptsLeft).toBe(1); // 3 - 1 - 1
  });
});

// =====================================================================
// generateOTP — devMode fixed code branch
// =====================================================================
describe('generateOTP devMode branch', () => {
  it('returns the fixed dev code when devMode is on', () => {
    OTP_CONFIG.devMode = true;
    expect(generateOTP()).toBe('123456');
  });
});
