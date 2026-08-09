/**
 * SOS zero-recipient escalation honesty (audit BE-M3).
 *
 * Before the fix, scheduleEscalation/logSecurityEvent in sosService were
 * logger.info-only stubs, and notifyEmergencyTeam with ZERO active
 * EMERGENCY_RESPONDER rows resolved Promise.all([]) and returned
 * { success: true, notified_count: 0 } — while formatAlertResponse told the
 * patient "Emergency teams have been notified."
 *
 * These tests pin the fix:
 *  (a) notifyEmergencyTeam with zero responders returns success:false /
 *      reason NO_ACTIVE_RESPONDERS, persists a durable SOS_ESCALATION_FAILED
 *      security-audit row, pages the live security webhook, and fans out a
 *      durable admin fallback notification;
 *  (b) the fallback fan-out failing does not mask the zero-recipient signal;
 *  (c) createAlert never claims teams were notified when notified_count is 0
 *      (teams_notified:false + "call emergency services" message), while the
 *      SOS row itself still succeeds;
 *  (d) a thrown fan-out is caught (the committed sos_alerts row must not
 *      500 into a patient retry/duplicate) but is escalated loudly via the
 *      same durable + webhook paths, and the response stays honest;
 *  (e) positive control: a real fan-out keeps the original success message.
 */

import { jest } from '@jest/globals';

// ── Shared mocks ───────────────────────────────────────────────────────────
const queryRawUnsafeMock = jest.fn();
const queryRawMock = jest.fn();
const usersFindFirstMock = jest.fn();

const loggerErrorMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

const logSecurityEventMock = jest.fn();
const sendSecurityWebhookMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();
const notifyEmergencyTeamMock = jest.fn();
const findNearbyMock = jest.fn(async () => ({ hospitals: [], police_stations: [] }));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: jest.fn(),
    $queryRaw: queryRawMock,
    users: { findFirst: usersFindFirstMock },
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: loggerErrorMock, warn: loggerWarnMock, info: loggerInfoMock, debug: jest.fn() },
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

jest.unstable_mockModule('../../services/locationService.js', () => ({
  findNearbyEmergencyServices: findNearbyMock,
}));

// sosService gets a mocked notification module so createAlert's honesty can be
// tested against controlled notified_count outcomes; notifyEmergencyTeam
// itself is imported REAL (separate module instance) further down.
jest.unstable_mockModule('../../services/notification/notificationService.js', () => ({
  notifyEmergencyTeam: notifyEmergencyTeamMock,
  notificationService: { notifyEmergencyTeam: notifyEmergencyTeamMock },
  default: { notifyEmergencyTeam: notifyEmergencyTeamMock },
}));

const { createAlert } = await import('../../services/sosService.js');

const ALERT_ROW = { id: 42, created_at: new Date('2026-08-09T10:00:00.000Z') };
const USER = { uid: '33333333-3333-4333-8333-333333333333', name: 'Asha' };

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  queryRawMock.mockReset().mockResolvedValue([ALERT_ROW]);
  usersFindFirstMock.mockReset().mockResolvedValue(USER);
  loggerErrorMock.mockReset();
  loggerInfoMock.mockReset();
  loggerWarnMock.mockReset();
  logSecurityEventMock.mockReset();
  sendSecurityWebhookMock.mockReset();
  sendStaffNotificationsMock.mockReset();
  notifyEmergencyTeamMock.mockReset();
  findNearbyMock.mockClear();
});

describe('createAlert response honesty (BE-M3)', () => {
  const baseInput = {
    phone: '+919800000042',
    severity: 'HIGH',
    message: 'help',
    ip_address: '10.0.0.9',
  };

  it('zero notified responders → SOS succeeds but the response must NOT claim teams were notified', async () => {
    notifyEmergencyTeamMock.mockResolvedValue({
      success: false, notified_count: 0, fallback_notified_count: 1, reason: 'NO_ACTIVE_RESPONDERS',
    });

    const res = await createAlert(baseInput);

    // The SOS row persisted and the patient gets their alert id...
    expect(res.alert_id).toBe(42);
    expect(res.status).toBe('active');
    // ...but the response is honest about the fan-out.
    expect(res.teams_notified).toBe(false);
    expect(res.responders_notified_count).toBe(0);
    expect(res.message).not.toMatch(/have been notified/i);
    expect(res.message).toMatch(/call emergency services directly/i);
  });

  it('positive control: a real fan-out keeps the original success message', async () => {
    notifyEmergencyTeamMock.mockResolvedValue({ success: true, notified_count: 3 });

    const res = await createAlert(baseInput);

    expect(res.teams_notified).toBe(true);
    expect(res.responders_notified_count).toBe(3);
    expect(res.message).toMatch(/Emergency teams have been notified/);
  });

  it('a thrown fan-out is caught (no 500 after the committed SOS row) but escalated loudly and honestly', async () => {
    notifyEmergencyTeamMock.mockRejectedValue(new Error('notif DB down'));

    const res = await createAlert(baseInput);

    // Patient-facing SOS still succeeds — the sos_alerts row is committed.
    expect(res.alert_id).toBe(42);
    // Response does not lie about notification.
    expect(res.teams_notified).toBe(false);
    expect(res.responders_notified_count).toBe(0);
    expect(res.message).not.toMatch(/have been notified/i);
    // The failure is escalated durably + live, not just logged.
    expect(loggerErrorMock).toHaveBeenCalled();
    expect(logSecurityEventMock).toHaveBeenCalledWith('SOS_ESCALATION_FAILED', expect.objectContaining({
      userId: USER.uid,
      reason: expect.stringContaining('notif DB down'),
    }));
    expect(sendSecurityWebhookMock).toHaveBeenCalledWith('SOS_ESCALATION_FAILED', expect.objectContaining({
      reason: expect.stringContaining('fan-out failed'),
    }));
  });

  it('test alerts skip fan-out entirely and say so', async () => {
    const res = await createAlert({ ...baseInput, isTestAlert: true });

    expect(notifyEmergencyTeamMock).not.toHaveBeenCalled();
    expect(res.is_test).toBe(true);
    expect(res.teams_notified).toBe(false);
    expect(res.responders_notified_count).toBe(0);
    expect(res.message).toMatch(/No notifications were sent/);
  });
});

void jest;
