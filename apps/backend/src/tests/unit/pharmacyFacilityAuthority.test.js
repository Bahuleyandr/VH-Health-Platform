import { jest } from '@jest/globals';

import {
  assertPharmacyFacilityGrant,
  requestedPharmacyFacilityId,
  requireOrderFacility,
  resolvePharmacyFacility,
} from '../../services/pharmacy/pharmacyFacilityAuthorityService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';

describe('pharmacy facility custody authority', () => {
  test('uses the sole active default facility under an explicit tenant predicate', async () => {
    const query = jest.fn().mockResolvedValue([{
      id: 7,
      facility_code: 'MAIN',
      display_name: 'Main Pharmacy',
    }]);

    await expect(resolvePharmacyFacility(
      { $queryRawUnsafe: query },
      {
        tenantId: TENANT,
        requestedFacilityId: null,
        forUpdate: true,
        requireActorGrant: false,
      },
    )).resolves.toEqual({
      id: 7,
      facility_code: 'MAIN',
      display_name: 'Main Pharmacy',
      actor_authority: null,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/tenant_id = \$1::uuid/);
    expect(query.mock.calls[0][0]).toMatch(/status = 'active'/);
    expect(query.mock.calls[0][0]).toMatch(/is_default\s*=\s*TRUE/);
    expect(query.mock.calls[0][0]).toMatch(/LIMIT 2[\s\S]*FOR UPDATE/);
    expect(query.mock.calls[0].slice(1)).toEqual([TENANT, null]);
  });

  test('write-locks canonical actor and grant rows before accepting custody authority', async () => {
    const actorUid = '22222222-2222-4222-8222-222222222222';
    const query = jest.fn()
      .mockResolvedValueOnce([{
        id: 22,
        uid: actorUid,
        role: 'PHARMACY_STAFF',
        staff_id: 12,
        staff_name: 'Pharmacist',
      }])
      .mockResolvedValueOnce([{
        id: '9223372036854775807',
        granted_at: new Date().toISOString(),
      }]);

    await expect(assertPharmacyFacilityGrant(
      { $queryRawUnsafe: query },
      {
        tenantId: TENANT,
        facilityId: 7,
        actorUid,
        actorRole: 'PHARMACY_STAFF',
        forUpdate: true,
      },
    )).resolves.toMatchObject({
      actor_uid: actorUid,
      facility_id: 7,
      grant_id: '9223372036854775807',
    });

    expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE OF actor/);
    expect(query.mock.calls[0][0]).not.toMatch(/FOR KEY SHARE/);
    expect(query.mock.calls[1][0]).toMatch(/FOR UPDATE/);
    expect(query.mock.calls[1][0]).not.toMatch(/FOR KEY SHARE/);
    expect(query.mock.calls[1][0]).toMatch(/id::text AS id/);
  });

  test.each([
    {
      name: 'missing default',
      rows: [],
      requestedFacilityId: null,
    },
    {
      name: 'ambiguous defaults',
      rows: [{ id: 7 }, { id: 8 }],
      requestedFacilityId: null,
    },
    {
      name: 'caller-selected non-default facility',
      rows: [],
      requestedFacilityId: 8,
    },
  ])('fails closed for $name', async ({ rows, requestedFacilityId }) => {
    const query = jest.fn().mockResolvedValue(rows);

    await expect(resolvePharmacyFacility(
      { $queryRawUnsafe: query },
      { tenantId: TENANT, requestedFacilityId },
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FACILITY_REQUIRED',
      details: {
        requested_facility_id: requestedFacilityId,
        recovery_action: 'contact_admin_to_configure_one_default_pharmacy_facility',
      },
    });
  });

  test('parses only positive facility ids from body, query, or header', () => {
    expect(requestedPharmacyFacilityId({ body: { facility_id: '7' } })).toBe(7);
    expect(requestedPharmacyFacilityId({ query: { facility_id: 8 } })).toBe(8);
    expect(requestedPharmacyFacilityId({ get: () => '9' })).toBe(9);
    expect(() => requestedPharmacyFacilityId({ body: { facility_id: '0' } }))
      .toThrow(expect.objectContaining({ code: 'PHARMACY_FACILITY_INVALID' }));
  });

  test('legacy facility-null orders expose a governed assignment recovery action', () => {
    expect(() => requireOrderFacility({ facility_id: null }))
      .toThrow(expect.objectContaining({
        statusCode: 409,
        code: 'PHARMACY_ORDER_FACILITY_UNRESOLVED',
        details: { recovery_action: 'assign_order_facility' },
      }));
    expect(requireOrderFacility({ facility_id: 7 })).toBe(7);
  });
});
