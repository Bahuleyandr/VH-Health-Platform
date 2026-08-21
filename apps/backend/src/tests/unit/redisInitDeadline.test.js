// initRedis() must SETTLE in bounded time in EVERY configuration (Redis-loss
// drill 2026-08-15, Finding 2).
//
// Root cause, proven by execution against real ioredis: with all Sentinels
// unreachable, ioredis's SentinelConnector exhausts the sentinel list and then
// sentinelRetryStrategy — which always returns a delay — restarts discovery
// "from scratch" forever, so connect() NEVER rejects (observed still pending at
// 30s, 17 discovery passes). A blackholed socket (TCP accepts, never replies)
// hangs BOTH modes: the ready-check INFO is never answered and connectTimeout
// only bounds the TCP dial. The strict-mode fail-fast in bin/www.js therefore
// never executed under the production config shape: the pod neither became
// ready nor crash-looped into visibility.
//
// This suite uses REAL ioredis (no mock) against genuinely closed and
// genuinely silent local ports, with REDIS_INIT_TIMEOUT_MS shrunk so the
// deadline is observable in unit time.
import net from 'node:net';

const {
  initRedis,
  disconnectRedis,
  hasRedisInitFailed,
  redisInitTimeoutMs,
  redisCommandTimeoutMs,
} = await import('../../lib/redis.js');

const REDIS_ENV_KEYS = [
  'REDIS_URL',
  'REDIS_REQUIRE_SENTINEL',
  'REDIS_SENTINEL_HOSTS',
  'REDIS_SENTINEL_MASTER',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_SENTINEL_USERNAME',
  'REDIS_SENTINEL_PASSWORD',
  'REDIS_INIT_TIMEOUT_MS',
  'REDIS_COMMAND_TIMEOUT_MS',
];
const savedEnv = {};

// A port that was just bound and released — closed with high confidence.
async function getClosedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A TCP server that accepts connections but never sends a byte — what a
// blackholed / wedged Redis looks like to a client.
function startSilentServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

beforeAll(() => {
  for (const key of REDIS_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(async () => {
  await disconnectRedis();
  for (const key of REDIS_ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of REDIS_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

describe('initRedis boot deadline', () => {
  it('rejects within REDIS_INIT_TIMEOUT_MS when all Sentinels are unreachable (prod config shape)', async () => {
    const [p1, p2, p3] = await Promise.all([getClosedPort(), getClosedPort(), getClosedPort()]);
    process.env.REDIS_SENTINEL_HOSTS = `127.0.0.1:${p1},127.0.0.1:${p2},127.0.0.1:${p3}`;
    process.env.REDIS_SENTINEL_MASTER = 'vhhealth-primary';
    process.env.REDIS_USERNAME = 'vhhealth-backend';
    process.env.REDIS_SENTINEL_USERNAME = 'vhhealth-discovery';
    process.env.REDIS_PASSWORD = 'a'.repeat(32);
    process.env.REDIS_SENTINEL_PASSWORD = 'b'.repeat(32);
    process.env.REDIS_INIT_TIMEOUT_MS = '1500';

    const started = Date.now();
    await expect(initRedis()).rejects.toMatchObject({ code: 'REDIS_INIT_TIMEOUT' });
    const elapsed = Date.now() - started;

    // Bounded: the deadline, not the infinite discovery loop, decided.
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(6000);
    expect(hasRedisInitFailed()).toBe(true);
  }, 15000);

  it('rejects within the deadline against a blackholed socket (accepts TCP, never replies)', async () => {
    const silent = await startSilentServer();
    process.env.REDIS_URL = `redis://127.0.0.1:${silent.port}`;
    process.env.REDIS_INIT_TIMEOUT_MS = '1500';

    try {
      const started = Date.now();
      await expect(initRedis()).rejects.toMatchObject({ code: 'REDIS_INIT_TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(6000);
      expect(hasRedisInitFailed()).toBe(true);
    } finally {
      await silent.close();
    }
  }, 15000);

  it('still rejects fast against a plainly closed standalone port', async () => {
    process.env.REDIS_URL = `redis://127.0.0.1:${await getClosedPort()}`;
    process.env.REDIS_INIT_TIMEOUT_MS = '5000';

    const started = Date.now();
    await expect(initRedis()).rejects.toThrow();
    // The pre-existing fast path: a refused connection settles well before the
    // deadline (measured ~5ms).
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hasRedisInitFailed()).toBe(true);
  }, 15000);

  it('resolves null (and clears the failure flag) when Redis is not configured', async () => {
    await expect(initRedis()).resolves.toBeNull();
    expect(hasRedisInitFailed()).toBe(false);
  });

  it('reads sane defaults and env overrides for the two bounds', () => {
    expect(redisInitTimeoutMs()).toBe(15000);
    expect(redisCommandTimeoutMs()).toBe(2000);
    process.env.REDIS_INIT_TIMEOUT_MS = '9000';
    process.env.REDIS_COMMAND_TIMEOUT_MS = '750';
    expect(redisInitTimeoutMs()).toBe(9000);
    expect(redisCommandTimeoutMs()).toBe(750);
    process.env.REDIS_INIT_TIMEOUT_MS = 'not-a-number';
    expect(redisInitTimeoutMs()).toBe(15000);
  });
});
