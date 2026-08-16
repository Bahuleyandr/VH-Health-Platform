// src/tests/unit/tokenBlacklistCacheLatch.test.js
//
// 873-F9: a BLACKHOLED Redis (peer silently drops packets — no FIN/RST, so
// isRedisConnected() still reports true) made jwtMiddleware's per-request
// revocation pair (isTokenBlacklisted + isUserTokensRevoked) each pay the
// full REDIS_COMMAND_TIMEOUT_MS: ~4s added to EVERY authenticated request,
// sustained until TCP noticed, with no breaker.
//
// The known-bad latch (modelled on rateLimitStoreHealth's breaker):
//   * opens after N consecutive timeout-class cache failures — subsequent
//     requests skip the cache read entirely and go straight to the
//     authoritative DB predicate (they stop paying the timeout);
//   * NEVER fails open — a revoked token is still rejected while latched
//     (DB path), and dual failure still throws (503);
//   * lets one read per probe interval through as a half-open recovery
//     probe; a healthy read closes the latch.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const cacheGetMock = jest.fn();
let redisConnected = true;

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_t, fn) => fn(__prismaDefaultMock),
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  cacheGet: cacheGetMock,
  cacheSet: jest.fn(),
  isRedisConnected: () => redisConnected,
  redisCommandTimeoutMs: () => 2000,
}));
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: loggerInfo, warn: loggerWarn, error: jest.fn(), debug: jest.fn() },
}));

const {
  isTokenBlacklisted,
  isUserTokensRevoked,
  RevocationCheckUnavailableError,
  __resetTokenBlacklistCacheLatchForTests,
} = await import('../../utils/tokenBlacklist.js');

const LATCH_THRESHOLD = 3;
const PROBE_INTERVAL_MS = 15000;
const UUID_USER = '11111111-1111-4111-8111-111111111111';

// A cache whose reads fail like a timeout-class outage. In production the
// timeout manifests as a SLOW null from cacheGet (which swallows command
// errors); the latch classifies a throwing cache identically, which is what
// a fake can produce without real 2s waits.
const timeoutThrowingCache = () => {
  cacheGetMock.mockRejectedValue(new Error('Command timed out'));
};

beforeEach(() => {
  __resetTokenBlacklistCacheLatchForTests();
  queryRawUnsafeMock.mockReset();
  cacheGetMock.mockReset();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  redisConnected = true; // blackholed: connection LOOKS up throughout
  queryRawUnsafeMock.mockResolvedValue([]); // DB default: not revoked
});

describe('873-F9 — latch opens and requests stop paying the timeout', () => {
  it('after the threshold of consecutive failures, cache reads are skipped entirely', async () => {
    timeoutThrowingCache();

    for (let i = 0; i < LATCH_THRESHOLD; i += 1) {
      await isTokenBlacklisted(`jti-${i}`); // each pays one (fake) timeout
    }
    expect(cacheGetMock).toHaveBeenCalledTimes(LATCH_THRESHOLD);
    const warns = loggerWarn.mock.calls.filter(([msg]) => String(msg).includes('latched known-bad'));
    expect(warns).toHaveLength(1); // ONE WARN on latch, not per-request spam

    // Latched: further requests never touch the cache — straight to the DB.
    await isTokenBlacklisted('jti-after-latch');
    await isUserTokensRevoked(UUID_USER, 1000);
    expect(cacheGetMock).toHaveBeenCalledTimes(LATCH_THRESHOLD);
    expect(queryRawUnsafeMock).toHaveBeenCalled(); // DB stays authoritative
  });

  it('the two per-request reads share one latch (failures across both count)', async () => {
    timeoutThrowingCache();

    await isTokenBlacklisted('jti-a');
    await isUserTokensRevoked(UUID_USER, 1000);
    await isTokenBlacklisted('jti-b');
    expect(cacheGetMock).toHaveBeenCalledTimes(3);

    await isUserTokensRevoked(UUID_USER, 1000);
    expect(cacheGetMock).toHaveBeenCalledTimes(3); // latched
  });

  it('a success before the threshold resets the consecutive-failure streak', async () => {
    cacheGetMock
      .mockRejectedValueOnce(new Error('Command timed out'))
      .mockRejectedValueOnce(new Error('Command timed out'))
      .mockResolvedValueOnce(null) // healthy miss — streak resets
      .mockRejectedValue(new Error('Command timed out'));

    for (let i = 0; i < 5; i += 1) {
      await isTokenBlacklisted(`jti-${i}`);
    }
    // 2 failures + 1 ok + 2 failures: never 3 consecutive, latch never opens.
    expect(cacheGetMock).toHaveBeenCalledTimes(5);
    expect(loggerWarn.mock.calls.filter(([m]) => String(m).includes('latched known-bad'))).toHaveLength(0);
  });
});

