// scheduleWsFanoutRewire — background recovery for the degraded start where
// Redis init SUCCEEDED but the boot-time initWsFanout itself failed (PR #874
// follow-up: that pod previously stayed silently deaf to cross-pod clinical
// broadcasts until restart, with only a boot log line and the non-strict
// /health/ready block to show for it). Pins:
//   * idempotence — a second call while a loop is armed (or after the fan-out
//     is wired) returns false and arms no second loop;
//   * a failed attempt tears down the subscriber duplicate it created (a
//     failed fanout.init() cannot clean up its own duplicate without close(),
//     which would also unregister local delivery) and re-arms with doubled,
//     capped backoff;
//   * recovery — once PSUBSCRIBE succeeds the fan-out reports ready, the loop
//     stops, and no further attempts fire;
//   * the attempt cap — the loop gives up LOUDLY after maxAttempts and can be
//     re-armed afterwards;
//   * stand-down — if another path (the Redis reinit onReconnect hook) wires
//     the fan-out first, the loop exits without probing.
//
// Mock preamble mirrors wsSessionRevocation.test.js (wsServer pulls ws,
// jwtUtils, tokenBlacklist, tenantContext, reliabilityMetrics at load).

import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

class FakeWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }

  close(callback) {
    this.emit('close');
    callback?.();
  }
}

jest.unstable_mockModule('ws', () => ({ WebSocketServer: FakeWebSocketServer }));
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  verifyToken: () => ({ sub: 'user-1', role: 'PATIENT' }),
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isTokenBlacklisted: jest.fn().mockResolvedValue(false),
  isDelegatedTupleRevoked: jest.fn().mockResolvedValue(false),
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  isUserTokensRevoked: jest.fn().mockResolvedValue(false),
}));
jest.unstable_mockModule('../../utils/websocket/channelAuth.js', () => ({
  authorizeChannel: () => ({ allowed: true, reason: 'ok' }),
  parsePatientChannel: () => null,
}));
// subscriptionAuth pulls accessDecisionService -> prisma at load; this suite
// never authorizes a subscription, so keep the import graph prisma-free.
jest.unstable_mockModule('../../utils/websocket/subscriptionAuth.js', () => ({
  authorizeSubscriptionChannel: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  getCurrentTenantId: () => null,
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordWsBroadcastDropped: jest.fn(),
  recordWsFanoutSubscriberError: jest.fn(),
}));

const {
  scheduleWsFanoutRewire,
  cancelWsFanoutRewire,
  initWsFanout,
  isWsFanoutReady,
  closeWsFanout,
} = await import('../../utils/websocket/wsServer.js');

let psubscribeShouldFail = true;
const createdSubs = [];

function makeSub() {
  const sub = new EventEmitter();
  jest.spyOn(sub, 'on');
  jest.spyOn(sub, 'off');
  sub.psubscribe = jest.fn(async () => {
    if (psubscribeShouldFail) throw new Error('ECONNREFUSED psubscribe');
    return 1;
  });
  sub.punsubscribe = jest.fn().mockResolvedValue(1);
  sub.quit = jest.fn().mockResolvedValue(undefined);
  sub.disconnect = jest.fn();
  createdSubs.push(sub);
  return sub;
}

const pub = {
  duplicate: jest.fn(() => makeSub()),
  publish: jest.fn().mockResolvedValue(1),
};

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(async () => {
  await closeWsFanout();
  jest.useRealTimers();
});

afterEach(async () => {
  cancelWsFanoutRewire();
  await closeWsFanout();
  createdSubs.length = 0;
  pub.duplicate.mockClear();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
});

