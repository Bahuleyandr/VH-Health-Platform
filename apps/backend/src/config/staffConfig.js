// Staff role definitions.
//
// SUPER_ADMIN is included here even though jwtMiddleware normalizes
// SUPER_ADMIN→ADMIN at the request boundary. The JWT-claim normalization
// is for RBAC route gating (super-admins can do everything an admin can);
// but the staff hierarchy used by `getStaffHierarchy()` keys off the
// stored `users.role` column, which still holds the unnormalized
// 'SUPER_ADMIN' string. Without SUPER_ADMIN here, `Object.values(STAFF_ROLES)`
// excludes it, and ANY admin (including a super-admin viewing their own
// profile) ends up with `WHERE u.role = ANY([no super_admin])` → 0 rows
// → 404 on /staff/:uid and /auth/staff/profile.
// H' D30 — ANAESTHETIST joined the role allowlist after the OT and
// admission services started honouring it as a clinical-doctor role
// (admissionService.assertDoctorUid, theatreService anaesthesia chart
// surfaces, surgicalDocumentationService.anesthesia_records.anesthetist).
// Before this entry the role was rejected by the staff registry: any
// /staff list query filtered on ANY(STAFF_ROLES) silently dropped
// ANAESTHETIST rows, and /staff/:uid / /auth/staff/profile returned
// 404 for a real anaesthetist because the row's stored role wasn't in
// the hierarchy fan-out — same regression class as the SUPER_ADMIN
// fix noted above. Finding 2026-05-22-..._aa11d8f2.
// RADIOLOGY_STAFF mirrors the same problem for the radiology role
// gates added in PR #196 (acquire endpoint inner-RBAC).
export const STAFF_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  DOCTOR: 'DOCTOR',
  ANAESTHETIST: 'ANAESTHETIST',
  NURSING_STAFF: 'NURSING_STAFF',
  PHARMACY_STAFF: 'PHARMACY_STAFF',
  LAB_STAFF: 'LAB_STAFF',
  RADIOLOGY_STAFF: 'RADIOLOGY_STAFF',
  HR_STAFF: 'HR_STAFF',
  GENERAL_STAFF: 'GENERAL_STAFF',
  RECEPTIONIST: 'RECEPTIONIST',
  SECURITY: 'SECURITY',
  MAINTENANCE: 'MAINTENANCE',
  EMERGENCY_RESPONDER: 'EMERGENCY_RESPONDER'
};

// Shift types and working hours
export const SHIFT_TYPES = {
  MORNING: { name: 'MORNING', start: '06:00', end: '14:00', duration: 8 },
  AFTERNOON: { name: 'AFTERNOON', start: '14:00', end: '22:00', duration: 8 },
  NIGHT: { name: 'NIGHT', start: '22:00', end: '06:00', duration: 8 },
  FULL_DAY: { name: 'FULL_DAY', start: '09:00', end: '17:00', duration: 8 },
  ON_CALL: { name: 'ON_CALL', start: 'flexible', end: 'flexible', duration: 0 }
};