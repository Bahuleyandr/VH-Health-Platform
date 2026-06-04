// Investigation types
export const INVESTIGATION_TYPES = {
  LAB: 'LAB',
  RADIOLOGY: 'RADIOLOGY',
  PATHOLOGY: 'PATHOLOGY',
  CARDIOLOGY: 'CARDIOLOGY',
  PULMONARY: 'PULMONARY',
  ENDOSCOPY: 'ENDOSCOPY'
};

// Investigation status.
//
// Lifecycle: REQUESTED -> SCHEDULED -> COLLECTED -> IN_PROGRESS
// -> COMPLETED. PENDING is the legacy alias for the doctor-side view.
// CANCELLED is terminal from any state. COLLECTED slots between
// SCHEDULED and IN_PROGRESS so a phlebotomist can mark sample-drawn
// without claiming "running on the analyser" (E-5).
//
// REQUESTED is included so the DB default matches the validator —
// previously fresh orders failed the enum check
// (2026-05-08-walk-in-opd-doctor-investigation-status-requested-not-in-enum).
// COLLECTED added per
// 2026-05-08-lab-walk-in-lab-tech-status-enum-mismatch.
export const INVESTIGATION_STATUS = {
  REQUESTED: 'REQUESTED',
  PENDING: 'PENDING',
  SCHEDULED: 'SCHEDULED',
  COLLECTED: 'COLLECTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

// Priority levels.
// STAT is the ER door-to-decision tier (ECG within 10 min, troponin within
// 60 min), distinct from generic URGENT (4h SLA). Without an explicit
// STAT level, ER doctors had to chart STAT intent in the notes field and
// downstream lab worklists could not see it. Finding:
// 2026-05-10-emergency-walk-in-doctor-stat-investigation-context-lost.
export const PRIORITY_LEVELS = {
  STAT: 'STAT',
  URGENT: 'URGENT',
  HIGH: 'HIGH',
  NORMAL: 'NORMAL',
  LOW: 'LOW'
};

// Default turnaround_target_hours per priority when the catalog row does
// not carry an explicit turnaround. STAT/URGENT must surface against an
// hours-scale clock on the worklist, not the catch-all 24h default.
export const PRIORITY_TURNAROUND_HOURS = {
  STAT: 1,
  URGENT: 4,
  HIGH: 8,
  NORMAL: 24,
  LOW: 48,
};

// Pagination defaults
export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  DEFAULT_PAGE: 1
};

// Access roles. `LAB_STAFF` is the canonical role string used by the seed
// scripts (seed-test-staff-accounts.mjs), the route guards in app.js,
// roleHelpers.js, and rbacConfig.js. The `LAB_TECHNICIAN` alias was an
// orphaned name only this file used; keep it for forward-compat in case
// any caller still passes it. See finding
// 2026-05-08-lab-walk-in-lab-tech-rbac-lab-staff-blocked.
export const MEDICAL_STAFF_ROLES = [
  'DOCTOR',
  'NURSE',
  'NURSING_STAFF',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'OP_STAFF_NURSE',
  'OP_INCHARGE',
  'OT_NURSE',
  'OT_INCHARGE',
  'CATH_LAB_STAFF',
  'CATH_LAB_INCHARGE',
  'LAB_STAFF',
  'LAB_TECHNICIAN',
  'RADIOLOGIST',
  'ADMIN',
  'SUPER_ADMIN'
];
export const LAB_STAFF_ROLES = ['LAB_STAFF', 'LAB_TECHNICIAN', 'DOCTOR', 'RADIOLOGIST', 'ADMIN', 'SUPER_ADMIN'];
