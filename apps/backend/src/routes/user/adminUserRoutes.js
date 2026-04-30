// src/routes/user/adminUserRoutes.js
import express from 'express';
import { AdminUserController } from '../../controllers/user/adminUserController.js';
import {
  ROLES,
  CLINICAL_ROLES,
  DOCTOR_TIERS,
  LEADERSHIP_ROLES,
  MACHINE_ROLES,
  PLATFORM_ROLES,
  SUPPORT_ROLES,
} from '../../utils/roleHelpers.js';
import { success } from '../../utils/responseHelper.js';
import {
  analyticsValidation,
  activityAuditValidation,
  inactiveUsersValidation,
  reactivationValidation,
  reportGenerationValidation
} from '../../validators/user/userValidator.js';

const router = express.Router();

// Dashboard
router.get('/dashboard', AdminUserController.getDashboard);

/**
 * Build the canonical role registry payload. Exported so unit tests
 * can exercise it without standing up the full admin route stack.
 */
export function buildRoleRegistry() {
  const allRoles = Object.values(ROLES);
  const inSet = (set) => (role) => set.includes(role);
  const isClinical = inSet(CLINICAL_ROLES);
  const isLeadership = inSet(LEADERSHIP_ROLES);
  const isSupport = inSet(SUPPORT_ROLES);
  const isPlatform = inSet(PLATFORM_ROLES);
  const isMachine = inSet(MACHINE_ROLES);
  const isDoctorTier = inSet(DOCTOR_TIERS);
  const groups = allRoles.map((r) => ({
    role: r,
    is_clinical: isClinical(r),
    is_leadership: isLeadership(r),
    is_support: isSupport(r),
    is_platform: isPlatform(r),
    is_machine: isMachine(r),
    is_doctor_tier: isDoctorTier(r),
    is_admin: r === 'ADMIN',
    is_patient: r === 'PATIENT',
  }));
  return {
    count: allRoles.length,
    roles: groups,
    doctor_tiers: DOCTOR_TIERS,
    clinical_roles: CLINICAL_ROLES,
    leadership_roles: LEADERSHIP_ROLES,
    support_roles: SUPPORT_ROLES,
    platform_roles: PLATFORM_ROLES,
    machine_roles: MACHINE_ROLES,
  };
}

/**
 * GET /admin/users/role-registry
 * Phase F1 follow-up — canonical role list with grouping metadata, so
 * the admin UI populates its role dropdown from one place.
 */
router.get('/role-registry', (_req, res) => {
  return success(res, buildRoleRegistry(), 'Role registry retrieved');
});

// User Analytics
router.get('/analytics', analyticsValidation, AdminUserController.getUserAnalytics);

// User Activity Audit
router.get('/activity-audit', activityAuditValidation, AdminUserController.getActivityAudit);

// Inactive Users Report
router.get('/inactive-users', inactiveUsersValidation, AdminUserController.getInactiveUsersReport);

// Reactivate User
router.post('/reactivate/:userId', reactivationValidation, AdminUserController.reactivateUser);

// Generate User Report
router.post('/generate-report', reportGenerationValidation, AdminUserController.generateReport);

// System Information
router.get('/system-info', AdminUserController.getSystemInfo);

export default router;