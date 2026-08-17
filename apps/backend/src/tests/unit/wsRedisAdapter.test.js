import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const recordWsFanoutSubscriberError = jest.fn();

jest.unstable_mockModule('../../logging/logger.js', () => ({ default: logger }));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordWsFanoutSubscriberError,
}));

const { createWsFanout } = await import('../../utils/websocket/wsRedisAdapter.js');

describe('wsRedisAdapter publish failure handling', () => {
  const subscriber = () => ({
    on: jest.fn(),
    off: jest.fn(),
    psubscribe: jest.fn().mockResolvedValue(1),
    punsubscribe: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue(undefined),
  });

  const eventSubscriber = () => {
    const emitter = new EventEmitter();
    const on = emitter.on.bind(emitter);
    const off = emitter.off.bind(emitter);
    emitter.on = jest.fn((event, handler) => on(event, handler));
    emitter.off = jest.fn((event, handler) => off(event, handler));
    emitter.psubscribe = jest.fn().mockResolvedValue(1);
    emitter.punsubscribe = jest.fn().mockResolvedValue(1);
    emitter.quit = jest.fn().mockResolvedValue(undefined);
    emitter.disconnect = jest.fn();
    return emitter;
  };

  beforeEach(() => {
    Object.values(logger).forEach((mock) => mock.mockClear());
    recordWsFanoutSubscriberError.mockClear();
  });

  it('falls back to local user delivery on an asynchronous publish rejection', async () => {
    const publishError = new Error('redis publish failed');
    const pub = { publish: jest.fn().mockRejectedValue(publishError) };
    const sub = subscriber();
    const fanout = createWsFanout();
    const deliverUser = jest.fn();
    fanout.registerLocalDelivery({ deliverBroadcast: jest.fn(), deliverUser });
    await fanout.init({ pub, sub });

    expect(fanout.publishUser('user-1', 'session:revoked', { reason: 'logout' }, null)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(deliverUser).toHaveBeenCalledWith(
      'user-1',
      'session:revoked',
      { reason: 'logout' },
      null,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'WS fan-out publishUser failed after dispatch — falling back to local:',
      'redis publish failed',
    );
    await fanout.close();
  });

  it('observes fire-and-forget broadcast rejection and exposes an awaited failure path', async () => {
    const publishError = new Error('redis broadcast failed');
    const pub = { publish: jest.fn().mockRejectedValue(publishError) };
    const fanout = createWsFanout();
    await fanout.init({ pub, sub: subscriber() });

    expect(fanout.publishBroadcast('admin:daily-ops', 'admin:daily-ops', {}, null)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(
      'WS fan-out publishBroadcast failed after dispatch — falling back to local:',
      'redis broadcast failed',
    );
    await expect(fanout.publishBroadcastConfirmed(
      'admin:daily-ops',
      'admin:daily-ops',
      {},
      null,
    )).rejects.toThrow('redis broadcast failed');
    await fanout.close();
  });

  it('requires at least one ready Redis subscriber for confirmed fleet broadcast', async () => {
    const pub = { publish: jest.fn().mockResolvedValue(0) };
    const fanout = createWsFanout();
    await fanout.init({ pub, sub: subscriber() });

    await expect(fanout.publishBroadcastConfirmed(
      'admin:daily-ops',
      'admin:daily-ops',
      {},
      null,
    )).rejects.toMatchObject({ code: 'WS_FANOUT_NO_SUBSCRIBERS' });
    pub.publish.mockResolvedValueOnce(1);
    await expect(fanout.publishBroadcastConfirmed(
      'admin:daily-ops',
      'admin:daily-ops',
      {},
      null,
    )).resolves.toBe(true);
    await fanout.close();
  });

  it('fails closed after the local subscriber reports an error', async () => {
    const handlers = new Map();
    const sub = subscriber();
    sub.on.mockImplementation((event, handler) => handlers.set(event, handler));
    const pub = { publish: jest.fn().mockResolvedValue(1) };
    const fanout = createWsFanout();
    await fanout.init({ pub, sub });

    handlers.get('error')(new Error('subscriber disconnected'));
    await expect(fanout.publishBroadcastConfirmed(
      'admin:daily-ops',
      'admin:daily-ops',
      {},
      null,
    )).rejects.toMatchObject({ code: 'WS_FANOUT_SUBSCRIPTION_NOT_READY' });
    expect(pub.publish).not.toHaveBeenCalled();
    await fanout.close();
  });

  it('does not let a stale subscription acknowledgement restore readiness', async () => {
    const handlers = new Map();
    let resolveSubscription;
    const sub = subscriber();
    sub.psubscribe.mockReturnValue(new Promise(resolve => { resolveSubscription = resolve; }));
    sub.on.mockImplementation((event, handler) => handlers.set(event, handler));
    const pub = { publish: jest.fn().mockResolvedValue(1) };
    const fanout = createWsFanout();
    const initPromise = fanout.init({ pub, sub });

    handlers.get('error')(new Error('subscriber disconnected before acknowledgement'));
    resolveSubscription(1);
    await expect(initPromise).rejects.toMatchObject({ code: 'WS_FANOUT_SUBSCRIPTION_NOT_READY' });

    await expect(fanout.publishBroadcastConfirmed(
      'admin:daily-ops',
      'admin:daily-ops',
      {},
      null,
    )).rejects.toMatchObject({ code: 'WS_FANOUT_SUBSCRIPTION_NOT_READY' });
    expect(pub.publish).not.toHaveBeenCalled();
    await fanout.close();
  });

  it('fails initialization closed when Redis rejects PSUBSCRIBE with NOPERM', async () => {
    const pub = { publish: jest.fn() };
    const sub = {
      on: jest.fn(),
      off: jest.fn(),
      psubscribe: jest.fn().mockRejectedValue(new Error('NOPERM this user has no permissions')),
      punsubscribe: jest.fn().mockResolvedValue(0),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    const fanout = createWsFanout();

    await expect(fanout.init({ pub, sub })).rejects.toThrow('NOPERM');
    expect(fanout.isEnabled()).toBe(false);
    expect(fanout.publishBroadcast('staff:test', 'event', {}, 'tenant-a')).toBe(false);
    expect(recordWsFanoutSubscriberError).toHaveBeenCalledTimes(1);
    await fanout.close();
  });

  it('disconnects an internally owned subscriber after failed initialization', async () => {
    const sub = {
      on: jest.fn(),
      off: jest.fn(),
      psubscribe: jest.fn().mockRejectedValue(new Error('NOPERM')),
      punsubscribe: jest.fn().mockResolvedValue(0),
      quit: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    const pub = { duplicate: jest.fn(() => sub), publish: jest.fn() };
    const fanout = createWsFanout();

    await expect(fanout.init({ pub })).rejects.toThrow('NOPERM');
    expect(sub.disconnect).toHaveBeenCalledWith(false);
  });

  it('single-flights overlapping initialization instead of subscribing twice', async () => {
    let resolveSubscription;
    const first = subscriber();
    first.psubscribe.mockReturnValue(new Promise((resolve) => {
      resolveSubscription = resolve;
    }));
    const second = subscriber();
    const pub = { publish: jest.fn() };
    const fanout = createWsFanout();

    const firstInit = fanout.init({ pub, sub: first });
    const secondInit = fanout.init({ pub, sub: second });

    expect(secondInit).toBe(firstInit);
    expect(first.psubscribe).toHaveBeenCalledTimes(1);
    expect(second.psubscribe).not.toHaveBeenCalled();
    resolveSubscription(1);
    await expect(Promise.all([firstInit, secondInit])).resolves.toEqual([true, true]);
    await fanout.close();
  });

  it('retires an owned unavailable subscriber before a replacement can deliver', async () => {
    const oldSub = eventSubscriber();
    const replacementSub = eventSubscriber();
    const pub = {
      duplicate: jest.fn()
        .mockReturnValueOnce(oldSub)
        .mockReturnValueOnce(replacementSub),
      publish: jest.fn().mockResolvedValue(1),
    };
    const deliverBroadcast = jest.fn();
    const fanout = createWsFanout();
    fanout.registerLocalDelivery({ deliverBroadcast, deliverUser: jest.fn() });

    await fanout.init({ pub });
    const staleMessageHandler = oldSub.listeners('pmessage')[0];
    oldSub.emit('reconnecting');
    expect(fanout.isEnabled()).toBe(false);

    await fanout.init({ pub });

    expect(pub.duplicate).toHaveBeenCalledTimes(2);
    for (const event of ['pmessage', 'ready', 'close', 'reconnecting', 'error']) {
      expect(oldSub.listenerCount(event)).toBe(0);
    }
    expect(oldSub.punsubscribe).toHaveBeenCalledWith('ws:*');
    expect(oldSub.quit).toHaveBeenCalledTimes(1);
    expect(oldSub.disconnect).not.toHaveBeenCalled();

    const envelope = JSON.stringify({
      event: 'changed',
      data: { id: 1 },
      tenantId: 'tenant-a',
    });
    staleMessageHandler('ws:*', 'ws:broadcast:staff:test', envelope);
    oldSub.emit('pmessage', 'ws:*', 'ws:broadcast:staff:test', envelope);
    expect(deliverBroadcast).not.toHaveBeenCalled();

    replacementSub.emit('pmessage', 'ws:*', 'ws:broadcast:staff:test', envelope);
    expect(deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(deliverBroadcast).toHaveBeenCalledWith(
      'staff:test',
      'changed',
      { id: 1 },
      'tenant-a',
    );
    await fanout.close();
  });

  it('bounds stale owned teardown when unsubscribe and quit never settle', async () => {
    const oldSub = eventSubscriber();
    const replacementSub = eventSubscriber();
    const pub = {
      duplicate: jest.fn()
        .mockReturnValueOnce(oldSub)
        .mockReturnValueOnce(replacementSub),
      publish: jest.fn().mockResolvedValue(1),
    };
    const deliverBroadcast = jest.fn();
    const fanout = createWsFanout({ teardownTimeoutMs: 5 });
    fanout.registerLocalDelivery({ deliverBroadcast, deliverUser: jest.fn() });

    await fanout.init({ pub });
    const staleMessageHandler = oldSub.listeners('pmessage')[0];
    oldSub.punsubscribe.mockReturnValueOnce(new Promise(() => {}));
    oldSub.quit.mockReturnValueOnce(new Promise(() => {}));
    oldSub.emit('reconnecting');

    await expect(fanout.init({ pub })).resolves.toBe(true);

    expect(pub.duplicate).toHaveBeenCalledTimes(2);
    expect(oldSub.punsubscribe).toHaveBeenCalledWith('ws:*');
    expect(oldSub.quit).toHaveBeenCalledTimes(1);
    expect(oldSub.disconnect).toHaveBeenCalledWith(false);
    for (const event of ['pmessage', 'ready', 'close', 'reconnecting', 'error']) {
      expect(oldSub.listenerCount(event)).toBe(0);
    }

    const envelope = JSON.stringify({
      event: 'changed',
      data: { id: 3 },
      tenantId: 'tenant-c',
    });
    staleMessageHandler('ws:*', 'ws:broadcast:staff:test', envelope);
    oldSub.emit('pmessage', 'ws:*', 'ws:broadcast:staff:test', envelope);
    expect(deliverBroadcast).not.toHaveBeenCalled();
    replacementSub.emit('pmessage', 'ws:*', 'ws:broadcast:staff:test', envelope);
    expect(deliverBroadcast).toHaveBeenCalledTimes(1);
    await fanout.close();
  });

  it('rejects a rewire that races an in-flight close and permits an explicit later init', async () => {
    const oldSub = eventSubscriber();
    const replacementSub = eventSubscriber();
    const pub = {
      duplicate: jest.fn()
        .mockReturnValueOnce(oldSub)
        .mockReturnValueOnce(replacementSub),
      publish: jest.fn().mockResolvedValue(1),
    };
    const fanout = createWsFanout();
    await fanout.init({ pub });

    let resolveUnsubscribe;
    oldSub.punsubscribe.mockReturnValueOnce(new Promise((resolve) => {
      resolveUnsubscribe = resolve;
    }));
    const closing = fanout.close();
    await Promise.resolve();

    await expect(fanout.init({ pub })).rejects.toMatchObject({
      code: 'WS_FANOUT_GENERATION_STALE',
    });
    expect(pub.duplicate).toHaveBeenCalledTimes(1);
    expect(fanout.isEnabled()).toBe(false);

    resolveUnsubscribe(1);
    await closing;
    expect(fanout.isEnabled()).toBe(false);
    expect(pub.duplicate).toHaveBeenCalledTimes(1);

    await expect(fanout.init({ pub })).resolves.toBe(true);
    expect(pub.duplicate).toHaveBeenCalledTimes(2);
    expect(fanout.isEnabled()).toBe(true);
    await fanout.close();
  });

  it('detaches but never closes injected subscribers during replacement or shutdown', async () => {
    const oldSub = eventSubscriber();
    const replacementSub = eventSubscriber();
    const pub = { publish: jest.fn().mockResolvedValue(1) };
    const deliverBroadcast = jest.fn();
    const fanout = createWsFanout();
    fanout.registerLocalDelivery({ deliverBroadcast, deliverUser: jest.fn() });

    await fanout.init({ pub, sub: oldSub });
    const staleMessageHandler = oldSub.listeners('pmessage')[0];
    oldSub.emit('close');
    await fanout.init({ pub, sub: replacementSub });

    for (const event of ['pmessage', 'ready', 'close', 'reconnecting', 'error']) {
      expect(oldSub.listenerCount(event)).toBe(0);
    }
    for (const method of ['punsubscribe', 'quit', 'disconnect']) {
      expect(oldSub[method]).not.toHaveBeenCalled();
    }

    const envelope = JSON.stringify({
      event: 'changed',
      data: { id: 2 },
      tenantId: 'tenant-b',
    });
    staleMessageHandler('ws:*', 'ws:broadcast:staff:test', envelope);
    replacementSub.emit('pmessage', 'ws:*', 'ws:broadcast:staff:test', envelope);
    expect(deliverBroadcast).toHaveBeenCalledTimes(1);

    await fanout.close();
    for (const event of ['pmessage', 'ready', 'close', 'reconnecting', 'error']) {
      expect(replacementSub.listenerCount(event)).toBe(0);
    }
    for (const targetSub of [oldSub, replacementSub]) {
      for (const method of ['punsubscribe', 'quit', 'disconnect']) {
        expect(targetSub[method]).not.toHaveBeenCalled();
      }
    }
  });

  it('fails initialization closed when Redis acknowledges zero subscriptions', async () => {
    const pub = { publish: jest.fn() };
    const sub = {
      on: jest.fn(),
      off: jest.fn(),
      psubscribe: jest.fn().mockResolvedValue(0),
      punsubscribe: jest.fn().mockResolvedValue(0),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    const fanout = createWsFanout();

    await expect(fanout.init({ pub, sub })).rejects.toThrow('zero WebSocket subscriptions');
    expect(fanout.isEnabled()).toBe(false);
    expect(pub.publish).not.toHaveBeenCalled();
    await fanout.close();
  });

  it('disables publishing when PSUBSCRIBE is rejected after a reconnect', async () => {
    const handlers = new Map();
    const pub = { publish: jest.fn() };
    const sub = {
      on: jest.fn((event, handler) => handlers.set(event, handler)),
      off: jest.fn(),
      psubscribe: jest.fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('NOPERM after Sentinel failover')),
      punsubscribe: jest.fn().mockResolvedValue(0),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    const fanout = createWsFanout();
    await fanout.init({ pub, sub });
    expect(fanout.isEnabled()).toBe(true);

    handlers.get('reconnecting')();
    expect(fanout.isEnabled()).toBe(false);
    handlers.get('ready')();
    await new Promise((resolve) => setImmediate(resolve));

    expect(fanout.isEnabled()).toBe(false);
    expect(fanout.publishBroadcast('staff:test', 'event', {}, 'tenant-a')).toBe(false);
    expect(pub.publish).not.toHaveBeenCalled();
    expect(recordWsFanoutSubscriberError).toHaveBeenCalledTimes(1);
    await fanout.close();
  });

  it('falls back locally when an async broadcast reaches zero subscribers', async () => {
    const pub = { publish: jest.fn().mockResolvedValue(0) };
    const sub = {
      on: jest.fn(),
      off: jest.fn(),
      psubscribe: jest.fn().mockResolvedValue(1),
      punsubscribe: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    const fanout = createWsFanout();
    const deliverBroadcast = jest.fn();
    fanout.registerLocalDelivery({ deliverBroadcast, deliverUser: jest.fn() });
    await fanout.init({ pub, sub });

    expect(fanout.publishBroadcast('staff:test', 'changed', { id: 1 }, 'tenant-a')).toBe(true);
    await Promise.resolve();

    expect(deliverBroadcast).toHaveBeenCalledWith(
      'staff:test',
      'changed',
      { id: 1 },
      'tenant-a',
    );
    await fanout.close();
  });
});
