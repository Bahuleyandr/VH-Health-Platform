import { jest } from '@jest/globals';

import {
  lockTenantPatientMergeExecutionExclusive,
  lockTenantPatientMergeStability,
} from '../../utils/patientMergeStabilityLock.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT_LOCK_KEY = `vhhealth:patient-merge-tenant:${TENANT}`;

describe('patient merge stability lock', () => {
  it('uses a transaction-scoped shared lock for ordinary stability readers', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 1 }]) };

    await lockTenantPatientMergeStability(tx, TENANT);

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, lockKey] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/SELECT 1 AS locked\s+FROM pg_advisory_xact_lock_shared\(/);
    expect(sql).toContain('hashtextextended($1::text, 0)');
    expect(lockKey).toBe(TENANT_LOCK_KEY);
  });

  it('uses the same key with an exclusive transaction lock for merge execution', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 1 }]) };

    await lockTenantPatientMergeExecutionExclusive(tx, TENANT);

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, lockKey] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/SELECT 1 AS locked\s+FROM pg_advisory_xact_lock\(/);
    expect(sql).not.toMatch(/pg_advisory_xact_lock_shared/);
    expect(sql).toContain('hashtextextended($1::text, 0)');
    expect(lockKey).toBe(TENANT_LOCK_KEY);
  });
});
