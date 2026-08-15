// src/tests/unit/rateLimiterProfileGuard.test.js
//
// 873-F8: getRateLimiter used to map an unknown profile name silently onto the
// generic `default` profile (fail-OPEN under store loss) while
// storeLossPostureFor() simultaneously resolved the same unknown name
// fail-CLOSED — the policy header's "unknown => fail_closed" invariant was
// unreachable through the only production limiter constructor. getRateLimiter
// now THROWS at construction time, so a typo'd profile name fails at boot
// instead of shipping the wrong posture.
//
// The second half is the call-site guard: every literal profile name passed to
// getRateLimiter anywhere in src/ must exist in RATE_LIMIT_PROFILES, and the
// only permitted NON-literal call site is routeWrapper.js (whose dynamic names
// come from ROUTE_RATE_PROFILES, already pinned subset-of-profiles by
// routeWrapperSettings.test.js). Same shape as the repo's other wiring-guard
// tests: the throw makes a bad name fail at boot, this makes it fail in CI
// with the offending file:name spelled out.
import { jest } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RATE_LIMIT_PROFILES } from '../../config/rateLimitProfiles.js';

jest.unstable_mockModule('rate-limit-redis', () => ({ RedisStore: class {} }));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  initRedis: jest.fn(async () => null),
  getRedisClient: () => null,
  isRedisConnected: () => false,
  hasRedisInitFailed: () => false,
  isRedisConfigured: () => false,
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => false),
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getRateLimitOverride: jest.fn(async () => null),
}));

const { getRateLimiter } = await import('../../middleware/rateLimitMiddleware.js');

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const listSourceFiles = () =>
  readdirSync(SRC_ROOT, { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith('.js'))
    .filter((rel) => {
      const posix = rel.split(path.sep).join('/');
      return !posix.startsWith('tests/') && !posix.includes('node_modules/');
    });

describe('getRateLimiter unknown-profile posture', () => {
  it('THROWS on an unknown profile name at construction time', () => {
    expect(() => getRateLimiter('speling-mistake')).toThrow(
      /Unknown rate-limit profile "speling-mistake"/
    );
  });

  it('still constructs the default profile when called with no arguments', () => {
    expect(typeof getRateLimiter()).toBe('function');
  });

  it('constructs every declared profile', () => {
    for (const name of Object.keys(RATE_LIMIT_PROFILES)) {
      expect(typeof getRateLimiter(name)).toBe('function');
    }
  });
});

describe('getRateLimiter call sites (grep guard over src/, tests excluded)', () => {
  const literalNames = new Map(); // name -> [files]
  const dynamicCallFiles = new Set();

  for (const rel of listSourceFiles()) {
    const source = readFileSync(path.join(SRC_ROOT, rel), 'utf8');
    const callRe = /getRateLimiter\((\s*)(['"`]?)([A-Za-z0-9_-]*)/g;
    let match;
    while ((match = callRe.exec(source)) !== null) {
      const [, , quote, name] = match;
      if (quote) {
        if (!literalNames.has(name)) literalNames.set(name, []);
        literalNames.get(name).push(rel);
      } else {
        dynamicCallFiles.add(rel.split(path.sep).join('/'));
      }
    }
  }

  it('every literal profile name exists in RATE_LIMIT_PROFILES', () => {
    const known = new Set(Object.keys(RATE_LIMIT_PROFILES));
    const phantoms = [...literalNames.entries()]
      .filter(([name]) => !known.has(name))
      .map(([name, files]) => `${name} <- ${files.join(', ')}`);
    expect(phantoms).toEqual([]);
    // Sanity: the scan actually found the known call sites.
    expect(literalNames.size).toBeGreaterThanOrEqual(5);
  });

  it('the ONLY dynamic call site is routeWrapper.js (covered by the ROUTE_RATE_PROFILES guard)', () => {
    expect([...dynamicCallFiles].sort()).toEqual(['config/routeWrapper.js']);
  });
});