describe('873-F9 — never fails open while latched', () => {
  beforeEach(async () => {
    timeoutThrowingCache();
    for (let i = 0; i < LATCH_THRESHOLD; i += 1) {
      await isTokenBlacklisted(`warmup-${i}`);
    }
    cacheGetMock.mockClear();
  });

  it('a revoked token is still rejected via the authoritative DB path', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ '?column?': 1 }]);

    await expect(isTokenBlacklisted('revoked-jti')).resolves.toBe(true);
    await expect(isUserTokensRevoked(UUID_USER, 1000)).resolves.toBe(true);
    expect(cacheGetMock).not.toHaveBeenCalled(); // and without paying the timeout
  });

  it('dual failure (latched cache + DB down) still throws — deny, not accept', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('db down'));

    await expect(isTokenBlacklisted('unknown-jti'))
      .rejects.toBeInstanceOf(RevocationCheckUnavailableError);
    await expect(isUserTokensRevoked(UUID_USER, 1000))
      .rejects.toBeInstanceOf(RevocationCheckUnavailableError);
  });
});

describe('873-F9 — half-open recovery probe closes the latch', () => {
  it('one probe per interval; a healthy read restores cache-first behaviour', async () => {
    timeoutThrowingCache();
    for (let i = 0; i < LATCH_THRESHOLD; i += 1) {
      await isTokenBlacklisted(`warmup-${i}`);
    }
    cacheGetMock.mockClear();

    // Inside the probe window: still skipped.
    await isTokenBlacklisted('inside-window');
    expect(cacheGetMock).not.toHaveBeenCalled();

    // Window matures; Redis has recovered: the probe read goes through fast,
    // closes the latch, and logs ONE recovery INFO.
    cacheGetMock.mockResolvedValue(null);
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + PROBE_INTERVAL_MS + 1000);
    try {
      await isTokenBlacklisted('probe-read');
      expect(cacheGetMock).toHaveBeenCalledTimes(1);
      const infos = loggerInfo.mock.calls.filter(([m]) => String(m).includes('cache recovered'));
      expect(infos).toHaveLength(1);

      // Latch closed: cache-first behaviour is back (a positive hit
      // short-circuits without a DB query).
      cacheGetMock.mockResolvedValue({ reason: 'logout' });
      queryRawUnsafeMock.mockClear();
      await expect(isTokenBlacklisted('cached-revoked')).resolves.toBe(true);
      expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    } finally {
      Date.now.mockRestore();
    }
  });

  it('a failed probe re-arms the interval instead of reopening the floodgates', async () => {
    timeoutThrowingCache();
    for (let i = 0; i < LATCH_THRESHOLD; i += 1) {
      await isTokenBlacklisted(`warmup-${i}`);
    }
    cacheGetMock.mockClear();

    const realNow = Date.now;
    let offset = PROBE_INTERVAL_MS + 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      await isTokenBlacklisted('probe-fails'); // probe granted, still broken
      expect(cacheGetMock).toHaveBeenCalledTimes(1);

      offset += 1000; // 1s later — next probe not due
      await isTokenBlacklisted('still-latched');
      expect(cacheGetMock).toHaveBeenCalledTimes(1); // no second read
    } finally {
      Date.now.mockRestore();
    }
  });
});
