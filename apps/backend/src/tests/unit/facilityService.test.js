/**
 * Phase C1 — facilityService unit tests.
 *
 * Covers validation, default-demotion, hierarchy guards, and SQL load
 * shape across facilities / facility_locations / facility_rooms /
 * service_catalog. Mocks prisma.$queryRawUnsafe.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  getDefaultFacility,
  listFacilities,
  listLocations,
  listRooms,
  listServices,
  seedDefaultFacilityForTenant,
  upsertFacility,
  upsertLocation,
  upsertRoom,
  upsertService,
  __testing__,
} = await import('../../services/facility/facilityService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

describe('upsertFacility', () => {
  it('rejects missing facility_code', async () => {
    await expect(upsertFacility({ tenantId: TENANT, displayName: 'X' }))
      .rejects.toThrow(/facility_code is required/);
  });

  it('rejects missing display_name', async () => {
    await expect(upsertFacility({ tenantId: TENANT, facilityCode: 'X' }))
      .rejects.toThrow(/display_name is required/);
  });

  it('rejects unknown facility_kind', async () => {
    await expect(upsertFacility({
      tenantId: TENANT, facilityCode: 'X', displayName: 'X', facilityKind: 'spaceship',
    })).rejects.toThrow(/facility_kind must be one of/);
  });

  it('rejects out-of-range geo coordinates', async () => {
    await expect(upsertFacility({
      tenantId: TENANT, facilityCode: 'X', displayName: 'X', geoLat: 100,
    })).rejects.toThrow(/geo_lat must be <= 90/);
    await expect(upsertFacility({
      tenantId: TENANT, facilityCode: 'X', displayName: 'X', geoLng: 200,
    })).rejects.toThrow(/geo_lng must be <= 180/);
  });

  it('demotes other defaults when isDefault=true', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, is_default: true }]);
    const row = await upsertFacility({
      tenantId: TENANT, facilityCode: 'MAIN', displayName: 'Main Hospital',
      isDefault: true,
    });
    expect(row.is_default).toBe(true);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET is_default = false/);
  });

  it('updates an existing facility when id provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, status: 'paused' }]);
    const row = await upsertFacility({
      tenantId: TENANT, id: 7, facilityCode: 'X', displayName: 'X', status: 'paused',
    });
    expect(row.status).toBe('paused');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/UPDATE facilities/);
  });

  it('throws conflict on duplicate facility_code', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertFacility({
      tenantId: TENANT, facilityCode: 'X', displayName: 'X',
    })).rejects.toThrow(/already exists/);
  });
});

describe('listFacilities + getDefaultFacility', () => {
  it('listFacilities orders is_default DESC', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, is_default: true }]);
    await listFacilities({ tenantId: TENANT });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY is_default DESC/);
  });

  it('listFacilities degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "facilities" does not exist'));
    expect(await listFacilities({ tenantId: TENANT })).toEqual({ facilities: [], count: 0 });
  });

  it('getDefaultFacility returns null when none', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    expect(await getDefaultFacility({ tenantId: TENANT })).toBeNull();
  });
});

describe('seedDefaultFacilityForTenant', () => {
  it('returns existing default when present', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, is_default: true, display_name: 'Existing' }]);
    const row = await seedDefaultFacilityForTenant({ tenantId: TENANT });
    expect(row.id).toBe(1);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('creates a default from tenant.name when none exists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // getDefaultFacility -> none
    queryUnsafeMock.mockResolvedValueOnce([{ name: 'Apollo Hospital' }]); // tenant lookup
    queryUnsafeMock.mockResolvedValueOnce([]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, is_default: true, display_name: 'Apollo Hospital' }]);
    const row = await seedDefaultFacilityForTenant({ tenantId: TENANT });
    expect(row.display_name).toBe('Apollo Hospital');
  });

  it('falls back to "Default Facility" when tenant lookup empty', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // no default
    queryUnsafeMock.mockResolvedValueOnce([]); // no tenant
    queryUnsafeMock.mockResolvedValueOnce([]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{ id: 6, display_name: 'Default Facility' }]);
    const row = await seedDefaultFacilityForTenant({ tenantId: TENANT });
    expect(row.display_name).toBe('Default Facility');
  });
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

describe('upsertLocation', () => {
  it('rejects missing location_code', async () => {
    await expect(upsertLocation({
      tenantId: TENANT, facilityId: 1, displayName: 'X',
    })).rejects.toThrow(/location_code is required/);
  });

  it('rejects parent_id == id (self-parent)', async () => {
    await expect(upsertLocation({
      tenantId: TENANT, id: 5, facilityId: 1, parentId: 5,
      locationCode: 'X', displayName: 'X',
    })).rejects.toThrow(/parent_id cannot equal id/);
  });

  it('rejects unknown location_kind', async () => {
    await expect(upsertLocation({
      tenantId: TENANT, facilityId: 1, locationCode: 'X', displayName: 'X',
      locationKind: 'mars',
    })).rejects.toThrow(/location_kind must be one of/);
  });

  it('inserts an OPD location', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, location_kind: 'opd' }]);
    const row = await upsertLocation({
      tenantId: TENANT, facilityId: 1, locationCode: 'OPD-1',
      displayName: 'OPD wing 1', locationKind: 'opd',
    });
    expect(row.location_kind).toBe('opd');
  });

  it('throws on FK violation (invalid facility_id or parent_id)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('insert or update violates foreign key constraint'));
    await expect(upsertLocation({
      tenantId: TENANT, facilityId: 999, locationCode: 'X', displayName: 'X',
    })).rejects.toThrow(/Invalid facility_id or parent_id/);
  });
});

describe('listLocations', () => {
  it('parent_id=null filters for top-level locations', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, parent_id: null }]);
    await listLocations({ tenantId: TENANT, parentId: null });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/parent_id IS NULL/);
  });

  it('parent_id=5 filters for children of that parent', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listLocations({ tenantId: TENANT, parentId: 5 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/parent_id = \$\d/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "facility_locations" does not exist'));
    expect(await listLocations({ tenantId: TENANT })).toEqual({ locations: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

describe('upsertRoom', () => {
  it('rejects unknown room_kind', async () => {
    await expect(upsertRoom({
      tenantId: TENANT, facilityId: 1, locationId: 1,
      roomCode: 'R1', displayName: 'R1', roomKind: 'penthouse',
    })).rejects.toThrow(/room_kind must be one of/);
  });

  it('rejects bed_capacity > 1000', async () => {
    await expect(upsertRoom({
      tenantId: TENANT, facilityId: 1, locationId: 1,
      roomCode: 'R1', displayName: 'R1', bedCapacity: 5000,
    })).rejects.toThrow(/bed_capacity must be <= 1000/);
  });

  it('inserts an OT room', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, room_kind: 'ot' }]);
    const row = await upsertRoom({
      tenantId: TENANT, facilityId: 1, locationId: 1,
      roomCode: 'OT-1', displayName: 'OT 1', roomKind: 'ot', bedCapacity: 1,
    });
    expect(row.room_kind).toBe('ot');
  });
});

describe('listRooms', () => {
  it('filters by location_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listRooms({ tenantId: TENANT, locationId: 5 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/location_id = \$\d/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "facility_rooms" does not exist'));
    expect(await listRooms({ tenantId: TENANT })).toEqual({ rooms: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Service catalog
// ---------------------------------------------------------------------------

describe('upsertService', () => {
  it('rejects missing service_code', async () => {
    await expect(upsertService({ tenantId: TENANT, displayName: 'X' }))
      .rejects.toThrow(/service_code is required/);
  });

  it('rejects unknown service_kind', async () => {
    await expect(upsertService({
      tenantId: TENANT, serviceCode: 'X', displayName: 'X', serviceKind: 'magic',
    })).rejects.toThrow(/service_kind must be one of/);
  });

  it('inserts a teleconsult service', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, service_code: 'TELE_GP', is_telehealth_eligible: true,
    }]);
    const row = await upsertService({
      tenantId: TENANT, serviceCode: 'TELE_GP', displayName: 'GP Teleconsult',
      serviceKind: 'teleconsult', isTelehealthEligible: true, requiresAppointment: true,
    });
    expect(row.is_telehealth_eligible).toBe(true);
  });

  it('throws conflict on duplicate service_code', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertService({
      tenantId: TENANT, serviceCode: 'X', displayName: 'X',
    })).rejects.toThrow(/already exists/);
  });
});

describe('listServices', () => {
  it('filters by telehealthEligible=true', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listServices({ tenantId: TENANT, telehealthEligible: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/is_telehealth_eligible = \$\d/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "service_catalog" does not exist'));
    expect(await listServices({ tenantId: TENANT })).toEqual({ services: [], count: 0 });
  });
});

describe('exported allow-lists', () => {
  it('exports the canonical kind sets', () => {
    expect(__testing__.FACILITY_KINDS.length).toBe(8);
    expect(__testing__.LOCATION_KINDS.length).toBe(19);
    expect(__testing__.ROOM_KINDS.length).toBe(13);
    expect(__testing__.SERVICE_KINDS.length).toBe(12);
  });
});
