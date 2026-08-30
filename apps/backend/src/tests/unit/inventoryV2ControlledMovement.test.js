import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const calls = { queries: [], executes: [] };
const assertFacilityGrantMock = jest.fn();
const approveWitnessApprovalMock = jest.fn();
const consumeWitnessApprovalMock = jest.fn();
const createWitnessApprovalMock = jest.fn();
const preflightWitnessApprovalMock = jest.fn();

const TENANT = '00000000-0000-4000-8000-000000000001';
const PERFORMER = 'aaaaaaaa-0000-4000-8000-000000000001';
const WITNESS = 'bbbbbbbb-0000-4000-8000-000000000002';
const FACILITY_ID = 3;

let chainRow;
let currentRemaining;
let movementRecord;
let priorMovements;
let registerRows;
let custodyBalancesByStatus;

const INVENTORY_SERVICE_SOURCE = readFileSync(
  new URL('../../services/pharmacy/inventoryV2Service.js', import.meta.url),
  'utf8',
);

function disposalChain(overrides = {}) {
  return {
    id: 7,
    catalog_id: 17,
    facility_id: FACILITY_ID,
    schedule_class: 'H1',
    is_narcotic: false,
    unit_label: 'tab',
    item_status: 'active',
    authoritative_catalog_id: 17,
    authoritative_batch_id: 11,
    batch_number: 'B1',
    lot_number: 'LOT-1',
    expiry_date: new Date('2027-01-01T00:00:00.000Z'),
    remaining_quantity: '30',
    batch_status: 'in_stock',
    supplier_id: 23,
    storage_location_id: 29,
    authoritative_supplier_id: 23,
    authoritative_storage_location_id: 29,
    ...overrides,
  };
}

function setChain(overrides = {}) {
  chainRow = disposalChain(overrides);
  currentRemaining = Number(chainRow.remaining_quantity);
}

function movementInserts() {
  return calls.queries.filter(({ sql }) => /INSERT INTO pharmacy_stock_movements/i.test(sql));
}

function registerInserts() {
  return calls.queries.filter(({ sql }) => /INSERT INTO pharmacy_schedule_register/i.test(sql));
}

function auditInserts() {
  return calls.executes.filter(({ sql }) => /INSERT INTO audit_logs/i.test(sql));
}

function controlledPerformerReads() {
  return calls.queries.filter(({ sql }) => /FROM users u[\s\S]*JOIN staff/i.test(sql));
}

function exportedFunctionSource(name) {
  const start = INVENTORY_SERVICE_SOURCE.indexOf(`export async function ${name}`);
  const next = INVENTORY_SERVICE_SOURCE.indexOf('\nexport async function ', start + 1);
  return INVENTORY_SERVICE_SOURCE.slice(start, next < 0 ? undefined : next);
}

