/**
 * Phase E2 — dataRetentionPolicyService unit tests.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  archiveRetentionPolicy,
  getRetentionForTable,
  listDataRetentionPolicies,
  upsertDataRetentionPolicy,
} = await import('../../services/compliance/dataRetentionPolicyService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('upsertDataRetentionPolicy', () => {
  it('rejects missing applies_to_table', async () => {
    await expect(upsertDataRetentionPolicy({
      tenantId: TENANT, policyCode: 'X', displayName: 'X', retentionDays: 30, basis: 'X',
    })).rejects.toThrow(/applies_to_table is required/);
  });

  it('rejects unknown action', async () => {
    await expect(upsertDataRetentionPolicy({
      tenantId: TENANT, policyCode: 'X', appliesToTable: 'audit_log',
      displayName: 'X', retentionDays: 30, basis: 'compliance', action: 'shred',
    })).rejects.toThrow(/action must be one of/);
  });

  it('rejects negative retention_days', async () => {
    await expect(upsertDataRetentionPolicy({
      tenantId: TENANT, policyCode: 'X', appliesToTable: 'audit_log',
      displayName: 'X', retentionDays: -7, basis: 'compliance',
    })).rejects.toThrow(/retention_days must be >= 0/);
  });

  it('inserts an erase policy with linked DPA', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, policy_code: 'AUDIT_7Y', applies_to_table: 'audit_log',
      action: 'erase', retention_days: 2555,
    }]);
    const row = await upsertDataRetentionPolicy({
      tenantId: TENANT, policyCode: 'AUDIT_7Y', appliesToTable: 'audit_log',
      displayName: 'Audit log 7-year retention',
      retentionDays: 2555, action: 'erase',
      basis: 'India IT Rules + HIPAA',
      dataProcessingActivityId: 11,
    });
    expect(row.action).toBe('erase');
  });

  it('throws conflict on duplicate policy_code or applies_to_table', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertDataRetentionPolicy({
      tenantId: TENANT, policyCode: 'AUDIT_7Y', appliesToTable: 'audit_log',
      displayName: 'X', retentionDays: 30, basis: 'X',
    })).rejects.toThrow(/collides/);
  });
});

describe('getRetentionForTable', () => {
  it('returns null when no policy exists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    expect(await getRetentionForTable({ tenantId: TENANT, appliesToTable: 'unknown' }))
      .toBeNull();
  });

  it('returns the active policy for the named table', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, applies_to_table: 'audit_log', retention_days: 2555 },
    ]);
    const row = await getRetentionForTable({ tenantId: TENANT, appliesToTable: 'audit_log' });
    expect(row.retention_days).toBe(2555);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "data_retention_policies" does not exist'));
    expect(await getRetentionForTable({ tenantId: TENANT, appliesToTable: 'audit_log' }))
      .toBeNull();
  });
});

describe('listDataRetentionPolicies', () => {
  it('filters by status + action', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listDataRetentionPolicies({ tenantId: TENANT, status: 'active', action: 'anonymise' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status = \$\d/);
    expect(sql).toMatch(/action = \$\d/);
  });
});

describe('archiveRetentionPolicy', () => {
  it('throws 404 when already archived', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(archiveRetentionPolicy({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('flips status to archived', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'archived' }]);
    const row = await archiveRetentionPolicy({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('archived');
  });
});
