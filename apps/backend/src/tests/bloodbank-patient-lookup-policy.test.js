import {
  BLOOD_BANK_ROUTE_ROLES,
  PATIENT_LOOKUP_ROUTE_ROLES,
} from '../config/routeRolePolicy.js';

describe('blood-bank patient lookup policy', () => {
  it('lets every blood-bank role resolve the patient required by a request', () => {
    const lookupRoles = new Set(PATIENT_LOOKUP_ROUTE_ROLES);
    const missingRoles = BLOOD_BANK_ROUTE_ROLES.filter(
      (role) => !lookupRoles.has(role),
    );

    expect(missingRoles).toEqual([]);
  });
});
