import { jest } from '@jest/globals';

// Isolate from a live Redis: stub the store + client so selectStore() can be
// exercised without a running server (rate-limit-redis's real RedisStore kicks
// off an async SCRIPT LOAD on construction).
class FakeRedisStore {
  constructor(opts) {
    this.opts = opts;
  }
}
jest.unstable_mockModule('rate-limit-redis', () => ({ RedisStore: FakeRedisStore }));

const redisCall = jest.fn(async () => 'script-sha');
const initRedis = jest.fn(async () => ({ call: redisCall }));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  initRedis,
  getRedisClient: jest.fn(() => null),
  isRedisConnected: jest.fn(() => false),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => false),
  cacheDelete: jest.fn(async () => undefined),
  cacheClear: jest.fn(async () => undefined),
  disconnectRedis: jest.fn(async () => undefined),
  isRedisConfigured: () => Boolean(process.env.REDIS_URL || process.env.REDIS_SENTINEL_HOSTS),
}));

const {
  __testing__,
  tenantKeyGenerator,
  selectStore,
} = await import('../../middleware/rateLimitMiddleware.js');

// Minimal express-req shape: a real req always carries `headers`.
const mkReq = (over) => ({ headers: {}, ...over });

describe('rate limit tenant keying', () => {
  it('prefixes the uid bucket with the resolved tenant', () => {
    expect(tenantKeyGenerator(mkReq({ tenantId: 'tA', user: { uid: 'u1' } }))).toBe('t:tA:u:u1');
  });

  it('falls back to ip, still tenant-prefixed', () => {
    const k = tenantKeyGenerator(mkReq({ tenantId: 'tB', ip: '9.9.9.9' }));
    expect(k.startsWith('t:tB:')).toBe(true);
    expect(k).toContain('9.9.9.9');
  });

  it('uses the default tenant label when tenantId is absent', () => {
    expect(tenantKeyGenerator(mkReq({ user: { uid: 'u1' }, ip: '1.2.3.4' }))).toBe('t:default:u:u1');
  });

  it('two tenants never share a bucket for the same uid', () => {
    expect(tenantKeyGenerator(mkReq({ tenantId: 'tA', user: { uid: 'u1' } }))).not.toBe(
      tenantKeyGenerator(mkReq({ tenantId: 'tB', user: { uid: 'u1' } })),
    );
  });

  it('keys post-auth logout throttling by identity rather than a shared IP', () => {
    const sharedIp = '198.51.100.176';
    expect(__testing__.authKeyGenerator(mkReq({ ip: sharedIp, user: { uid: 'u1' } })))
      .toBe('auth:u:u1');
    expect(__testing__.authKeyGenerator(mkReq({ ip: sharedIp, user: { uid: 'u2' } })))
      .toBe('auth:u:u2');
  });

  it.each([
    ['username', { body: { username: 'Dr.RawUser' } }, 'Dr.RawUser'],
    ['email', { body: { email: 'doctor@example.test' } }, 'doctor@example.test'],
    ['employee ID', { body: { employeeId: 'EMP-1007' } }, 'EMP-1007'],
    ['API key', { headers: { 'x-api-key': 'raw-api-key-secret' } }, 'raw-api-key-secret'],
  ])('does not persist a raw %s in the default Redis bucket key', (_label, request, raw) => {
    const key = tenantKeyGenerator(mkReq({ tenantId: 'tA', ip: '198.51.100.20', ...request }));
    expect(key).not.toContain(raw);
    expect(key).toMatch(/^t:tA:(?:acct:198\.51\.100\.20:|k:)[0-9a-f]{64}$/);
  });

  it('preserves case-insensitive login equivalence while hashing the account', () => {
    const lower = __testing__.authKeyGenerator(mkReq({
      ip: '198.51.100.21',
      body: { email: 'doctor@example.test' },
    }));
    const upper = __testing__.authKeyGenerator(mkReq({
      ip: '198.51.100.21',
      body: { email: 'DOCTOR@EXAMPLE.TEST' },
    }));
    expect(lower).toBe(upper);
    expect(lower).not.toContain('doctor@example.test');
  });

  it.each([
    ['username', { username: 'Dr.RawUser' }, 'Dr.RawUser'],
    ['email', { email: 'doctor@example.test' }, 'doctor@example.test'],
    ['employee ID', { employeeId: 'EMP-1007' }, 'EMP-1007'],
    ['phone', { phone: '+919876543210' }, '+919876543210'],
  ])('does not persist a raw %s in the auth Redis bucket key', (_label, body, raw) => {
    const key = __testing__.authKeyGenerator(mkReq({ ip: '198.51.100.23', body }));
    expect(key).toMatch(/^auth:198\.51\.100\.23:acct:[0-9a-f]{64}$/);
    expect(key).not.toContain(raw);
  });

  it('keeps hashed pre-auth identities separated by tenant prefix', () => {
    const request = { ip: '198.51.100.24', body: { employeeId: 'EMP-1007' } };
    const tenantA = tenantKeyGenerator(mkReq({ ...request, tenantId: 'tA' }));
    const tenantB = tenantKeyGenerator(mkReq({ ...request, tenantId: 'tB' }));
    expect(tenantA).not.toBe(tenantB);
    expect(tenantA).toMatch(/^t:tA:acct:/);
    expect(tenantB).toMatch(/^t:tB:acct:/);
  });

  it('hashes phone numbers in persistent OTP keys and preserves equivalence', () => {
    const phone = '+919876543210';
    const first = __testing__.otpKeyGenerator(mkReq({ ip: '198.51.100.22', body: { phone } }));
    const second = __testing__.otpKeyGenerator(mkReq({ ip: '203.0.113.22', body: { phoneNumber: phone } }));
    expect(first).toBe(second);
    expect(first).toMatch(/^otp:phone:[0-9a-f]{64}$/);
    expect(first).not.toContain(phone);
  });

  it('selectStore returns undefined (MemoryStore) when Redis is unset', () => {
    const prev = process.env.REDIS_URL;
    const prevSentinels = process.env.REDIS_SENTINEL_HOSTS;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_SENTINEL_HOSTS;
    expect(selectStore()).toBeUndefined();
    if (prev) process.env.REDIS_URL = prev;
    if (prevSentinels) process.env.REDIS_SENTINEL_HOSTS = prevSentinels;
  });

  it('selectStore builds a Redis store with the given namespace when REDIS_URL is set', async () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://localhost:6379';
    const store = selectStore('rl:patient:');
    expect(store).toBeInstanceOf(FakeRedisStore);
    expect(store.opts.prefix).toBe('rl:patient:');
    expect(typeof store.opts.sendCommand).toBe('function');
    await expect(store.opts.sendCommand('SCRIPT', 'LOAD', 'return 1')).resolves.toBe('script-sha');
    expect(initRedis).toHaveBeenCalledTimes(1);
    expect(redisCall).toHaveBeenCalledWith('SCRIPT', 'LOAD', 'return 1');
    if (prev) process.env.REDIS_URL = prev;
    else delete process.env.REDIS_URL;
  });

  it('selectStore uses the shared store when Sentinel discovery is configured', () => {
    const prev = process.env.REDIS_SENTINEL_HOSTS;
    process.env.REDIS_SENTINEL_HOSTS = 'redis-0.example:26379';
    expect(selectStore('rl:sentinel:')).toBeInstanceOf(FakeRedisStore);
    if (prev) process.env.REDIS_SENTINEL_HOSTS = prev;
    else delete process.env.REDIS_SENTINEL_HOSTS;
  });
});
