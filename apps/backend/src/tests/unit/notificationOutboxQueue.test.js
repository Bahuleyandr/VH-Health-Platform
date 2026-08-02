import { createHash } from 'node:crypto';

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn();
const getCurrentTenantIdMock = jest.fn();
const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  getCurrentTenantId: getCurrentTenantIdMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const {
  canonicalRenderedIntentBytes,
  notificationOutbox,
  renderedIntentHash,
  __testing__,
} = await import('../../utils/notifications/notificationOutbox.js');

const TENANT_ID = '8dfe8b20-0846-43a5-bc50-252393197221';
const RECIPIENT_UID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const INSERTED = Object.freeze({
  id: 7,
  status: 'PENDING',
  tenant_id: TENANT_ID,
  channel: 'push',
  source_event_key: 'event:7',
  recipient_key: `id:${RECIPIENT_UID}`,
  template_version: 'result-ready.v2',
  rendered_intent_hash: 'a'.repeat(64),
  duplicate: false,
});

function notification(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    type: 'push',
    channel: 'push',
    sourceEventKey: 'event:7',
    templateVersion: 'result-ready.v2',
    recipientId: RECIPIENT_UID,
    title: 'Result ready',
    body: 'A result is ready in your record.',
    data: { result_id: 9, nested: { z: 2, a: 1 } },
    ...overrides,
  };
}

describe('notificationOutbox durable intent identity', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    setTenantTxMock.mockReset();
    getCurrentTenantIdMock.mockReset();
    getCurrentTenantIdMock.mockReturnValue(null);
    loggerMock.warn.mockReset();
    setTenantTxMock.mockImplementation(async (tenantId, fn) => {
      expect(tenantId).toBe(TENANT_ID);
      return fn({ $queryRawUnsafe: queryRawUnsafeMock });
    });
    queryRawUnsafeMock.mockResolvedValue([INSERTED]);
  });

  it('hashes the canonical rendered bytes byte-for-byte independent of object key order', () => {
    const left = {
      type: 'push',
      payload: { z: 2, nested: { beta: true, alpha: 'x' } },
      title: 'Exact bytes',
    };
    const right = {
      title: 'Exact bytes',
      payload: { nested: { alpha: 'x', beta: true }, z: 2 },
      type: 'push',
    };
    const expectedBytes = Buffer.from(
      '{"payload":{"nested":{"alpha":"x","beta":true},"z":2},"title":"Exact bytes","type":"push"}',
      'utf8',
    );
    expect(canonicalRenderedIntentBytes(left)).toEqual(expectedBytes);
    expect(canonicalRenderedIntentBytes(right)).toEqual(expectedBytes);
    expect(renderedIntentHash(left)).toBe(
      createHash('sha256').update(expectedBytes).digest('hex'),
    );
    expect(renderedIntentHash(right)).toBe(renderedIntentHash(left));
  });

  it('inserts tenant, source, recipient, channel, template, and rendered hash explicitly', async () => {
    const queued = await notificationOutbox.queue(notification(), { strict: true });
    expect(queued).toEqual(INSERTED);
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, tenantId, type, recipientId, , title, body, payload, channel,
      sourceKey, recipientKey, version, hash] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT ON CONSTRAINT ux_notification_outbox_delivery_intent DO NOTHING/);
    expect(tenantId).toBe(TENANT_ID);
    expect(type).toBe('push');
    expect(recipientId).toBe(RECIPIENT_UID);
    expect(title).toBe('Result ready');
    expect(body).toBe('A result is ready in your record.');
    expect(JSON.parse(payload)).toEqual(notification().data);
    expect(channel).toBe('push');
    expect(sourceKey).toBe('event:7');
    expect(recipientKey).toBe(`id:${RECIPIENT_UID}`);
    expect(version).toBe('result-ready.v2');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves integer, uuid, bigint, and blank recipient identifiers as text or null', () => {
    expect(__testing__.buildIntent(notification({ recipientId: 42 })).recipientId).toBe('42');
    expect(__testing__.buildIntent(notification({ recipientId: RECIPIENT_UID })).recipientId)
      .toBe(RECIPIENT_UID);
    expect(__testing__.buildIntent(notification({ recipientId: 42n })).recipientId).toBe('42');
    expect(__testing__.buildIntent(notification({ recipientId: '   ' })).recipientId).toBeNull();
    expect(__testing__.buildIntent(notification({ recipientId: 42.5 })).recipientId).toBeNull();
  });

  it('uses a transaction only when its tenant GUC exactly matches the intent', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ tenant_id: TENANT_ID }])
      .mockResolvedValueOnce([{ ...INSERTED, id: 8 }]);
    const queued = await notificationOutbox.queue(notification(), {
      tx: { $queryRawUnsafe: txQuery },
      strict: true,
    });
    expect(queued.id).toBe(8);
    expect(txQuery).toHaveBeenCalledTimes(2);
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('fails closed when an atomic producer carries the wrong tenant context', async () => {
    const txQuery = jest.fn().mockResolvedValue([{ tenant_id: RECIPIENT_UID }]);
    await expect(notificationOutbox.queue(notification(), {
      tx: { $queryRawUnsafe: txQuery },
      strict: true,
    })).rejects.toThrow('transaction tenant does not match');
  });

  it('returns null and warns in compatibility mode when tenant provenance is absent', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);
    const queued = await notificationOutbox.queue(notification({
      tenantId: null,
      recipientId: null,
      recipientPhone: null,
    }));
    expect(queued).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Notification outbox queue failed:',
      'Notification outbox requires one explicit tenant',
    );
  });

  it('rethrows the 603 late-notification guard in strict mode', async () => {
    const guarded = Object.assign(new Error('late recovery notification blocked'), {
      code: '23514', constraint: 'chk_external_recovery_late_effect_guard',
    });
    queryRawUnsafeMock.mockRejectedValueOnce(guarded);
    await expect(notificationOutbox.queue(notification(), { strict: true })).rejects.toBe(guarded);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
