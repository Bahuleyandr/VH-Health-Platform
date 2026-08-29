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
const ACTOR = '00000000-0000-4000-8000-000000000002';

const NO_SHUTDOWN_BLOCKERS = {
  default_facility_assignment: 0,
  open_pharmacy_orders: 0,
  active_inventory_items: 0,
  active_inventory_batches: 0,
  nonterminal_purchase_orders: 0,
  nonterminal_goods_receipts: 0,
  active_ward_allocations: 0,
  open_ward_indents: 0,
  active_staff_grants: 0,
  // Cath facility shutdown blockers (migration 753 authority contract).
  open_cath_cases: 0,
  unreconciled_cath_usage: 0,
  open_cath_inventory_tasks: 0,
  open_cath_inventory_slas: 0,
  open_cath_authority_recoveries: 0,
};

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
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 2, facility_code: 'OLD', status: 'active', is_default: true,
    }]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2 }]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, facility_code: 'MAIN', status: 'active', is_default: true,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10 }]); // audit evidence
    const row = await upsertFacility({
      tenantId: TENANT, facilityCode: 'MAIN', displayName: 'Main Hospital',
      isDefault: true, createdBy: ACTOR,
    });
    expect(row.is_default).toBe(true);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/pg_advisory_xact_lock/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/ORDER BY id[\s\S]*FOR UPDATE/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/SET is_default=false/);
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(/INSERT INTO audit_logs/);
    expect(JSON.parse(queryUnsafeMock.mock.calls[4][5]).demoted_default_facility_ids).toEqual([2]);
  });

  it('updates an existing facility when id provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 7, facility_code: 'X', status: 'active', is_default: false },
      { id: 8, facility_code: 'MAIN', status: 'active', is_default: true },
    ]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([NO_SHUTDOWN_BLOCKERS]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_code: 'X', status: 'paused', is_default: false,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11 }]); // audit evidence
    const row = await upsertFacility({
      tenantId: TENANT, id: 7, facilityCode: 'X', displayName: 'X', status: 'paused',
      createdBy: ACTOR,
    });
    expect(row.status).toBe('paused');
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/FROM pharmacy_orders/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/FROM ward_indents/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/FROM pharmacy_staff_facility_grants/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/FROM cath_lab_cases cath_case/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/FROM cath_case_consumable_usage usage/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/cath_inventory_shortfall_v1/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/open_cath_authority_recoveries/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/case_facility_id/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/encounter_facility_id/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/catalog_facility_id/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/batch_facility_id/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/inventory_item_facility_id/);
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/UPDATE facilities/);
    const auditEvidence = JSON.parse(queryUnsafeMock.mock.calls[4][5]);
    expect(auditEvidence.before).toEqual({ status: 'active', is_default: false });
    expect(auditEvidence.after).toEqual({ status: 'paused', is_default: false });
    expect(auditEvidence.shutdown_evidence.total_blocker_count).toBe(0);
  });

  it('rejects a paused or archived tenant default before opening a transaction', async () => {
    await expect(upsertFacility({
      tenantId: TENANT,
      facilityCode: 'X',
      displayName: 'X',
      status: 'archived',
      isDefault: true,
    })).rejects.toMatchObject({ code: 'FACILITY_DEFAULT_MUST_BE_ACTIVE' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('fails closed with exact counts and recovery actions before deactivation', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 7, facility_code: 'X', status: 'active', is_default: false },
      { id: 8, facility_code: 'MAIN', status: 'active', is_default: true },
    ]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([{
      ...NO_SHUTDOWN_BLOCKERS,
      open_pharmacy_orders: 3,
      active_inventory_batches: 2,
      active_staff_grants: 1,
    }]);

    await expect(upsertFacility({
      tenantId: TENANT,
      id: 7,
      facilityCode: 'X',
      displayName: 'X',
      status: 'archived',
      createdBy: ACTOR,
    })).rejects.toMatchObject({
      code: 'FACILITY_DEACTIVATION_BLOCKED',
      details: {
        facility_id: 7,
        requested_status: 'archived',
        total_blocker_count: 6,
        blockers: {
          open_pharmacy_orders: 3,
          active_inventory_batches: 2,
          active_staff_grants: 1,
        },
        recovery_actions: [
          {
            blocker: 'open_pharmacy_orders',
            count: 3,
            action: 'COMPLETE_CANCEL_OR_REASSIGN_PHARMACY_ORDERS',
          },
          {
            blocker: 'active_inventory_batches',
            count: 2,
            action: 'TRANSFER_EXHAUST_OR_QUARANTINE_INVENTORY_BATCHES',
          },
          {
            blocker: 'active_staff_grants',
            count: 1,
            action: 'REVOKE_PHARMACY_FACILITY_GRANTS',
          },
        ],
      },
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
  });

  it('requires an atomic default switch before deactivating the current default', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_code: 'X', status: 'active', is_default: true,
    }]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([NO_SHUTDOWN_BLOCKERS]);

    await expect(upsertFacility({
      tenantId: TENANT,
      id: 7,
      facilityCode: 'X',
      displayName: 'X',
      status: 'paused',
      isDefault: false,
      createdBy: ACTOR,
    })).rejects.toMatchObject({
      code: 'FACILITY_DEACTIVATION_BLOCKED',
      details: {
        total_blocker_count: 1,
        blockers: { default_facility_assignment: 1 },
        recovery_actions: [{
          blocker: 'default_facility_assignment',
          count: 1,
          action: 'ASSIGN_ANOTHER_ACTIVE_DEFAULT_FACILITY',
        }],
      },
    });
  });

  it('fails closed on exact Cath facility workflow blockers', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 7, facility_code: 'X', status: 'active', is_default: false },
      { id: 8, facility_code: 'MAIN', status: 'active', is_default: true },
    ]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([{
      ...NO_SHUTDOWN_BLOCKERS,
      unreconciled_cath_usage: 2,
      open_cath_inventory_tasks: 1,
      open_cath_inventory_slas: 1,
      open_cath_authority_recoveries: 3,
    }]);

    await expect(upsertFacility({
      tenantId: TENANT,
      id: 7,
      facilityCode: 'X',
      displayName: 'X',
      status: 'paused',
      createdBy: ACTOR,
    })).rejects.toMatchObject({
      code: 'FACILITY_DEACTIVATION_BLOCKED',
      details: {
        total_blocker_count: 7,
        blockers: {
          unreconciled_cath_usage: 2,
          open_cath_inventory_tasks: 1,
          open_cath_inventory_slas: 1,
          open_cath_authority_recoveries: 3,
        },
        recovery_actions: [
          {
            blocker: 'unreconciled_cath_usage',
            count: 2,
            action: 'RECONCILE_OR_GOVERN_CATH_CONSUMABLE_USAGE',
          },
          {
            blocker: 'open_cath_inventory_tasks',
            count: 1,
            action: 'COMPLETE_CATH_INVENTORY_TASKS',
          },
          {
            blocker: 'open_cath_inventory_slas',
            count: 1,
            action: 'CLOSE_CATH_INVENTORY_SLAS_WITH_DOMAIN_EVIDENCE',
          },
          {
            blocker: 'open_cath_authority_recoveries',
            count: 3,
            action: 'RESOLVE_CATH_AUTHORITY_RECOVERY_WORKLIST',
          },
        ],
      },
    });
  });

  it('preserves the current default when is_default is omitted', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_code: 'X', status: 'active', is_default: true,
    }]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([]); // no other default to demote
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_code: 'X', status: 'active', is_default: true,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 14 }]); // audit evidence

    const row = await upsertFacility({
      tenantId: TENANT,
      id: 7,
      facilityCode: 'X',
      displayName: 'Renamed',
      status: 'active',
      createdBy: ACTOR,
    });

    expect(row.is_default).toBe(true);
    expect(queryUnsafeMock.mock.calls[3][16]).toBe(true);
  });

  it('rejects direct demotion of the active default without a replacement', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7, facility_code: 'X', status: 'active', is_default: true,
    }]); // row locks

    await expect(upsertFacility({
      tenantId: TENANT,
      id: 7,
      facilityCode: 'X',
      displayName: 'X',
      status: 'active',
      isDefault: false,
      createdBy: ACTOR,
    })).rejects.toMatchObject({
      code: 'FACILITY_DEFAULT_REPLACEMENT_REQUIRED',
      details: { recovery_action: 'ASSIGN_ANOTHER_ACTIVE_DEFAULT_FACILITY' },
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a non-default write would preserve a tenant with no active default', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([]); // row locks

    await expect(upsertFacility({
      tenantId: TENANT,
      facilityCode: 'X',
      displayName: 'X',
      isDefault: false,
      createdBy: ACTOR,
    })).rejects.toMatchObject({
      code: 'FACILITY_ACTIVE_DEFAULT_REQUIRED',
      details: { recovery_action: 'ASSIGN_ONE_ACTIVE_DEFAULT_FACILITY' },
    });
  });

  it('throws conflict on duplicate facility_code', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 8, facility_code: 'MAIN', status: 'active', is_default: true,
    }]); // row locks
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
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/status='active'[\s\S]*is_default = true/);
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
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 5, facility_code: 'DEFAULT', status: 'active',
      is_default: true, display_name: 'Apollo Hospital',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 12 }]); // audit evidence
    const row = await seedDefaultFacilityForTenant({ tenantId: TENANT });
    expect(row.display_name).toBe('Apollo Hospital');
  });

  it('falls back to "Default Facility" when tenant lookup empty', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // no default
    queryUnsafeMock.mockResolvedValueOnce([]); // no tenant
    queryUnsafeMock.mockResolvedValueOnce([]); // advisory lock
    queryUnsafeMock.mockResolvedValueOnce([]); // row locks
    queryUnsafeMock.mockResolvedValueOnce([]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 6, facility_code: 'DEFAULT', status: 'active',
      is_default: true, display_name: 'Default Facility',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 13 }]); // audit evidence
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