describe('scheduleWsFanoutRewire', () => {
  it('requires a getClient function', () => {
    expect(() => scheduleWsFanoutRewire()).toThrow(TypeError);
  });

  it('walks failed attempts through capped backoff to recovery, exactly once', async () => {
    psubscribeShouldFail = true;

    expect(
      scheduleWsFanoutRewire({
        getClient: () => pub,
        initialDelayMs: 1000,
        maxDelayMs: 4000,
        maxAttempts: 10,
      }),
    ).toBe(true);
    // Idempotent while armed: no second loop.
    expect(scheduleWsFanoutRewire({ getClient: () => pub })).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
    expect(isWsFanoutReady()).toBe(false);

    // Attempt 1 fails at +1000ms: the duplicate this attempt created is torn
    // down (leak bound) and the loop re-arms at doubled delay.
    await jest.advanceTimersByTimeAsync(1000);
    expect(pub.duplicate).toHaveBeenCalledTimes(1);
    expect(createdSubs[0].disconnect).toHaveBeenCalledWith(false);
    expect(isWsFanoutReady()).toBe(false);
    expect(jest.getTimerCount()).toBe(1);

    // Attempt 2 fails at +2000ms.
    await jest.advanceTimersByTimeAsync(2000);
    expect(pub.duplicate).toHaveBeenCalledTimes(2);
    expect(createdSubs[1].disconnect).toHaveBeenCalledWith(false);

    // Redis bus accepts PSUBSCRIBE again: attempt 3 (delay capped at 4000ms)
    // wires the fan-out and stops the loop.
    psubscribeShouldFail = false;
    await jest.advanceTimersByTimeAsync(4000);
    expect(pub.duplicate).toHaveBeenCalledTimes(3);
    expect(isWsFanoutReady()).toBe(true);
    expect(createdSubs[2].disconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(loggerInfo.mock.calls.some(
      (call) => String(call[0]).includes('restored by background rewire'),
    )).toBe(true);

    // No further attempts after recovery; re-arming is refused while wired.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(pub.duplicate).toHaveBeenCalledTimes(3);
    expect(scheduleWsFanoutRewire({ getClient: () => pub })).toBe(false);
  });

  it('gives up loudly after maxAttempts and can be re-armed', async () => {
    psubscribeShouldFail = true;

    expect(
      scheduleWsFanoutRewire({
        getClient: () => pub,
        initialDelayMs: 1000,
        maxDelayMs: 2000,
        maxAttempts: 2,
      }),
    ).toBe(true);

    await jest.advanceTimersByTimeAsync(1000); // attempt 1 fails, re-arms
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(2000); // attempt 2 fails → give up
    expect(jest.getTimerCount()).toBe(0);
    expect(isWsFanoutReady()).toBe(false);
    expect(loggerError.mock.calls.some(
      (call) => String(call[0]).includes('GAVE UP after 2 attempts'),
    )).toBe(true);

    // The loop is disarmed, not latched — an operator-driven or later
    // programmatic re-arm starts a fresh bounded loop.
    expect(scheduleWsFanoutRewire({ getClient: () => pub, initialDelayMs: 1000 })).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('a missing Redis client counts as a failed attempt and keeps patrolling', async () => {
    psubscribeShouldFail = true;

    expect(
      scheduleWsFanoutRewire({
        getClient: () => null,
        initialDelayMs: 1000,
        maxDelayMs: 8000,
        maxAttempts: 10,
      }),
    ).toBe(true);

    await jest.advanceTimersByTimeAsync(1000);
    expect(pub.duplicate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1); // still patrolling
    expect(loggerWarn.mock.calls.some(
      (call) => String(call[1] ?? '').includes('Redis client unavailable'),
    )).toBe(true);
  });

  it('stands down without probing when another path wired the fan-out first', async () => {
    psubscribeShouldFail = true;

    expect(
      scheduleWsFanoutRewire({
        getClient: () => pub,
        initialDelayMs: 1000,
      }),
    ).toBe(true);

    // The Redis-reinit onReconnect hook wins the race: wire directly.
    psubscribeShouldFail = false;
    await initWsFanout({ pub, sub: makeSub() });
    expect(isWsFanoutReady()).toBe(true);
    pub.duplicate.mockClear();

    await jest.advanceTimersByTimeAsync(1000);
    // The pending tick exits without creating a duplicate or re-arming.
    expect(pub.duplicate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(isWsFanoutReady()).toBe(true);
  });

  it('shares one in-flight initialization across reconnect and timer paths', async () => {
    let resolveSubscription;
    const firstSub = makeSub();
    firstSub.psubscribe.mockReturnValue(new Promise((resolve) => {
      resolveSubscription = resolve;
    }));
    const secondSub = makeSub();
    const overlappingPub = {
      duplicate: jest.fn()
        .mockReturnValueOnce(firstSub)
        .mockReturnValueOnce(secondSub),
      publish: jest.fn().mockResolvedValue(1),
    };

    const reconnectInit = initWsFanout({ pub: overlappingPub });
    const timerInit = initWsFanout({ pub: overlappingPub });

    expect(overlappingPub.duplicate).toHaveBeenCalledTimes(1);
    expect(firstSub.psubscribe).toHaveBeenCalledTimes(1);
    expect(secondSub.psubscribe).not.toHaveBeenCalled();

    resolveSubscription(1);
    await expect(Promise.all([reconnectInit, timerInit])).resolves.toEqual([true, true]);
    expect(isWsFanoutReady()).toBe(true);
  });

  it('retires the unavailable generation while reconnect and timer rewires overlap', async () => {
    psubscribeShouldFail = false;
    await initWsFanout({ pub });
    const oldSub = createdSubs[0];
    let resolveOldUnsubscribe;
    oldSub.punsubscribe.mockReturnValueOnce(new Promise((resolve) => {
      resolveOldUnsubscribe = resolve;
    }));

    oldSub.emit('reconnecting');
    expect(isWsFanoutReady()).toBe(false);
    const reconnectInit = initWsFanout({ pub });
    expect(
      scheduleWsFanoutRewire({
        getClient: () => pub,
        initialDelayMs: 1000,
      }),
    ).toBe(true);
    const timerTick = jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    resolveOldUnsubscribe(1);
    await Promise.all([reconnectInit, timerTick]);

    expect(pub.duplicate).toHaveBeenCalledTimes(2);
    expect(createdSubs).toHaveLength(2);
    for (const event of ['pmessage', 'ready', 'close', 'reconnecting', 'error']) {
      expect(oldSub.listenerCount(event)).toBe(0);
    }
    expect(oldSub.punsubscribe).toHaveBeenCalledWith('ws:*');
    expect(oldSub.quit).toHaveBeenCalledTimes(1);
    expect(createdSubs[1].listenerCount('pmessage')).toBe(1);
    expect(isWsFanoutReady()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not re-arm or restore an in-flight background rewire after close', async () => {
    let resolveSubscription;
    let markRewireStarted;
    const rewireStarted = new Promise((resolve) => {
      markRewireStarted = resolve;
    });
    const racingSub = makeSub();
    racingSub.psubscribe.mockReturnValue(new Promise((resolve) => {
      resolveSubscription = resolve;
    }));
    const racingPub = {
      duplicate: jest.fn(() => racingSub),
      publish: jest.fn().mockResolvedValue(1),
    };

    expect(scheduleWsFanoutRewire({
      getClient: () => {
        markRewireStarted();
        return racingPub;
      },
      initialDelayMs: 1000,
      maxAttempts: 10,
    })).toBe(true);
    const timerTick = jest.advanceTimersByTimeAsync(1000);
    await rewireStarted;
    expect(racingPub.duplicate).toHaveBeenCalledTimes(1);

    const closing = closeWsFanout();
    resolveSubscription(1);
    await Promise.all([timerTick, closing]);

    expect(isWsFanoutReady()).toBe(false);
    expect(racingPub.duplicate).toHaveBeenCalledTimes(1);
    expect(racingSub.disconnect).toHaveBeenCalledWith(false);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(racingPub.duplicate).toHaveBeenCalledTimes(1);
    expect(isWsFanoutReady()).toBe(false);
  });
});
