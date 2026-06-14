// Unit coverage for src/services/auth/adminOtpService.js (roadmap B3.2).
//
// adminOtpService is the admin-facing OTP operations surface: analytics, log
// listing/cleanup, runtime config updates, force-send, bulk delete, security
// alerts, active-session listing, per-phone status and revocation. It was
// ~9% statements (only the module-level imports executed). The integration
// path goes through adminOtpController + a live DB; this file is a
// *self-contained* unit suite with a fully-mocked Prisma so a SCOPED coverage
// run (which executes only this file) drives the whole service to >=80%
// statements without needing the QA DB.
//
// Prisma-mock convention matches the sibling auth unit tests
// (otpService.test.js / billingServiceCoverage.test.js):
//   jest.unstable_mockModule('../../lib/prisma.js', () => ({ default, setTenant, ... }))
// The service's private query() helper calls prisma.$queryRawUnsafe for
// read/RETURNING statements and prisma.$executeRawUnsafe for plain writes, so
// those two fns are the seam every raw-SQL path flows through.
//
// query()-wrapper contract: query() returns `{ rows, rowCount }` for a RETURNING
// statement. forceSendOtp / getSecurityAlerts / getActiveSessions /
// getOtpStatusForPhone read `result.rows` / `result.rowCount` accordingly (fixed
// 2026-06-14 — they previously indexed the wrapper as if it were the rows array,
// which 500'd the admin force-send and returned malformed shapes to the admin
// controller). The tests below assert the real success shapes.

import { jest } from '@jest/globals';

// ── Prisma mock ─────────────────────────────────────────────────────────────
// $queryRawUnsafe  → read / WITH / RETURNING statements (query() read path)
// $executeRawUnsafe → plain INSERT/UPDATE/DELETE (query() write path)
// otp_logs.findMany / otp_logs.count → getOtpLogs (typed-ORM path)
const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  otp_logs: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// bcrypt.hash is awaited by forceSendOtp — stub to a deterministic hash so the
// test never spends real CPU on a bcrypt round.
const bcryptHash = jest.fn(async () => '$2b$06$deterministichashvalueforunit');
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: bcryptHash },
}));

// otpService.logActivity is a fire-and-forget audit write — stub it so
// forceSendOtp doesn't reach the real (prisma-backed) implementation. The
// specifier is keyed by the absolute file jest resolves it to, so it is written
// relative to THIS test file (which resolves to the same module the service
// imports via './otpService.js').
const logActivity = jest.fn(async () => {});
jest.unstable_mockModule('../../services/auth/otpService.js', () => ({
  logActivity,
}));

// Deterministic phone normalization (mirrors otpService.test.js).
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

// otpConfig is mutated by updateOtpConfiguration, so give each test run a fresh,
// test-friendly object. devMode flips the force-send OTP source between the
// fixed dev OTP and crypto.randomInt.
jest.unstable_mockModule('../../config/otpConfig.js', () => ({
  OTP_CONFIG: {
    length: 6,
    expirationMinutes: 5,
    maxAttempts: 3,
    resendCooldownMinutes: 1,
    dailyLimit: 10,
    devMode: false,
    purposes: {
      LOGIN: 'login',
      REGISTER: 'register',
      RESET_PASSWORD: 'reset_password',
      VERIFY_PHONE: 'verify_phone',
      GENERAL: 'general',
      ADMIN_OVERRIDE: 'admin_override',
    },
  },
  OTP_ERRORS: {},
}));

// ── Import service + the live OTP_CONFIG (so tests can read/flip devMode) ─────
const adminOtpService = await import('../../services/auth/adminOtpService.js');
const { OTP_CONFIG } = await import('../../config/otpConfig.js');

const ADMIN_UID = 'admin-uuid-0001';

beforeEach(() => {
  jest.clearAllMocks();
  // Safe defaults — read path returns an empty result set, write path 0 rows.
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  mockPrisma.$executeRawUnsafe.mockResolvedValue(0);
  mockPrisma.otp_logs.findMany.mockResolvedValue([]);
  mockPrisma.otp_logs.count.mockResolvedValue(0);
  // Reset mutable config back to defaults each test.
  OTP_CONFIG.expirationMinutes = 5;
  OTP_CONFIG.maxAttempts = 3;
  OTP_CONFIG.dailyLimit = 10;
  OTP_CONFIG.resendCooldownMinutes = 1;
  OTP_CONFIG.devMode = false;
});

