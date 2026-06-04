// Unit regression for finding H' D30.
//
// `STAFF_ROLES` lacked ANAESTHETIST (and RADIOLOGY_STAFF) even after
// the OT and admission services started honouring them as clinical
// roles. The staff registry (`/staff` list, `/staff/:uid`, `/auth/staff
// /profile`) filtered users by `WHERE u.role = ANY($staffRoles)`, so
// any genuine anaesthetist or radiology tech row was silently dropped
// from the list and returned 404 on the profile lookup — the same
// regression class as the SUPER_ADMIN one the comment in
// `staffConfig.js` already calls out.
//
// This test fences both surfaces:
//   1. STAFF_ROLES contains ANAESTHETIST and RADIOLOGY_STAFF.
//   2. The role hierarchy fan-out (`getStaffHierarchy`) treats
//      ANAESTHETIST as its own bucket plus self-includes it in the
//      DOCTOR and ADMIN/HR/SUPER_ADMIN fan-outs.
//   3. ADMIN/SUPER_ADMIN/HR fan-outs include RADIOLOGY_STAFF.
//
// Finding `aa11d8f2`.

import { STAFF_ROLES } from '../../config/staffConfig.js';
import { getStaffHierarchy } from '../../utils/staff/staffHelpers.js';

describe('STAFF_ROLES + getStaffHierarchy — anaesthetist + radiology coverage (H D30)', () => {
  it('STAFF_ROLES includes anaesthesia spellings, RADIOLOGY_STAFF, and desk roles', () => {
    expect(STAFF_ROLES.ANAESTHETIST).toBe('ANAESTHETIST');
    expect(STAFF_ROLES.ANESTHETIST).toBe('ANESTHETIST');
    expect(STAFF_ROLES.RADIOLOGY_STAFF).toBe('RADIOLOGY_STAFF');
    expect(STAFF_ROLES.IP_STAFF_NURSE).toBe('IP_STAFF_NURSE');
    expect(STAFF_ROLES.IP_INCHARGE).toBe('IP_INCHARGE');
    expect(STAFF_ROLES.OT_NURSE).toBe('OT_NURSE');
    expect(STAFF_ROLES.OT_INCHARGE).toBe('OT_INCHARGE');
    expect(STAFF_ROLES.OT_STAFF).toBe('OT_STAFF');
    expect(STAFF_ROLES.CATH_LAB_STAFF).toBe('CATH_LAB_STAFF');
    expect(STAFF_ROLES.CATH_LAB_INCHARGE).toBe('CATH_LAB_INCHARGE');
    expect(STAFF_ROLES.BILLING_STAFF).toBe('BILLING_STAFF');
    expect(STAFF_ROLES.BILLING_INCHARGE).toBe('BILLING_INCHARGE');
    expect(STAFF_ROLES.FINANCE_INCHARGE).toBe('FINANCE_INCHARGE');
    expect(STAFF_ROLES.ADMISSION_OFFICER).toBe('ADMISSION_OFFICER');
    expect(STAFF_ROLES.INSURANCE_COORDINATOR).toBe('INSURANCE_COORDINATOR');
    expect(STAFF_ROLES.IPD_COUNSELLOR).toBe('IPD_COUNSELLOR');
  });

  it('ADMIN fan-out includes ANAESTHETIST and RADIOLOGY_STAFF (admins see all clinical roles)', () => {
    const admin = getStaffHierarchy('ADMIN');
    expect(admin).toEqual(expect.arrayContaining(['ANAESTHETIST', 'ANESTHETIST', 'RADIOLOGY_STAFF']));
  });

  it('SUPER_ADMIN fan-out includes ANAESTHETIST and RADIOLOGY_STAFF + SUPER_ADMIN itself', () => {
    const su = getStaffHierarchy('SUPER_ADMIN');
    expect(su).toEqual(expect.arrayContaining(['ANAESTHETIST', 'ANESTHETIST', 'RADIOLOGY_STAFF', 'SUPER_ADMIN']));
  });

  it('HR_STAFF fan-out includes all onboardable clinical and operations roles', () => {
    const hr = getStaffHierarchy('HR_STAFF');
    expect(hr).toEqual(expect.arrayContaining([
      'ANAESTHETIST',
      'ANESTHETIST',
      'RADIOLOGY_STAFF',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'OT_NURSE',
      'OT_INCHARGE',
      'OT_STAFF',
      'CATH_LAB_STAFF',
      'CATH_LAB_INCHARGE',
      'BILLING_STAFF',
      'BILLING_INCHARGE',
      'FINANCE_INCHARGE',
      'ADMISSION_OFFICER',
      'INSURANCE_COORDINATOR',
      'IPD_COUNSELLOR',
      'DRIVER',
      'SECURITY',
      'EMERGENCY_RESPONDER',
    ]));
    expect(hr).not.toContain('ADMIN');
    expect(hr).not.toContain('SUPER_ADMIN');
  });

  it('DOCTOR fan-out includes ANAESTHETIST (consultants see the OT anaesthesia roster)', () => {
    const doctor = getStaffHierarchy('DOCTOR');
    expect(doctor).toEqual(expect.arrayContaining(['ANAESTHETIST', 'ANESTHETIST']));
  });

  it('ANAESTHETIST is a self-contained bucket — does not silently fall through to `[role]`', () => {
    const anaes = getStaffHierarchy('ANAESTHETIST');
    // Must be the hierarchy bucket (includes self + NURSING_STAFF), not
    // the bare-fallback `['ANAESTHETIST']`. Anaesthetists see their own
    // bucket plus the nursing staff they work with in OT.
    expect(anaes).toEqual(expect.arrayContaining(['ANAESTHETIST', 'ANESTHETIST', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OT_NURSE']));
  });

  it('ANESTHETIST is supported for theatre route compatibility', () => {
    const anest = getStaffHierarchy('ANESTHETIST');
    expect(anest).toEqual(expect.arrayContaining(['ANESTHETIST', 'ANAESTHETIST', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OT_NURSE']));
  });

  it('RADIOLOGY_STAFF is its own self-contained bucket (like LAB_STAFF)', () => {
    const rad = getStaffHierarchy('RADIOLOGY_STAFF');
    expect(rad).toEqual(['RADIOLOGY_STAFF']);
  });

  it('nursing subrole buckets separate OP, IP, OT, and Cath Lab teams', () => {
    expect(getStaffHierarchy('OP_INCHARGE')).toEqual(['OP_INCHARGE', 'OP_STAFF_NURSE']);
    expect(getStaffHierarchy('IP_INCHARGE')).toEqual(expect.arrayContaining(['IP_INCHARGE', 'NURSING_STAFF', 'IP_STAFF_NURSE']));
    expect(getStaffHierarchy('OT_INCHARGE')).toEqual(['OT_INCHARGE', 'OT_NURSE', 'OT_STAFF']);
    expect(getStaffHierarchy('OT_NURSE')).toEqual(['OT_NURSE', 'OT_STAFF']);
    expect(getStaffHierarchy('CATH_LAB_INCHARGE')).toEqual(['CATH_LAB_STAFF', 'CATH_LAB_INCHARGE']);
  });
});
