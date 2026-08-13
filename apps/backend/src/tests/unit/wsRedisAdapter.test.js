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