// ─────────────────────────────────────────────────────────────────────────────
// getOtpAnalytics — three parallel aggregate reads + dynamic WHERE building
// ─────────────────────────────────────────────────────────────────────────────
describe('getOtpAnalytics', () => {
  it('builds analytics with no filters (WHERE 1=1, empty params)', async () => {
    const usage = [{ date: '2026-06-13', purpose: 'login', total_count: 3 }];
    const failures = [{ failure_reason: 'invalid', count: 1 }];
    const top = [{ phone: '+919876543210', otp_requests: 4 }];
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce(usage)
      .mockResolvedValueOnce(failures)
      .mockResolvedValueOnce(top);

    const res = await adminOtpService.getOtpAnalytics({ requestedBy: ADMIN_UID });

    expect(res.usageStatistics).toEqual(usage);
    expect(res.failureAnalysis).toEqual(failures);
    expect(res.topUsers).toEqual(top);
    expect(res.generatedBy).toBe(ADMIN_UID);
    expect(res.queryPeriod).toEqual({ startDate: undefined, endDate: undefined, purpose: undefined });
    expect(typeof res.timestamp).toBe('string');
    // No filters → no bound params on any of the three queries.
    for (const call of mockPrisma.$queryRawUnsafe.mock.calls) {
      expect(call.slice(1)).toEqual([]);
    }
  });

  it('appends startDate, endDate and purpose to the WHERE clause + params', async () => {
    await adminOtpService.getOtpAnalytics({
      startDate: '2026-01-01',
      endDate: '2026-02-01',
      purpose: 'login',
      requestedBy: ADMIN_UID,
    });

    // Every parallel query gets the same 3 spread params in declaration order.
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    for (const call of mockPrisma.$queryRawUnsafe.mock.calls) {
      const [sql, ...params] = call;
      expect(params).toEqual(['2026-01-01', '2026-02-01', 'login']);
      expect(sql).toMatch(/created_at >= \$1/);
      expect(sql).toMatch(/created_at <= \$2/);
      expect(sql).toMatch(/purpose = \$3/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOtpLogs — typed-ORM findMany + count with dynamic where
// ─────────────────────────────────────────────────────────────────────────────
describe('getOtpLogs', () => {
  it('returns logs + pagination with no filters', async () => {
    const logs = [{ id: 1, phone: '+919876543210', action: 'verify' }];
    mockPrisma.otp_logs.findMany.mockResolvedValue(logs);
    mockPrisma.otp_logs.count.mockResolvedValue(1);

    const res = await adminOtpService.getOtpLogs({ page: 1, limit: 20 }, ADMIN_UID);

    expect(res.logs).toEqual(logs);
    expect(res.pagination.total).toBe(1);
    expect(res.pagination.page).toBe(1);
    expect(res.generatedBy).toBe(ADMIN_UID);
    // Empty where (no filters) → first findMany arg has where:{}.
    expect(mockPrisma.otp_logs.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('maps every filter into the prisma where clause', async () => {
    await adminOtpService.getOtpLogs(
      {
        page: 2,
        limit: 10,
        phone: '9876543210',
        purpose: 'login',
        action: 'verify',
        success: 'true',
        startDate: '2026-01-01',
        endDate: '2026-02-01',
        ipAddress: '10.0.0.1',
      },
      ADMIN_UID,
    );

    const where = mockPrisma.otp_logs.findMany.mock.calls[0][0].where;
    expect(where.phone).toBe('+919876543210'); // normalized
    expect(where.purpose).toBe('login');
    expect(where.action).toBe('verify');
    expect(where.success).toBe(true); // 'true' string coerced
    expect(where.ip_address).toBe('10.0.0.1');
    expect(where.created_at.gte).toBeInstanceOf(Date);
    expect(where.created_at.lte).toBeInstanceOf(Date);
    // page 2, limit 10 → skip 10.
    expect(mockPrisma.otp_logs.findMany.mock.calls[0][0].skip).toBe(10);
    expect(mockPrisma.otp_logs.findMany.mock.calls[0][0].take).toBe(10);
  });

  it('treats boolean success=false as a filter (success !== undefined branch)', async () => {
    await adminOtpService.getOtpLogs({ page: 1, limit: 20, success: false }, ADMIN_UID);
    const where = mockPrisma.otp_logs.findMany.mock.calls[0][0].where;
    expect(where.success).toBe(false);
  });

  it('applies only startDate when endDate is absent', async () => {
    await adminOtpService.getOtpLogs(
      { page: 1, limit: 20, startDate: '2026-03-01' },
      ADMIN_UID,
    );
    const where = mockPrisma.otp_logs.findMany.mock.calls[0][0].where;
    expect(where.created_at.gte).toBeInstanceOf(Date);
    expect(where.created_at.lte).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanupOtpLogs — plain DELETE through the write path
// ─────────────────────────────────────────────────────────────────────────────
describe('cleanupOtpLogs', () => {
  it('returns the deleted row count from $executeRawUnsafe', async () => {
    mockPrisma.$executeRawUnsafe.mockResolvedValue(7);

    const res = await adminOtpService.cleanupOtpLogs(30, ADMIN_UID);

    expect(res.deletedCount).toBe(7);
    expect(res.olderThanDays).toBe(30);
    expect(res.cleanedBy).toBe(ADMIN_UID);
    expect(typeof res.timestamp).toBe('string');
    const [sql, ...params] = mockPrisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM otp_logs/);
    expect(params).toEqual([30]);
  });

  it('defaults deletedCount to 0 when the driver reports no rows', async () => {
    mockPrisma.$executeRawUnsafe.mockResolvedValue(0);
    const res = await adminOtpService.cleanupOtpLogs(90, ADMIN_UID);
    expect(res.deletedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateOtpConfiguration — in-memory config mutation + validation branch
// ─────────────────────────────────────────────────────────────────────────────
describe('updateOtpConfiguration', () => {
  it('applies every supported field and echoes previous + new config', async () => {
    const res = await adminOtpService.updateOtpConfiguration(
      {
        expirationMinutes: 9,
        maxAttempts: 4,
        dailyLimit: 25,
        resendCooldownMinutes: 2,
      },
      ADMIN_UID,
    );

    expect(res.updates).toEqual({
      expirationMinutes: 9,
      maxAttempts: 4,
      dailyLimit: 25,
      resendCooldownMinutes: 2,
    });
    expect(res.newConfig.expirationMinutes).toBe(9);
    expect(res.newConfig.maxAttempts).toBe(4);
    expect(res.newConfig.dailyLimit).toBe(25);
    expect(res.newConfig.resendCooldownMinutes).toBe(2);
    // previousConfig is a snapshot taken before mutation.
    expect(res.previousConfig.expirationMinutes).toBe(5);
    expect(res.updatedBy).toBe(ADMIN_UID);
  });

  it('applies a single field, leaving others untouched', async () => {
    const res = await adminOtpService.updateOtpConfiguration({ dailyLimit: 50 }, ADMIN_UID);
    expect(res.updates).toEqual({ dailyLimit: 50 });
    expect(OTP_CONFIG.dailyLimit).toBe(50);
    expect(OTP_CONFIG.expirationMinutes).toBe(5); // unchanged
  });

  it('throws a 400 when no valid updates are provided', async () => {
    await expect(adminOtpService.updateOtpConfiguration({}, ADMIN_UID)).rejects.toMatchObject({
      message: /No valid configuration updates/i,
      statusCode: 400,
    });
  });

  it('ignores unknown keys (treated as no valid updates → 400)', async () => {
    await expect(
      adminOtpService.updateOtpConfiguration({ bogusField: 1 }, ADMIN_UID),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forceSendOtp — OTP generation + hashing + insert + success response. Reads the
// session id from result.rows[0].id (the query() wrapper) and returns the issue
// receipt; the empty-rows defensive guard is exercised too.
// ─────────────────────────────────────────────────────────────────────────────
describe('forceSendOtp', () => {
  it('generates a random OTP, hashes it, inserts a session, and returns the success shape (non-dev)', async () => {
    OTP_CONFIG.devMode = false;
    // RETURNING goes through the read path → query() returns { rows, rowCount }.
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 555 }]);

    const res = await adminOtpService.forceSendOtp('9876543210', 'login', 'support call', false, ADMIN_UID, {});

    // Session id read from result.rows[0].id; success branch (logActivity + response) reached.
    expect(res.otpSent).toBe(true);
    expect(res.sessionId).toBe(555);
    expect(res.phone).toBe('+919876543210');
    expect(res.purpose).toBe('login');
    expect(res.reason).toBe('support call');
    expect(res.sentBy).toBe(ADMIN_UID);
    expect(res).not.toHaveProperty('devOtp'); // never leaked when devMode is off
    expect(logActivity).toHaveBeenCalledWith('+919876543210', 'login', 'admin_force_send', true, 'support call', {});

    // The OTP was hashed (never stored plaintext) + inserted.
    expect(bcryptHash).toHaveBeenCalledTimes(1);
    const hashedArg = bcryptHash.mock.calls[0][0];
    expect(hashedArg).toMatch(/^\d{6}$/); // a 6-digit numeric OTP string
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO otp_sessions/);
    expect(sql).toMatch(/RETURNING id/);
    expect(params[0]).toBe('+919876543210'); // normalized phone
    expect(params[1]).toBe('$2b$06$deterministichashvalueforunit'); // hashed, never plaintext
    expect(params[2]).toBe('login');
    expect(params[3]).toBeInstanceOf(Date); // expiresAt
  });

  it('uses the fixed dev OTP (123456) and echoes devOtp when devMode is on', async () => {
    OTP_CONFIG.devMode = true;
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 1 }]);

    const res = await adminOtpService.forceSendOtp('9876543210', 'login', 'dev', true, ADMIN_UID, {});

    expect(bcryptHash).toHaveBeenCalledWith('123456', 6);
    expect(res.otpSent).toBe(true);
    expect(res.sessionId).toBe(1);
    expect(res.devOtp).toBe('123456'); // dev-mode echoes the OTP in the response
  });

  it('throws a clear error when INSERT ... RETURNING yields no row (defensive guard)', async () => {
    OTP_CONFIG.devMode = false;
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]); // empty rows
    await expect(
      adminOtpService.forceSendOtp('9876543210', 'login', 'x', false, ADMIN_UID, {}),
    ).rejects.toThrow(/Failed to create OTP session/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bulkDeleteSessions — dynamic WHERE + RETURNING (read path → rowCount)
// ─────────────────────────────────────────────────────────────────────────────
describe('bulkDeleteSessions', () => {
  it('deletes with no filters (WHERE 1=1) and reports rowCount', async () => {
    // RETURNING → read path; query() computes rowCount from rows.length.
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const res = await adminOtpService.bulkDeleteSessions({ reason: 'cleanup' }, ADMIN_UID);

    expect(res.deletedCount).toBe(3);
    expect(res.reason).toBe('cleanup');
    expect(res.deletedBy).toBe(ADMIN_UID);
    expect(res.filters).toEqual({ phone: undefined, purpose: undefined, olderThanHours: undefined });
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM otp_sessions/);
    expect(params).toEqual([]);
  });

  it('builds incremental placeholders for phone + purpose + olderThanHours', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 9 }]);

    const res = await adminOtpService.bulkDeleteSessions(
      { phone: '9876543210', purpose: 'login', olderThanHours: 12, reason: 'stale' },
      ADMIN_UID,
    );

    expect(res.deletedCount).toBe(1);
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/phone = \$1/);
    expect(sql).toMatch(/purpose = \$2/);
    expect(sql).toMatch(/make_interval\(hours => \$3\)/);
    expect(params).toEqual(['+919876543210', 'login', 12]);
  });

  it('applies only the olderThanHours filter (placeholder index resets to $1)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    await adminOtpService.bulkDeleteSessions({ olderThanHours: 48, reason: 'x' }, ADMIN_UID);
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/make_interval\(hours => \$1\)/);
    expect(params).toEqual([48]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSecurityAlerts — three parallel anomaly reads
// ─────────────────────────────────────────────────────────────────────────────
describe('getSecurityAlerts', () => {
  it('returns the three alert buckets + metadata', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ phone: '+91999', count: 6 }])
      .mockResolvedValueOnce([{ phone: '+91888', failure_count: 4 }])
      .mockResolvedValueOnce([{ ip_address: '1.2.3.4', attempt_count: 11 }]);

    const res = await adminOtpService.getSecurityAlerts(ADMIN_UID);

    // query() wraps each read as { rows, rowCount }; the service reads .rows, so
    // each bucket is the actual row array.
    expect(res.requestedBy).toBe(ADMIN_UID);
    expect(typeof res.generatedAt).toBe('string');
    expect(res.suspiciousActivity).toEqual([{ phone: '+91999', count: 6 }]);
    expect(res.failurePatterns).toEqual([{ phone: '+91888', failure_count: 4 }]);
    expect(res.ipAnalysis).toEqual([{ ip_address: '1.2.3.4', attempt_count: 11 }]);
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getActiveSessions — single read with a LIMIT param
// ─────────────────────────────────────────────────────────────────────────────
describe('getActiveSessions', () => {
  it('passes the limit param and returns a count fallback', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const res = await adminOtpService.getActiveSessions(25, ADMIN_UID);

    expect(res.requestedBy).toBe(ADMIN_UID);
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM otp_sessions/);
    expect(sql).toMatch(/LIMIT \$1/);
    expect(params).toEqual([25]);
    // result is the { rows, rowCount } wrapper; the service reads .rows / .rowCount.
    expect(res.activeSessions).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.count).toBe(2);
  });

  it('uses the default limit of 100 when none is supplied', async () => {
    await adminOtpService.getActiveSessions(undefined, ADMIN_UID);
    const params = mockPrisma.$queryRawUnsafe.mock.calls[0].slice(1);
    expect(params).toEqual([100]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOtpStatusForPhone — single read, normalized phone, default purpose
// ─────────────────────────────────────────────────────────────────────────────
describe('getOtpStatusForPhone', () => {
  it('normalizes the phone and defaults purpose to "general"', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 1, used: false }]);

    const res = await adminOtpService.getOtpStatusForPhone('9876543210');

    expect(res.phone).toBe('+919876543210');
    expect(res.purpose).toBe('general');
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM otp_sessions/);
    expect(params).toEqual(['+919876543210', 'general']);
    // result is the { rows, rowCount } wrapper; the service reads result.rows[0].
    expect(res.hasActiveOTP).toBe(true);
    expect(res.session).toEqual({ id: 1, used: false });
  });

  it('honours an explicit purpose argument', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 2, used: false }]);
    await adminOtpService.getOtpStatusForPhone('9876543210', 'reset_password');
    const params = mockPrisma.$queryRawUnsafe.mock.calls[0].slice(1);
    expect(params).toEqual(['+919876543210', 'reset_password']);
  });

  it('reports no active OTP when the query returns no rows', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    const res = await adminOtpService.getOtpStatusForPhone('9876543210');
    expect(res.hasActiveOTP).toBe(false);
    expect(res.session).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// revokeOtp — UPDATE ... RETURNING (read path → rowCount)
// ─────────────────────────────────────────────────────────────────────────────
describe('revokeOtp', () => {
  it('revokes matching sessions and reports the revoked count', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const res = await adminOtpService.revokeOtp(
      '9876543210',
      'login',
      'compromised',
      ADMIN_UID,
      {},
    );

    expect(res.phone).toBe('+919876543210');
    expect(res.purpose).toBe('login');
    expect(res.revokedCount).toBe(2);
    expect(res.reason).toBe('compromised');
    expect(res.revokedBy).toBe(ADMIN_UID);
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/UPDATE otp_sessions/);
    expect(sql).toMatch(/SET used = true/);
    expect(params).toEqual(['+919876543210', 'login']);
  });

  it('reports 0 revoked when nothing matched', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    const res = await adminOtpService.revokeOtp('9876543210', 'login', 'x', ADMIN_UID, {});
    expect(res.revokedCount).toBe(0);
  });
});
