// Unit coverage for the controlled-stock guard on the generic movements path
// (2026-08-25 reaudit BC-H1 / BC-M1). Drives inventoryV2Service.recordMovement
// against a mocked prisma so it runs without a database:
//   - a controlled ISSUE is refused and steered to /controlled-dispense
//     (no stock movement, no register row);
//   - caller-asserted witness identity cannot authorize a decrement;
//   - a Schedule X decrement with a one-time approval writes the movement AND a
//     pharmacy_schedule_register row in the same tx;
//   - controlled decrements require an exact batch under a movement-specific
//     server policy, including the already-expired expiry-scan state;
//   - a Schedule H1 receipt writes a 'receive' register row (BC-M1);
//   - a non-controlled movement is unaffected (no register row).
import { jest } from '@jest/globals';

const calls = { queries: [], executes: [] };

// One fake tx that pattern-matches the raw SQL recordMovement issues. setTenantTx
// simply runs the callback against it, so the whole flow stays in one "tx".
let itemRow = null;
let batchRow = null;
const consumeWitnessApprovalMock = jest.fn();
const fakeTx = {
  async $queryRawUnsafe(sql, ...args) {
    calls.queries.push({ sql, args });
    if (/FROM pharmacy_inventory_items\s+WHERE id/i.test(sql)) {
      return itemRow ? [itemRow] : [];
    }
    if (/FROM pharmacy_inventory_batches[\s\S]*FOR UPDATE/i.test(sql)) {
      return [batchRow || {
        id: args[0], inventory_item_id: args[2], batch_number: 'B1', lot_number: null,
        expiry_date: new Date('2027-01-01'), remaining_quantity: 30, status: 'in_stock',
        is_expired: false,
      }];
    }
    if (/INSERT INTO pharmacy_stock_movements/i.test(sql)) {
      return [{ id: 999, movement_kind: args[3], quantity_delta: args[4] }];
    }
    if (/SUM\(remaining_quantity\)/i.test(sql)) {
      return [{ bal: 25 }];
    }
    if (/INSERT INTO pharmacy_schedule_register/i.test(sql)) {
      return [{ id: 555, movement_kind: args[4], schedule_class: args[3] }];
    }
    return [];
  },
  async $executeRawUnsafe(sql, ...args) {
    calls.executes.push({ sql, args });
    return 1;
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: fakeTx,
  prismaReadOnly: fakeTx,
  setTenantTx: async (_tenantId, fn) => fn(fakeTx),
  setTenant: async (_tenantId, fn) => fn(fakeTx),
  isTenantTransactionClient: () => true,
  circuitBreakerStatus: () => ({ state: 'closed' }),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../services/pharmacy/controlledDispenseWitnessService.js', () => ({
  CONTROLLED_DISPENSE_APPROVAL_SCOPES: {
    inventory: 'inventory_controlled_dispense',
    inventoryMovement: 'inventory_controlled_movement',
  },
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'DOCTOR'],
  approveControlledDispenseWitnessApproval: jest.fn(),
  consumeControlledDispenseWitnessApproval: consumeWitnessApprovalMock,
  createControlledDispenseWitnessApproval: jest.fn(),
  isControlledDispenseWitnessEvidence: () => false,
}));

