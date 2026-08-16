// HIGH-1 regression pins for the sos-alert-age-escalation sweep: a
// never-acknowledged ACTIVE alert escalates one severity step per window and
// re-fans-out; a stalled CRITICAL alert marks its SLA instance escalated and
// pages ops; the claim UPDATE makes the sweep idempotent per window.
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const escalateAlertMock = jest.fn();
const emitCanonicalMock = jest.fn().mockResolvedValue(null);
const notifyEmergencyTeamMock = jest.fn().mockResolvedValue({ notified_count: 2 });
const logSecurityEventMock = jest.fn();
const sendSecurityWebhookMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

jest.unstable_mockModule('../../services/sosService.js', () => ({
  SOS_RESPONSE_SLA_RULE: 'sos_response_ack',
  escalateAlert: escalateAlertMock,
  emitSosCanonicalEvent: emitCanonicalMock,
}));

jest.unstable_mockModule('../../services/notification/notificationService.js', () => ({
  notifyEmergencyTeam: notifyEmergencyTeamMock,
}));

jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: logSecurityEventMock,
}));

jest.unstable_mockModule('../../utils/securityWebhook.js', () => ({
  sendSecurityWebhook: sendSecurityWebhookMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { runSosAlertAgeEscalationSweep, DEFAULT_ESCALATION_WINDOW_MINUTES } = await import(
  '../../services/sosEscalationService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

function overdueRow(overrides = {}) {
  return {
    id: 42,
    uid: null,
    phone: '+919999999999',
    severity: 'HIGH',
    message: 'help',
    latitude: 13.0,
    longitude: 80.2,
    raised_at: new Date(Date.now() - 11 * 60000).toISOString(),
    last_escalated_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  escalateAlertMock.mockReset();
  emitCanonicalMock.mockClear();
  notifyEmergencyTeamMock.mockClear();
  logSecurityEventMock.mockClear();
  sendSecurityWebhookMock.mockClear();
});

test('window default derives from sosConfig ESCALATION_TIMEOUT (5 minutes)', () => {
  expect(DEFAULT_ESCALATION_WINDOW_MINUTES).toBe(5);
});

test('no tenant -> no-op, no queries', async () => {
  const result = await runSosAlertAgeEscalationSweep({});
  expect(result).toEqual({ scanned: 0, escalated: 0, refannedOut: 0, criticalStalled: 0 });
  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
});

test('overdue HIGH alert: claims, ladder-escalates, re-fans-out, emits sos.escalated', async () => {
  queryRawUnsafeMock
    .mockResolvedValueOnce([overdueRow()]) // overdue SELECT
    .mockResolvedValueOnce([{ id: 42, severity: 'HIGH' }]); // claim UPDATE
  escalateAlertMock.mockResolvedValueOnce({ id: 42, severity: 'CRITICAL', previousSeverity: 'HIGH' });

  const result = await runSosAlertAgeEscalationSweep({ tenantId: TENANT });

  expect(result).toEqual({ scanned: 1, escalated: 1, refannedOut: 1, criticalStalled: 0 });

  const [selectSql, selectTenant, selectWindow] = queryRawUnsafeMock.mock.calls[0];
  expect(selectSql).toContain("sa.status = 'ACTIVE'");
  expect(selectSql).toContain('sa.responded_at IS NULL');
  expect(selectSql).toContain('COALESCE(sa.last_escalated_at, sa.raised_at)');
  expect(selectTenant).toBe(TENANT);
  expect(selectWindow).toBe(5);

  const [claimSql] = queryRawUnsafeMock.mock.calls[1];
  expect(claimSql).toContain('SET last_escalated_at = NOW()');
  expect(claimSql).toContain('COALESCE(last_escalated_at, raised_at)');

  expect(escalateAlertMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT,
    alertId: 42,
    reason: expect.stringContaining('unacknowledged'),
  }));
  expect(notifyEmergencyTeamMock).toHaveBeenCalledWith(
    expect.objectContaining({ id: 42, severity: 'CRITICAL' }),
    [],
  );
  expect(emitCanonicalMock).toHaveBeenCalledWith(expect.objectContaining({
    eventType: 'sos.escalated',
    alertId: 42,
    payload: expect.objectContaining({
      previous_severity: 'HIGH',
      severity: 'CRITICAL',
      trigger: 'sos-alert-age-escalation',
    }),
  }));
  // Not a critical stall: no ops page.
  expect(logSecurityEventMock).not.toHaveBeenCalled();
});

test('stalled CRITICAL alert: no ladder, marks SLA escalated, pages ops, still re-fans-out', async () => {
  queryRawUnsafeMock
    .mockResolvedValueOnce([overdueRow({ severity: 'CRITICAL' })]) // overdue SELECT
    .mockResolvedValueOnce([{ id: 42, severity: 'CRITICAL' }]) // claim UPDATE
    .mockResolvedValueOnce([]); // markSlaEscalated UPDATE

  const result = await runSosAlertAgeEscalationSweep({ tenantId: TENANT });

  expect(result).toEqual({ scanned: 1, escalated: 0, refannedOut: 1, criticalStalled: 1 });
  expect(escalateAlertMock).not.toHaveBeenCalled();

  const [slaSql, slaTenant, slaRule, slaSourceId] = queryRawUnsafeMock.mock.calls[2];
  expect(slaSql).toContain("status = 'escalated'");
  expect(slaSql).toContain("status NOT IN ('completed', 'cancelled')");
  expect(slaTenant).toBe(TENANT);
  expect(slaRule).toBe('sos_response_ack');
  expect(slaSourceId).toBe('42');

  expect(logSecurityEventMock).toHaveBeenCalledWith(
    'SOS_ALERT_UNACKNOWLEDGED',
    expect.objectContaining({ reason: expect.stringContaining('42') }),
  );
  expect(sendSecurityWebhookMock).toHaveBeenCalled();
  expect(notifyEmergencyTeamMock).toHaveBeenCalled();
});

test('lost claim (concurrent sweep or racing respond) skips the alert entirely', async () => {
  queryRawUnsafeMock
    .mockResolvedValueOnce([overdueRow()]) // overdue SELECT
    .mockResolvedValueOnce([]); // claim UPDATE returns no row

  const result = await runSosAlertAgeEscalationSweep({ tenantId: TENANT });

  expect(result).toEqual({ scanned: 1, escalated: 0, refannedOut: 0, criticalStalled: 0 });
  expect(escalateAlertMock).not.toHaveBeenCalled();
  expect(notifyEmergencyTeamMock).not.toHaveBeenCalled();
  expect(emitCanonicalMock).not.toHaveBeenCalled();
});

test('ladder failure (severity raced to max) still re-fans-out and never hot-loops', async () => {
  queryRawUnsafeMock
    .mockResolvedValueOnce([overdueRow()])
    .mockResolvedValueOnce([{ id: 42, severity: 'HIGH' }]);
  escalateAlertMock.mockRejectedValueOnce(new Error('Alert cannot be escalated from severity CRITICAL'));

  const result = await runSosAlertAgeEscalationSweep({ tenantId: TENANT });

  expect(result.escalated).toBe(0);
  expect(result.refannedOut).toBe(1);
  // The claim already stamped last_escalated_at, so the next tick inside the
  // same window will not re-select this alert.
  const [claimSql] = queryRawUnsafeMock.mock.calls[1];
  expect(claimSql).toContain('SET last_escalated_at = NOW()');
});

// ── Age ceiling ─────────────────────────────────────────────────────────────
// Migration 677 adds last_escalated_at nullable with no backfill, so
// COALESCE(last_escalated_at, raised_at) falls through to raised_at on every
// pre-existing row. Without an age ceiling the first tick after deploy makes
// the ENTIRE historical backlog eligible — and that backlog is every alert
// ever raised and not patient-cancelled, because the responder endpoints had
// no client before this wave. Re-eligibility is one window, so nothing ever
// drains it: the sweep would re-page the emergency team for weeks-old alerts
// forever. The same bound fixes starvation — ORDER BY raised_at ASC LIMIT 20
// otherwise lets stale rows monopolise every tick so a NEW alert is never
// reached.

test('both the select and the claim are bounded by the age ceiling, parameterised at 24h', async () => {
  queryRawUnsafeMock
    .mockResolvedValueOnce([overdueRow()])
    .mockResolvedValueOnce([{ id: 42, severity: 'HIGH' }]);
  escalateAlertMock.mockResolvedValueOnce({ id: 42, severity: 'CRITICAL', previousSeverity: 'HIGH' });

  await runSosAlertAgeEscalationSweep({ tenantId: TENANT });

  // Eligibility SELECT: (sql, tenantId, windowMinutes, limit, maxAgeHours)
  const [selectSql, , , , selectMaxAge] = queryRawUnsafeMock.mock.calls[0];
  expect(selectSql).toMatch(/sa\.raised_at > NOW\(\) - \(\$4::int \* INTERVAL '1 hour'\)/);
  expect(selectMaxAge).toBe(24);

  // Claim UPDATE: (sql, alertId, tenantId, windowMinutes, maxAgeHours) — the
  // ceiling must be on the claim too, or a row that ages past the bound
  // between SELECT and UPDATE still escalates.
  const [claimSql, , , , claimMaxAge] = queryRawUnsafeMock.mock.calls[1];
  expect(claimSql).toMatch(/raised_at > NOW\(\) - \(\$4::int \* INTERVAL '1 hour'\)/);
  expect(claimMaxAge).toBe(24);
});

test('the ceiling is a real parameter, not baked into the SQL text', async () => {
  queryRawUnsafeMock.mockResolvedValueOnce([]);

  await runSosAlertAgeEscalationSweep({ tenantId: TENANT, maxAgeHours: 6 });

  const [, , , , selectMaxAge] = queryRawUnsafeMock.mock.calls[0];
  expect(selectMaxAge).toBe(6);
});
