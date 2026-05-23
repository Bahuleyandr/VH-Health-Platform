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
  it('STAFF_ROLES includes ANAESTHETIST and RADIOLOGY_STAFF', () => {
    expect(STAFF_ROLES.ANAESTHETIST).toBe('ANAESTHETIST');
    expect(STAFF_ROLES.RADIOLOGY_STAFF).toBe('RADIOLOGY_STAFF');
  });

  it('ADMIN fan-out includes ANAESTHETIST and RADIOLOGY_STAFF (admins see all clinical roles)', () => {
    const admin = getStaffHierarchy('ADMIN');
    expect(admin).toEqual(expect.arrayContaining(['ANAESTHETIST', 'RADIOLOGY_STAFF']));
  });

  it('SUPER_ADMIN fan-out includes ANAESTHETIST and RADIOLOGY_STAFF + SUPER_ADMIN itself', () => {
    const su = getStaffHierarchy('SUPER_ADMIN');
    expect(su).toEqual(expect.arrayContaining(['ANAESTHETIST', 'RADIOLOGY_STAFF', 'SUPER_ADMIN']));
  });

  it('HR_STAFF fan-out includes ANAESTHETIST and RADIOLOGY_STAFF (HR manages full clinical roster)', () => {
    const hr = getStaffHierarchy('HR_STAFF');
    expect(hr).toEqual(expect.arrayContaining(['ANAESTHETIST', 'RADIOLOGY_STAFF']));
  });

  it('DOCTOR fan-out includes ANAESTHETIST (consultants see the OT anaesthesia roster)', () => {
    const doctor = getStaffHierarchy('DOCTOR');
    expect(doctor).toEqual(expect.arrayContaining(['ANAESTHETIST']));
  });

  it('ANAESTHETIST is a self-contained bucket — does not silently fall through to `[role]`', () => {
    const anaes = getStaffHierarchy('ANAESTHETIST');
    // Must be the hierarchy bucket (includes self + NURSING_STAFF), not
    // the bare-fallback `['ANAESTHETIST']`. Anaesthetists see their own
    // bucket plus the nursing staff they work with in OT.
    expect(anaes).toEqual(expect.arrayContaining(['ANAESTHETIST', 'NURSING_STAFF']));
  });

  it('RADIOLOGY_STAFF is its own self-contained bucket (like LAB_STAFF)', () => {
    const rad = getStaffHierarchy('RADIOLOGY_STAFF');
    expect(rad).toEqual(['RADIOLOGY_STAFF']);
  });
});
