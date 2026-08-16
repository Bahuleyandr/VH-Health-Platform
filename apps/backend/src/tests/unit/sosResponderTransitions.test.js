// HIGH-1 regression pins: the responder transitions must PERSIST the validated
// responder text (migration 677 — responseMessage / resolutionNotes used to be
// validated and then dropped), complete the sos_response_ack SLA clock, and
// emit the canonical timeline/audit pair. Runs without Postgres: the prisma
// singleton is mocked and the bound SQL/params are asserted directly.
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const queryRawMock = jest.fn();
const recordCanonicalMock = jest.fn().mockResolvedValue({ timeline: {}, audit: {} });
const startSlaMock = jest.fn().mockResolvedValue({ id: 'sla-1' });
const completeSlaMock = jest.fn().mockResolvedValue({ id: 'sla-1', status: 'completed' });
const notifyEmergencyTeamMock = jest.fn().mockResolvedValue({ notified_count: 1 });

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock, $queryRaw: queryRawMock },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalMock,
  startWorkflowSla: startSlaMock,
  completeWorkflowSla: completeSlaMock,
}));

jest.unstable_mockModule('../../services/notification/notificationService.js', () => ({
  notifyEmergencyTeam: notifyEmergencyTeamMock,
}));

jest.unstable_mockModule('../../services/locationService.js', () => ({
  findNearbyEmergencyServices: jest.fn().mockResolvedValue({ hospitals: [], police_stations: [] }),
}));

jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: jest.fn(),
}));

jest.unstable_mockModule('../../utils/securityWebhook.js', () => ({
  sendSecurityWebhook: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const sosService = await import('../../services/sosService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const RESPONDER = '22222222-2222-4222-8222-222222222222';
const PATIENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  queryRawMock.mockReset();
  recordCanonicalMock.mockClear();
  completeSlaMock.mockClear();
  startSlaMock.mockClear();
});

describe('sosService.respondToAlert', () => {
  test('persists responseMessage, completes the ack SLA, and emits the canonical pair', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      status: 'RESPONDING',
      responded_at: new Date('2026-08-15T10:00:00Z'),
      response_message: 'On my way, 2 minutes out',
      tenant_id: TENANT,
      uid: PATIENT,
    }]);

    const row = await sosService.respondToAlert({
      tenantId: TENANT,
      alertId: '42',
      responderUid: RESPONDER,
      responderRole: 'EMERGENCY_RESPONDER',
      responseMessage: 'On my way, 2 minutes out',
    });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain("SET status = 'RESPONDING'");
    expect(sql).toContain('response_message = $4');
    expect(sql).toContain("status = 'ACTIVE'");
    // Original tenant scoping preserved: user-join derived, not sa.tenant_id.
    expect(sql).toContain('u.uid = sos_alerts.uid OR u.phone = sos_alerts.phone');
    expect(params).toEqual([RESPONDER, 42, TENANT, 'On my way, 2 minutes out']);

    expect(row).toMatchObject({
      id: 42,
      status: 'RESPONDING',
      response_message: 'On my way, 2 minutes out',
    });

    expect(completeSlaMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      ruleCode: 'sos_response_ack',
      sourceTable: 'sos_alerts',
      sourceId: '42',
    }));

    expect(recordCanonicalMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'sos.responded',
      sourceTable: 'sos_alerts',
      sourceId: '42',
      patientUid: PATIENT,
      actorUid: RESPONDER,
    }), expect.anything());
  });

  test('returns null (controller 404) for a non-ACTIVE or wrong-tenant alert and emits nothing', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const row = await sosService.respondToAlert({
      tenantId: TENANT,
      alertId: '999',
      responderUid: RESPONDER,
      responseMessage: 'hello',
    });

    expect(row).toBeNull();
    expect(completeSlaMock).not.toHaveBeenCalled();
    expect(recordCanonicalMock).not.toHaveBeenCalled();
  });
});

describe('sosService.resolveAlert', () => {
  test('persists resolutionNotes and completes the ack SLA', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      status: 'RESOLVED',
      resolved_at: new Date('2026-08-15T10:30:00Z'),
      resolution_notes: 'Patient stabilized, handed to ED',
      tenant_id: TENANT,
      uid: PATIENT,
    }]);

    const row = await sosService.resolveAlert({
      tenantId: TENANT,
      alertId: '42',
      actorUid: RESPONDER,
      actorRole: 'SECURITY',
      resolutionNotes: 'Patient stabilized, handed to ED',
    });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain("SET status = 'RESOLVED'");
    expect(sql).toContain('resolution_notes = $3');
    expect(sql).toContain("status IN ('ACTIVE', 'RESPONDING')");
    expect(params).toEqual([42, TENANT, 'Patient stabilized, handed to ED']);

    expect(row).toMatchObject({
      id: 42,
      status: 'RESOLVED',
      resolution_notes: 'Patient stabilized, handed to ED',
    });
    expect(completeSlaMock).toHaveBeenCalledWith(expect.objectContaining({
      ruleCode: 'sos_response_ack',
      sourceId: '42',
    }));
    expect(recordCanonicalMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'sos.resolved',
    }), expect.anything());
  });

  test('optional notes bind as NULL, never as the string "undefined"', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 7, status: 'RESOLVED', resolved_at: new Date(), resolution_notes: null,
      tenant_id: TENANT, uid: null,
    }]);

    await sosService.resolveAlert({ tenantId: TENANT, alertId: 7 });
    const [, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(params).toEqual([7, TENANT, null]);
  });
});

describe('sosService.createAlert canonical wiring', () => {
  test('starts the sos_response_ack SLA clock and emits sos.raised', async () => {
    // users.findFirst is not on the prisma mock — getUserMedicalInfo uses
    // prisma.users; extend the mock shape for this test.
    const prisma = (await import('../../lib/prisma.js')).default;
    prisma.users = {
      findFirst: jest.fn().mockResolvedValue({ uid: PATIENT, name: 'Pat' }),
    };
    queryRawMock.mockResolvedValueOnce([{ id: 77, created_at: new Date(), tenant_id: TENANT }]);

    const result = await sosService.createAlert({
      phone: '+919999999999',
      severity: 'high',
      isTestAlert: false,
    });

    expect(result.alert_id).toBe(77);
    expect(startSlaMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      ruleCode: 'sos_response_ack',
      sourceTable: 'sos_alerts',
      sourceId: '77',
      patientUid: PATIENT,
    }));
    expect(recordCanonicalMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'sos.raised',
      sourceId: '77',
    }), expect.anything());
    // Fan-out still runs and the honest notified count is preserved.
    expect(notifyEmergencyTeamMock).toHaveBeenCalled();
    expect(result.teams_notified).toBe(true);
  });
});
