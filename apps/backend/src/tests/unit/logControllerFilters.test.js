import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();
const errorMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
    error: errorMock,
  },
}));

const { getAuditLogs, getSystemLogs } = await import('../../controllers/logs/logController.js');

function mockResponse() {
  return {
    req: { id: 'req-logs-test', originalUrl: '/api/v1/logs/audit' },
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  warnMock.mockReset();
  errorMock.mockReset();
});

describe('logController filters', () => {
  it('applies audit log search, type, role, resource, and date filters', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 7, action: 'BED_STATUS_CHANGED' }])
      .mockResolvedValueOnce([{ count: 1 }]);

    const req = {
      query: {
        search: 'bed',
        action: 'BED_STATUS_CHANGED',
        resource: 'bed',
        role: 'ADMIN',
        dateRange: 'last_7d',
        from: '2026-06-01',
        to: '2026-06-02',
        page: '2',
        limit: '25',
      },
    };
    const res = mockResponse();

    await getAuditLogs(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const listCall = queryRawUnsafeMock.mock.calls[0];
    expect(listCall[0]).toContain('FROM audit_logs');
    expect(listCall[0]).toContain('action ILIKE $1');
    expect(listCall[0]).toContain('action ILIKE $2');
    expect(listCall[0]).toContain('resource ILIKE $3');
    expect(listCall[0]).toContain('role ILIKE $4');
    expect(listCall[0]).toContain("created_at >= NOW() - INTERVAL '7 days'");
    expect(listCall[0]).toContain('created_at >= $5::timestamptz');
    expect(listCall[0]).toContain("created_at < ($6::date + INTERVAL '1 day')");
    expect(listCall.slice(1)).toEqual([
      '%bed%',
      '%BED_STATUS_CHANGED%',
      '%bed%',
      '%ADMIN%',
      '2026-06-01',
      '2026-06-02',
      25,
      25,
    ]);
    expect(res.json.mock.calls[0][0].data.filters).toEqual(expect.objectContaining({
      search: 'bed',
      action: 'BED_STATUS_CHANGED',
      resource: 'bed',
      role: 'ADMIN',
      dateRange: 'last_7d',
      from: '2026-06-01',
      to: '2026-06-02',
    }));
  });

  it('applies system log admin/action/date filters', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 3, action: 'ROLE_UPDATED' }])
      .mockResolvedValueOnce([{ count: 1 }]);

    const req = {
      query: {
        action: 'ROLE_UPDATED',
        admin_uid: '11111111-1111-4111-8111-111111111111',
        date_range: 'today',
        limit: '10',
      },
    };
    const res = mockResponse();

    await getSystemLogs(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const listCall = queryRawUnsafeMock.mock.calls[0];
    expect(listCall[0]).toContain('FROM admin_activity_logs');
    expect(listCall[0]).toContain('action ILIKE $1');
    expect(listCall[0]).toContain('admin_uid::text ILIKE $2');
    expect(listCall[0]).toContain('created_at >= CURRENT_DATE');
    expect(listCall.slice(1)).toEqual([
      '%ROLE_UPDATED%',
      '%11111111-1111-4111-8111-111111111111%',
      10,
      0,
    ]);
    expect(res.json.mock.calls[0][0].data.filters).toEqual(expect.objectContaining({
      action: 'ROLE_UPDATED',
      admin_uid: '11111111-1111-4111-8111-111111111111',
      dateRange: 'today',
    }));
  });
});
