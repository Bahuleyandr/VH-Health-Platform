// Investigation types
export const INVESTIGATION_TYPES = {
  LAB: 'LAB',
  RADIOLOGY: 'RADIOLOGY',
  PATHOLOGY: 'PATHOLOGY',
  CARDIOLOGY: 'CARDIOLOGY',
  PULMONARY: 'PULMONARY',
  ENDOSCOPY: 'ENDOSCOPY'
};

// Investigation status. Includes REQUESTED as the initial state callers use
// when ordering — previously REQUESTED was outside the enum so the order
// service rejected fresh orders that hadn't yet been scheduled. See finding
// 2026-05-08-walk-in-opd-doctor-investigation-status-requested-not-in-enum.
export const INVESTIGATION_STATUS = {
  REQUESTED: 'REQUESTED',
  PENDING: 'PENDING',
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

// Priority levels
export const PRIORITY_LEVELS = {
  URGENT: 'URGENT',
  HIGH: 'HIGH',
  NORMAL: 'NORMAL',
  LOW: 'LOW'
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
export const MEDICAL_STAFF_ROLES = ['DOCTOR', 'NURSE', 'NURSING_STAFF', 'LAB_STAFF', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN', 'SUPER_ADMIN'];
export const LAB_STAFF_ROLES = ['LAB_STAFF', 'LAB_TECHNICIAN', 'DOCTOR', 'RADIOLOGIST', 'ADMIN', 'SUPER_ADMIN'];