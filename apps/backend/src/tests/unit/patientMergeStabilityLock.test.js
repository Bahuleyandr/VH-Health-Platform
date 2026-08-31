import { jest } from '@jest/globals';

const tenantTransactions = new WeakSet();
const isTenantTransactionClient = jest.fn((value) => tenantTransactions.has(value));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  isTenantTransactionClient,
}));

const {
  assertTenantPatientMergeStabilityLease,
  lockTenantPatientMergeExecutionExclusive,
  lockTenantPatientMergeStability,
} = await import('../../utils/patientMergeStabilityLock.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT_LOCK_KEY = `vhhealth:patient-merge-tenant:${TENANT}`;

function transactionClient() {
  const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 1 }]) };
  tenantTransactions.add(tx);
  return tx;
}

describe('patient merge stability lock', () => {
  it('uses a transaction-scoped shared lock for ordinary stability readers', async () => {
    const tx = transactionClient();

    const lease = await lockTenantPatientMergeStability(tx, TENANT);

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, lockKey] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/SELECT 1 AS locked\s+FROM pg_advisory_xact_lock_shared\(/);
    expect(sql).toContain('hashtextextended($1::text, 0)');
    expect(lockKey).toBe(TENANT_LOCK_KEY);
    expect(() => assertTenantPatientMergeStabilityLease(lease, { tx, tenantId: TENANT }))
      .not.toThrow();
  });

  it('rejects forged, cross-transaction, and cross-tenant stability leases', async () => {
    const tx = transactionClient();
    const otherTx = transactionClient();
    const lease = await lockTenantPatientMergeStability(tx, TENANT);

    expect(() => assertTenantPatientMergeStabilityLease({}, { tx, tenantId: TENANT }))
      .toThrow(TypeError);
    expect(() => assertTenantPatientMergeStabilityLease(lease, {
      tx: otherTx,
      tenantId: TENANT,
    })).toThrow(TypeError);
    expect(() => assertTenantPatientMergeStabilityLease(lease, {
      tx,
      tenantId: '00000000-0000-4000-8000-000000000002',
    })).toThrow(TypeError);
  });

  it('does not acquire a tenantless stability lock or issue a lease', async () => {
    const tx = transactionClient();

    await expect(lockTenantPatientMergeStability(tx, null)).rejects.toThrow(TypeError);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('does not accept a lease minted on a root or otherwise unbranded client', async () => {
    const rootClient = { $queryRawUnsafe: jest.fn() };

    const lease = await lockTenantPatientMergeStability(rootClient, TENANT);

    expect(() => assertTenantPatientMergeStabilityLease(lease, {
      tx: rootClient,
      tenantId: TENANT,
    })).toThrow(/active tenant transaction client/);
    expect(rootClient.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('uses the same key with an exclusive transaction lock for merge execution', async () => {
    const tx = transactionClient();

    await lockTenantPatientMergeExecutionExclusive(tx, TENANT);

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, lockKey] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/SELECT 1 AS locked\s+FROM pg_advisory_xact_lock\(/);
    expect(sql).not.toMatch(/pg_advisory_xact_lock_shared/);
    expect(sql).toContain('hashtextextended($1::text, 0)');
    expect(lockKey).toBe(TENANT_LOCK_KEY);
  });
});
