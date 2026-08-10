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
  it('observes an asynchronous user-publish rejection instead of leaking it as unhandled', async () => {
    const publishError = new Error('redis publish failed');
    const pub = { publish: jest.fn().mockRejectedValue(publishError) };
    const sub = {
      on: jest.fn(),
      off: jest.fn(),
      psubscribe: jest.fn().mockResolvedValue(1),
      punsubscribe: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue(undefined),
    };
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
});
