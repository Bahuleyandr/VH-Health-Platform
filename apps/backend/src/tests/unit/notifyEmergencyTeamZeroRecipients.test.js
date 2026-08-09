/**
 * notifyEmergencyTeam zero-recipient path (audit BE-M3).
 *
 * Before the fix, zero active EMERGENCY_RESPONDER rows meant
 * `responders.map` was empty, `Promise.all([])` resolved, the service logged
 * "Notified 0 emergency responders" and returned
 * { success: true, notified_count: 0 } — a fake success nobody ever saw.
 *
 * Pins the fix: zero responders is a loud failure — success:false with
 * reason NO_ACTIVE_RESPONDERS, a durable SOS_ESCALATION_FAILED
 * security-audit row (audit_log with file fallback), a live
 * security-webhook page, and a durable admin fallback fan-out so a human
 * can dispatch manually. The fallback failing must not mask the signal.
 *
 * The sibling suite sosZeroRecipientEscalation.test.js covers the
 * createAlert response-honesty half with notifyEmergencyTeam mocked; here
 * the REAL notificationService runs against mocked prisma/webhook/audit.
 */

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerInfoMock = jest.fn();
const logSecurityEventMock = jest.fn();
const sendSecurityWebhookMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: loggerErrorMock, warn: jest.fn(), info: loggerInfoMock, debug: jest.fn() },
}));

jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: logSecurityEventMock,
  SecurityEvents: {},
}));

jest.unstable_mockModule('../../utils/securityWebhook.js', () => ({
  sendSecurityWebhook: sendSecurityWebhookMock,
}));

jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
}));

const { notifyEmergencyTeam } = await import('../../services/notification/notificationService.js');

const USER_UID = '33333333-3333-4333-8333-333333333333';
const alertData = { id: 42, uid: USER_UID, phone: '+919800000042', severity: 'HIGH' };

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  loggerErrorMock.mockReset();
  loggerInfoMock.mockReset();
  logSecurityEventMock.mockReset();
  sendSecurityWebhookMock.mockReset();
  sendStaffNotificationsMock.mockReset();
});

describe('notifyEmergencyTeam zero-recipient path (BE-M3)', () => {
  it('zero active responders → success:false, durable audit row, live webhook, admin fallback', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]); // responders SELECT
    sendStaffNotificationsMock.mockResolvedValue({ notification_count: 2 });

    const res = await notifyEmergencyTeam(alertData);

    expect(res).toEqual({
      success: false,
      notified_count: 0,
      fallback_notified_count: 2,
      reason: 'NO_ACTIVE_RESPONDERS',
    });
    // Loud log + durable security-audit row + live ops page.
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining('no active EMERGENCY_RESPONDER'));
    expect(logSecurityEventMock).toHaveBeenCalledWith('SOS_ESCALATION_FAILED', expect.objectContaining({
      userId: USER_UID,
      reason: expect.stringContaining('no active EMERGENCY_RESPONDER'),
    }));
    expect(sendSecurityWebhookMock).toHaveBeenCalledWith('SOS_ESCALATION_FAILED', expect.objectContaining({
      reason: expect.stringContaining('no active emergency responders'),
    }));
    // Durable fallback fan-out to humans who can dispatch manually.
    expect(sendStaffNotificationsMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientRoles: ['ADMIN', 'SUPER_ADMIN'],
      data: expect.objectContaining({ sos_alert_id: 42, reason: 'no_active_responders' }),
    }));
    // And no fake "Notified 0 emergency responders" success log.
    expect(loggerInfoMock).not.toHaveBeenCalledWith(expect.stringMatching(/Notified 0 emergency responders/));
  });

  it('fallback fan-out failure does not mask the zero-recipient failure signal', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]); // responders SELECT
    sendStaffNotificationsMock.mockRejectedValue(new Error('notifications table gone'));

    const res = await notifyEmergencyTeam(alertData);

    expect(res).toMatchObject({
      success: false,
      notified_count: 0,
      fallback_notified_count: 0,
      reason: 'NO_ACTIVE_RESPONDERS',
    });
    expect(logSecurityEventMock).toHaveBeenCalledWith('SOS_ESCALATION_FAILED', expect.any(Object));
    expect(sendSecurityWebhookMock).toHaveBeenCalled();
    // The fallback failure itself is logged too.
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('admin fallback fan-out also failed'),
      expect.any(String),
    );
  });
});

void jest;
