/**
 * Phase E1 — dataProcessingActivityService unit tests.
 * Drives validation + CRUD + degrade-on-schema-missing for the GDPR
 * Art. 30 register.
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
  archiveDataProcessingActivity,
  getDataProcessingActivity,
  listDataProcessingActivities,
  upsertDataProcessingActivity,
  __testing__,
} = await import('../../services/compliance/dataProcessingActivityService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('upsertDataProcessingActivity', () => {
  it('rejects missing activity_code', async () => {
    await expect(upsertDataProcessingActivity({
      tenantId: TENANT, displayName: 'X', purposes: 'X', lawfulBasis: 'consent',
    })).rejects.toThrow(/activity_code is required/);
  });

  it('rejects missing purposes', async () => {
    await expect(upsertDataProcessingActivity({
      tenantId: TENANT, activityCode: 'X', displayName: 'X', lawfulBasis: 'consent',
    })).rejects.toThrow(/purposes is required/);
  });

  it('rejects unknown lawful_basis', async () => {
    await expect(upsertDataProcessingActivity({
      tenantId: TENANT, activityCode: 'X', displayName: 'X',
      purposes: 'Patient registration', lawfulBasis: 'magic',
    })).rejects.toThrow(/lawful_basis must be one of/);
  });

  it('inserts an active DPA with public_task lawful basis', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, activity_code: 'PT_REG', lawful_basis: 'public_task', status: 'active',
    }]);
    const row = await upsertDataProcessingActivity({
      tenantId: TENANT, activityCode: 'PT_REG', displayName: 'Patient registration',
      purposes: 'Capture demographics for clinical care',
      lawfulBasis: 'public_task',
      personalDataCategories: ['name', 'date_of_birth', 'phone'],
      retentionPeriodDays: 3650,
    });
    expect(row.id).toBe(1);
    expect(row.lawful_basis).toBe('public_task');
  });

  it('throws conflict on duplicate activity_code', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertDataProcessingActivity({
      tenantId: TENANT, activityCode: 'PT_REG', displayName: 'X',
      purposes: 'X', lawfulBasis: 'consent',
    })).rejects.toThrow(/already exists/);
  });

  it('updates an existing DPA when id is provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'paused' }]);
    const row = await upsertDataProcessingActivity({
      tenantId: TENANT, id: 1, activityCode: 'PT_REG', displayName: 'X',
      purposes: 'X', lawfulBasis: 'consent', status: 'paused',
    });
    expect(row.status).toBe('paused');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/UPDATE data_processing_activities/);
  });
});

describe('listDataProcessingActivities', () => {
  it('filters by status + lawful_basis + dpia_required', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listDataProcessingActivities({
      tenantId: TENANT, status: 'active', lawfulBasis: 'consent', dpiaRequired: true,
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status = \$\d/);
    expect(sql).toMatch(/lawful_basis = \$\d/);
    expect(sql).toMatch(/dpia_required = \$\d/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "data_processing_activities" does not exist'));
    expect(await listDataProcessingActivities({ tenantId: TENANT })).toEqual({ activities: [], count: 0 });
  });
});

describe('getDataProcessingActivity', () => {
  it('throws 404 when not found', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(getDataProcessingActivity({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the row when found', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, activity_code: 'X' }]);
    const row = await getDataProcessingActivity({ tenantId: TENANT, id: 1 });
    expect(row.id).toBe(1);
  });
});

describe('archiveDataProcessingActivity', () => {
  it('flips status to archived', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'archived' }]);
    const row = await archiveDataProcessingActivity({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('archived');
  });

  it('throws 404 when already archived', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(archiveDataProcessingActivity({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('lawful basis enum', () => {
  it('exposes the GDPR Art. 6(1) basis list', () => {
    expect(__testing__.LAWFUL_BASES).toContain('consent');
    expect(__testing__.LAWFUL_BASES).toContain('legal_obligation');
    expect(__testing__.LAWFUL_BASES).toContain('legitimate_interests');
  });
});
