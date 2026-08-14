import crypto from 'node:crypto';
import { jest } from '@jest/globals';

const executeRaw = jest.fn();
const redisSet = jest.fn();
const getRedisClient = jest.fn();
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $executeRawUnsafe: executeRaw },
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  getRedisClient,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: logger }));

const {
  assertSharedReplayOnce,
  verifySignedRequest,
  __testing__,
} = await import('../../utils/signedRequest.js');

function sign({ secret, timestamp, requestId, payload }) {
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${JSON.stringify(payload || {})}`)
    .digest('hex');
}

describe('durable signed-request replay authority', () => {
  beforeEach(() => {
    executeRaw.mockReset().mockResolvedValue(1);
    redisSet.mockReset().mockResolvedValue('OK');
    getRedisClient.mockReset().mockReturnValue({ set: redisSet });
    __testing__.replayCache.clear();
    jest.spyOn(Math, 'random').mockReturnValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes the durable DB claim before adding the Redis cache marker', async () => {
    const now = 2_000_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await assertSharedReplayOnce({
      replayNamespace: 'durable-test',
      requestId: 'request-1',
      timestamp: now,
      signature: 'ab'.repeat(32),
    });

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(redisSet.mock.invocationCallOrder[0]);
  });

  it('rejects when the durable DB authority is unavailable even if Redis is healthy', async () => {
    executeRaw.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(assertSharedReplayOnce({
      replayNamespace: 'durable-test',
      requestId: 'request-2',
      timestamp: Date.now(),
      signature: 'cd'.repeat(32),
    })).rejects.toMatchObject({ code: 'SIGNED_REQUEST_REPLAY_STORE_UNAVAILABLE' });

    expect(redisSet).not.toHaveBeenCalled();
  });

  it('keeps the durable claim authoritative when the Redis marker rejects asynchronously', async () => {
    redisSet.mockRejectedValueOnce(new Error('NOREPLICAS'));

    await expect(assertSharedReplayOnce({
      replayNamespace: 'durable-test',
      requestId: 'request-3',
      timestamp: Date.now(),
      signature: 'ef'.repeat(32),
    })).resolves.toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      'Shared replay cache marker failed after durable DB claim',
      expect.objectContaining({ namespace: 'durable-test', message: 'NOREPLICAS' }),
    );
  });

  it('covers the full remaining horizon for a near-future accepted timestamp', async () => {
    const now = 2_000_000_000_000;
    const toleranceMs = 5 * 60 * 1000;
    const futureTimestamp = now + toleranceMs - 1000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await assertSharedReplayOnce({
      replayNamespace: 'durable-test',
      requestId: 'future-request',
      timestamp: futureTimestamp,
      signature: '12'.repeat(32),
      toleranceMs,
    });

    expect(executeRaw.mock.calls[0][3]).toBe('599');
    expect(redisSet).toHaveBeenCalledWith(
      expect.stringContaining('future-request'),
      '1',
      'EX',
      599,
      'NX',
    );

    executeRaw.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    jest.spyOn(Date, 'now').mockReturnValue(now + toleranceMs + 1);
    await expect(assertSharedReplayOnce({
      replayNamespace: 'durable-test',
      requestId: 'future-request',
      timestamp: futureTimestamp,
      signature: '12'.repeat(32),
      toleranceMs,
    })).rejects.toMatchObject({ code: 'SIGNED_REQUEST_REPLAY' });
  });

  it('keeps the local fast-path claim through the future-skew acceptance horizon', () => {
    const now = 2_000_000_000_000;
    const toleranceMs = 5 * 60 * 1000;
    const timestamp = now + toleranceMs - 1000;
    const secret = 'future-skew-test-secret';
    const requestId = 'future-local-request';
    const payload = { ok: true };
    const signature = sign({ secret, timestamp, requestId, payload });
    jest.spyOn(Date, 'now').mockReturnValue(now);

    verifySignedRequest({ secret, signature, timestamp, requestId, payload, toleranceMs });
    jest.spyOn(Date, 'now').mockReturnValue(now + toleranceMs + 1);

    expect(() => verifySignedRequest({
      secret,
      signature,
      timestamp,
      requestId,
      payload,
      toleranceMs,
    })).toThrow(/replay/);
  });
});
