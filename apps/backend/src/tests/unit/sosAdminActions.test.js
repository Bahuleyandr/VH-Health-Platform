// Shared SOS admin actions — branches the deep test cannot reach (audit F1).
//
// sos-admin-console-real-actions.deep.test.js pins the happy paths against a real
// database. These cover the guards around them: a fan-out that reaches nobody has
// to be loud (it is indistinguishable from a successful broadcast at the API
// boundary), and bad input must raise a typed AppError rather than reaching SQL.
import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const warn = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  // Named exports the rest of the module graph reaches for.
  isTenantTransactionClient: jest.fn(() => false),
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  prismaReadOnly: { $queryRawUnsafe: queryRawUnsafe },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn, info: jest.fn(), error: jest.fn() },
}));
// sosService's patient-facing half pulls in geocoding and FCM; neither is
// involved in the admin actions under test.
jest.unstable_mockModule('../../services/locationService.js', () => ({
  findNearbyEmergencyServices: jest.fn(),
}));
jest.unstable_mockModule('../../services/notification/notificationService.js', () => ({
  notifyEmergencyTeam: jest.fn(),
}));

const { broadcastEmergencyAlert, escalateAlert } = await import('../../services/sosService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryRawUnsafe.mockReset();
  warn.mockReset();
});

describe('broadcastEmergencyAlert', () => {
  it('warns when the broadcast reaches zero staff', async () => {
    queryRawUnsafe.mockResolvedValue([]);

    const result = await broadcastEmergencyAlert({ tenantId: TENANT, title: 't', message: 'm' });

    expect(result).toEqual({ notified: 0 });
    expect(warn).toHaveBeenCalledWith('SOS broadcast reached zero staff', expect.objectContaining({ tenantId: TENANT }));
  });

  it('stays quiet when staff were notified', async () => {
    queryRawUnsafe.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const result = await broadcastEmergencyAlert({ tenantId: TENANT, title: 't', message: 'm' });

    expect(result).toEqual({ notified: 2 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a missing message without touching the database', async () => {
    await expect(broadcastEmergencyAlert({ tenantId: TENANT, title: 't' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'SOS_BROADCAST_INCOMPLETE' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('excludes phone-less and patient rows, and scopes to the tenant', async () => {
    queryRawUnsafe.mockResolvedValue([{ id: 1 }]);

    await broadcastEmergencyAlert({ tenantId: TENANT, title: 't', message: 'm' });

    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('phone IS NOT NULL');
    expect(sql).toContain("role <> 'PATIENT'");
    expect(sql).toContain('tenant_id = $4::uuid');
    expect(params[3]).toBe(TENANT);
  });
});

describe('escalateAlert', () => {
  it('rejects a non-numeric alert id without touching the database', async () => {
    await expect(escalateAlert({ tenantId: TENANT, alertId: 'not-an-id' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'SOS_ALERT_ID_INVALID' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('404s when the alert is absent from the caller tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(escalateAlert({ tenantId: TENANT, alertId: 7 }))
      .rejects.toMatchObject({ statusCode: 404, code: 'SOS_ALERT_NOT_FOUND' });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1); // lookup only, no UPDATE
  });

  it('escalates a lowercase stored severity and writes back the canonical uppercase', async () => {
    // Patient-app alerts store lowercase severities via SOS_SEVERITY.
    queryRawUnsafe
      .mockResolvedValueOnce([{ id: 7, severity: 'medium' }])
      .mockResolvedValueOnce([{ id: 7, severity: 'HIGH' }]);

    const result = await escalateAlert({ tenantId: TENANT, alertId: 7 });

    expect(result).toEqual({ id: 7, severity: 'HIGH', previousSeverity: 'MEDIUM' });
    expect(queryRawUnsafe.mock.calls[1]).toContain('HIGH');
  });

  it('refuses to escalate past CRITICAL without issuing an UPDATE', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ id: 7, severity: 'CRITICAL' }]);

    await expect(escalateAlert({ tenantId: TENANT, alertId: 7 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'SOS_ALERT_AT_MAX_SEVERITY' });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
