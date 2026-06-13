/**
 * Phase A3 PR1 — integrationService unit tests.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  archiveIntegration,
  createIntegration,
  getIntegration,
  listIntegrationLogs,
  listIntegrations,
  updateIntegration,
  writeIntegrationLog,
  __testing__,
} = await import('../../services/integrations/integrationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

describe('createIntegration', () => {
  it('rejects empty name', async () => {
    await expect(createIntegration({ tenantId: TENANT, integrationType: 'zoom' })).rejects.toThrow(/name/);
  });
  it('rejects empty integration_type', async () => {
    await expect(createIntegration({ tenantId: TENANT, name: 'Zoom' })).rejects.toThrow(/integration_type/);
  });
  it('inserts and returns the row', async () => {
    mockNext([{ id: 1, name: 'Zoom', integration_type: 'zoom', status: 'active' }]);
    const row = await createIntegration({
      tenantId: TENANT, name: 'Zoom', integrationType: 'zoom',
      config: { account: 'X' }, createdBy: 'admin',
    });
    expect(row.id).toBe(1);
    const args = queryUnsafeMock.mock.calls[0];
    expect(args[0]).toMatch(/INSERT INTO integrations/);
    expect(args.slice(1, 5)).toEqual([TENANT, 'Zoom', null, 'zoom']);
  });
  it('maps unique-violation to 409', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(createIntegration({
      tenantId: TENANT, name: 'Zoom', integrationType: 'zoom',
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listIntegrations', () => {
  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "integrations" does not exist'));
    expect(await listIntegrations({ tenantId: TENANT })).toEqual({ integrations: [], count: 0 });
  });
  it('rejects unknown status', async () => {
    await expect(listIntegrations({ tenantId: TENANT, status: 'weird' })).rejects.toThrow(/status must be one of/);
  });
  it('passes filters into the WHERE clause', async () => {
    mockNext([{ id: 1 }, { id: 2 }]);
    await listIntegrations({ tenantId: TENANT, status: 'active', integrationType: 'zoom', limit: 10 });
    const args = queryUnsafeMock.mock.calls[0];
    expect(args.slice(1)).toEqual([TENANT, 'active', 'zoom', 10]);
  });
});

describe('getIntegration', () => {
  it('throws 404 when missing', async () => {
    mockNext([]);
    await expect(getIntegration({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('updateIntegration', () => {
  it('skips DB write and re-fetches when no fields supplied', async () => {
    mockNext([{ id: 1 }]);
    await updateIntegration({ tenantId: TENANT, id: 1 });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SELECT/);
  });
  it('builds an UPDATE with only the supplied columns', async () => {
    mockNext([{ id: 1, status: 'paused' }]);
    await updateIntegration({ tenantId: TENANT, id: 1, status: 'paused' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE integrations[\s\S]*status = \$1/);
    expect(sql).not.toMatch(/name = /);
  });
  it('throws 404 when no row matches', async () => {
    mockNext([]);
    await expect(updateIntegration({ tenantId: TENANT, id: 99, status: 'paused' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('archiveIntegration', () => {
  it('flips status to archived via updateIntegration', async () => {
    mockNext([{ id: 1, status: 'archived' }]);
    const row = await archiveIntegration({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('archived');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET status = \$1/);
  });
});

describe('writeIntegrationLog', () => {
  it('rejects unknown log_type', async () => {
    await expect(writeIntegrationLog({ tenantId: TENANT, logType: 'weird', message: 'x' })).rejects.toThrow(/log_type/);
  });
  it('rejects unknown severity', async () => {
    await expect(writeIntegrationLog({ tenantId: TENANT, logType: 'config_change', severity: 'PANIC' })).rejects.toThrow(/severity/);
  });
  it('best-effort: returns null on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "integration_logs" does not exist'));
    const result = await writeIntegrationLog({ tenantId: TENANT, logType: 'config_change' });
    expect(result).toBeNull();
  });
  it('inserts and returns the row', async () => {
    mockNext([{ id: 1, log_type: 'config_change', severity: 'info' }]);
    const row = await writeIntegrationLog({
      tenantId: TENANT, integrationId: 5, logType: 'config_change', message: 'hi',
    });
    expect(row.id).toBe(1);
  });
});

describe('listIntegrationLogs', () => {
  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "integration_logs" does not exist'));
    expect(await listIntegrationLogs({ tenantId: TENANT })).toEqual({ logs: [], count: 0 });
  });
  it('rejects unknown filters', async () => {
    await expect(listIntegrationLogs({ tenantId: TENANT, severity: 'huh' })).rejects.toThrow(/severity/);
    await expect(listIntegrationLogs({ tenantId: TENANT, logType: 'huh' })).rejects.toThrow(/log_type/);
  });
});

describe('exported constants', () => {
  it('matches the migration CHECK lists', () => {
    expect(__testing__.INTEGRATION_STATUSES).toEqual(['active', 'paused', 'failed', 'archived']);
    expect(__testing__.LOG_SEVERITIES).toEqual(['debug', 'info', 'warn', 'error']);
    expect(__testing__.LOG_TYPES).toEqual([
      'config_change', 'auth_refresh', 'webhook_send', 'webhook_receive',
      'mapping_sync', 'health_check', 'error',
    ]);
  });
});