const fakeTx = {
  async $queryRawUnsafe(sql, ...args) {
    calls.queries.push({ sql, args });
    if (/pg_advisory_xact_lock/i.test(sql)) {
      return [{ lock_acquired: 'ok' }];
    }
    if (/FROM tenants\s+WHERE id=/i.test(sql)) {
      return [{ id: TENANT }];
    }
    if (/FROM pharmacy_stock_movements movement[\s\S]*command_key_sha256/i.test(sql)) {
      return priorMovements;
    }
    if (/authoritative_storage_location_id[\s\S]*JOIN tenants tenant/i.test(sql)) {
      return [chainRow];
    }
    if (/FROM users u[\s\S]*JOIN staff/i.test(sql)) {
      return [{
        uid: PERFORMER,
        role: 'PHARMACY_INCHARGE',
        name: 'Canonical Pharmacist',
      }];
    }
    if (/FROM pharmacy_inventory_batches batch[\s\S]*FOR UPDATE OF batch/i.test(sql)) {
      return [{
        id: chainRow.authoritative_batch_id,
        inventory_item_id: chainRow.id,
        facility_id: chainRow.facility_id,
        batch_number: chainRow.batch_number,
        lot_number: chainRow.lot_number,
        expiry_date: chainRow.expiry_date,
        remaining_quantity: currentRemaining,
        status: chainRow.batch_status,
        schedule_class: chainRow.schedule_class,
        is_narcotic: chainRow.is_narcotic,
        is_expired: chainRow.expiry_date < new Date('2026-08-30T00:00:00.000Z'),
      }];
    }
    if (/INSERT INTO pharmacy_stock_movements/i.test(sql)) {
      movementRecord = {
        id: 999,
        tenant_id: args[0],
        inventory_item_id: args[1],
        inventory_batch_id: args[2],
        movement_kind: args[3],
        quantity_delta: args[4],
        reference_type: args[5],
        reference_id: args[6],
        performed_by: args[7],
        notes: args[8],
        metadata: JSON.parse(args[9]),
        created_at: new Date('2026-08-30T10:00:00.000Z'),
      };
      priorMovements = [movementRecord];
      return [movementRecord];
    }
    if (/UPDATE pharmacy_inventory_batches[\s\S]*RETURNING remaining_quantity::text AS remaining_quantity/i.test(sql)) {
      return [{
        remaining_quantity: String(currentRemaining),
        status: currentRemaining === 0 ? 'disposed' : chainRow.batch_status,
      }];
    }
    if (/SUM\(remaining_quantity\)/i.test(sql)) {
      const statuses = Array.isArray(args[3]) ? args[3] : [];
      const balance = custodyBalancesByStatus
        ? statuses.reduce((sum, status) => sum + Number(custodyBalancesByStatus[status] || 0), 0)
        : currentRemaining;
      return [{ balance: String(balance), bal: String(balance) }];
    }
    if (/INSERT INTO pharmacy_schedule_register/i.test(sql)) {
      const register = {
        id: 555,
        facility_id: args[1],
        inventory_item_id: args[2],
        inventory_batch_id: args[3],
        schedule_class: args[4],
        movement_kind: 'dispose',
        quantity: args[5],
        running_balance: args[7],
        performed_by: args[8],
        performed_by_name: args[9],
        witness_uid: args[10],
        witness_name: args[11],
        reference_movement_id: args[12],
      };
      registerRows = [register];
      return [register];
    }
    if (/FROM pharmacy_schedule_register[\s\S]*reference_movement_id/i.test(sql)) {
      return registerRows;
    }
    return [];
  },
  async $executeRawUnsafe(sql, ...args) {
    calls.executes.push({ sql, args });
    if (/UPDATE pharmacy_inventory_batches[\s\S]*remaining_quantity = remaining_quantity/i.test(sql)) {
      currentRemaining = Number((currentRemaining + Number(args[0])).toFixed(4));
    }
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
jest.unstable_mockModule(
  '../../services/pharmacy/pharmacyFacilityAuthorityService.js',
  () => ({ assertPharmacyFacilityGrant: assertFacilityGrantMock }),
);
jest.unstable_mockModule('../../services/pharmacy/controlledDispenseWitnessService.js', () => ({
  CONTROLLED_DISPENSE_APPROVAL_SCOPES: {
    inventory: 'inventory_controlled_dispense',
    inventoryMovement: 'inventory_controlled_movement',
    inventoryDisposal: 'pharmacy_inventory_controlled_disposal',
    pharmacyOrder: 'pharmacy_order_inventory_dispense',
    counterSale: 'pharmacy_counter_sale',
    dispenseSubstitution: 'pharmacy_dispense_substitution',
    wardIndent: 'ward_indent_controlled_handoff',
  },
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'DOCTOR'],
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES: [
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
  ],
  approveControlledDispenseWitnessApproval: approveWitnessApprovalMock,
  consumeControlledDispenseWitnessApproval: consumeWitnessApprovalMock,
  createControlledDispenseWitnessApproval: createWitnessApprovalMock,
  isControlledDispenseWitnessEvidence: () => false,
  preflightControlledDispenseWitnessApproval: preflightWitnessApprovalMock,
}));

const {
  approveInventoryMovementWitnessApproval,
  approveInventoryDisposalWitnessApproval,
  disposeInventoryBatch,
  preflightInventoryDisposalWitnessApproval,
  recordMovement,
  requestControlledMovementWitnessApproval,
  requestInventoryDisposalWitnessApproval,
} = await import('../../services/pharmacy/inventoryV2Service.js');

const baseIntent = {
  tenantId: TENANT,
  facility_id: FACILITY_ID,
  inventory_item_id: 7,
  inventory_batch_id: 11,
  quantity: 5,
  reason_code: 'damaged_stock',
  disposition_method: 'incineration',
  authority_reference: 'AUTH-7',
  expected_batch_number: 'B1',
  expected_lot_number: 'LOT-1',
  expected_expiry_date: '2027-01-01',
  notes: 'Quarantined stock destruction',
};
const disposeCommand = {
  ...baseIntent,
  performed_by: PERFORMER,
  actorRole: 'PHARMACY_INCHARGE',
  commandKey: 'inventory-disposal-unit-7',
  requestFingerprint: 'a'.repeat(64),
};

beforeEach(() => {
  calls.queries = [];
  calls.executes = [];
  movementRecord = null;
  priorMovements = [];
  registerRows = [];
  custodyBalancesByStatus = null;
  setChain();
  assertFacilityGrantMock.mockReset();
  assertFacilityGrantMock.mockResolvedValue({
    actor_uid: PERFORMER,
    actor_role: 'PHARMACY_INCHARGE',
    actor_name: 'Canonical Pharmacist',
    facility_id: FACILITY_ID,
    grant_id: 41,
  });
  createWitnessApprovalMock.mockReset();
  createWitnessApprovalMock.mockResolvedValue({ id: '71', status: 'pending' });
  approveWitnessApprovalMock.mockReset();
  approveWitnessApprovalMock.mockImplementation(async (params) => ({
    id: '71',
    status: 'approved',
    witness: {
      uid: WITNESS,
      name: 'Canonical Witness',
      role: 'PHARMACY_STAFF',
      facility_grant_id: '51',
    },
    resolved_payload: await params.resolvePayload({
      tx: fakeTx,
      requestedBy: PERFORMER,
      scope: 'pharmacy_inventory_controlled_disposal',
    }),
  }));
  preflightWitnessApprovalMock.mockReset();
  preflightWitnessApprovalMock.mockImplementation(async (params) => ({
    id: '71',
    resolved_payload: await params.resolvePayload({
      tx: fakeTx,
      requestedBy: PERFORMER,
      scope: 'pharmacy_inventory_controlled_disposal',
    }),
  }));
  consumeWitnessApprovalMock.mockReset();
  consumeWitnessApprovalMock.mockImplementation(async ({ approvalId }) => {
    if (!approvalId) {
      throw Object.assign(new Error('approval required'), {
        code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
        statusCode: 400,
      });
    }
    return {
      uid: WITNESS,
      name: 'Canonical Witness',
      role: 'PHARMACY_STAFF',
      facility_grant_id: '51',
    };
  });
});

describe('retired generic inventory mutation surface', () => {
  test.each([
    ['recordMovement', () => recordMovement({ ...disposeCommand, movement_kind: 'dispose' })],
    ['requestControlledMovementWitnessApproval', () => requestControlledMovementWitnessApproval({
      ...disposeCommand,
      requested_by: PERFORMER,
    })],
    ['approveInventoryMovementWitnessApproval', () => approveInventoryMovementWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      movement: disposeCommand,
    })],
  ])('%s is an explicit no-mutation 410 tombstone', async (_name, invoke) => {
    await expect(invoke()).rejects.toMatchObject({
      code: 'INVENTORY_GENERIC_MOVEMENT_RETIRED',
      statusCode: 410,
    });
    expect(calls.queries).toHaveLength(0);
    expect(calls.executes).toHaveLength(0);
  });
});

