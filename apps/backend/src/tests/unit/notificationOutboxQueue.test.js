// C3: notification_outbox.recipient_id is TEXT and must transport both an
// integer users.id and a uuid users.uid. queue() previously coerced the value
// through Number() + a $2::int cast, silently NULLing uuid recipients. These
// tests pin the repaired contract: non-blank identifiers bind verbatim as
// text, numeric ids keep their exact decimal form, and blank / unsupported
// values normalize to NULL.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: loggerMock,
}));

const { notificationOutbox } = await import(
  '../../utils/notifications/notificationOutbox.js'
);

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

async function queueAndCaptureBinding(recipientId) {
  const queued = await notificationOutbox.queue({
    type: 'push',
    recipientId,
    title: 'C3 transport',
    body: 'recipient binding probe',
    data: { kind: 'c3' },
  });
  expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  const [sql, , boundRecipient] = queryRawUnsafeMock.mock.calls[0];
  return { queued, sql, boundRecipient };
}

describe('notificationOutbox.queue recipient_id text transport', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([{ id: 7, status: 'PENDING' }]);
    loggerMock.warn.mockReset();
  });

  it('binds recipient_id as text — never through an int cast', async () => {
    const { sql } = await queueAndCaptureBinding(42);
    expect(sql).toMatch(/\$2::text/);
    expect(sql).not.toMatch(/\$2::int/);
  });

  it('preserves a numeric users.id as its exact decimal text', async () => {
    const { boundRecipient } = await queueAndCaptureBinding(42);
    expect(boundRecipient).toBe('42');
  });

  it('preserves a uuid users.uid string verbatim', async () => {
    const { boundRecipient } = await queueAndCaptureBinding(UUID);
    expect(boundRecipient).toBe(UUID);
  });

  it('trims surrounding whitespace from string identifiers', async () => {
    const { boundRecipient } = await queueAndCaptureBinding('  42  ');
    expect(boundRecipient).toBe('42');
  });

  it('preserves a bigint id as decimal text', async () => {
    const { boundRecipient } = await queueAndCaptureBinding(42n);
    expect(boundRecipient).toBe('42');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
  ])('normalizes %s to NULL (phone-only rows stay valid)', async (_label, value) => {
    const { boundRecipient } = await queueAndCaptureBinding(value);
    expect(boundRecipient).toBeNull();
  });

  it.each([
    ['a non-integer number', 42.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a boolean', true],
    ['an object', { id: 42 }],
    ['an array', [42]],
  ])('normalizes %s to NULL instead of coercing it', async (_label, value) => {
    const { boundRecipient } = await queueAndCaptureBinding(value);
    expect(boundRecipient).toBeNull();
  });

  it('returns the inserted row on success', async () => {
    const { queued } = await queueAndCaptureBinding(UUID);
    expect(queued).toEqual({ id: 7, status: 'PENDING' });
  });

  it('returns null and warns when the insert fails', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('db down'));
    const queued = await notificationOutbox.queue({
      type: 'push',
      recipientId: UUID,
      title: 'C3 transport',
      body: 'failure path',
    });
    expect(queued).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('uses a supplied transaction client for an atomic producer', async () => {
    const txQuery = jest.fn().mockResolvedValue([{ id: 8, status: 'PENDING' }]);
    const queued = await notificationOutbox.queue({
      type: 'push',
      recipientId: UUID,
      title: 'Atomic producer',
      body: 'transaction-bound',
    }, {
      tx: { $queryRawUnsafe: txQuery },
      strict: true,
    });

    expect(queued).toEqual({ id: 8, status: 'PENDING' });
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rethrows database guard failures in strict mode', async () => {
    const guarded = Object.assign(new Error('late recovery notification blocked'), {
      code: '23514',
      constraint: 'chk_external_recovery_late_effect_guard',
    });
    queryRawUnsafeMock.mockRejectedValueOnce(guarded);

    await expect(notificationOutbox.queue({
      type: 'push',
      recipientId: UUID,
      title: 'Must remain pending-only',
      body: 'blocked',
    }, { strict: true })).rejects.toBe(guarded);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
