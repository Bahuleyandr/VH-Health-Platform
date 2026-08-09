// Unit regressions for Phase-3 B-L3 + B-L2.
//
// B-L3: notifyHousekeepingRecipients stamped notified_at for EVERY recipient
// even when the notification service created ZERO notifications (the
// `notifiedIds.length ? notifiedIds : ids` fallback) — a failed fan-out
// looked delivered forever and nothing re-notified. Fixed: notified_at is
// stamped only when notifications were actually created.
//
// B-L2: three per-file SLA_MINUTES tables assigned the same urgency different
// deadlines depending on entry point (dispatch 30/30/240/1440, staff raise
// 30/120/240/1440, admin create 30/60/120/240). HOUSEKEEPING_SLA_MINUTES is
// now the single exported source; the bed-lane values must stay pinned to the
// migration-269 bed_cleaning_turnaround rule (30 min).

import { jest } from '@jest/globals';

const executeRawMock = jest.fn();
const queryRawMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawMock,
    $executeRawUnsafe: executeRawMock,
  },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: loggerWarnMock, error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
}));
jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitHousekeepingRequestRaised: jest.fn(),
}));

const {
  HOUSEKEEPING_SLA_MINUTES,
  notifyHousekeepingRecipients,
} = await import('../../services/staff/housekeepingTaskDispatchService.js');

beforeEach(() => {
  executeRawMock.mockReset();
  queryRawMock.mockReset();
  sendStaffNotificationsMock.mockReset();
  loggerWarnMock.mockReset();
  executeRawMock.mockResolvedValue(1);
});

describe('notifyHousekeepingRecipients — notified_at stamping (B-L3)', () => {
  const recipients = [
    { id: 11, uid: 'u-11', name: 'HK One' },
    { id: 12, uid: 'u-12', name: 'HK Two' },
  ];

  it('does NOT stamp notified_at when zero notifications were created', async () => {
    sendStaffNotificationsMock.mockResolvedValue({
      notification_count: 0,
      recipients: recipients.map(({ id, uid, name }) => ({ id, uid, name })),
      notifications: [],
    });

    const result = await notifyHousekeepingRecipients({
      requestId: 42,
      recipients,
      title: 'T',
      body: 'B',
      urgency: 'high',
    });

    expect(result.notification_count).toBe(0);
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  it('stamps notified_at for the resolved recipient set when notifications were created', async () => {
    sendStaffNotificationsMock.mockResolvedValue({
      notification_count: 2,
      recipients: recipients.map(({ id, uid, name }) => ({ id, uid, name })),
      notifications: [{ id: 1 }, { id: 2 }],
    });

    const result = await notifyHousekeepingRecipients({
      requestId: 42,
      recipients,
      title: 'T',
      body: 'B',
      urgency: 'high',
    });

    expect(result.notification_count).toBe(2);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const [sql, requestId, ids] = executeRawMock.mock.calls[0];
    expect(sql).toContain('SET notified_at = COALESCE(notified_at, NOW())');
    expect(requestId).toBe(42);
    expect(ids).toEqual([11, 12]);
  });

  it('no-ops without a requestId or recipients', async () => {
    const result = await notifyHousekeepingRecipients({ requestId: null, recipients });
    expect(result).toEqual({ notification_count: 0 });
    expect(sendStaffNotificationsMock).not.toHaveBeenCalled();
  });
});

describe('HOUSEKEEPING_SLA_MINUTES — single shared table (B-L2)', () => {
  it('is frozen and pins the bed-cleaning lanes to the migration-269 30-minute rule', () => {
    expect(Object.isFrozen(HOUSEKEEPING_SLA_MINUTES)).toBe(true);
    expect(HOUSEKEEPING_SLA_MINUTES).toEqual({ urgent: 30, high: 30, normal: 240, low: 1440 });
  });
});
