import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({ setTenantTx: setTenantTxMock }));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: value => String(value).toLowerCase(),
}));

const {
  applyProviderReceiptToCursor,
  providerForChannel,
  recordProviderReceipt,
  resetChannelCursor,
} = await import('../../services/notification/notificationDeliveryLedgerService.js');

const TENANT_ID = '8dfe8b20-0846-43a5-bc50-252393197221';
const ATTEMPT_ID = 'bb9df2f4-4032-441d-afc4-5319ee696ea4';
const RECEIPT_ID = '7ff89b43-9fdc-46f5-901f-6b16c275fb26';

describe('notification delivery ledger state separation', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    setTenantTxMock.mockReset();
    setTenantTxMock.mockImplementation((_tenantId, fn) => fn({
      $queryRawUnsafe: queryRawUnsafeMock,
      $executeRawUnsafe: executeRawUnsafeMock,
    }));
  });

  it('records provider evidence without mutating the cursor or send permission', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      receipt_id: RECEIPT_ID,
      tenant_id: TENANT_ID,
      attempt_id: ATTEMPT_ID,
      notification_outbox_id: 41,
      channel: 'push',
      outcome: 'uncertain',
      receipt_source: 'transport_failure',
      provider_reference: null,
      provider_code: 'ECONNRESET',
      evidence: { phase: 'response_wait' },
    }]);

    const receipt = await recordProviderReceipt({
      tenantId: TENANT_ID,
      attemptId: ATTEMPT_ID,
      outboxId: 41,
      channel: 'push',
      outcome: 'uncertain',
      receiptSource: 'transport_failure',
      providerCode: 'ECONNRESET',
      evidence: { phase: 'response_wait' },
    });

    expect(receipt.receipt_id).toBe(RECEIPT_ID);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/INSERT INTO notification_provider_receipts/);
    expect(queryRawUnsafeMock.mock.calls[0][0]).not.toMatch(/notification_delivery_cursors/);
    expect(queryRawUnsafeMock.mock.calls[0][0]).not.toMatch(/UPDATE notification_outbox/);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('requires a provider reference for positive acceptance', async () => {
    await expect(recordProviderReceipt({
      tenantId: TENANT_ID,
      attemptId: ATTEMPT_ID,
      outboxId: 41,
      channel: 'push',
      outcome: 'acknowledged',
      receiptSource: 'provider_response',
    })).rejects.toMatchObject({ code: 'NOTIFICATION_DELIVERY_INPUT_INVALID' });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('applies uncertain evidence only in the separate cursor operation and pauses it', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        receipt_id: RECEIPT_ID,
        notification_outbox_id: 41,
        channel: 'email',
        outcome: 'uncertain',
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'email',
        last_contiguous_outbox_id: 40,
        state: 'delivering',
        blocked_outbox_id: 41,
        inflight_outbox_id: 41,
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'email',
        last_contiguous_outbox_id: 40,
        state: 'paused_uncertain',
        blocked_outbox_id: 41,
        inflight_outbox_id: null,
      }]);
    executeRawUnsafeMock.mockResolvedValueOnce(0);

    const cursor = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: RECEIPT_ID,
    });

    expect(cursor).toMatchObject({
      state: 'paused_uncertain',
      last_contiguous_outbox_id: 40,
      blocked_outbox_id: 41,
    });
    expect(queryRawUnsafeMock.mock.calls.at(-1)[0]).toMatch(/state = \$3::text/);
    expect(queryRawUnsafeMock.mock.calls.at(-1)[3]).toBe('paused_uncertain');
  });

  it('resumes (never pauses) the cursor on a TERMINAL per-recipient rejection (R3)', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        receipt_id: RECEIPT_ID,
        notification_outbox_id: 41,
        channel: 'push',
        outcome: 'rejected',
        provider_code: 'fcm_token_missing',
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'push',
        last_contiguous_outbox_id: 40,
        state: 'delivering',
        blocked_outbox_id: 41,
        inflight_outbox_id: 41,
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'push',
        last_contiguous_outbox_id: 40,
        state: 'ready',
        blocked_outbox_id: null,
        inflight_outbox_id: null,
      }]);
    executeRawUnsafeMock.mockResolvedValueOnce(0);

    const cursor = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: RECEIPT_ID,
    });

    expect(cursor).toMatchObject({
      state: 'ready',
      blocked_outbox_id: null,
      skipped_outbox_id: 41,
      terminal_rejection_code: 'fcm_token_missing',
    });
    // last_contiguous is untouched: the mig-609 trigger reserves it for
    // acknowledged rows; the resume UPDATE only clears the block.
    const updateSql = queryRawUnsafeMock.mock.calls.at(-1)[0];
    expect(updateSql).toMatch(/SET state = 'ready'/);
    expect(updateSql).not.toMatch(/last_contiguous_outbox_id =/);
  });

  it('still pauses on a non-terminal (channel-level) rejection', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        receipt_id: RECEIPT_ID,
        notification_outbox_id: 41,
        channel: 'sms',
        outcome: 'rejected',
        provider_code: 'sms_gateway_not_configured',
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'sms',
        last_contiguous_outbox_id: null,
        state: 'delivering',
        blocked_outbox_id: 41,
        inflight_outbox_id: 41,
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'sms',
        last_contiguous_outbox_id: null,
        state: 'paused_rejected',
        blocked_outbox_id: 41,
        inflight_outbox_id: null,
      }]);
    executeRawUnsafeMock.mockResolvedValueOnce(0);

    const cursor = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: RECEIPT_ID,
    });

    expect(cursor).toMatchObject({ state: 'paused_rejected', blocked_outbox_id: 41 });
    expect(queryRawUnsafeMock.mock.calls.at(-1)[3]).toBe('paused_rejected');
  });

  it('maps each physical channel to its factual provider ledger name', () => {
    expect(providerForChannel('push')).toBe('firebase_fcm');
    expect(providerForChannel('email')).toBe('smtp');
    expect(providerForChannel('whatsapp')).toBe('twilio_whatsapp');
    expect(providerForChannel('voice')).toBe('twilio_voice');
    expect(providerForChannel('inapp')).toBe('local_database');
  });

  it('refuses to report a cursor reset while its head-of-line outbox row is unresolved', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'push',
        last_contiguous_outbox_id: 40,
        state: 'paused_uncertain',
        blocked_outbox_id: 41,
        inflight_outbox_id: null,
      }])
      .mockResolvedValueOnce([{
        id: 41,
        status: 'RECONCILIATION_REQUIRED',
        failure_reason: 'provider_delivery_outcome_uncertain',
        ledger_resolved: false,
      }]);

    await expect(resetChannelCursor({
      tenantId: TENANT_ID,
      channel: 'push',
      reason: 'Provider outage was investigated',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRole: 'SUPER_ADMIN',
    })).rejects.toMatchObject({ code: 'NOTIFICATION_DELIVERY_HEAD_UNRESOLVED' });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(/notification_provider_receipts/);
    expect(queryRawUnsafeMock.mock.calls.some(([sql]) => /UPDATE notification_delivery_cursors/.test(sql))).toBe(false);
  });

  it('resets a paused cursor only after its blocked head is factually resolved', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'push',
        last_contiguous_outbox_id: 40,
        state: 'paused_rejected',
        blocked_outbox_id: 41,
        inflight_outbox_id: null,
      }])
      .mockResolvedValueOnce([{
        id: 41,
        status: 'FAILED',
        failure_reason: 'fcm_token_missing',
        ledger_resolved: true,
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        channel: 'push',
        last_contiguous_outbox_id: 40,
        state: 'ready',
        blocked_outbox_id: null,
        inflight_outbox_id: null,
      }])
      .mockResolvedValueOnce([]);

    await expect(resetChannelCursor({
      tenantId: TENANT_ID,
      channel: 'push',
      reason: 'Terminal rejection was verified',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRole: 'SUPER_ADMIN',
    })).resolves.toMatchObject({ state: 'ready', blocked_outbox_id: null });

    expect(queryRawUnsafeMock.mock.calls[2][0]).toMatch(/UPDATE notification_delivery_cursors/);
    expect(queryRawUnsafeMock.mock.calls[3][0]).toMatch(/NOTIFICATION_CHANNEL_CURSOR_RESET/);
  });
});
