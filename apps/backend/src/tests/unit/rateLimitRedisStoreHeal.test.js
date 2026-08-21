// src/tests/unit/rateLimitRedisStoreHeal.test.js
//
// 873-F11: the script-SHA-promise heal claim, proven against the REAL
// vendored rate-limit-redis@6 (previously pinned only against the hand-rolled
// FakeRedisStore). No live Redis needed: the library talks to Redis solely
// through the injected sendCommand function, so a controllable fake
// connection exercises the genuine library code paths.
//
// The claim (ResilientRateLimitStore docblock): rate-limit-redis v6 loads its
// Lua scripts inside init() and CACHES the returned promise
// (this.incrementScriptSha). With Redis down at init, that cached promise is
// permanently REJECTED — the library never retries the load on its own, so a
// degraded start would leave the store broken even after Redis returns.
// ResilientRateLimitStore absorbs the failed init and re-runs it on the next
// healthy access, which replaces the rejected promise and heals the store.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/redis.js', () => ({
  getRedisClient: () => ({ fake: true }), // connection LOOKS present
  isRedisConnected: () => true,
  hasRedisInitFailed: () => false,
  isRedisConfigured: () => true,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// REAL library — deliberately not mocked.
const { RedisStore } = await import('rate-limit-redis');
const {
  ResilientRateLimitStore,
  rateLimitStoreStatus,
  __resetRateLimitStoreHealthForTests,
} = await import('../../middleware/rateLimitStoreHealth.js');
const { RATE_LIMIT_STORE_LOSS_POSTURE } = await import(
  '../../config/rateLimitStoreLossPolicy.js'
);

// A fake Redis CONNECTION (not a fake store): SCRIPT LOAD hands back a sha,
// EVALSHA runs the loaded increment script's contract (fixed-window INCR).
function makeFakeConnection() {
  const state = { down: true, hits: 0, sends: [] };
  const sendCommand = jest.fn(async (...command) => {
    state.sends.push(command[0]);
    if (state.down) {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
    const [cmd] = command;
    if (cmd === 'SCRIPT') return `sha-${command[1].toLowerCase()}-${command[2].length}`;
    if (cmd === 'EVALSHA') {
      state.hits += 1;
      return [state.hits, 60000];
    }
    if (cmd === 'DECR') return state.hits > 0 ? (state.hits -= 1) : 0;
    if (cmd === 'DEL') return 1;
    throw new Error(`unexpected command: ${cmd}`);
  });
  return { state, sendCommand };
}

beforeEach(() => {
  __resetRateLimitStoreHealthForTests();
});

describe('real rate-limit-redis v6 heal after a failed init', () => {
  it('the raw library alone stays broken after recovery (the defect the wrapper exists for)', async () => {
    const { state, sendCommand } = makeFakeConnection();
    const raw = new RedisStore({ sendCommand, prefix: 'rl:heal-raw:' });

    await expect(raw.init({ windowMs: 60000 })).rejects.toThrow();

    // Redis comes back — but the cached script-SHA promise is already
    // rejected, so increments keep failing forever without a re-init.
    state.down = false;
    await expect(raw.increment('k1')).rejects.toThrow();
  });

  it('ResilientRateLimitStore absorbs the failed init and heals through the real library', async () => {
    const { state, sendCommand } = makeFakeConnection();
    const store = new ResilientRateLimitStore({
      inner: new RedisStore({ sendCommand, prefix: 'rl:heal:' }),
      profileName: 'auth',
      posture: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
    });

    // Init with Redis down: absorbed (no throw, no unhandledRejection storm),
    // breaker opens.
    await store.init({ windowMs: 60000 });
    expect(rateLimitStoreStatus().state).toBe('degraded');

    // While down: fail-closed store-loss result, library never re-consulted.
    const denied = await store.increment('t:default:auth:k');
    expect(denied.totalHits).toBe(Number.MAX_SAFE_INTEGER);

    // Redis returns; the probe window matures; the next increment re-runs the
    // REAL init (fresh script promises replace the rejected ones) and counts.
    state.down = false;
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 16000);
    try {
      const healed = await store.increment('t:default:auth:k');
      expect(healed.totalHits).toBe(1);
      expect(rateLimitStoreStatus().state).toBe('ok');
      // The heal went through genuine library commands: script loads + evalsha.
      expect(state.sends).toContain('SCRIPT');
      expect(state.sends).toContain('EVALSHA');

      // And subsequent increments keep counting through the healed store.
      const next = await store.increment('t:default:auth:k');
      expect(next.totalHits).toBe(2);
    } finally {
      Date.now.mockRestore();
    }
  });
});
