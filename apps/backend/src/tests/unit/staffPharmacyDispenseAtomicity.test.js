import { jest } from '@jest/globals';

// Audit BE-M6: staff pharmacyService.updatePharmacyOrderStatus ran the
// dispense UPDATE as an autocommit statement, emitted the canonical
// timeline/audit pair post-commit best-effort, and then awaited an UNcaught
// notifications INSERT — a failure there 500'd after the commit and a client
// retry re-ran dispense bookkeeping. These tests pin the fixed contract
// (mirrors pharmacyOrderLifecycleAtomicity.test.js for the controller
// sibling): UPDATE + canonical emit share one tenant transaction and fail
// together; the notification/activity inserts are post-commit best-effort.

const prismaQuery = jest.fn();
const txQuery = jest.fn();
const emitPharmacyOrderEvent = jest.fn();
const setTenantTx = jest.fn();
const loggerWarn = jest.fn();

const tx = { $queryRawUnsafe: txQuery };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQuery },
  setTenantTx,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: loggerWarn, info: jest.fn() },
}));

jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitPharmacyOrderEvent,
}));

const { updatePharmacyOrderStatus } = await import('../../services/staff/pharmacyService.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const STAFF_UID = '20000000-0000-4000-8000-000000000002';

function orderRow(overrides = {}) {
  return {
    id: 55,
    uid: '30000000-0000-4000-8000-000000000003',
    tenant_id: TENANT_ID,
    phone: '+919000000001',
    status: 'dispensed',
    ordered_at: new Date('2026-08-01T09:00:00Z'),
    dispensed_at: new Date('2026-08-01T10:00:00Z'),
    updated_at: new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    phone: '+919000000001',
    order_id: 55,
    status: 'dispensed',
    notes: null,
    dispensed_medications: [{ name: 'Paracetamol 500mg', qty: 10 }],
    pharmacist_notes: 'Counselled patient',
    dispensed_at: null,
    tenantId: TENANT_ID,
    updatedBy: STAFF_UID,
    updatedByName: 'Pharmacist One',
    ...overrides,
  };
}

describe('staff pharmacy dispense canonical atomicity (BE-M6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(tx));
    prismaQuery.mockResolvedValue([]); // post-commit inserts
    txQuery.mockResolvedValue([orderRow()]);
    emitPharmacyOrderEvent.mockResolvedValue({ id: 'canonical-1' });
  });

  it('runs the dispense UPDATE and the canonical emit in the same tenant transaction', async () => {
    const result = await updatePharmacyOrderStatus(input());

    expect(setTenantTx).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    const updateSql = txQuery.mock.calls[0][0];
    expect(updateSql).toContain('UPDATE pharmacy_orders');
    expect(updateSql).toContain('tenant_id = $10::uuid');
    expect(txQuery.mock.calls[0].at(-1)).toBe(TENANT_ID);
    expect(emitPharmacyOrderEvent).toHaveBeenCalledWith(expect.objectContaining({
      db: tx,
      eventType: 'pharmacy.order_status_changed',
      eventStatus: 'dispensed',
      actorUid: STAFF_UID,
      order: expect.objectContaining({ id: 55, tenant_id: TENANT_ID }),
    }));
    // The UPDATE happens before the canonical emit, inside the same tx.
    expect(txQuery.mock.invocationCallOrder[0])
      .toBeLessThan(emitPharmacyOrderEvent.mock.invocationCallOrder[0]);
    expect(result.patientNotified).toBe(true);
  });

  it('propagates a canonical emit failure out of the transaction and skips post-commit inserts', async () => {
    let transactionRejected = false;
    setTenantTx.mockImplementation(async (_tenantId, callback) => {
      try {
        return await callback(tx);
      } catch (err) {
        transactionRejected = true; // real setTenantTx rolls the tx back here
        throw err;
      }
    });
    emitPharmacyOrderEvent.mockRejectedValueOnce(new Error('canonical insert failed'));

    await expect(updatePharmacyOrderStatus(input())).rejects.toThrow('canonical insert failed');

    expect(transactionRejected).toBe(true);
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('does not 500 after commit when the notification insert fails (retry-safety)', async () => {
    prismaQuery
      .mockRejectedValueOnce(new Error('notifications insert failed')) // notification
      .mockResolvedValueOnce([]); // activity log

    const result = await updatePharmacyOrderStatus(input());

    expect(result.order.id).toBe(55);
    expect(result.patientNotified).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('notification insert failed'),
      'notifications insert failed',
    );
  });

  it('does not 500 after commit when the activity-log insert fails', async () => {
    prismaQuery
      .mockResolvedValueOnce([]) // notification
      .mockRejectedValueOnce(new Error('activity log insert failed'));

    const result = await updatePharmacyOrderStatus(input());

    expect(result.order.id).toBe(55);
    expect(result.patientNotified).toBe(true);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('activity log insert failed'),
      'activity log insert failed',
    );
  });

  it('requires the caller tenant before opening a transaction', async () => {
    await expect(updatePharmacyOrderStatus(input({ tenantId: null }))).rejects.toThrow('TENANT_REQUIRED');
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('stamps the caller tenant on post-commit notification and activity rows', async () => {
    await updatePharmacyOrderStatus(input());

    expect(prismaQuery).toHaveBeenCalledTimes(2);
    expect(prismaQuery.mock.calls[0][0]).toContain('tenant_id');
    expect(prismaQuery.mock.calls[0].at(-1)).toBe(TENANT_ID);
    expect(prismaQuery.mock.calls[1][0]).toContain('tenant_id');
    expect(prismaQuery.mock.calls[1].at(-1)).toBe(TENANT_ID);
  });

  it('throws ORDER_NOT_FOUND when the guarded UPDATE matches no row, without emitting', async () => {
    txQuery.mockResolvedValueOnce([]);

    await expect(updatePharmacyOrderStatus(input())).rejects.toThrow('ORDER_NOT_FOUND');
    expect(emitPharmacyOrderEvent).not.toHaveBeenCalled();
  });
});
