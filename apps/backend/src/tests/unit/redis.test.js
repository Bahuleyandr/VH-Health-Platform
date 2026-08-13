import { jest } from '@jest/globals';

const clients = [];

class FakeRedis {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.quit = jest.fn(async () => undefined);
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

const { initRedis, disconnectRedis } = await import('../../lib/redis.js');

describe('Redis initialization', () => {
  afterEach(async () => {
    await disconnectRedis();
    delete process.env.REDIS_URL;
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
    expect(clients[0].url).toBe(process.env.REDIS_URL);
    expect(clients[0].options.protocol).toBe(2);
  });
});
