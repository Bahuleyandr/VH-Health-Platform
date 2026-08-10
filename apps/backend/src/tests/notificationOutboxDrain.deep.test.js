import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '00000000-0000-4000-8000-000000000099';
const claimPendingBatchMock = jest.fn();
const markSentMock = jest.fn();
const markFailedMock = jest.fn();
const markTerminalFailedMock = jest.fn();
const markReconciliationRequiredMock = jest.fn();
const releaseClaimMock = jest.fn();
const deliverMock = jest.fn();
const reconcileExpiredClaimsMock = jest.fn();

jest.unstable_mockModule('../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: {
    claimPendingBatch: claimPendingBatchMock,
    markSent: markSentMock,
    markFailed: markFailedMock,
    markTerminalFailed: markTerminalFailedMock,
    markReconciliationRequired: markReconciliationRequiredMock,
    releaseClaim: releaseClaimMock,
  },
}));
jest.unstable_mockModule('../utils/notifications/notificationOutboxDelivery.js', () => ({
  deliverNotificationOutboxRow: deliverMock,
}));
jest.unstable_mockModule('../services/notification/notificationDeliveryLedgerService.js', () => ({
  reconcileExpiredClaims: reconcileExpiredClaimsMock,
}));

const { drainNotificationOutbox } = await import('../utils/scheduler.js');

function claim(id = 41) {
  return {
    id,
    tenant_id: TENANT_ID,
    claim_token: CLAIM_TOKEN,
    claim_generation: 2,
    channel: 'push',
    rendered_intent_hash: 'a'.repeat(64),
  };
}

describe('notification outbox drain claim/receipt finalization', () => {
  beforeEach(() => {
    claimPendingBatchMock.mockReset();
    markSentMock.mockReset();
    markFailedMock.mockReset();
    markTerminalFailedMock.mockReset();
    markReconciliationRequiredMock.mockReset();
    releaseClaimMock.mockReset();
    deliverMock.mockReset();
    reconcileExpiredClaimsMock.mockReset();
    reconcileExpiredClaimsMock.mockResolvedValue({ expired: 0, reset: 0, reconciled: 0 });
    claimPendingBatchMock.mockResolvedValue([claim()]);
    markSentMock.mockResolvedValue({ status: 'SENT' });
    markFailedMock.mockResolvedValue({ status: 'FAILED' });
    markTerminalFailedMock.mockResolvedValue({ status: 'FAILED', retry_count: 3 });
    markReconciliationRequiredMock.mockResolvedValue({ status: 'RECONCILIATION_REQUIRED' });
    releaseClaimMock.mockResolvedValue({ status: 'PENDING' });
  });

  test('requires an explicit tenant instead of a cross-tenant scheduler scan', async () => {
    await expect(drainNotificationOutbox({ limit: 5 }))
      .rejects.toThrow('requires tenantId');
    expect(claimPendingBatchMock).not.toHaveBeenCalled();
  });

  test('marks sent only after the delivery path returns acknowledged receipts', async () => {
    deliverMock.mockResolvedValue({ outcome: 'acknowledged' });
    const result = await drainNotificationOutbox({ tenantId: TENANT_ID, limit: 5 });
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, uncertain: 0 });
    expect(reconcileExpiredClaimsMock).toHaveBeenCalledWith({ tenantId: TENANT_ID, limit: 5 });
    expect(claimPendingBatchMock).toHaveBeenCalledWith({ tenantId: TENANT_ID, limit: 5 });
    expect(markSentMock).toHaveBeenCalledWith(41, {
      tenantId: TENANT_ID,
      claimToken: CLAIM_TOKEN,
      claimGeneration: 2,
    });
  });

  test('keeps rejected, uncertain, and cursor-blocked outcomes distinct', async () => {
    claimPendingBatchMock.mockResolvedValue([claim(51), claim(52), claim(53)]);
    deliverMock
      .mockResolvedValueOnce({ outcome: 'rejected' })
      .mockResolvedValueOnce({ outcome: 'uncertain' })
      .mockResolvedValueOnce({ outcome: 'deferred' });
    const result = await drainNotificationOutbox({ tenantId: TENANT_ID, limit: 5 });
    expect(result).toMatchObject({
      claimed: 3, sent: 0, failed: 1, uncertain: 1, deferred: 1,
    });
    expect(markFailedMock).toHaveBeenCalledWith(
      51,
      'provider_rejected_notification',
      expect.objectContaining({ claimToken: CLAIM_TOKEN }),
    );
    expect(markReconciliationRequiredMock).toHaveBeenCalledWith(
      52,
      'provider_delivery_outcome_uncertain',
      expect.objectContaining({ claimToken: CLAIM_TOKEN }),
    );
    expect(releaseClaimMock).toHaveBeenCalledWith(
      53,
      'tenant_channel_cursor_blocked',
      expect.objectContaining({ claimToken: CLAIM_TOKEN }),
    );
  });

  test('leaves a claim leased when execution fails after an attempt may have started', async () => {
    deliverMock.mockRejectedValue(new Error('worker exited after provider call'));
    const result = await drainNotificationOutbox({ tenantId: TENANT_ID, limit: 5 });
    expect(result).toMatchObject({ claimed: 1, uncertain: 1 });
    expect(markSentMock).not.toHaveBeenCalled();
    expect(markFailedMock).not.toHaveBeenCalled();
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled();
    expect(releaseClaimMock).not.toHaveBeenCalled();
  });

  test('dead-letters a terminal provider rejection without retrying it three times', async () => {
    deliverMock.mockResolvedValue({ outcome: 'rejected', terminal: true });

    const result = await drainNotificationOutbox({ tenantId: TENANT_ID, limit: 5 });

    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    expect(markTerminalFailedMock).toHaveBeenCalledWith(
      41,
      'provider_terminal_rejection',
      expect.objectContaining({ claimToken: CLAIM_TOKEN }),
    );
    expect(markFailedMock).not.toHaveBeenCalled();
  });
});
