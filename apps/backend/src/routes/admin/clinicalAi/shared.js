import { error } from '../../../utils/responseHelper.js';

// Control-plane roles — govern the clinical AI system: configure modules,
// approve prompt activations, view audit, run drift canary, manage break-
// glass, etc. Admin- and IT-class only.
const CLINICAL_AI_CONTROL_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'IT',
  'IT_ADMIN',
  'IT_STAFF',
  'SYSTEM_ADMIN',
]);

// Clinical-use roles — the OUTER door for /api/v1/clinical-ai/clinical/*.
//
// This list is the union of every clinical_ai_modules.settings.reviewRoles[]
// across the catalog plus the canonical role groups from utils/roleHelpers.js
// (CLINICAL_ROLES + DISCHARGE_SUMMARY_VIEW_ROLES + ALL_STAFF_ROLES) plus a
// few SUPER_ADMIN/ADMIN catch-alls.
//
// This is broad by design — the route guard's only job is to keep
// PATIENT, DELIVERY_STAFF, and unknown/anonymous roles out of clinical
// AI endpoints. The REAL filtering ("can role X sign off on module Y?")
// happens inside the service layer via per-module reviewRoles checks.
// See updateReview / listReviews in clinicalAiWorkflowService.js.
//
// Drift guard: src/tests/unit/clinicalAiRouteSplit.test.js verifies
// every reviewRole across all modules is on this list. When adding a
// new reviewer role to a module, add it here too — the test will fail
// loudly if you don't.
//
// Phase 0 of the rollout plan (docs/CLINICAL_AI_ROLLOUT_PLAN.md).
export const CLINICAL_AI_USER_ROLES_LIST = [
  // Direct-care clinical roles
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'RESIDENT',
  'MEDICAL_SUPERINTENDENT',
  'NURSING_STAFF',
  'NURSE',
  'NURSE_MANAGER',
  'ED_CHARGE_NURSE',
  'HOUSE_SUPERVISOR',
  'OBSTETRICIAN',
  'PULMONOLOGIST',
  'ICU_TEAM',
  'ANESTHETIST',
  'PHYSIOTHERAPIST',
  'DIETITIAN',

  // Clinical support
  'PHARMACY_STAFF',
  'PHARMACIST',
  'LAB_STAFF',
  'PATHOLOGIST',
  'RADIOLOGIST',
  'RADIOLOGY_STAFF',
  'BLOOD_BANK_TECHNICIAN',
  'BLOOD_BANK_STAFF',
  'OT_STAFF',
  'OT_MANAGER',
  'INFECTION_CONTROL_OFFICER',
  'INFECTION_CONTROL',

  // Records / quality / billing — legit reviewers on several modules
  'MEDICAL_RECORDS',
  'BILLING_STAFF',
  'FINANCE_STAFF',
  'INSURANCE_COORDINATOR',
  'QUALITY_OFFICER',
  'QUALITY_STAFF',
  'COMPLIANCE_OFFICER',
  'COMPLIANCE_LEAD',
  'LEGAL',

  // Operations — some modules surface operational reviewers
  'BED_MANAGER',
  'HOUSEKEEPING_STAFF',
  'BIOMEDICAL_STAFF',
  'FACILITY_MANAGER',
  'PROCUREMENT_LEAD',
  'MATERIALS_MANAGER',
  'SECURITY_OFFICER',
  'RECEPTIONIST',
  'HR_STAFF',
  'RESEARCH_COORDINATOR',

  // AI lifecycle / governance reviewers — some modules list these as
  // reviewers because the module IS itself an AI governance surface
  // (agent lifecycle, dataset labeling, federation, eval workbench).
  // Including them here lets those reviewers act via /clinical/* too;
  // they still need their role to be on the per-module reviewRoles list.
  'AI_GOVERNANCE',
  'AI_EVAL_LEAD',
  'TRAINING_LEAD',
  'DATA_LABELER',
  'DATA_ENGINEER',
  'IT_ADMIN',

  // Leadership
  'DEPARTMENT_HEAD',
  'CMO',
  'CNO',

  // Catch-alls
  'ADMIN',
  'SUPER_ADMIN',
];
const CLINICAL_AI_USER_ROLES = new Set(CLINICAL_AI_USER_ROLES_LIST);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

export function requireClinicalAiControl(req, res, next) {
  if (!req.user) {
    return error(res, 'Authentication required', 401, { safe: true });
  }

  const role = normalizeRole(req.user.role);
  if (!CLINICAL_AI_CONTROL_ROLES.has(role)) {
    return error(res, 'Clinical AI controls require Admin or IT privileges', 403, {
      safe: true,
    });
  }

  return next();
}

/**
 * Defense-in-depth gate for clinical-use routes (mounted at
 * /api/v1/clinical-ai/clinical/*). The outer mount-level requireRole(...)
 * in app.js is the first check; this is the second. Both must pass.
 *
 * Rejects 401 unauthenticated, 403 anyone whose role isn't on the
 * clinical-use allowlist. Per-module review-role filtering happens
 * inside the service layer (listReviews / updateReview / etc.).
 */
export function requireClinicalAiUse(req, res, next) {
  if (!req.user) {
    return error(res, 'Authentication required', 401, { safe: true });
  }

  const role = normalizeRole(req.user.role);
  if (!CLINICAL_AI_USER_ROLES.has(role)) {
    return error(res, 'Clinical AI use requires a clinical role', 403, {
      safe: true,
    });
  }

  return next();
}

export function uuidOrNull(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text : null;
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).trim();
  }
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}

export function parseClinicalAiWindowDays(value, fallback = 7) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), 90);
}
