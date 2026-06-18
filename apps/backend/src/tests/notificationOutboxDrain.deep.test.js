// src/tests/notificationOutboxDrain.deep.test.js
//
// Audit C-6: the notification outbox was written but never drained. This deep
// test proves the new drain (scheduler.drainNotificationOutbox) claims a
// PENDING row, delivers it via the (mocked) send path, and marks it SENT. A
// row whose send throws is marked FAILED with its retry_count bumped.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.
// The external send path (FCM / SMS) is mocked so no network egress happens.

import { jest } from '@jest/globals';

const sendPushMock = jest.fn();
const sendSmsMock = jest.fn();

jest.unstable_mockModule('../utils/notifications/sendPushNotification.js', () => ({
  __esModule: true,
  sendPushNotification: sendPushMock,
}));
// Mirror ALL named exports of the real smsService — the scheduler module graph
// (appointmentReminderJob etc.) imports the other two by name, so a partial
// mock would fail module linking.
jest.unstable_mockModule('../services/smsService.js', () => ({
  __esModule: true,
  sendSMS: sendSmsMock,
  sendAppointmentConfirmationSMS: jest.fn(),
  sendAppointmentReminderSMS: jest.fn(),
  default: { sendSMS: sendSmsMock },
}));

const { drainNotificationOutbox } = await import('../utils/scheduler.js');
const { notificationOutbox } = await import('../utils/notifications/notificationOutbox.js');
const prisma = (await import('../lib/prisma.js')).default;

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

async function statusOf(id) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT status, retry_count, failure_reason FROM notification_outbox WHERE id = $1',
    id,
  );
  return rows[0];
}

d('notification outbox drain (deep)', () => {
  const insertedIds = [];

  beforeAll(async () => {
    // Isolation: clear any stale queued rows left by prior runs / other suites so
    // the bounded drain batch (limit) deterministically reaches THIS suite's rows
    // rather than being crowded out by older PENDING/FAILED leftovers.
    await prisma.$executeRawUnsafe(
      `DELETE FROM notification_outbox WHERE status IN ('PENDING','FAILED')`,
    ).catch(() => {});
  });

  beforeEach(() => {
    sendPushMock.mockReset();
    sendSmsMock.mockReset();
  });

  afterAll(async () => {
    if (insertedIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM notification_outbox WHERE id = ANY($1::int[])`,
        insertedIds,
      ).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('marks a PENDING SMS row SENT after a successful drain', async () => {
    sendSmsMock.mockResolvedValue({ ok: true });

    const queued = await notificationOutbox.queue({
      type: 'sms',
      recipientPhone: '+919000000001',
      title: 'Test',
      body: 'Outbox drain SMS body',
      data: { kind: 'test' },
    });
    expect(queued?.id).toBeTruthy();
    insertedIds.push(queued.id);

    const result = await drainNotificationOutbox({ limit: 100 });
    expect(result.claimed).toBeGreaterThanOrEqual(1);

    const row = await statusOf(queued.id);
    expect(row.status).toBe('SENT');
    expect(sendSmsMock).toHaveBeenCalledWith('+919000000001', 'Outbox drain SMS body');
  });

  it('marks a PENDING push row SENT (WS-only delivery is still success)', async () => {
    sendPushMock.mockResolvedValue({ successCount: 0, failureCount: 0 });

    const queued = await notificationOutbox.queue({
      type: 'push',
      recipientId: 999999999, // no real device token → WS-only attempt, still SENT
      title: 'Push test',
      body: 'Outbox drain push body',
      data: { kind: 'test' },
    });
    expect(queued?.id).toBeTruthy();
    insertedIds.push(queued.id);

    await drainNotificationOutbox({ limit: 100 });

    const row = await statusOf(queued.id);
    expect(row.status).toBe('SENT');
    expect(sendPushMock).toHaveBeenCalledTimes(1);
  });

  it('marks a row FAILED and bumps retry_count when the send throws', async () => {
    sendSmsMock.mockRejectedValue(new Error('gateway down'));

    const queued = await notificationOutbox.queue({
      type: 'sms',
      recipientPhone: '+919000000002',
      title: 'Fail test',
      body: 'Outbox drain fail body',
      data: {},
    });
    expect(queued?.id).toBeTruthy();
    insertedIds.push(queued.id);

    await drainNotificationOutbox({ limit: 100 });

    const row = await statusOf(queued.id);
    expect(row.status).toBe('FAILED');
    expect(Number(row.retry_count)).toBe(1);
    expect(row.failure_reason).toMatch(/gateway down/);
  });

  it('does NOT re-claim a row inside its 5-minute backoff window', async () => {
    // The FAILED row from the previous test was just attempted (last_attempt_at
    // = NOW()), so a second drain must skip it (retry_count stays 1).
    sendSmsMock.mockRejectedValue(new Error('should not be called'));

    const before = insertedIds[insertedIds.length - 1];
    await drainNotificationOutbox({ limit: 100 });

    const row = await statusOf(before);
    expect(Number(row.retry_count)).toBe(1); // unchanged — not re-attempted
  });
});
