import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '33333333-3333-4333-8333-333333333333';
const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const notificationOutboxQueueMock = jest.fn();
const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
const prismaDouble = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaDouble,
  setTenant: async (_tenantId, fn) => fn(prismaDouble),
  setTenantTx: async (_tenantId, fn) => fn(prismaDouble),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  getCurrentTenantId: () => TENANT_ID,
  runInTenantContext: async (_tenantId, fn) => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queueAppointmentReminderSms: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: notificationOutboxQueueMock },
  default: { queue: notificationOutboxQueueMock },
}));
jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: jest.fn(),
}));

const { processPendingScheduledNotifications } = await import(
  '../../utils/notifications/appointmentReminderJob.js'
);

const dueNotification = {
  id: 41n,
  user_id: 77,
  type: 'feedback_request',
  data: { appointment_id: '501', survey: 'nps' },
  send_at: new Date('2030-01-01T04:00:00Z'),
  status: 'pending',
};

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockResolvedValue(1);
  notificationOutboxQueueMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  notificationOutboxQueueMock.mockResolvedValue({
    id: 901,
    status: 'PENDING',
    duplicate: false,
  });
});

describe('scheduled notification durable outbox handoff', () => {
  it('records a deterministic outbox intent and does not call or claim a provider', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dueNotification])
      // recordPatientFeedNotification resolves the recipient's identity
      // columns before writing the in-app row.
      .mockResolvedValueOnce([{ id: 77, uid: PATIENT_UID, phone: '+919876500077' }])
      .mockResolvedValueOnce([{ id: 41n, status: 'queued', sent_at: null }]);

    const result = await processPendingScheduledNotifications({ tenantId: TENANT_ID });

    expect(result).toMatchObject({ due: 1, queued: 1, retrying: 0, rejected: 0 });
    expect(notificationOutboxQueueMock).toHaveBeenCalledTimes(1);
    expect(notificationOutboxQueueMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      channel: 'push',
      recipientId: 77,
      sourceEventKey: 'scheduled-notification:41',
      templateVersion: 'push.feedback_request.v1',
      data: expect.objectContaining({
        appointment_id: '501',
        scheduled_notification_id: '41',
      }),
    }), { strict: true });
    const writes = queryRawUnsafeMock.mock.calls.map(([sql]) => String(sql));
    expect(writes.some(sql => sql.includes("SET status='sent'"))).toBe(false);
  });

  // The push this intent becomes is privacy-stripped to a generic "open the
  // app" that lands on /notifications, and `feedback_request` has no tenant
  // preference key so the drain's channels always resolve legacy ['push'] —
  // nothing else writes the readable copy. Without this row the patient is
  // buzzed into an empty inbox two hours after their visit.
  it('writes the in-app feed row the privacy-stripped push points at', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dueNotification])
      .mockResolvedValueOnce([{ id: 77, uid: PATIENT_UID, phone: '+919876500077' }])
      .mockResolvedValueOnce([]);

    await processPendingScheduledNotifications({ tenantId: TENANT_ID });

    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, ...params] = executeRawUnsafeMock.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO notifications');
    // tenant_id bound explicitly ($8), never left to the column DEFAULT — a
    // defaulted row lands on the literal default tenant and is invisible to
    // the recipient, whose inbox reader filters on tenant_id.
    expect(String(sql)).toContain('$8::uuid');
    expect(params[0]).toBe(PATIENT_UID);
    expect(params[1]).toBe(77);
    // A type the patient app's inbox tap handler actually routes.
    expect(params[5]).toBe('feedback_request');
    expect(params[7]).toBe(TENANT_ID);
  });

  it('does not write a feed row when the durable enqueue never happened', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dueNotification])
      .mockResolvedValueOnce([{ id: 41n, status: 'retrying' }])
      .mockResolvedValueOnce([]);
    notificationOutboxQueueMock.mockRejectedValue(new Error('database unavailable'));

    await processPendingScheduledNotifications({ tenantId: TENANT_ID });

    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('does not write a second feed row when the outbox reports a duplicate intent', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dueNotification])
      .mockResolvedValueOnce([]);
    notificationOutboxQueueMock.mockResolvedValue({
      id: 901, status: 'PENDING', duplicate: true,
    });

    await processPendingScheduledNotifications({ tenantId: TENANT_ID });

    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('leaves an explicit retry state when the durable enqueue fails', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dueNotification])
      .mockResolvedValueOnce([{ id: 41n, status: 'retrying' }])
      .mockResolvedValueOnce([]);
    notificationOutboxQueueMock.mockRejectedValue(new Error('database unavailable'));

    const result = await processPendingScheduledNotifications({ tenantId: TENANT_ID });

    expect(result).toMatchObject({ due: 1, queued: 0, retrying: 1 });
    const retryWrite = queryRawUnsafeMock.mock.calls.find(
      ([sql]) => String(sql).includes('SET status = $3::text'),
    );
    expect(retryWrite?.[3]).toBe('retrying');
  });

  it('recovers a crash after outbox commit without enqueueing a duplicate', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 41n, status: 'queued', sent_at: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await processPendingScheduledNotifications({ tenantId: TENANT_ID });

    expect(result).toMatchObject({ due: 0, queued: 0, reconciled: 1 });
    expect(notificationOutboxQueueMock).not.toHaveBeenCalled();
    const candidateSql = String(queryRawUnsafeMock.mock.calls[1][0]);
    expect(candidateSql).toContain('NOT EXISTS');
    expect(candidateSql).toContain("'scheduled-notification:' || scheduled.id::text");
  });

  it('derives sent, missing-recipient, rejection, retry, and crash states from receipts and leases', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    await processPendingScheduledNotifications({ tenantId: TENANT_ID });

    const reconciliationSql = String(queryRawUnsafeMock.mock.calls[0][0]);
    expect(reconciliationSql).toContain("receipt_outcome = 'acknowledged' THEN 'sent'");
    expect(reconciliationSql).toContain("THEN 'recipient_missing'");
    expect(reconciliationSql).toContain("outbox_status = 'FAILED' THEN 'retrying'");
    expect(reconciliationSql).toContain("outbox_status = 'CLAIMED' THEN 'delivering'");
    expect(reconciliationSql).toContain("outbox_status = 'RECONCILIATION_REQUIRED'");
    expect(reconciliationSql).toContain("THEN 'reconcile_required'");
    expect(reconciliationSql).toContain("outbox_status = 'FAILED' AND retry_count >= 3");
    expect(reconciliationSql).toContain("THEN 'rejected'");
    expect(reconciliationSql).toContain("WHEN classified.delivery_status = 'sent'");
  });
});
