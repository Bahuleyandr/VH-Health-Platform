// src/tests/unit/redisReinitSchedule.test.js
//
// 873-F11(a): scheduleRedisReinit() had zero jest coverage. Pins:
//   * idempotence — a second call while a timer is armed (or after recovery)
//     returns false and arms NO second timer;
//   * a failed background attempt keeps the timer alive (keeps retrying);
//   * clear-on-success — a successful attempt clears the interval and no
//     further attempts fire;
//   * 873-F10(a): the onReconnect hook fires exactly once on recovery with
//     the live client (bin/www.js uses it to rewire the boot-wired WS
//     fan-out subscriber, which the singleton cannot restore by itself).
//
// ioredis is mocked (redis.js imports it dynamically); timers are fake, so
// the 30s cadence is advanced synthetically.

import { jest } from '@jest/globals';

let connectShouldFail = true;
const connectMock = jest.fn(async () => {
  if (connectShouldFail) throw new Error('ECONNREFUSED 127.0.0.1:6379');
});

class FakeRedis {
  constructor() {}

  on() {}

  connect() {
    return connectMock();
  }

  async ping() {
    return 'PONG';
  }

  disconnect() {}

  async quit() {}
}

jest.unstable_mockModule('ioredis', () => ({ default: FakeRedis }));
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: loggerInfo, warn: loggerWarn, error: jest.fn(), debug: jest.fn() },
}));

const {
  initRedis,
  scheduleRedisReinit,
  disconnectRedis,
  hasRedisInitFailed,
  getRedisClient,
} = await import('../../lib/redis.js');

const REINIT_INTERVAL_MS = 30000;

beforeAll(() => {
  jest.useFakeTimers();
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  delete process.env.REDIS_SENTINEL_HOSTS;
  delete process.env.REDIS_REQUIRE_SENTINEL;
});

afterAll(async () => {
  await disconnectRedis();
  jest.useRealTimers();
  delete process.env.REDIS_URL;
});

// Sequential narrative on one module instance: failed boot → armed reinit →
// failed tick → successful tick → cleared.
describe('scheduleRedisReinit (873-F11a / 873-F10a)', () => {
  it('walks a degraded start through background recovery exactly once', async () => {
    // Degraded start: boot init fails, flag set, no client.
    connectShouldFail = true;
    await expect(initRedis()).rejects.toThrow('ECONNREFUSED');
    expect(hasRedisInitFailed()).toBe(true);
    expect(getRedisClient()).toBeNull();

    const onReconnect = jest.fn();

    // Arm. Second call is a no-op: no double timer.
    expect(scheduleRedisReinit({ onReconnect })).toBe(true);
    expect(scheduleRedisReinit({ onReconnect })).toBe(false);
    expect(jest.getTimerCount()).toBe(1);

    // First tick fails: timer survives, hook untouched.
    const attemptsBefore = connectMock.mock.calls.length;
    await jest.advanceTimersByTimeAsync(REINIT_INTERVAL_MS);
    expect(connectMock.mock.calls.length).toBe(attemptsBefore + 1);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    expect(getRedisClient()).toBeNull();

    // Redis returns: the next tick succeeds, clears the interval, and fires
    // the rewire hook once with the live client.
    connectShouldFail = false;
    await jest.advanceTimersByTimeAsync(REINIT_INTERVAL_MS);
    expect(getRedisClient()).not.toBeNull();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledWith(getRedisClient());
    expect(jest.getTimerCount()).toBe(0); // clear-on-success

    // No further attempts after recovery.
    const attemptsAfterRecovery = connectMock.mock.calls.length;
    await jest.advanceTimersByTimeAsync(REINIT_INTERVAL_MS * 3);
    expect(connectMock.mock.calls.length).toBe(attemptsAfterRecovery);

    // Idempotent after recovery too: Redis is up, nothing to arm.
    expect(scheduleRedisReinit({ onReconnect })).toBe(false);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('a throwing onReconnect hook does not kill the recovery (error is contained)', async () => {
    // Tear down the recovered client from the previous test, then fail boot
    // again so a fresh reinit cycle can run.
    await disconnectRedis();
    connectShouldFail = true;
    await expect(initRedis()).rejects.toThrow();

    const badHook = jest.fn(async () => {
      throw new Error('subscriber wiring exploded');
    });
    expect(scheduleRedisReinit({ onReconnect: badHook })).toBe(true);

    connectShouldFail = false;
    await jest.advanceTimersByTimeAsync(REINIT_INTERVAL_MS);

    expect(badHook).toHaveBeenCalledTimes(1);
    expect(getRedisClient()).not.toBeNull(); // recovery itself stands
    expect(jest.getTimerCount()).toBe(0);
  });
});
