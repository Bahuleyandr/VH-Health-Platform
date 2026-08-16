// Unit tests: controlled-dispense witness identity validation (PR #875
// follow-up — witness.uid was stored unvalidated on the statutory Schedule
// X / narcotic register). Locks assertControlledDispenseWitness's rejection
// branches and its wiring inside dispenseControlledTx: every invalid witness
// must reject BEFORE any stock movement or register write.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const txMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenantTx: setTenantTxMock,
}));

const {
  assertControlledDispenseWitness,
  dispenseControlled,
  CONTROLLED_DISPENSE_WITNESS_ROLES,
} = await import('../../services/pharmacy/inventoryV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const DISPENSER = '11111111-1111-4111-8111-111111111111';
const WITNESS = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
});

describe('assertControlledDispenseWitness', () => {
  test('rejects a non-UUID witness uid before touching the database', async () => {
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: 'garbage', witnessName: 'X', performedBy: DISPENSER,
    })).rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_INVALID' });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('rejects a missing witness uid', async () => {
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: null, witnessName: 'X', performedBy: DISPENSER,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_INVALID' });
  });

  test('rejects self-witnessing before touching the database', async () => {
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: DISPENSER, witnessName: 'Me', performedBy: DISPENSER,
    })).rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_SELF' });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('rejects a witness with no active same-tenant staff row', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: WITNESS, witnessName: 'Ghost', performedBy: DISPENSER,
    })).rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });

    // The lookup is tenant-scoped, requires the live-identity triple, and
    // pins the row for the transaction (FOR KEY SHARE, marService idiom).
    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).toContain('is_active = true');
    expect(sql).toContain(`status = 'active'`);
    expect(sql).toContain('COALESCE(is_deleted, false) = false');
    expect(sql).toContain('FOR KEY SHARE');
    expect(params).toEqual([TENANT, WITNESS]);
  });

  test('rejects a clinically inappropriate role', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: WITNESS, name: 'Clerk', role: 'RECEPTIONIST' }]);
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: WITNESS, witnessName: 'Clerk', performedBy: DISPENSER,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE',
      details: { witness_role: 'RECEPTIONIST' },
    });
  });

  test('accepts an active pharmacist and normalises role aliases', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: WITNESS, name: 'W', role: 'PHARMACY_STAFF' }]);
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: WITNESS, witnessName: 'W', performedBy: DISPENSER,
    })).resolves.toMatchObject({ uid: WITNESS, role: 'PHARMACY_STAFF' });

    // Alias form ("STAFF_NURSE" → NURSING_STAFF) is eligible too.
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: WITNESS, name: 'N', role: 'STAFF_NURSE' }]);
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: WITNESS, witnessName: 'N', performedBy: DISPENSER,
    })).resolves.toBeTruthy();
  });

  test('the eligible roster is clinical-only', () => {
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).toEqual(expect.arrayContaining([
      'PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'DOCTOR', 'NURSING_STAFF',
    ]));
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('RECEPTIONIST');
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('PATIENT');
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('PHARMACY_WALKIN');
  });
});

describe('dispenseControlledTx wiring', () => {
  test('an invalid witness rejects a Schedule X dispense before any stock movement', async () => {
    // Call 1: item lookup (Schedule X). Call 2: witness lookup → no row.
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, schedule_class: 'X', is_narcotic: true, unit_label: 'tab' }])
      .mockResolvedValueOnce([]);

    await expect(dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
      performed_by: DISPENSER,
      performed_by_name: 'Pharmacist',
      witness_uid: WITNESS,
      witness_name: 'Ghost Witness',
    })).rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });

    // No batch decrement, no movement row, no register row was attempted.
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });
});
