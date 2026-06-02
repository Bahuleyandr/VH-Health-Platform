import { canAllocateIcuBedForAdmission } from '../../services/emr/admissionService.js';

describe('admission ICU bed allocation roles', () => {
  it.each([
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'JUNIOR_DOCTOR',
    'ADMIN',
    'SUPER_ADMIN',
    'MEDICAL_SUPERINTENDENT',
    'ICU_NURSE',
    'ICU_INCHARGE',
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
  ])('allows %s to allocate an ICU bed at admission time', (role) => {
    expect(canAllocateIcuBedForAdmission(role)).toBe(true);
  });

  it('normalizes known aliases before checking ICU allocation permission', () => {
    expect(canAllocateIcuBedForAdmission('nurse')).toBe(false);
    expect(canAllocateIcuBedForAdmission('medical_superintendant')).toBe(true);
  });

  it.each([
    'NURSING_STAFF',
    'STAFF_NURSE',
    'PHARMACY_STAFF',
    'LAB_STAFF',
    'HR_STAFF',
    'BILLING_STAFF',
  ])('keeps %s blocked from independent ICU bed allocation', (role) => {
    expect(canAllocateIcuBedForAdmission(role)).toBe(false);
  });
});
