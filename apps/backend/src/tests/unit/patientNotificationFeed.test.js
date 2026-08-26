// The `notifications` feed row is not decoration — it is the ONLY readable
// copy of a normal-priority patient push.
//
// `sendPushNotification` replaces the whole data payload of every
// normal-priority message with `createPrivatePushEnvelope()`, whose single
// destination is `route: '/notifications'`, and replaces the FCM notification
// block with a generic "You have a new update. Open the app to view it."
// (sendPushNotification.js:36-43, :116-135). So the push carries no content
// and no feature deep link. If no feed row exists, the patient is buzzed into
// an empty inbox.
//
// These tests pin the two contracts every caller of
// `recordPatientFeedNotification` depends on:
//   1. it NEVER throws — callers are fire-and-forget tails on clinical and
//      scheduling writes that are already committed, and this must not become
//      a new failing path on a write that must not fail;
//   2. tenant_id is ALWAYS bound explicitly — the column DEFAULT falls back to
//      the LITERAL default tenant whenever app.current_tenant_id is unset
//      (cron, bare transaction, bypass context, all of dev/QA/CI), and the
//      patient's inbox reader filters on tenant_id, so a defaulted row is
//      invisible to its own recipient.

import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '44444444-4444-4444-8444-444444444444';

const queryRawUnsafeMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const {
  recordPatientFeedNotification,
  recordPatientFeedNotificationWithReceipt,
} = await import(
  '../../utils/notifications/patientNotificationFeed.js'
);

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  loggerMock.warn.mockReset();
  queryRawUnsafeMock.mockImplementation(async (sql) => (
    /INSERT\s+INTO\s+notifications/i.test(String(sql)) ? [{ id: 501 }] : []
  ));
});

function insertCall() {
  const [sql, ...params] = queryRawUnsafeMock.mock.calls.find(
    ([text]) => /INSERT\s+INTO\s+notifications/i.test(String(text)),
  );
  return { sql: String(sql), params };
}

