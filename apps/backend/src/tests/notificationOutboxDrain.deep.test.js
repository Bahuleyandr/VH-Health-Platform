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
const { resolveRecipientTokens } = await import(
  '../utils/notifications/notificationOutboxDelivery.js'
);
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

// C3: recipient_id is TEXT and may carry an integer users.id or a uuid
// users.uid. queue() previously coerced through $2::int, silently NULLing
// uuid recipients. This suite proves both forms survive queue insertion
// unchanged and resolve to the recipient's device token through the existing
// delivery path (resolveRecipientTokens + the real drain), and that blank
// recipient ids are stored as NULL.
d('C3: outbox recipient_id text/uuid transport (deep)', () => {
  const outboxIds = [];
  let user = null;
  const deviceToken = `c3-outbox-token-${Date.now()}`;
  const phone = `+9190613${String(Date.now() % 100000).padStart(5, '0')}`;

  beforeAll(async () => {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at, device_token)
       VALUES ($1, 'C3 Outbox Transport Probe', 'PATIENT', true, NOW(), $2)
       RETURNING id, uid`,
      phone,
      deviceToken,
    );
    user = rows[0];
  });

  beforeEach(() => {
    sendPushMock.mockReset();
    sendSmsMock.mockReset();
  });

  afterAll(async () => {
    if (outboxIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM notification_outbox WHERE id = ANY($1::int[])`,
        outboxIds,
      ).catch(() => {});
    }
    if (user) {
      await prisma.$executeRawUnsafe(
        'DELETE FROM users WHERE id = $1',
        user.id,
      ).catch(() => {});
    }
  });

  async function storedRecipientId(id) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT recipient_id FROM notification_outbox WHERE id = $1',
      id,
    );
    return rows[0].recipient_id;
  }

  it('stores a numeric users.id recipient as exact decimal text and resolves its device token', async () => {
    const queued = await notificationOutbox.queue({
      type: 'push',
      recipientId: user.id, // integer id, as legacy callers pass it
      title: 'C3 id-form',
      body: 'numeric id transport',
      data: { kind: 'c3' },
    });
    expect(queued?.id).toBeTruthy();
    outboxIds.push(queued.id);

    const stored = await storedRecipientId(queued.id);
    expect(stored).toBe(String(user.id));
    await expect(resolveRecipientTokens(stored)).resolves.toContain(deviceToken);
  });

  it('stores a uuid users.uid recipient verbatim and resolves its device token', async () => {
    const queued = await notificationOutbox.queue({
      type: 'push',
      recipientId: user.uid, // uuid string — previously NULLed by the int cast
      title: 'C3 uid-form',
      body: 'uuid transport',
      data: { kind: 'c3' },
    });
    expect(queued?.id).toBeTruthy();
    outboxIds.push(queued.id);

    const stored = await storedRecipientId(queued.id);
    expect(stored).toBe(user.uid);
    await expect(resolveRecipientTokens(stored)).resolves.toContain(deviceToken);
  });

  it('stores NULL for a blank recipient id (phone-only rows stay valid)', async () => {
    const queued = await notificationOutbox.queue({
      type: 'sms',
      recipientId: '   ',
      recipientPhone: phone,
      title: 'C3 blank',
      body: 'blank recipient normalizes to NULL',
      data: {},
    });
    expect(queued?.id).toBeTruthy();
    outboxIds.push(queued.id);

    const stored = await storedRecipientId(queued.id);
    expect(stored).toBeNull();
  });

  it('delivers the id-form and uid-form rows through the real drain', async () => {
    sendPushMock.mockResolvedValue({ successCount: 1, failureCount: 0 });
    sendSmsMock.mockResolvedValue({ ok: true });

    const result = await drainNotificationOutbox({ limit: 100 });
    expect(result.claimed).toBeGreaterThanOrEqual(3);

    for (const id of outboxIds) {
      const row = await statusOf(id);
      expect(row.status).toBe('SENT');
    }

    // Both push rows resolved this user's device token, one per id form.
    const tokenCalls = sendPushMock.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => (arg.tokens || []).includes(deviceToken));
    expect(tokenCalls.map((c) => String(c.userId)).sort()).toEqual(
      [String(user.id), user.uid].sort(),
    );

    // The blank-recipient row delivered over its phone-only SMS path.
    expect(sendSmsMock).toHaveBeenCalledWith(phone, 'blank recipient normalizes to NULL');
  });
});
