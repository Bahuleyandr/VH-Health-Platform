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

  it('selectStore returns undefined (MemoryStore) when REDIS_URL is unset', () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    expect(selectStore()).toBeUndefined();
    if (prev) process.env.REDIS_URL = prev;
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
});
