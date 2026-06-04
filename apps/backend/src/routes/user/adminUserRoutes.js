// src/routes/user/adminUserRoutes.js
import express from 'express';
import { AdminUserController } from '../../controllers/user/adminUserController.js';
import {
  CLINICAL_ROLES,
  DOCTOR_TIERS,
  LEADERSHIP_ROLES,
  MACHINE_ROLES,
  PLATFORM_ROLES,
  SUPPORT_ROLES,
} from '../../utils/roleHelpers.js';
import { getRolePickerOptions, getRolePolicy } from '../../config/rolePolicyGraph.js';
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
  const policy = getRolePolicy();
  const inSet = (set) => (role) => set.includes(role);
  const isClinical = inSet(CLINICAL_ROLES);
  const isLeadership = inSet(LEADERSHIP_ROLES);
  const isSupport = inSet(SUPPORT_ROLES);
  const isPlatform = inSet(PLATFORM_ROLES);
  const isMachine = inSet(MACHINE_ROLES);
  const isDoctorTier = inSet(DOCTOR_TIERS);
  const groups = policy.roles.map((rolePolicy) => ({
    role: rolePolicy.role_code,
    label: rolePolicy.display_title,
    group: rolePolicy.group,
    department: rolePolicy.department,
    unit: rolePolicy.unit,
    assignable_staff: rolePolicy.assignable_staff,
    human: rolePolicy.human,
    machine: rolePolicy.machine,
    phi_access_level: rolePolicy.phi?.access_level,
    reports_to_role: rolePolicy.reporting?.reports_to_role,
    supervises_roles: rolePolicy.reporting?.supervises_roles || [],
    route_capability_groups: rolePolicy.access?.route_capability_groups || [],
    ui_feature_ids: rolePolicy.ui?.feature_ids || [],
    is_clinical: isClinical(rolePolicy.role_code) || rolePolicy.group === 'clinical',
    is_leadership: isLeadership(rolePolicy.role_code) || rolePolicy.group === 'leadership',
    is_support: isSupport(rolePolicy.role_code) || rolePolicy.group === 'support',
    is_platform: isPlatform(rolePolicy.role_code) || rolePolicy.group === 'platform',
    is_machine: isMachine(rolePolicy.role_code) || rolePolicy.machine,
    is_doctor_tier: isDoctorTier(rolePolicy.role_code),
    is_admin: rolePolicy.role_code === 'ADMIN' || rolePolicy.role_code === 'SUPER_ADMIN',
    is_patient: rolePolicy.role_code === 'PATIENT',
  }));
  return {
    policy_version: policy.policy_version,
    policy_hash: policy.policy_hash,
    generated_at: policy.generated_at,
    count: groups.length,
    roles: groups,
    role_picker_options: getRolePickerOptions(),
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