const {
  controlledMovementWitnessPayload,
  recordMovement,
} = await import('../../services/pharmacy/inventoryV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const base = { tenantId: TENANT, inventory_item_id: 7, inventory_batch_id: 11, quantity: 5, performed_by: 'aaaaaaaa-0000-4000-8000-000000000001' };

const registerInserts = () => calls.queries.filter((c) => /INSERT INTO pharmacy_schedule_register/i.test(c.sql));
const movementInserts = () => calls.queries.filter((c) => /INSERT INTO pharmacy_stock_movements/i.test(c.sql));

beforeEach(() => {
  calls.queries = [];
  calls.executes = [];
  itemRow = null;
  batchRow = null;
  consumeWitnessApprovalMock.mockReset();
  consumeWitnessApprovalMock.mockImplementation(async ({ approvalId }) => {
    if (!approvalId) {
      throw Object.assign(new Error('approval required'), {
        code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
        statusCode: 400,
      });
    }
    return { uid: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Roster Nurse' };
  });
});

describe('recordMovement controlled-stock guard', () => {
  test('controlled ISSUE is refused and steered to the controlled-dispense path (no movement, no register)', async () => {
    itemRow = { id: 7, schedule_class: 'X', is_narcotic: true, unit_label: 'amp' };
    await expect(recordMovement({ ...base, movement_kind: 'issue' }))
      .rejects.toMatchObject({ code: 'CONTROLLED_MOVEMENT_REQUIRES_DISPENSE_PATH', statusCode: 409 });
    expect(movementInserts()).toHaveLength(0);
    expect(registerInserts()).toHaveLength(0);
  });

  test('caller-asserted witness identity cannot authorize a Schedule X decrement', async () => {
    itemRow = { id: 7, schedule_class: 'X', is_narcotic: true, unit_label: 'amp' };
    await expect(recordMovement({
      ...base,
      movement_kind: 'adjust_decrease',
      witness_uid: 'cccccccc-0000-4000-8000-000000000003',
      witness_name: 'Caller Supplied',
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
      statusCode: 400,
    });
    expect(consumeWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: undefined,
      scope: 'inventory_controlled_movement',
      requestedBy: base.performed_by,
    }));
    expect(movementInserts()).toHaveLength(0);
    expect(registerInserts()).toHaveLength(0);
  });

  test('Schedule X dispose consumes an exact approval and records canonical witness identity', async () => {
    itemRow = { id: 7, schedule_class: 'X', is_narcotic: true, unit_label: 'amp' };
    const result = await recordMovement({
      ...base, movement_kind: 'dispose',
      witness_approval_id: '71',
      witness_uid: 'cccccccc-0000-4000-8000-000000000003',
      witness_name: 'Caller Supplied',
    });
    expect(movementInserts()).toHaveLength(1);
    const reg = registerInserts();
    expect(reg).toHaveLength(1);
    expect(reg[0].args[4]).toBe('dispose'); // register movement_kind
    expect(reg[0].args[10]).toBe('bbbbbbbb-0000-4000-8000-000000000002');
    expect(reg[0].args[11]).toBe('Roster Nurse');
    expect(result.register_entry).toMatchObject({ movement_kind: 'dispose' });
  });

  test('controlled decrements require a positive batch even when the caller disables safety', async () => {
    itemRow = { id: 7, schedule_class: 'H1', is_narcotic: false, unit_label: 'tab' };
    await expect(recordMovement({
      ...base,
      inventory_batch_id: null,
      movement_kind: 'adjust_decrease',
      require_usable_batch: false,
    })).rejects.toMatchObject({ code: 'INVENTORY_BATCH_REQUIRED', statusCode: 400 });
    expect(movementInserts()).toHaveLength(0);
  });

  test('controlled expiry write-off accepts an already-expired batch from the expiry scanner', async () => {
    itemRow = { id: 7, schedule_class: 'H1', is_narcotic: false, unit_label: 'tab' };
    batchRow = {
      id: 11,
      inventory_item_id: 7,
      batch_number: 'EXPIRED-1',
      lot_number: null,
      expiry_date: new Date('2025-01-01'),
      remaining_quantity: 30,
      status: 'expired',
      is_expired: true,
    };
    await expect(recordMovement({ ...base, movement_kind: 'expire' })).resolves.toMatchObject({
      register_entry: { movement_kind: 'dispose' },
    });
    expect(movementInserts()).toHaveLength(1);
  });

  test('controlled expiry write-off rejects a batch that has not expired', async () => {
    itemRow = { id: 7, schedule_class: 'H1', is_narcotic: false, unit_label: 'tab' };
    await expect(recordMovement({ ...base, movement_kind: 'expire' }))
      .rejects.toMatchObject({ code: 'INVENTORY_BATCH_NOT_EXPIRED', statusCode: 400 });
    expect(movementInserts()).toHaveLength(0);
  });

  test('movement approval payload excludes caller-selected witness fields', () => {
    expect(controlledMovementWitnessPayload({
      ...base,
      movement_kind: 'dispose',
      witness_uid: 'cccccccc-0000-4000-8000-000000000003',
      witness_name: 'Caller Supplied',
    })).not.toEqual(expect.objectContaining({
      witness_uid: expect.anything(),
      witness_name: expect.anything(),
    }));
  });

  test('Schedule H1 receipt writes a receive register row without a witness (BC-M1)', async () => {
    itemRow = { id: 7, schedule_class: 'H1', is_narcotic: false, unit_label: 'tab' };
    await recordMovement({ ...base, movement_kind: 'receive' });
    const reg = registerInserts();
    expect(reg).toHaveLength(1);
    expect(reg[0].args[4]).toBe('receive');
  });

  test('non-controlled movement is unaffected — no register row written', async () => {
    itemRow = { id: 7, schedule_class: 'OTC', is_narcotic: false, unit_label: 'tab' };
    await recordMovement({ ...base, movement_kind: 'issue' });
    expect(movementInserts()).toHaveLength(1);
    expect(registerInserts()).toHaveLength(0);
  });
});
