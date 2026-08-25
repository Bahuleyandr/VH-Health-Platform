// The 24h/1h appointment reminder is a patient push with no readable content.
//
// The reminder is queued as a `push` outbox intent. Its type
// (`appointment_reminder_24h` / `_1h`) maps to the `appointment_reminder`
// tenant preference key, and with no tenant override the drain resolves the
// legacy channel set `['push']` — which never writes an in-app row. The push
// itself is privacy-stripped by `sendPushNotification` to a generic "You have
// a new update" landing on /notifications. So the default configuration buzzed
// the patient the day before their appointment and opened an empty inbox.
//
// The fix writes the feed row at queue time, and must not double-write for the
// two cases where a row already exists or will exist: a duplicate intent, and
// a tenant that has configured `inapp` among its reminder channels (the drain
// then routes through dispatch(), whose inapp branch commits the row itself).

import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '55555555-5555-4555-8555-555555555555';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const outboxQueueMock = jest.fn();
const getTenantSettingsMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const prismaDouble = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaDouble,
  setTenant: async (_t, fn) => fn(prismaDouble),
  setTenantTx: async (_t, fn) => fn(prismaDouble),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  getCurrentTenantId: () => TENANT_ID,
  runInTenantContext: async (_t, fn) => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getTenantSettings: getTenantSettingsMock,
}));
jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queueAppointmentReminderSms: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: outboxQueueMock },
  default: { queue: outboxQueueMock },
}));

const { __testing__ } = await import('../../utils/notifications/appointmentReminderJob.js');
const { queueAppointmentReminderPush } = __testing__;

const APPOINTMENT = Object.freeze({
  id: 512,
  tenant_id: TENANT_ID,
  patient_user_id: 41,
  patient_phone: '+919876500041',
  patient_name: 'Asha R',
  doctor_name: 'Rao',
  appointment_time: '10:30',
  token_number: 'A7',
});

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  outboxQueueMock.mockReset();
  getTenantSettingsMock.mockReset();
  loggerMock.warn.mockReset();
  executeRawUnsafeMock.mockResolvedValue(1);
  outboxQueueMock.mockResolvedValue({ id: 900, status: 'PENDING', duplicate: false });
  getTenantSettingsMock.mockResolvedValue({});
  queryRawUnsafeMock.mockResolvedValue([
    { id: 41, uid: PATIENT_UID, phone: '+919876500041' },
  ]);
});

describe('appointment reminder feed row', () => {
  it('writes the in-app row the privacy-stripped reminder push points at', async () => {
    await queueAppointmentReminderPush(APPOINTMENT, 24);

    expect(outboxQueueMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, ...params] = executeRawUnsafeMock.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO notifications');
    expect(String(sql)).toContain('$8::uuid');
    expect(params[7]).toBe(TENANT_ID);
    expect(params[0]).toBe(PATIENT_UID);
    expect(params[1]).toBe(41);
    // The suffixed `appointment_reminder_24h` is transport/template identity;
    // the patient app's inbox tap handler routes the UNSUFFIXED type, so a
    // row typed `appointment_reminder_24h` would render and go nowhere.
    expect(params[5]).toBe('appointment_reminder');
  });

  it('carries the same copy the push would have carried', async () => {
    await queueAppointmentReminderPush(APPOINTMENT, 1);

    const [, ...params] = executeRawUnsafeMock.mock.calls[0];
    const [queued] = outboxQueueMock.mock.calls[0];
    expect(params[3]).toBe(queued.title);
    expect(params[4]).toBe(queued.body);
    expect(params[4]).toContain('10:30');
  });

  it('does not double-write when the tenant already routes reminders in-app', async () => {
    // With `inapp` configured the drain routes through dispatch(), whose inapp
    // branch commits the row itself — a queue-time insert would duplicate it.
    // Suppressing here is only safe because the drain's row is now typed
    // `appointment_reminder` too: dispatch() runs the outbox row's
    // `appointment_reminder_24h` through feedRowTypeForTransportType first
    // (pinned in notificationDispatcherChannels.test.js). Without that mapping
    // this guard traded a routed row for an unrouted one.
    getTenantSettingsMock.mockResolvedValue({
      notificationChannels: { appointment_reminder: ['push', 'inapp'] },
    });

    await queueAppointmentReminderPush(APPOINTMENT, 24);

    expect(outboxQueueMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('does not write a second row when the intent was already queued', async () => {
    outboxQueueMock.mockResolvedValue({ id: 900, status: 'PENDING', duplicate: true });

    await queueAppointmentReminderPush(APPOINTMENT, 24);

    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('does not write a row when the intent was never recorded', async () => {
    outboxQueueMock.mockResolvedValue(null);

    await expect(queueAppointmentReminderPush(APPOINTMENT, 24)).resolves.toBeNull();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  // The reminder sweep treats a rejection from this function as a channel
  // failure (REMINDER_CHANNEL_RECORD_FAILED). The feed-row tail must never be
  // what causes that.
  it('still returns the outbox row when the feed-row write fails', async () => {
    executeRawUnsafeMock.mockRejectedValue(new Error('deadlock detected'));

    await expect(queueAppointmentReminderPush(APPOINTMENT, 24))
      .resolves.toMatchObject({ id: 900 });
  });

  it('still returns the outbox row when the tenant settings read fails', async () => {
    getTenantSettingsMock.mockRejectedValue(new Error('tenant cache unavailable'));

    await expect(queueAppointmentReminderPush(APPOINTMENT, 24))
      .resolves.toMatchObject({ id: 900 });
    // Fails toward writing the row: a duplicate is cosmetic, a missing one is
    // the dead-end buzz this exists to remove.
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
  });
});
