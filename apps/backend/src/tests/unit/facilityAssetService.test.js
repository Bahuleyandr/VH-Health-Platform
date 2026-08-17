/**
 * Facility asset register service (migration 704) — mocked-prisma unit suite.
 *
 * Pins the service-side guards the DB CHECKs back up:
 *   - vocabulary validation (category/condition/status) → clean 400s;
 *   - the status machine (active ⇄ under_repair → condemned → disposed,
 *     disposed terminal) → AppError.invalidTransition;
 *   - disposal evidence preflight → clean 422 BEFORE any transaction work
 *     (the 704 chk_facility_asset_disposal_evidence would otherwise surface
 *     as a raw constraint error);
 *   - duplicate asset tag (23505 on ux_facility_assets_tenant_tag) → 409;
 *   - master mutation + event append run on the SAME tx client.
 */
import { jest } from '@jest/globals';

const mockTx = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};
const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};
const setTenantTx = jest.fn(async (_tenantId, fn) => fn(mockTx));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenant: jest.fn(),
  setTenantTx,
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

let service;

beforeAll(async () => {
  service = await import('../../services/facility/facilityAssetService.js');
});

function assetRow(overrides = {}) {
  return {
    id: 7,
    tenant_id: TENANT_ID,
    asset_tag: 'GEN-02',
    name: 'Diesel generator 125 kVA',
    category: 'generator',
    description: null,
    location_department: 'Plant room',
    location_room: 'B-04',
    custodian_uid: null,
    vendor: null,
    purchase_date: null,
    purchase_cost: null,
    warranty_until: null,
    condition: 'good',
    status: 'active',
    version: 1,
    disposal_reason: null,
    disposed_at: null,
    disposed_by: null,
    created_by: ACTOR_UID,
    updated_by: ACTOR_UID,
    created_at: new Date('2026-08-16T10:00:00Z'),
    updated_at: new Date('2026-08-16T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mockTx.$queryRawUnsafe.mockReset();
  mockTx.$executeRawUnsafe.mockReset();
  mockPrisma.$queryRawUnsafe.mockReset();
  mockPrisma.$executeRawUnsafe.mockReset();
  setTenantTx.mockClear();
});

describe('facilityAssetService — vocabulary + creation', () => {
  it('creates the master row and the `created` event in the same transaction', async () => {
    mockTx.$queryRawUnsafe
      .mockResolvedValueOnce([assetRow()]) // INSERT master
      .mockResolvedValueOnce([]); // INSERT event
    const created = await service.createFacilityAsset(TENANT_ID, {
      assetTag: 'GEN-02',
      name: 'Diesel generator 125 kVA',
      category: 'generator',
      locationDepartment: 'Plant room',
      locationRoom: 'B-04',
    }, { actorUid: ACTOR_UID, actorRole: 'ADMIN' });

    expect(created).toMatchObject({ id: 7, assetTag: 'GEN-02', status: 'active' });
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(setTenantTx.mock.calls[0][0]).toBe(TENANT_ID);
    expect(mockTx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    const [eventSql, ...eventParams] = mockTx.$queryRawUnsafe.mock.calls[1];
    expect(eventSql).toContain('INSERT INTO facility_asset_events');
    expect(eventParams[0]).toBe(TENANT_ID); // explicit tenant predicate
    expect(eventParams[4]).toBe('created');
  });

  it('rejects a non-vocabulary category with a clean 400 before any DB work', async () => {
    await expect(service.createFacilityAsset(TENANT_ID, {
      assetTag: 'VENT-01',
      name: 'Ventilator', // biomed devices belong in the CMMS, not here
      category: 'ventilator',
    })).rejects.toMatchObject({ statusCode: 400, code: 'FACILITY_ASSET_INVALID' });
    expect(setTenantTx).not.toHaveBeenCalled();
  });

  it('maps the 23505 tag-unique violation onto a friendly 409', async () => {
    mockTx.$queryRawUnsafe.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint "ux_facility_assets_tenant_tag"'), {
        meta: { code: '23505' },
      }),
    );
    await expect(service.createFacilityAsset(TENANT_ID, {
      assetTag: 'GEN-02', name: 'Duplicate', category: 'generator',
    })).rejects.toMatchObject({ statusCode: 409, code: 'FACILITY_ASSET_TAG_EXISTS' });
  });

  it('rejects an unscoped custodian before inserting an asset', async () => {
    const otherTenantCustodian = '44444444-4444-4444-8444-444444444444';
    mockTx.$queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(service.createFacilityAsset(TENANT_ID, {
      assetTag: 'GEN-03',
      name: 'Standby generator',
      category: 'generator',
      custodianUid: otherTenantCustodian,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'FACILITY_ASSET_CUSTODIAN_INVALID',
    });
    expect(mockTx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('facilityAssetService — status machine', () => {
  it('allows active → under_repair and writes a repair_opened event same-tx', async () => {
    mockTx.$queryRawUnsafe
      .mockResolvedValueOnce([assetRow()]) // FOR UPDATE lock
      .mockResolvedValueOnce([assetRow({ status: 'under_repair' })]) // UPDATE
      .mockResolvedValueOnce([]); // event insert
    const updated = await service.transitionFacilityAssetStatus(TENANT_ID, 7, {
      toStatus: 'under_repair', notes: 'Coolant leak',
    }, { actorUid: ACTOR_UID, actorRole: 'MAINTENANCE' });
    expect(updated.status).toBe('under_repair');
    const [eventSql, ...eventParams] = mockTx.$queryRawUnsafe.mock.calls[2];
    expect(eventSql).toContain('INSERT INTO facility_asset_events');
    expect(eventParams[4]).toBe('repair_opened');
    expect(eventParams[5]).toBe('active'); // from_status
    expect(eventParams[6]).toBe('under_repair'); // to_status
  });

  it('rejects condemned → active (only disposal leaves condemned)', async () => {
    mockTx.$queryRawUnsafe.mockResolvedValueOnce([assetRow({ status: 'condemned' })]);
    await expect(service.transitionFacilityAssetStatus(TENANT_ID, 7, {
      toStatus: 'active',
    }, { actorUid: ACTOR_UID })).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { from: 'condemned', to: 'active', allowed: ['disposed'] },
    });
  });

  it('treats disposed as terminal', async () => {
    mockTx.$queryRawUnsafe.mockResolvedValueOnce([assetRow({
      status: 'disposed',
      disposal_reason: 'Beyond repair',
      disposed_at: new Date(),
      disposed_by: ACTOR_UID,
    })]);
    await expect(service.transitionFacilityAssetStatus(TENANT_ID, 7, {
      toStatus: 'active',
    }, { actorUid: ACTOR_UID })).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { from: 'disposed', to: 'active', allowed: [] },
    });
  });

  it('surfaces disposal-without-reason as a clean 422 before opening the transaction', async () => {
    await expect(service.transitionFacilityAssetStatus(TENANT_ID, 7, {
      toStatus: 'disposed',
    }, { actorUid: ACTOR_UID })).rejects.toMatchObject({
      statusCode: 422,
      code: 'FACILITY_ASSET_DISPOSAL_REASON_REQUIRED',
    });
    await expect(service.transitionFacilityAssetStatus(TENANT_ID, 7, {
      toStatus: 'disposed', reason: 'Written off',
    }, { actorUid: null })).rejects.toMatchObject({
      statusCode: 422,
      code: 'FACILITY_ASSET_DISPOSAL_ACTOR_REQUIRED',
    });
    expect(setTenantTx).not.toHaveBeenCalled();
  });

  it('stamps disposal evidence and writes the disposed event on a reasoned disposal', async () => {
    const disposedRow = assetRow({
      status: 'disposed',
      disposal_reason: 'Condemned by safety audit',
      disposed_at: new Date('2026-08-16T11:00:00Z'),
      disposed_by: ACTOR_UID,
    });
    mockTx.$queryRawUnsafe
      .mockResolvedValueOnce([assetRow({ status: 'condemned' })])
      .mockResolvedValueOnce([disposedRow])
      .mockResolvedValueOnce([]);
    const updated = await service.transitionFacilityAssetStatus(TENANT_ID, 7, {
      toStatus: 'disposed', reason: 'Condemned by safety audit',
    }, { actorUid: ACTOR_UID, actorRole: 'ADMIN' });
    expect(updated).toMatchObject({
      status: 'disposed',
      disposalReason: 'Condemned by safety audit',
      disposedBy: ACTOR_UID,
    });
    const updateParams = mockTx.$queryRawUnsafe.mock.calls[1];
    expect(updateParams[3]).toBe('disposed'); // target status
    expect(updateParams[4]).toBe('Condemned by safety audit'); // reason param
    expect(updateParams[5]).toBe(ACTOR_UID); // disposed_by
    const eventParams = mockTx.$queryRawUnsafe.mock.calls[2];
    expect(eventParams[5]).toBe('disposed'); // event_type ($5 after sql)
  });
});

describe('facilityAssetService — update + maintenance guards', () => {
  it('refuses status changes through updateFacilityAsset', async () => {
    await expect(service.updateFacilityAsset(TENANT_ID, 7, { status: 'disposed' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'FACILITY_ASSET_INVALID' });
    expect(setTenantTx).not.toHaveBeenCalled();
  });

  it('refuses edits and maintenance on a disposed asset', async () => {
    const disposed = assetRow({
      status: 'disposed',
      disposal_reason: 'Gone',
      disposed_at: new Date(),
      disposed_by: ACTOR_UID,
    });
    mockTx.$queryRawUnsafe.mockResolvedValueOnce([disposed]);
    await expect(service.updateFacilityAsset(TENANT_ID, 7, { name: 'Renamed', expectedVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FACILITY_ASSET_DISPOSED' });

    mockTx.$queryRawUnsafe.mockReset();
    mockTx.$queryRawUnsafe.mockResolvedValueOnce([disposed]);
    await expect(service.recordFacilityAssetMaintenance(TENANT_ID, 7, { notes: 'Oil change' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FACILITY_ASSET_DISPOSED' });
  });

  it('emits moved + custodian_assigned + condition_changed events per changed field group', async () => {
    const current = assetRow();
    const custodian = '33333333-3333-4333-8333-333333333333';
    const updated = assetRow({
      location_department: 'Ward A',
      location_room: 'A-01',
      custodian_uid: custodian,
      condition: 'fair',
    });
    mockTx.$queryRawUnsafe
      .mockResolvedValueOnce([current]) // lock
      .mockResolvedValueOnce([{ uid: custodian }]) // tenant-scoped custodian validation
      .mockResolvedValueOnce([updated]) // update
      .mockResolvedValue([]); // event inserts
    await service.updateFacilityAsset(TENANT_ID, 7, {
      expectedVersion: 1,
      locationDepartment: 'Ward A',
      locationRoom: 'A-01',
      custodianUid: custodian,
      condition: 'fair',
    }, { actorUid: ACTOR_UID, actorRole: 'ADMIN' });
    const eventTypes = mockTx.$queryRawUnsafe.mock.calls
      .slice(3)
      .map((call) => call[5]);
    expect(eventTypes).toEqual(['moved', 'custodian_assigned', 'condition_changed']);
  });

  it('rejects a custodian that is not a user in the asset tenant', async () => {
    const otherTenantCustodian = '44444444-4444-4444-8444-444444444444';
    mockTx.$queryRawUnsafe
      .mockResolvedValueOnce([assetRow()])
      .mockResolvedValueOnce([]);

    await expect(service.updateFacilityAsset(TENANT_ID, 7, {
      expectedVersion: 1,
      custodianUid: otherTenantCustodian,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'FACILITY_ASSET_CUSTODIAN_INVALID',
    });
    expect(mockTx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mockTx.$queryRawUnsafe.mock.calls[1][0]).toContain('tenant_id = $1::uuid');
    expect(mockTx.$queryRawUnsafe.mock.calls[1].slice(1)).toEqual([
      TENANT_ID,
      otherTenantCustodian,
    ]);
  });

  it('rejects a stale edit without updating the master row or appending events', async () => {
    mockTx.$queryRawUnsafe.mockResolvedValueOnce([assetRow({ version: 4 })]);

    await expect(service.updateFacilityAsset(TENANT_ID, 7, {
      expectedVersion: 3,
      name: 'Stale full-form name',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'FACILITY_ASSET_STALE_WRITE',
      details: { expectedVersion: 3, currentVersion: 4 },
    });
    expect(mockTx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('clears explicitly-null nullable master fields instead of restoring old values', async () => {
    const custodian = '33333333-3333-4333-8333-333333333333';
    const current = assetRow({
      description: 'Backup generator',
      location_department: 'Plant room',
      location_room: 'B-04',
      custodian_uid: custodian,
      vendor: 'Old vendor',
      purchase_date: '2025-01-02',
      purchase_cost: '1234.50',
      warranty_until: '2027-01-02',
    });
    const updated = assetRow({
      version: 2,
      description: null,
      location_department: null,
      location_room: null,
      custodian_uid: null,
      vendor: null,
      purchase_date: null,
      purchase_cost: null,
      warranty_until: null,
    });
    mockTx.$queryRawUnsafe
      .mockResolvedValueOnce([current])
      .mockResolvedValueOnce([updated])
      .mockResolvedValue([]);

    const result = await service.updateFacilityAsset(TENANT_ID, 7, {
      expectedVersion: 1,
      description: null,
      locationDepartment: null,
      locationRoom: null,
      custodianUid: null,
      vendor: null,
      purchaseDate: null,
      purchaseCost: null,
      warrantyUntil: null,
    }, { actorUid: ACTOR_UID, actorRole: 'ADMIN' });

    expect(result).toMatchObject({
      version: 2,
      description: null,
      locationDepartment: null,
      locationRoom: null,
      custodianUid: null,
      vendor: null,
      purchaseDate: null,
      purchaseCost: null,
      warrantyUntil: null,
    });
    const updateParams = mockTx.$queryRawUnsafe.mock.calls[1];
    expect(updateParams.slice(6, 14)).toEqual([
      null, null, null, null, null, null, null, null,
    ]);
    const eventTypes = mockTx.$queryRawUnsafe.mock.calls
      .slice(2)
      .map((call) => call[5]);
    expect(eventTypes).toEqual(['moved', 'custodian_assigned', 'updated']);
  });
});

describe('facilityAssetService — custodian picker', () => {
  it('lists only active non-patient users from the request tenant', async () => {
    const custodian = '33333333-3333-4333-8333-333333333333';
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      uid: custodian,
      name: 'Maya Rao',
      role: 'MAINTENANCE',
    }]);

    const result = await service.listFacilityAssetCustodians(TENANT_ID, {
      q: 'maya',
      limit: 50,
    });

    expect(result).toEqual({
      custodians: [{ uid: custodian, name: 'Maya Rao', role: 'MAINTENANCE' }],
      limit: 50,
    });
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).toContain("role <> 'PATIENT'");
    expect(sql).toContain('is_active IS TRUE');
    expect(params).toEqual([TENANT_ID, 'maya', 50]);
  });
});

describe('facilityAssetService — pagination', () => {
  it('keeps the filtered total when a later asset page is empty', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: null,
      total_count: 23,
    }]);

    const result = await service.listFacilityAssets(TENANT_ID, {
      limit: 10,
      offset: 30,
    });

    expect(result).toEqual({ assets: [], total: 23, limit: 10, offset: 30 });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0][0]).toContain('LEFT JOIN page ON TRUE');
  });

  it('keeps the filtered total when a later event page is empty', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      id: null,
      total_count: 9,
    }]);

    const result = await service.listFacilityAssetEvents(TENANT_ID, 7, {
      limit: 5,
      offset: 10,
    });

    expect(result).toEqual({ events: [], total: 9, limit: 5, offset: 10 });
  });

  it('rejects non-integer and out-of-range pagination before querying Postgres', async () => {
    await expect(service.listFacilityAssets(TENANT_ID, { offset: '12oops' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'FACILITY_ASSET_INVALID' });
    await expect(service.listFacilityAssets(TENANT_ID, { offset: 2_147_483_648 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'FACILITY_ASSET_INVALID' });
    await expect(service.listFacilityAssetEvents(TENANT_ID, 7, { limit: 201 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'FACILITY_ASSET_INVALID' });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
