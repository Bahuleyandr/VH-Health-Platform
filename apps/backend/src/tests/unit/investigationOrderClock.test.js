import { jest } from '@jest/globals';

const DB_MS = Date.parse('2026-09-15T12:00:00.123Z');
const TENANT = '00000000-0000-4000-8000-00000000c10c';
const PATIENT = '00000000-0000-4000-8000-00000000c10d';
const ACTOR = '00000000-0000-4000-8000-00000000c10e';
const tx = {
  $queryRawUnsafe: jest.fn(),
  investigations: { create: jest.fn() },
};
const prisma = {
  users: { findFirst: jest.fn() },
  notifications: { create: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};
const transaction = jest.fn(async (_tenant, fn) => fn(tx));
const canonical = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prisma,
  setTenantTx: transaction,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: canonical,
}));
jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  publishInpatientDiagnosticResourceLinkedTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/appointment/opChildResourceEventService.js', () => ({
  publishOpChildResourceLinkedTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const { createInvestigationOrder } = await import('../../services/investigation/orderService.js');
const order = {
  patient_id: 17, doctor_uid: ACTOR, test_name: 'Clock test CBC',
  type: 'LAB', tenantId: TENANT,
};

beforeEach(() => {
  jest.resetAllMocks();
  transaction.mockImplementation(async (_tenant, fn) => fn(tx));
  prisma.users.findFirst.mockResolvedValue({ id: 17, uid: PATIENT, name: 'Clock Patient', phone: '9011881901', tenant_id: TENANT });
  prisma.$queryRawUnsafe.mockResolvedValue([]);
  prisma.notifications.create.mockResolvedValue({ id: 1 });
  tx.$queryRawUnsafe.mockResolvedValue([{ requested_at_epoch_ms: BigInt(DB_MS) }]);
  tx.investigations.create.mockImplementation(async ({ data }) => ({
    id: 101, requested_at: new Date(), ...data,
  }));
  canonical.mockResolvedValue({ timeline: { id: 'timeline-1' }, audit: { id: 'audit-1' } });
});

afterEach(() => jest.useRealTimers());

describe('investigation order database clock', () => {
  it.each([-86_400_000, 86_400_000])('binds the transaction clock when the application clock differs by %i ms', async (skew) => {
    jest.useFakeTimers({ now: DB_MS + skew });
    const result = await createInvestigationOrder(order);

    expect(transaction).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS requested_at_epoch_ms',
    );
    const data = tx.investigations.create.mock.calls[0][0].data;
    expect(data.requested_at).toEqual(new Date(DB_MS));
    expect(result.investigation.requested_at).toEqual(new Date(DB_MS));
    expect(tx.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(tx.investigations.create.mock.invocationCallOrder[0]);
    expect(canonical).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, patientUid: PATIENT,
      afterState: expect.objectContaining({ requested_at: new Date(DB_MS) }),
    }), { db: tx });
    expect(data.updated_at).toEqual(new Date(DB_MS + skew));
    expect(data.collection_deadline_at).toEqual(new Date(DB_MS + skew + 24 * 60 * 60 * 1000));
    expect(prisma.$queryRawUnsafe.mock.calls.every(([sql]) => !sql.includes('clock_timestamp'))).toBe(true);
  });

  it('preserves an explicit collection deadline', async () => {
    const deadline = '2026-09-17T15:00:00.000Z';
    await createInvestigationOrder({ ...order, collection_deadline_at: deadline });
    expect(tx.investigations.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      requested_at: new Date(DB_MS), collection_deadline_at: new Date(deadline),
    }));
  });

  it.each([
    { rows: [] }, { rows: [{}] },
    { rows: [{ requested_at_epoch_ms: null }] },
    { rows: [{ requested_at_epoch_ms: 'invalid' }] },
  ])('refuses a missing or unusable database clock: $rows', async ({ rows }) => {
    tx.$queryRawUnsafe.mockResolvedValue(rows);
    await expect(createInvestigationOrder(order)).rejects.toMatchObject({ code: 'INVESTIGATION_DB_CLOCK_UNAVAILABLE' });
    expect(tx.investigations.create).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
    expect(prisma.notifications.create).not.toHaveBeenCalled();
  });

  it('propagates a database-clock query failure before the order is written', async () => {
    const failure = new Error('synthetic clock query failure');
    tx.$queryRawUnsafe.mockRejectedValue(failure);
    await expect(createInvestigationOrder(order)).rejects.toBe(failure);
    expect(tx.investigations.create).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
    expect(prisma.notifications.create).not.toHaveBeenCalled();
  });
});
