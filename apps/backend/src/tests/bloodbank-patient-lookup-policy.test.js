import {
  BLOOD_BANK_PATIENT_LOOKUP_ROUTE_ROLES,
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

  it('only widens lookup to roles that already have blood-bank access', () => {
    expect(new Set(BLOOD_BANK_PATIENT_LOOKUP_ROUTE_ROLES)).toEqual(new Set([
      'BLOOD_BANK_STAFF',
      'BLOOD_BANK_TECHNICIAN',
      'DIALYSIS_TECHNICIAN',
      'LAB_INCHARGE',
      'PATHOLOGIST',
    ]));

    const bloodBankRoles = new Set(BLOOD_BANK_ROUTE_ROLES);
    expect(
      BLOOD_BANK_PATIENT_LOOKUP_ROUTE_ROLES.filter(
        (role) => !bloodBankRoles.has(role),
      ),
    ).toEqual([]);
  });
});
