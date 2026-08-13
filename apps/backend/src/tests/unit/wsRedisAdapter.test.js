import { jest } from '@jest/globals';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../../logging/logger.js', () => ({ default: logger }));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordWsFanoutSubscriberError: jest.fn(),
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

  it('observes an asynchronous user-publish rejection instead of leaking it as unhandled', async () => {
    const publishError = new Error('redis publish failed');
    const pub = { publish: jest.fn().mockRejectedValue(publishError) };
    const sub = subscriber();
    const fanout = createWsFanout();
    fanout.init({ pub, sub });

    expect(fanout.publishUser('user-1', 'session:revoked', { reason: 'logout' }, null)).toBe(true);
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      'WS fan-out publishUser failed after dispatch:',
      'redis publish failed',
    );
    await fanout.close();
  });

  it('observes fire-and-forget broadcast rejection and exposes an awaited failure path', async () => {
    const publishError = new Error('redis broadcast failed');
    const pub = { publish: jest.fn().mockRejectedValue(publishError) };
    const fanout = createWsFanout();
    fanout.init({ pub, sub: subscriber() });

    expect(fanout.publishBroadcast('admin:daily-ops', 'admin:daily-ops', {}, null)).toBe(true);
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      'WS fan-out publishBroadcast failed after dispatch:',
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
    fanout.init({ pub, sub: subscriber() });

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
    fanout.init({ pub, sub });
    await Promise.resolve();

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
    fanout.init({ pub, sub });

    handlers.get('error')(new Error('subscriber disconnected before acknowledgement'));
    resolveSubscription(1);
    await Promise.resolve();
    await Promise.resolve();

    await expect(fanout.publishBroadcastConfirmed(
      'admin:daily-ops',
      'admin:daily-ops',
      {},
      null,
    )).rejects.toMatchObject({ code: 'WS_FANOUT_SUBSCRIPTION_NOT_READY' });
    expect(pub.publish).not.toHaveBeenCalled();
    await fanout.close();
  });
});
