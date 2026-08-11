import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECEIPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const queryRawMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn({ $queryRawUnsafe: queryRawMock }));
const recordReceiptMock = jest.fn();
const applyReceiptMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordOutboxOperatorRedrive: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: jest.fn() },
}));
jest.unstable_mockModule('../../services/notification/notificationDeliveryLedgerService.js', () => ({
  recordProviderReceiptTx: recordReceiptMock,
  applyProviderReceiptToCursorTx: applyReceiptMock,
}));

const { reconcileNotificationOutboxAttempt } = await import(
  '../../services/notification/notificationOutboxAdminService.js'
);

beforeEach(() => {
  jest.clearAllMocks();
  queryRawMock
    .mockResolvedValueOnce([{ id: 41, status: 'RECONCILIATION_REQUIRED' }])
    .mockResolvedValueOnce([{
      attempt_id: ATTEMPT,
      channel: 'push',
      provider: 'firebase_fcm',
      receipt_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      outcome: 'uncertain',
      provider_code: 'fcm_no_acceptance_unresolved',
    }])
    .mockResolvedValueOnce([{ id: 41, status: 'SENT', sent_at: new Date(), failure_reason: null }])
    .mockResolvedValueOnce([]);
  recordReceiptMock.mockResolvedValue({
    receipt_id: RECEIPT,
    observed_at: '2026-08-11T10:00:00.000Z',
    outcome: 'acknowledged',
  });
  applyReceiptMock.mockResolvedValue({ channel: 'push', state: 'ready' });
});

describe('notification outbox operator reconciliation', () => {
  test('appends acceptance evidence, advances the exact cursor, and audits the actor', async () => {
    const result = await reconcileNotificationOutboxAttempt({
      tenantId: TENANT,
      id: 41,
      attemptId: ATTEMPT,
      providerReference: 'projects/vh/messages/41',
      evidence: { provider_export_sha256: 'abc123' },
      reason: 'Acceptance verified in provider export',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'request-41',
    });

    expect(recordReceiptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: TENANT,
      attemptId: ATTEMPT,
      outboxId: 41,
      channel: 'push',
      outcome: 'acknowledged',
      receiptSource: 'operator_reconciliation',
      providerReference: 'projects/vh/messages/41',
      providerCode: 'operator_verified_acceptance',
      evidence: { provider_export_sha256: 'abc123' },
      ownerActorUid: ACTOR,
      ownerReason: 'Acceptance verified in provider export',
    }));
    expect(applyReceiptMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      receiptId: RECEIPT,
    });
    expect(queryRawMock.mock.calls[3][0]).toMatch(/NOTIFICATION_OUTBOX_PROVIDER_ACCEPTANCE_RECORDED/);
    expect(queryRawMock.mock.calls[3][5]).toContain('request-41');
    expect(result.fully_reconciled).toBe(true);
    expect(result.row.status).toBe('SENT');
  });

  test('does not write a terminal state or audit row when receipt append fails', async () => {
    recordReceiptMock.mockRejectedValueOnce(new Error('receipt insert failed'));

    await expect(reconcileNotificationOutboxAttempt({
      tenantId: TENANT,
      id: 41,
      attemptId: ATTEMPT,
      providerReference: 'projects/vh/messages/41',
      evidence: { provider_export_sha256: 'abc123' },
      reason: 'Acceptance verified in provider export',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
    })).rejects.toThrow('receipt insert failed');

    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(applyReceiptMock).not.toHaveBeenCalled();
  });
});
