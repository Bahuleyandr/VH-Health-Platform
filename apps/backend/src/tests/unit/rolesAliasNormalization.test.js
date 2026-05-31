import { hasRole, normalizeRole } from '../../utils/roles.js';

describe('role alias normalization', () => {
  it.each([
    ['CONSULTANT_PHYSICIAN', 'CONSULTANT'],
    ['CHIEF_MEDICAL_OFFICER', 'CMO'],
    ['CHIEF_NURSING_OFFICER', 'CNO'],
    ['MEDICAL_SUPERINTENDANT', 'MEDICAL_SUPERINTENDENT'],
    ['NURSING_IN_CHARGE', 'NURSING_INCHARGE'],
    ['NURSING_SUPERINTENDENT', 'CNO'],
    ['STAFF_NURSE', 'NURSING_STAFF'],
    ['WARD_NURSE', 'NURSING_STAFF'],
    ['REGISTERED_NURSE', 'NURSING_STAFF'],
    ['HOUSEKEEPING_ATTENDANT', 'HOUSEKEEPING_STAFF'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeRole(input)).toBe(expected);
  });

  it('allows legacy clinical role labels through canonical RBAC gates', () => {
    expect(hasRole('CONSULTANT_PHYSICIAN', ['CONSULTANT'])).toBe(true);
    expect(hasRole('MEDICAL_SUPERINTENDANT', ['MEDICAL_SUPERINTENDENT'])).toBe(true);
    expect(hasRole('NURSING_IN_CHARGE', ['NURSING_INCHARGE'])).toBe(true);
    expect(hasRole('STAFF_NURSE', ['NURSING_STAFF'])).toBe(true);
    expect(hasRole('HOUSEKEEPING_ATTENDANT', ['HOUSEKEEPING_STAFF'])).toBe(true);
  });
});
