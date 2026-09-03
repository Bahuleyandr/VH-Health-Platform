import { jest } from '@jest/globals';

const clockQuery = jest.fn();
const createAuditLog = jest.fn();
const transactionClient = {
  $queryRawUnsafe: clockQuery,
  audit_logs: { create: createAuditLog },
};
const setTenantMock = jest.fn(async (_tenantId, callback) => callback(transactionClient));
const loggerError = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  prismaReadOnly: {},
  setTenant: setTenantMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: loggerError,
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const { recordAuditConsoleAccess } = await import(
  '../../services/compliance/auditAccountabilityService.js'
);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '57400000-0000-4000-8000-000000000001';
const DATABASE_CLOCK = new Date('2000-01-02T03:04:05.678Z');

function requestContext() {
  return {
    id: 'audit-clock-request',
    ip: '127.0.0.1',
    tenantId: TENANT_ID,
    headers: { 'user-agent': 'audit-clock-test' },
    user: {
      id: 57401,
      uid: ACTOR_UID,
      role: 'ADMIN',
      tenant_id: TENANT_ID,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setTenantMock.mockImplementation(async (_tenantId, callback) => callback(transactionClient));
});

describe('recordAuditConsoleAccess database clock', () => {
  it('binds the PostgreSQL UTC clock to the audit row in the same tenant transaction', async () => {
    clockQuery.mockResolvedValueOnce([{ created_at: DATABASE_CLOCK }]);
    createAuditLog.mockResolvedValueOnce({ id: 1 });

    await recordAuditConsoleAccess(requestContext(), 'AUDIT_EVENTS_EXPORT', {
      exported_count: 7,
    });

    expect(setTenantMock).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(clockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/date_trunc\('milliseconds', clock_timestamp\(\)\) AS created_at/),
    );
    expect(clockQuery.mock.invocationCallOrder[0]).toBeLessThan(
      createAuditLog.mock.invocationCallOrder[0],
    );
    expect(createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: TENANT_ID,
        action: 'AUDIT_EVENTS_EXPORT',
        created_at: DATABASE_CLOCK,
        metadata: expect.objectContaining({
          request_id: 'audit-clock-request',
          exported_count: 7,
        }),
      }),
    });
  });

  it('does not write an audit row when the database clock is unavailable', async () => {
    clockQuery.mockResolvedValueOnce([]);

    await recordAuditConsoleAccess(requestContext(), 'AUDIT_EVENTS_EXPORT');

    expect(createAuditLog).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      'Failed to record audit-console access',
      expect.objectContaining({
        action: 'AUDIT_EVENTS_EXPORT',
        error: 'Database clock returned an invalid audit-console timestamp',
      }),
    );
  });
});