describe('recordPatientFeedNotification', () => {
  it('uses the supplied transaction client and returns the committed row id', async () => {
    const transactionQuery = jest.fn(async (sql) => (
      /INSERT\s+INTO\s+notifications/i.test(String(sql)) ? [{ id: 731 }] : []
    ));

    await expect(recordPatientFeedNotificationWithReceipt({
      client: { $queryRawUnsafe: transactionQuery },
      tenantId: TENANT_ID,
      userId: 41,
      uid: PATIENT_UID,
      phone: '+919876500041',
      title: 'New report available',
      body: 'Open VH Health to securely view your latest report.',
      type: 'diagnostic_result_ready',
      data: { generation_id: '731' },
    })).resolves.toEqual({ written: true, notificationId: 731 });

    expect(transactionQuery).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('binds tenant_id explicitly rather than leaving it to the column DEFAULT', async () => {
    const written = await recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 41,
      uid: PATIENT_UID,
      phone: '+919876500041',
      title: 'Appointment Rescheduled',
      body: 'Moved to 2026-09-02 at 11:30.',
      type: 'appointment_rescheduled',
      data: { type: 'appointment_rescheduled', appointment_id: '77' },
    });

    expect(written).toBe(true);
    const { sql, params } = insertCall();
    expect(sql).toContain('INSERT INTO notifications');
    expect(sql).toMatch(/\(tenant_id,\s*uid,\s*user_id,\s*phone/);
    expect(sql).toContain('$8::uuid');
    expect(params[7]).toBe(TENANT_ID);
  });

  it('writes all three identity columns the inbox reader matches on', async () => {
    // buildOwnNotificationCondition ORs uid / user_id / phone. Writing all
    // three is what makes the row reachable however the reader resolved the
    // caller.
    await recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 41,
      uid: PATIENT_UID,
      phone: '+919876500041',
      title: 'Investigation Results Ready',
      body: 'Results are ready.',
      type: 'investigation_result_ready',
    });

    const { params } = insertCall();
    expect(params[0]).toBe(PATIENT_UID);
    expect(params[1]).toBe(41);
    expect(params[2]).toBe('+919876500041');
    // No recipient lookup was needed — everything was supplied.
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('resolves uid and phone from users when the caller only holds an id', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      { id: 41, uid: PATIENT_UID, phone: '+919876500041' },
    ]);

    const written = await recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 41,
      title: 'Appointment Tomorrow',
      body: 'Reminder.',
      type: 'appointment_reminder',
    });

    expect(written).toBe(true);
    const lookupSql = String(queryRawUnsafeMock.mock.calls[0][0]);
    // The lookup is tenant-scoped: a bare `WHERE id = $1` would read across
    // tenants on a SERIAL id.
    expect(lookupSql).toContain('tenant_id = $1::uuid');
    const { params } = insertCall();
    expect(params[0]).toBe(PATIENT_UID);
    expect(params[2]).toBe('+919876500041');
  });

  it('still writes a row for a patient with no phone on file', async () => {
    // notifications.phone is NOT NULL, so a phone-less patient needs a
    // placeholder rather than a skipped row — the inbox is the only surface
    // such a patient has.
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 41, uid: PATIENT_UID, phone: null }]);

    const written = await recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 41,
      title: 'Document Available',
      body: 'Your prescription is available.',
      type: 'document_uploaded',
    });

    expect(written).toBe(true);
    expect(insertCall().params[2]).toBe('unknown');
  });

  it('clips an over-long phone instead of failing the insert with 22001', async () => {
    // notifications.phone is VARCHAR(15); isValidPhone permits up to 16 chars.
    const written = await recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 41,
      uid: PATIENT_UID,
      phone: '+1234567890123456',
      title: 'T',
      body: 'B',
      type: 'appointment_confirmed',
    });

    expect(written).toBe(true);
    expect(insertCall().params[2].length).toBeLessThanOrEqual(15);
  });

  // ── Contract 1: never throws ────────────────────────────────────────────
  it('swallows an insert failure and reports false', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 41,
      uid: PATIENT_UID,
      phone: '+919876500041',
      title: 'T',
      body: 'B',
      type: 'appointment_cancelled',
      context: 'appointment-cancelled',
    })).resolves.toBe(false);

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('appointment-cancelled'),
    );
  });

  it('swallows a recipient-lookup failure and reports false', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('connection reset'));

    await expect(recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 41,
      title: 'T',
      body: 'B',
      type: 'appointment_reminder',
    })).resolves.toBe(false);
    expect(queryRawUnsafeMock.mock.calls.some(
      ([sql]) => /INSERT\s+INTO\s+notifications/i.test(String(sql)),
    )).toBe(false);
  });

  it('refuses to write an unreachable row when the recipient does not exist', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(recordPatientFeedNotification({
      tenantId: TENANT_ID,
      userId: 999,
      title: 'T',
      body: 'B',
      type: 'appointment_reminder',
    })).resolves.toBe(false);
    expect(queryRawUnsafeMock.mock.calls.some(
      ([sql]) => /INSERT\s+INTO\s+notifications/i.test(String(sql)),
    )).toBe(false);
  });

  it('refuses to write without a tenant rather than defaulting one', async () => {
    await expect(recordPatientFeedNotification({
      tenantId: null,
      userId: 41,
      uid: PATIENT_UID,
      title: 'T',
      body: 'B',
      type: 'appointment_reminder',
    })).resolves.toBe(false);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('refuses unregistered or transport-alias types', async () => {
    for (const type of ['invented_patient_event', 'secure_message']) {
      await expect(recordPatientFeedNotification({
        tenantId: TENANT_ID,
        userId: 41,
        uid: PATIENT_UID,
        phone: '+919876500041',
        title: 'T',
        body: 'B',
        type,
      })).resolves.toBe(false);
    }
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});