describe('controlled statutory register contract', () => {
  test('every register writer locks before movement and records exact facility custody', () => {
    const workflowSources = [
      'disposeInventoryBatch',
      'dispenseControlledTx',
      'dispenseWardControlledAllocationTx',
      'returnWardControlledAllocationTx',
    ].map(exportedFunctionSource);
    for (const source of workflowSources) {
      expect(source.indexOf('lockControlledRegisterItemTx(')).toBeGreaterThan(-1);
      expect(source.indexOf('lockControlledRegisterItemTx('))
        .toBeLessThan(source.indexOf('recordMovementTx('));
    }

    const disposalWriterStart = INVENTORY_SERVICE_SOURCE.indexOf(
      'async function appendInventoryDisposalRegisterTx',
    );
    const disposalWriterEnd = INVENTORY_SERVICE_SOURCE.indexOf(
      'async function appendInventoryDisposalAuditTx',
      disposalWriterStart,
    );
    const registerSources = [
      INVENTORY_SERVICE_SOURCE.slice(disposalWriterStart, disposalWriterEnd),
      ...workflowSources.slice(1),
    ];
    for (const source of registerSources) {
      expect(source).toContain('controlledCustodyBalanceTx(tx');
      expect(source).toContain('(tenant_id, facility_id, inventory_item_id');
      expect(source).toContain('canonicalControlledSchedule(');
    }
  });
});

