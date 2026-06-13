import { STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES } from '../../config/routeRolePolicy.js';

describe('staff phone route policy', () => {
  it('allows ordinary staff roles through the phone self-service mount', () => {
    expect(STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'NURSING_STAFF',
      'DOCTOR',
      'HR_STAFF',
      'HOUSEKEEPING_STAFF',
      'GENERAL_STAFF',
      'ADMIN',
      'SUPER_ADMIN',
    ]));
  });

  it('keeps patient accounts out of staff phone self-service routes', () => {
    expect(STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES).not.toContain('PATIENT');
  });
});
