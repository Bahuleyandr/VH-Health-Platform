import { jest } from '@jest/globals';

const clients = [];

class FakeRedis {
  constructor(...args) {
    this.args = args;
    this.values = new Map();
    this.connect = jest.fn(async () => undefined);
    this.ping = jest.fn(async () => 'PONG');
    this.set = jest.fn(async (key, value) => {
      this.values.set(key, value);
      return 'OK';
    });
    this.get = jest.fn(async (key) => this.values.get(key) ?? null);
    this.del = jest.fn(async (key) => this.values.delete(key) ? 1 : 0);
    this.quit = jest.fn(async () => undefined);
    this.disconnect = jest.fn();
    clients.push(this);
  }

  on() {
    return this;
  }
}

jest.unstable_mockModule('ioredis', () => ({ default: FakeRedis }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  initRedis,
  disconnectRedis,
  parseSentinelHosts,
  resolveRedisConnection,
  assertRedisWritable,
} = await import('../../lib/redis.js');

const redisEnvKeys = [
  'REDIS_URL',
  'REDIS_REQUIRE_SENTINEL',
  'REDIS_SENTINEL_HOSTS',
  'REDIS_SENTINEL_MASTER',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_SENTINEL_USERNAME',
  'REDIS_SENTINEL_PASSWORD',
];

describe('Redis initialization', () => {
  afterEach(async () => {
    await disconnectRedis();
    for (const key of redisEnvKeys) delete process.env[key];
    clients.length = 0;
  });

  it('shares one in-flight connection across concurrent callers', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    const [first, second, third] = await Promise.all([
      initRedis(),
      initRedis(),
      initRedis(),
    ]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(clients).toHaveLength(1);
    expect(clients[0].args[0]).toBe(process.env.REDIS_URL);
    expect(clients[0].args[1].protocol).toBe(2);
    expect(clients[0].connect).toHaveBeenCalledTimes(1);
    expect(clients[0].ping).toHaveBeenCalledTimes(1);
  });

  it('builds an authenticated master-only Sentinel client', async () => {
    process.env.REDIS_REQUIRE_SENTINEL = 'true';
    process.env.REDIS_SENTINEL_HOSTS = 'redis-0.example:26379, redis-1.example,redis-2.example:26380';
    process.env.REDIS_SENTINEL_MASTER = 'vhhealth-primary';
    process.env.REDIS_USERNAME = 'data-user';
    process.env.REDIS_PASSWORD = 'data-password-for-test';
    process.env.REDIS_SENTINEL_USERNAME = 'sentinel-user';
    process.env.REDIS_SENTINEL_PASSWORD = 'sentinel-password-for-test';

    await initRedis();

    expect(clients).toHaveLength(1);
    expect(clients[0].args).toHaveLength(1);
    expect(clients[0].args[0]).toMatchObject({
      name: 'vhhealth-primary',
      role: 'master',
      username: 'data-user',
      password: 'data-password-for-test',
      sentinelUsername: 'sentinel-user',
      sentinelPassword: 'sentinel-password-for-test',
      protocol: 2,
      lazyConnect: true,
      sentinels: [
        { host: 'redis-0.example', port: 26379 },
        { host: 'redis-1.example', port: 26379 },
        { host: 'redis-2.example', port: 26380 },
      ],
    });

    await expect(assertRedisWritable()).resolves.toBe(true);
    expect(clients[0].set).toHaveBeenCalledWith(
      expect.stringMatching(/^vhhealth:health:redis-write-probe:/),
      expect.any(String),
      'PX',
      10000,
      'NX',
    );
    expect(clients[0].get).toHaveBeenCalledTimes(1);
    expect(clients[0].del).toHaveBeenCalledTimes(1);
  });

  it('rejects readiness when the discovered primary is write-fenced', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    await initRedis();
    clients[0].set.mockResolvedValueOnce(null);

    await expect(assertRedisWritable()).rejects.toThrow('write was not accepted');
  });

  it('fails closed when Sentinel is required but its topology is absent', async () => {
    process.env.REDIS_REQUIRE_SENTINEL = 'true';

    await expect(initRedis()).rejects.toThrow('REDIS_SENTINEL_HOSTS');
    expect(clients).toHaveLength(0);
  });

  it('requires three unique Sentinel endpoints in strict mode', () => {
    expect(() => resolveRedisConnection({
      REDIS_REQUIRE_SENTINEL: 'true',
      REDIS_SENTINEL_HOSTS: 'redis-0.example:26379,redis-0.example:26379',
      REDIS_PASSWORD: 'data-password-for-test',
      REDIS_SENTINEL_PASSWORD: 'sentinel-password-for-test',
    })).toThrow('three unique REDIS_SENTINEL_HOSTS');
  });

  it('rejects default superuser identities in strict Sentinel mode', () => {
    expect(() => resolveRedisConnection({
      REDIS_REQUIRE_SENTINEL: 'true',
      REDIS_SENTINEL_HOSTS: 'redis-0.example:26379,redis-1.example:26379,redis-2.example:26379',
      REDIS_PASSWORD: 'data-password-for-test',
      REDIS_SENTINEL_PASSWORD: 'sentinel-password-for-test',
      REDIS_USERNAME: 'default',
      REDIS_SENTINEL_USERNAME: 'default',
    })).toThrow('named least-privilege');
  });

  it('rejects ambiguous standalone and Sentinel configuration', () => {
    expect(() => resolveRedisConnection({
      REDIS_URL: 'redis://localhost:6379',
      REDIS_SENTINEL_HOSTS: 'redis-0.example:26379',
      REDIS_PASSWORD: 'data-password-for-test',
      REDIS_SENTINEL_PASSWORD: 'sentinel-password-for-test',
    })).toThrow('either REDIS_URL or REDIS_SENTINEL_HOSTS');
  });

  it('parses bracketed IPv6 Sentinel endpoints and rejects invalid ports', () => {
    expect(parseSentinelHosts('[fd00::10]:26380')).toEqual([
      { host: 'fd00::10', port: 26380 },
    ]);
    expect(() => parseSentinelHosts('redis-0.example:70000')).toThrow('Invalid');
  });
});
