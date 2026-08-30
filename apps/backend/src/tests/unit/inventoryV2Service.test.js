import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const txMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txMock));
const assertPharmacyFacilityGrantMock = jest.fn(async () => ({
  actor: { uid: '11111111-1111-4111-8111-111111111111', role: 'PHARMACY_STAFF' },
  facility: { id: 23 },
  grant: { id: 31 },
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  isTenantTransactionClient: () => true,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  assertPharmacyFacilityGrant: assertPharmacyFacilityGrantMock,
}));

const {
  listItems,
  listBatches,
  listScheduleRegister,
  recordMovement,
} = await import('../../services/pharmacy/inventoryV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const FACILITY = 23;
const ACTOR_ROLE = 'PHARMACY_STAFF';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
  assertPharmacyFacilityGrantMock.mockClear();
});

describe('inventoryV2Service facility-scoped reads', () => {
  test('projects catalog and composition only after exact actor-facility authority', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listItems({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: ACTOR_ROLE,
      facilityId: FACILITY,
      catalogId: 17,
      search: 'morphine',
    });

    expect(assertPharmacyFacilityGrantMock).toHaveBeenCalledWith(txMock, {
      tenantId: TENANT,
      facilityId: FACILITY,
      actorUid: ACTOR,
      actorRole: ACTOR_ROLE,
    });
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/catalog_id/);
    expect(sql).toMatch(/composition_id/);
    expect(sql).toMatch(/facility_id = \$2::int/);
    expect(sql).toMatch(/catalog_id = \$4::int/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      TENANT,
      FACILITY,
      'active',
      17,
      '%morphine%',
      100,
    ]);
  });

  test('rejects a missing facility before opening a transaction', async () => {
    await expect(listItems({ tenantId: TENANT, actorUid: ACTOR, actorRole: ACTOR_ROLE }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PHARMACY_FACILITY_REQUIRED' });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  test('rejects an invalid exact catalog lookup before querying', async () => {
    await expect(listItems({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: ACTOR_ROLE,
      facilityId: FACILITY,
      catalogId: 'not-an-id',
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('binds the batch feed to the exact granted facility', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listBatches({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: ACTOR_ROLE,
      facility_id: FACILITY,
      item_id: 17,
    });

    expect(assertPharmacyFacilityGrantMock).toHaveBeenCalledWith(txMock, {
      tenantId: TENANT,
      facilityId: FACILITY,
      actorUid: ACTOR,
      actorRole: ACTOR_ROLE,
    });
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toContain('b.facility_id = $2::int');
    expect(sql).toContain('i.facility_id = b.facility_id');
    expect(sql).toContain("b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date");
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      TENANT,
      FACILITY,
      17,
      'in_stock',
      200,
    ]);
  });

  test('binds the statutory register to the exact granted facility', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: ACTOR_ROLE,
      facility_id: FACILITY,
      schedule_class: 'H1',
    });

    expect(assertPharmacyFacilityGrantMock).toHaveBeenCalledWith(txMock, {
      tenantId: TENANT,
      facilityId: FACILITY,
      actorUid: ACTOR,
      actorRole: ACTOR_ROLE,
    });
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toContain('FROM pharmacy_schedule_register register');
    expect(sql).toContain('register.facility_id = $2::int');
    expect(sql).toContain('item.tenant_id=register.tenant_id');
    expect(sql).toContain('item.facility_id=register.facility_id');
    expect(sql).toContain('batch.tenant_id=register.tenant_id');
    expect(sql).toContain('batch.inventory_item_id=register.inventory_item_id');
    expect(sql).toContain('batch.facility_id=register.facility_id');
    expect(sql).not.toContain('SELECT register.*');
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      TENANT,
      FACILITY,
      'H1',
      200,
    ]);
  });
});

describe('inventoryV2Service.recordMovement', () => {
  test('retires the caller-defined generic movement surface before storage', async () => {
    await expect(recordMovement({
      tenantId: TENANT,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      movement_kind: 'adjust_decrease',
      quantity: 1,
      performed_by: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 410,
      code: 'INVENTORY_GENERIC_MOVEMENT_RETIRED',
    });

    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });
});
