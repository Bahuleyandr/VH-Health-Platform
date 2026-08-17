import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const queryRawMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn({
  $queryRawUnsafe: queryRawMock,
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordOutboxOperatorRedrive: jest.fn(),
  recordNotificationOutboxAutoReplay: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: jest.fn() },
}));
jest.unstable_mockModule('../../services/notification/notificationDeliveryLedgerService.js', () => ({
  recordProviderReceiptTx: jest.fn(),
  applyProviderReceiptToCursorTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { replayNotificationOutboxRow } = await import(
  '../../services/notification/notificationOutboxAdminService.js'
);

function failedRow(overrides = {}) {
  return {
    id: 41,
    type: 'result_ready',
    channel: 'push',
    status: 'FAILED',
    recipient_id: '42',
    recipient_phone: null,
    title: 'Result ready',
    body: 'body',
    payload: { __delivery_channels: ['email'] },
    source_event_key: 'result:41',
    template_version: 'result.v1',
    retry_count: 3,
    created_at: new Date('2026-08-17T05:00:00.000Z'),
    failure_reason: 'provider_rejected_notification',
    replay_generation: 0,
    ...overrides,
  };
}

async function replay() {
  return replayNotificationOutboxRow({
    tenantId: TENANT,
    id: 41,
    reason: 'Provider repaired; retry rejected channels.',
    actorUid: ACTOR,
    actorRole: 'SUPER_ADMIN',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  queryRawMock.mockReset();
});

describe('FAILED notification outbox replay channels', () => {
  test('resets actual rejected fanout channels but excludes the acknowledged primary channel', async () => {
    queryRawMock
      .mockResolvedValueOnce([failedRow()])
      .mockResolvedValueOnce([
        { channel: 'email', outcome: 'rejected' },
        { channel: 'push', outcome: 'acknowledged' },
        { channel: 'whatsapp', outcome: 'rejected' },
      ])
      .mockResolvedValueOnce([
        { channel: 'email', state: 'paused_rejected' },
        { channel: 'whatsapp', state: 'paused_rejected' },
      ])
      .mockResolvedValueOnce([{ channel: 'email' }, { channel: 'whatsapp' }])
      .mockResolvedValueOnce([{
        id: 41,
        status: 'FAILED',
        retry_count: 0,
        failure_reason: 'operator_replay_requested',
      }])
      .mockResolvedValueOnce([]);

    const result = await replay();

    expect(result).toMatchObject({ mode: 'retry_reset', replacement_id: null });
    expect(queryRawMock.mock.calls[1][0]).toMatch(
      /ORDER BY \(outcome = 'acknowledged'\) DESC/,
    );
    expect(queryRawMock.mock.calls[1][0]).toMatch(
      /attempt_id = attempt\.attempt_id OR outcome = 'acknowledged'/,
    );
    const cursorReset = queryRawMock.mock.calls[3];
    expect(cursorReset[0]).toMatch(/channel = ANY\(\$2::text\[\]\)/);
    expect(cursorReset.slice(1)).toEqual([TENANT, ['email', 'whatsapp'], 41]);
    const audit = JSON.parse(queryRawMock.mock.calls[5][5]);
    expect(audit).toMatchObject({
      replay_channels: ['email', 'whatsapp'],
      resumed_channels: ['email', 'whatsapp'],
    });
    expect(audit.replay_channels).not.toContain('push');
  });

  test('preserves legitimate same-channel FAILED replay', async () => {
    queryRawMock
      .mockResolvedValueOnce([failedRow({ payload: {} })])
      .mockResolvedValueOnce([{ channel: 'push', outcome: 'rejected' }])
      .mockResolvedValueOnce([{ channel: 'push', state: 'paused_rejected' }])
      .mockResolvedValueOnce([{ channel: 'push' }])
      .mockResolvedValueOnce([{
        id: 41,
        status: 'FAILED',
        retry_count: 0,
        failure_reason: 'operator_replay_requested',
      }])
      .mockResolvedValueOnce([]);

    await expect(replay()).resolves.toMatchObject({ mode: 'retry_reset' });
    expect(queryRawMock.mock.calls[3].slice(1)).toEqual([TENANT, ['push'], 41]);
  });

  test('does not clear an ambiguous channel through the FAILED retry path', async () => {
    queryRawMock
      .mockResolvedValueOnce([failedRow()])
      .mockResolvedValueOnce([{ channel: 'email', outcome: 'uncertain' }])
      .mockResolvedValueOnce([{ channel: 'email', state: 'paused_uncertain' }]);

    await expect(replay()).rejects.toMatchObject({
      code: 'NOTIFICATION_OUTBOX_REPLAY_CHANNEL_AMBIGUOUS',
      statusCode: 409,
    });
    expect(queryRawMock).toHaveBeenCalledTimes(3);
  });
});