describe('typed inventory disposal workflow', () => {
  test('rejects caller-selected authority and identity fields before opening a transaction', async () => {
    await expect(disposeInventoryBatch({
      ...disposeCommand,
      witness_uid: WITNESS,
      witness_facility_grant_id: '51',
      movement_kind: 'dispose',
      reference_type: 'caller-selected',
    })).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_CALLER_AUTHORITY_REJECTED',
      statusCode: 400,
      details: {
        forbidden_fields: expect.arrayContaining([
          'witness_uid', 'witness_facility_grant_id', 'movement_kind', 'reference_type',
        ]),
      },
    });
    expect(calls.queries).toHaveLength(0);
    expect(calls.executes).toHaveLength(0);
    expect(consumeWitnessApprovalMock).not.toHaveBeenCalled();
  });

  test('requires an exact positive batch identity', async () => {
    await expect(disposeInventoryBatch({
      ...disposeCommand,
      inventory_batch_id: null,
    })).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_INPUT_INVALID',
      statusCode: 400,
      details: { field: 'inventory_batch_id' },
    });
    expect(calls.queries).toHaveLength(0);
    expect(movementInserts()).toHaveLength(0);
  });

  test('accepts the exact NUMERIC(14,4) disposal quantity ceiling', async () => {
    setChain({
      schedule_class: 'OTC',
      is_narcotic: false,
      remaining_quantity: '9999999999.9999',
    });
    const result = await disposeInventoryBatch({
      ...disposeCommand,
      quantity: 9_999_999_999.9999,
    });

    expect(result.disposal).toMatchObject({
      quantity: 9_999_999_999.9999,
      resulting_batch_status: 'disposed',
    });
    expect(currentRemaining).toBe(0);
    expect(movementInserts()).toHaveLength(1);
  });

  test('rejects a high-magnitude fifth decimal before opening a transaction', async () => {
    await expect(disposeInventoryBatch({
      ...disposeCommand,
      quantity: 9_999_999_999.99991,
    })).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_INPUT_INVALID',
      statusCode: 400,
      details: { field: 'quantity' },
    });
    expect(calls.queries).toHaveLength(0);
    expect(calls.executes).toHaveLength(0);
  });

  test('rejects stale documented batch lineage before any stock mutation', async () => {
    await expect(disposeInventoryBatch({
      ...disposeCommand,
      expected_expiry_date: '2027-01-02',
    })).rejects.toMatchObject({
      code: 'INVENTORY_BATCH_LINEAGE_MISMATCH',
      statusCode: 400,
    });
    expect(movementInserts()).toHaveLength(0);
    expect(registerInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(0);
  });

  test('an already-expired Schedule H1 batch writes one typed disposal and statutory register row', async () => {
    setChain({
      batch_status: 'expired',
      expiry_date: new Date('2025-01-01T00:00:00.000Z'),
      remaining_quantity: '30',
    });
    const result = await disposeInventoryBatch({
      ...disposeCommand,
      quantity: 30,
      reason_code: 'expired_stock',
      expected_expiry_date: '2025-01-01',
    });

    expect(result).toMatchObject({
      idempotent_replay: false,
      disposal: {
        contract: 'pharmacy_inventory_disposal_v1',
        facility_id: FACILITY_ID,
        inventory_item_id: 7,
        inventory_batch_id: 11,
        quantity: 30,
        source_batch_status: 'expired',
        resulting_batch_status: 'disposed',
        performed_by: PERFORMER,
        facility_grant_id: '41',
        witness_uid: null,
        schedule_register_id: 555,
      },
      register_entry: {
        movement_kind: 'dispose',
        schedule_class: 'H1',
        witness_uid: null,
      },
    });
    expect(currentRemaining).toBe(0);
    expect(movementInserts()).toHaveLength(1);
    expect(registerInserts()).toHaveLength(1);
    expect(auditInserts()).toHaveLength(1);
    expect(consumeWitnessApprovalMock).not.toHaveBeenCalled();
  });

  test('statutory balance preserves every physical custody state and excludes terminal stock', async () => {
    setChain({ schedule_class: 'H1', is_narcotic: false, remaining_quantity: '30' });
    custodyBalancesByStatus = {
      in_stock: 25,
      reserved: 4,
      expired: 3,
      recalled: 2,
      quarantined: 1,
      depleted: 50,
      disposed: 60,
    };

    const result = await disposeInventoryBatch(disposeCommand);
    const balanceRead = calls.queries.find(({ sql }) => /SUM\(remaining_quantity\)/i.test(sql));

    expect(balanceRead.args).toEqual([
      TENANT,
      FACILITY_ID,
      7,
      ['in_stock', 'reserved', 'expired', 'recalled', 'quarantined'],
    ]);
    expect(result.register_entry.running_balance).toBe('35');
    expect(balanceRead.args[3]).not.toEqual(expect.arrayContaining(['depleted', 'disposed']));
  });

  test('Schedule X disposal refuses mutation without one exact approval', async () => {
    setChain({ schedule_class: 'X', is_narcotic: true, unit_label: 'amp' });
    await expect(disposeInventoryBatch(disposeCommand)).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
      statusCode: 400,
    });
    expect(consumeWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: null,
      scope: 'pharmacy_inventory_controlled_disposal',
      requestedBy: PERFORMER,
      payload: expect.objectContaining({
        contract: 'pharmacy_inventory_disposal_v1',
        facility_id: FACILITY_ID,
        facility_grant_id: '41',
        performer_role: 'PHARMACY_INCHARGE',
        catalog_id: 17,
        supplier_id: 23,
        storage_location_id: 29,
        batch_number: 'B1',
        source_batch_status: 'in_stock',
      }),
    }));
    expect(movementInserts()).toHaveLength(0);
    expect(registerInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(0);
  });

  test('Schedule X disposal records only the canonical consumed witness identity', async () => {
    setChain({ schedule_class: 'X', is_narcotic: true, unit_label: 'amp' });
    const result = await disposeInventoryBatch({
      ...disposeCommand,
      witness_approval_id: '71',
    });

    expect(result.disposal).toMatchObject({
      witness_approval_id: '71',
      witness_uid: WITNESS,
      witness_facility_grant_id: '51',
      performed_by: PERFORMER,
    });
    expect(result.register_entry).toMatchObject({
      schedule_class: 'X',
      movement_kind: 'dispose',
      performed_by: PERFORMER,
      performed_by_name: 'Canonical Pharmacist',
      witness_uid: WITNESS,
      witness_name: 'Canonical Witness',
    });
    expect(consumeWitnessApprovalMock).toHaveBeenCalledTimes(1);
    expect(movementInserts()).toHaveLength(1);
    expect(registerInserts()).toHaveLength(1);
    expect(auditInserts()).toHaveLength(1);
  });

  test('non-controlled disposal writes no controlled-substance register row', async () => {
    setChain({ schedule_class: 'OTC', is_narcotic: false });
    const result = await disposeInventoryBatch(disposeCommand);

    expect(result).toMatchObject({
      idempotent_replay: false,
      disposal: {
        schedule_register_id: null,
        witness_approval_id: null,
        witness_uid: null,
      },
      register_entry: null,
    });
    expect(movementInserts()).toHaveLength(1);
    expect(registerInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(1);
    expect(consumeWitnessApprovalMock).not.toHaveBeenCalled();
  });

  test('non-pharmacy facility roles cannot dispose even non-controlled stock', async () => {
    setChain({ schedule_class: 'OTC', is_narcotic: false });
    assertFacilityGrantMock.mockResolvedValueOnce({
      actor_uid: PERFORMER,
      actor_role: 'DELIVERY_STAFF',
      actor_name: 'Canonical Delivery Staff',
      facility_id: FACILITY_ID,
      grant_id: 41,
    });

    await expect(disposeInventoryBatch(disposeCommand)).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_PERFORMER_IDENTITY_REQUIRED',
      statusCode: 403,
    });
    expect(movementInserts()).toHaveLength(0);
    expect(registerInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(0);
  });

  test('OTC durable replay skips controlled identity and never duplicates its decrement or audit', async () => {
    setChain({ schedule_class: 'OTC', is_narcotic: false });
    const first = await disposeInventoryBatch(disposeCommand);
    const replay = await disposeInventoryBatch(disposeCommand);

    expect(first.idempotent_replay).toBe(false);
    expect(replay).toMatchObject({
      idempotent_replay: true,
      disposal: {
        movement_id: first.disposal.movement_id,
        schedule_register_id: null,
        command_key_sha256: first.disposal.command_key_sha256,
        request_sha256: first.disposal.request_sha256,
      },
      register_entry: null,
    });
    expect(currentRemaining).toBe(25);
    expect(movementInserts()).toHaveLength(1);
    expect(registerInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(1);
    expect(controlledPerformerReads()).toHaveLength(0);

    await expect(disposeInventoryBatch({
      ...disposeCommand,
      requestFingerprint: 'f'.repeat(64),
    })).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_IDEMPOTENCY_MISMATCH',
      statusCode: 409,
    });
    expect(currentRemaining).toBe(25);
    expect(movementInserts()).toHaveLength(1);
    expect(registerInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(1);
    expect(controlledPerformerReads()).toHaveLength(0);
  });

  test('completed replay fails closed without a receipt and revalidates a present receipt', async () => {
    setChain({ schedule_class: 'OTC', is_narcotic: false });
    await expect(disposeInventoryBatch({
      ...disposeCommand,
      requireExistingReceipt: true,
    })).rejects.toMatchObject({
      code: 'INVENTORY_DISPOSAL_COMPLETED_REPLAY_RECEIPT_REQUIRED',
      statusCode: 409,
    });
    expect(assertFacilityGrantMock).not.toHaveBeenCalled();
    expect(movementInserts()).toHaveLength(0);
    expect(auditInserts()).toHaveLength(0);

    const first = await disposeInventoryBatch(disposeCommand);
    assertFacilityGrantMock.mockClear();
    const replay = await disposeInventoryBatch({
      ...disposeCommand,
      requireExistingReceipt: true,
    });

    expect(first.idempotent_replay).toBe(false);
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.disposal.movement_id).toBe(first.disposal.movement_id);
    expect(assertFacilityGrantMock).toHaveBeenCalledTimes(1);
    expect(movementInserts()).toHaveLength(1);
    expect(auditInserts()).toHaveLength(1);
  });

  test.each(['active', 'paused', 'blacklisted', 'archived'])(
    'controlled disposal preserves exact supplier lineage when supplier is %s',
    async (supplierStatus) => {
      setChain({
        schedule_class: 'X',
        is_narcotic: true,
        supplier_status: supplierStatus,
      });
      await expect(requestInventoryDisposalWitnessApproval({
        ...baseIntent,
        requested_by: PERFORMER,
        actorRole: 'PHARMACY_INCHARGE',
      })).resolves.toMatchObject({ id: '71', status: 'pending' });

      const chainRead = calls.queries.find(({ sql }) => (
        /authoritative_storage_location_id[\s\S]*JOIN tenants tenant/i.test(sql)
      ));
      expect(chainRead.sql).toMatch(
        /supplier\.tenant_id=batch\.tenant_id[\s\S]*supplier\.id=batch\.supplier_id[\s\S]*supplier\.facility_id=batch\.facility_id/,
      );
      expect(chainRead.sql).not.toMatch(/supplier\.status\s*=\s*'active'/i);
      expect(createWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ supplier_id: 23 }),
      }));
    },
  );

  test('witness request and approval bind to the server-resolved disposal chain and requester', async () => {
    setChain({ schedule_class: 'X', is_narcotic: true, unit_label: 'amp' });
    const request = await requestInventoryDisposalWitnessApproval({
      ...baseIntent,
      requested_by: PERFORMER,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(request).toMatchObject({ id: '71', status: 'pending' });
    expect(createWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      scope: 'pharmacy_inventory_controlled_disposal',
      requestedBy: PERFORMER,
      payload: expect.objectContaining({
        contract: 'pharmacy_inventory_disposal_v1',
        facility_id: FACILITY_ID,
        facility_grant_id: '41',
        performer_role: 'PHARMACY_INCHARGE',
        inventory_item_id: 7,
        inventory_batch_id: 11,
        catalog_id: 17,
        supplier_id: 23,
        storage_location_id: 29,
        source_batch_status: 'in_stock',
      }),
    }));

    const preflight = await preflightInventoryDisposalWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      requesterUid: PERFORMER,
      disposal: baseIntent,
    });
    expect(preflight.resolved_payload).toMatchObject({
      contract: 'pharmacy_inventory_disposal_v1',
      facility_grant_id: '41',
      batch_number: 'B1',
    });
    expect(preflightWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      approvalId: 71,
      scope: 'pharmacy_inventory_controlled_disposal',
      requesterUid: PERFORMER,
      resolvePayload: expect.any(Function),
    }));

    const approved = await approveInventoryDisposalWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      disposal: baseIntent,
    });
    expect(approved).toMatchObject({
      id: '71',
      witness: { uid: WITNESS, name: 'Canonical Witness' },
      resolved_payload: expect.objectContaining({
        contract: 'pharmacy_inventory_disposal_v1',
        batch_number: 'B1',
        source_batch_status: 'in_stock',
      }),
    });
    expect(approveWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      scope: 'pharmacy_inventory_controlled_disposal',
      requesterUid: null,
      resolvePayload: expect.any(Function),
    }));
    expect(assertFacilityGrantMock.mock.calls.at(-1)[1]).toMatchObject({
      actorUid: PERFORMER,
      facilityId: FACILITY_ID,
      forUpdate: true,
    });
  });
});

