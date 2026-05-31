import { hasRole } from '../../utils/roles.js';
import {
  PATIENT_LOOKUP_ROLES,
  PATIENT_REGISTRY_WRITE_ROLES,
} from '../../config/patientAccessRoles.js';

describe('patient access role gates', () => {
  it.each([
    'DOCTOR',
    'CONSULTANT',
    'CONSULTANT_PHYSICIAN',
    'DUTY_MEDICAL_OFFICER',
    'NURSING_STAFF',
    'STAFF_NURSE',
    'MEDICAL_SUPERINTENDANT',
    'NURSING_SUPERINTENDENT',
    'RECEPTIONIST',
    'ADMISSION_OFFICER',
    'BILLING_STAFF',
    'MEDICAL_RECORDS',
  ])('allows %s to search patient demographics', (role) => {
    expect(hasRole(role, PATIENT_LOOKUP_ROLES)).toBe(true);
  });

  it.each([
    'GENERAL_STAFF',
    'HOUSEKEEPING_STAFF',
    'HOUSEKEEPING_ATTENDANT',
    'MAINTENANCE',
    'DRIVER',
    'HR_STAFF',
  ])('does not allow %s to search patient demographics', (role) => {
    expect(hasRole(role, PATIENT_LOOKUP_ROLES)).toBe(false);
  });

  it.each([
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
    'BILLING_STAFF',
    'MEDICAL_RECORDS',
    'ADMIN',
  ])('allows %s to create or update patient registry demographics', (role) => {
    expect(hasRole(role, PATIENT_REGISTRY_WRITE_ROLES)).toBe(true);
  });

  it.each([
    'DOCTOR',
    'CONSULTANT',
    'NURSING_STAFF',
    'STAFF_NURSE',
    'GENERAL_STAFF',
  ])('does not allow %s to create or update patient registry demographics', (role) => {
    expect(hasRole(role, PATIENT_REGISTRY_WRITE_ROLES)).toBe(false);
  });
});
