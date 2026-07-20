import { jest } from '@jest/globals';

import { lockResultsInboxResourceTx } from '../../services/results/resultsInboxResourceLock.js';

describe('results inbox resource lock', () => {
  it('uses one transaction-scoped 64-bit advisory key for tenant and resource identity', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ resource_locked: null }]) };

    await lockResultsInboxResourceTx({
      tx,
      tenantId: '00000000-0000-4000-8000-000000000001',
      resourceType: 'lab_result',
      resourceId: 73,
    });

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, tenantId, resourceType, resourceId] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/hashtextextended/);
    expect(sql).toMatch(/jsonb_build_array/);
    expect(sql).toMatch(/pg_advisory_xact_lock[\s\S]*\)::text/);
    expect(tenantId).toBe('00000000-0000-4000-8000-000000000001');
    expect(resourceType).toBe('lab_result');
    expect(resourceId).toBe('73');
  });
});