async function expectInventoryDisposalReceiptConflict({
  chainOverrides = { schedule_class: 'OTC', is_narcotic: false },
  commandOverrides = {},
  corrupt,
  expectedRegisterInserts = 0,
}) {
  setChain(chainOverrides);
  const command = { ...disposeCommand, ...commandOverrides };
  const first = await disposeInventoryBatch(command);
  const remainingAfterFirst = currentRemaining;

  expect(first.idempotent_replay).toBe(false);
  corrupt({
    movement: movementRecord,
    metadata: movementRecord.metadata,
    receipt: movementRecord.metadata.receipt,
    registers: registerRows,
  });

  await expect(disposeInventoryBatch(command)).rejects.toMatchObject({
    code: 'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
    statusCode: 409,
  });
  expect(currentRemaining).toBe(remainingAfterFirst);
  expect(movementInserts()).toHaveLength(1);
  expect(registerInserts()).toHaveLength(expectedRegisterInserts);
  expect(auditInserts()).toHaveLength(1);
}

describe('typed inventory disposal replay receipt corruption', () => {
  const controlledChain = {
    schedule_class: 'X',
    is_narcotic: true,
    unit_label: 'amp',
  };
  const controlledCommand = { witness_approval_id: '71' };

  test.each([
    {
      name: 'Schedule X identity is rewritten as non-controlled',
      corrupt: ({ receipt }) => {
        receipt.controlled_item = false;
        receipt.register_required = false;
        registerRows = [];
      },
    },
    {
      name: 'a controlled Schedule X disposal omits its register requirement and evidence',
      corrupt: ({ receipt }) => {
        receipt.register_required = false;
        registerRows = [];
      },
    },
    {
      name: 'Schedule X marks its witness unnecessary while retaining witness evidence',
      corrupt: ({ receipt }) => {
        receipt.witness_required = false;
      },
    },
    {
      name: 'Schedule X erases required witness evidence consistently from both ledgers',
      corrupt: ({ metadata, receipt, registers }) => {
        metadata.witness_approval_id = null;
        receipt.witness_approval_id = null;
        receipt.witness_uid = null;
        receipt.witness_name = null;
        receipt.witness_role = null;
        receipt.witness_facility_grant_id = null;
        registers[0].witness_uid = null;
        registers[0].witness_name = null;
      },
    },
    {
      name: 'Schedule X claims a clinical witness without pharmacy facility custody',
      corrupt: ({ receipt }) => {
        receipt.witness_role = 'DOCTOR';
      },
    },
    {
      name: 'Schedule X omits the exact witness pharmacy grant provenance',
      corrupt: ({ receipt }) => {
        receipt.witness_facility_grant_id = null;
      },
    },
  ])('rejects replay when $name', async ({ corrupt }) => {
    await expectInventoryDisposalReceiptConflict({
      chainOverrides: controlledChain,
      commandOverrides: controlledCommand,
      corrupt,
      expectedRegisterInserts: 1,
    });
  });

  test('rejects unexpected witness evidence on a Schedule H1 disposal', async () => {
    await expectInventoryDisposalReceiptConflict({
      chainOverrides: {
        schedule_class: 'H1',
        is_narcotic: false,
      },
      expectedRegisterInserts: 1,
      corrupt: ({ metadata, receipt, registers }) => {
        metadata.witness_approval_id = '71';
        receipt.witness_approval_id = '71';
        receipt.witness_uid = WITNESS;
        receipt.witness_name = 'Canonical Witness';
        receipt.witness_role = 'PHARMACY_STAFF';
        receipt.witness_facility_grant_id = '51';
        registers[0].witness_uid = WITNESS;
        registers[0].witness_name = 'Canonical Witness';
      },
    });
  });

  test.each([
    {
      name: 'quantity is non-positive even though the movement and stock arithmetic agree',
      corrupt: ({ movement, receipt }) => {
        movement.quantity_delta = 0;
        receipt.quantity = 0;
        receipt.remaining_quantity_before = 25;
        receipt.remaining_quantity_after = 25;
      },
    },
    {
      name: 'remaining quantity does not equal before minus disposed quantity',
      corrupt: ({ receipt }) => {
        receipt.remaining_quantity_after = 26;
      },
    },
    {
      name: 'a partial disposal claims a terminal disposed batch status',
      corrupt: ({ receipt }) => {
        receipt.resulting_batch_status = 'disposed';
      },
    },
  ])('rejects replay when $name', async ({ corrupt }) => {
    await expectInventoryDisposalReceiptConflict({ corrupt });
  });

  test('rejects a zero-balance receipt that preserves the source batch status', async () => {
    await expectInventoryDisposalReceiptConflict({
      commandOverrides: { quantity: 30 },
      corrupt: ({ receipt }) => {
        receipt.resulting_batch_status = receipt.source_batch_status;
      },
    });
  });

  test.each([
    {
      name: 'inventory item ID is non-positive across receipt and movement',
      corrupt: ({ movement, receipt }) => {
        movement.inventory_item_id = 0;
        receipt.inventory_item_id = 0;
      },
    },
    {
      name: 'inventory batch ID is non-positive across receipt, movement, and reference',
      corrupt: ({ movement, receipt }) => {
        movement.inventory_batch_id = 0;
        movement.reference_id = '0';
        receipt.inventory_batch_id = 0;
      },
    },
    {
      name: 'catalog ID is non-positive',
      corrupt: ({ receipt }) => {
        receipt.catalog_id = 0;
      },
    },
    {
      name: 'supplier ID is non-positive',
      corrupt: ({ receipt }) => {
        receipt.supplier_id = 0;
      },
    },
    {
      name: 'storage-location ID is non-positive',
      corrupt: ({ receipt }) => {
        receipt.storage_location_id = 0;
      },
    },
    {
      name: 'facility-grant ID is non-positive',
      corrupt: ({ receipt }) => {
        receipt.facility_grant_id = 0;
      },
    },
    {
      name: 'performer UID is absent from both receipt and movement',
      corrupt: ({ movement, receipt }) => {
        movement.performed_by = null;
        receipt.performed_by = null;
      },
    },
    {
      name: 'performer canonical name is blank',
      corrupt: ({ receipt }) => {
        receipt.performed_by_name = '   ';
      },
    },
    {
      name: 'performer role is outside the disposal authority roster',
      corrupt: ({ receipt }) => {
        receipt.performer_role = 'DELIVERY_STAFF';
      },
    },
  ])('rejects replay when $name', async ({ corrupt }) => {
    await expectInventoryDisposalReceiptConflict({ corrupt });
  });
});
