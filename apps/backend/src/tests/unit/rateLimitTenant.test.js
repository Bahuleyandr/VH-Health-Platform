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

const { tenantKeyGenerator, selectStore } = await import('../../middleware/rateLimitMiddleware.js');

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

  it('selectStore returns undefined (MemoryStore) when REDIS_URL is unset', () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    expect(selectStore()).toBeUndefined();
    if (prev) process.env.REDIS_URL = prev;
  });

  it('selectStore builds a Redis store with the given namespace when REDIS_URL is set', () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://localhost:6379';
    const store = selectStore('rl:patient:');
    expect(store).toBeInstanceOf(FakeRedisStore);
    expect(store.opts.prefix).toBe('rl:patient:');
    expect(typeof store.opts.sendCommand).toBe('function');
    if (prev) process.env.REDIS_URL = prev;
    else delete process.env.REDIS_URL;
  });
});
