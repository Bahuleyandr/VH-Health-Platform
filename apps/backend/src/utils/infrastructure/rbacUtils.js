// utils/infrastructure/rbacUtils.js
import prisma from '../../lib/prisma.js';
import {
  ALL_ROLES,
  SUPER_ADMIN,
  ADMIN,
  PATIENT,
  CNO,
  NURSING_STAFF,
  NURSING_INCHARGE,
  OP_STAFF_NURSE,
  OP_INCHARGE,
  IP_STAFF_NURSE,
  IP_INCHARGE,
  OT_NURSE,
  OT_INCHARGE,
  OT_STAFF,
  CATH_LAB_STAFF,
  CATH_LAB_INCHARGE,
  PHARMACY_STAFF,
  LAB_STAFF,
  DOCTOR,
  DUTY_DOCTOR,
  MEDICAL_SUPERINTENDENT,
  GENERAL_STAFF,
  HOUSEKEEPING_STAFF,
  HOUSEKEEPING_INCHARGE,
  MAINTENANCE,
  HR_STAFF,
  RECEPTIONIST,
  RECEPTION_INCHARGE,
  BILLING_STAFF,
  BILLING_INCHARGE,
  FINANCE_INCHARGE,
  ADMISSION_OFFICER,
  IPD_COUNSELLOR,
  DRIVER,
  SECURITY,
  EMERGENCY_RESPONDER
} from '../../utils/roles.js';

const ALL_ASSIGNABLE_ROLES = ALL_ROLES.filter(role => role !== SUPER_ADMIN);
const IP_NURSING_ROLES = [NURSING_INCHARGE, IP_INCHARGE, NURSING_STAFF, IP_STAFF_NURSE];
const OP_NURSING_ROLES = [OP_INCHARGE, OP_STAFF_NURSE];
const OT_NURSING_ROLES = [OT_INCHARGE, OT_NURSE, OT_STAFF];
const CATH_LAB_ROLES = [CATH_LAB_INCHARGE, CATH_LAB_STAFF];
const ALL_NURSING_SUPERVISION_ROLES = [
  ...IP_NURSING_ROLES,
  ...OP_NURSING_ROLES,
  ...OT_NURSING_ROLES,
  ...CATH_LAB_ROLES
];

// Role hierarchy configuration
export const ROLE_HIERARCHY = {
  [SUPER_ADMIN]: {
    level: 110,
    permissions: ['*'],
    canManageRoles: ALL_ASSIGNABLE_ROLES,
    canViewData: 'all',
    description: 'Super Administrator - Full Platform Access',
    color: '#991b1b',
    maxUsers: null,
    requiresApproval: false
  },
  [ADMIN]: {
    level: 100,
    permissions: ['*'], // All permissions
    canManageRoles: ALL_ASSIGNABLE_ROLES,
    canViewData: 'all',
    description: 'System Administrator - Full Access',
    color: '#dc2626',
    maxUsers: null,
    requiresApproval: false
  },
  [DOCTOR]: {
    level: 80,
    permissions: [
      'view_patients',
      'manage_appointments',
      'access_records',
      'create_prescriptions',
      'view_investigations',
      'create_consultations',
      'access_medical_records',
      'create_treatment_plans'
    ],
    canManageRoles: [PATIENT],
    canViewData: 'departmental',
    description: 'Medical Doctor - Clinical Access',
    color: '#2563eb',
    maxUsers: null,
    requiresApproval: true
  },
  [DUTY_DOCTOR]: {
    level: 78,
    permissions: [
      'view_patients',
      'access_records',
      'view_investigations',
      'create_consultations',
      'access_medical_records'
    ],
    canManageRoles: [],
    canViewData: 'assigned_clinical',
    description: 'Duty Doctor - Assigned Clinical Access',
    color: '#1d4ed8',
    maxUsers: null,
    requiresApproval: true
  },
  [MEDICAL_SUPERINTENDENT]: {
    level: 90,
    permissions: [
      'view_patients',
      'access_records',
      'view_investigations',
      'view_staff',
      'view_clinical_rosters',
      'manage_clinical_escalations'
    ],
    canManageRoles: [DOCTOR, DUTY_DOCTOR],
    canViewData: 'clinical_leadership',
    description: 'Medical Superintendent - Medical Leadership',
    color: '#1e40af',
    maxUsers: null,
    requiresApproval: true
  },
  [CNO]: {
    level: 85,
    permissions: [
      'view_staff',
      'manage_nursing_roster',
      'view_nursing_workload',
      'assign_nursing_incharges',
      'approve_nursing_coverage',
      'view_patients',
      'access_basic_records',
      'update_patient_vitals'
    ],
    canManageRoles: ALL_NURSING_SUPERVISION_ROLES,
    canViewData: 'nursing_leadership',
    description: 'Nursing Superintendent - OP/IP/OT/Cath Lab Nursing Leadership',
    color: '#0f766e',
    maxUsers: 3,
    requiresApproval: true
  },
  [NURSING_STAFF]: {
    level: 70,
    permissions: [
      'view_patients',
      'manage_appointments',
      'access_basic_records',
      'assist_consultations',
      'manage_investigations',
      'update_patient_vitals',
      'schedule_procedures'
    ],
    canManageRoles: [PATIENT],
    canViewData: 'ward_based',
    description: 'Nursing Staff - Patient Care',
    color: '#059669',
    maxUsers: null,
    requiresApproval: true
  },
  [NURSING_INCHARGE]: {
    level: 74,
    permissions: [
      'view_patients',
      'access_basic_records',
      'update_patient_vitals',
      'view_staff',
      'manage_ip_nursing_roster',
      'view_ip_nursing_workload'
    ],
    canManageRoles: [IP_INCHARGE, NURSING_STAFF, IP_STAFF_NURSE],
    canViewData: 'ip_nursing_department',
    description: 'IP / Ward Nursing Incharge - Inpatient Nursing Supervision',
    color: '#047857',
    maxUsers: null,
    requiresApproval: true
  },
  [IP_INCHARGE]: {
    level: 73,
    permissions: [
      'view_patients',
      'access_basic_records',
      'update_patient_vitals',
      'view_staff',
      'manage_ip_nursing_roster'
    ],
    canManageRoles: [NURSING_STAFF, IP_STAFF_NURSE],
    canViewData: 'ip_nursing_department',
    description: 'IP Nursing Incharge - Ward Nursing Work Allocation',
    color: '#047857',
    maxUsers: null,
    requiresApproval: true
  },
  [IP_STAFF_NURSE]: {
    level: 70,
    permissions: [
      'view_patients',
      'access_basic_records',
      'update_patient_vitals',
      'assist_consultations',
      'manage_investigations'
    ],
    canManageRoles: [PATIENT],
    canViewData: 'ward_based',
    description: 'IP Staff Nurse - Inpatient Care',
    color: '#059669',
    maxUsers: null,
    requiresApproval: true
  },
  [OP_INCHARGE]: {
    level: 72,
    permissions: [
      'view_patients',
      'manage_appointments',
      'access_basic_records',
      'view_staff',
      'manage_op_nursing_roster',
      'view_op_queue'
    ],
    canManageRoles: [OP_STAFF_NURSE],
    canViewData: 'op_nursing_department',
    description: 'OP Nursing Incharge - OP Nursing Work Allocation',
    color: '#0891b2',
    maxUsers: null,
    requiresApproval: true
  },
  [OP_STAFF_NURSE]: {
    level: 68,
    permissions: [
      'view_patients',
      'manage_appointments',
      'access_basic_records',
      'assist_consultations',
      'manage_investigations'
    ],
    canManageRoles: [PATIENT],
    canViewData: 'op_nursing_department',
    description: 'OP Staff Nurse - OP Flow Support',
    color: '#0d9488',
    maxUsers: null,
    requiresApproval: true
  },
  [OT_INCHARGE]: {
    level: 72,
    permissions: [
      'view_patients',
      'access_basic_records',
      'view_staff',
      'manage_ot_nursing_roster',
      'view_theatre_workload'
    ],
    canManageRoles: [OT_NURSE, OT_STAFF],
    canViewData: 'ot_nursing_department',
    description: 'OT Nursing Incharge - Theatre Nursing Work Allocation',
    color: '#7c3aed',
    maxUsers: null,
    requiresApproval: true
  },
  [OT_NURSE]: {
    level: 68,
    permissions: [
      'view_patients',
      'access_basic_records',
      'assist_theatre_workflow',
      'view_theatre_workload'
    ],
    canManageRoles: [],
    canViewData: 'ot_nursing_department',
    description: 'OT Nurse - Theatre Nursing Support',
    color: '#8b5cf6',
    maxUsers: null,
    requiresApproval: true
  },
  [OT_STAFF]: {
    level: 66,
    permissions: [
      'view_patients',
      'access_basic_records',
      'assist_theatre_workflow'
    ],
    canManageRoles: [],
    canViewData: 'ot_nursing_department',
    description: 'OT Staff - Theatre Support',
    color: '#a855f7',
    maxUsers: null,
    requiresApproval: true
  },
  [CATH_LAB_INCHARGE]: {
    level: 72,
    permissions: [
      'view_patients',
      'access_basic_records',
      'view_staff',
      'manage_cath_lab_roster',
      'view_cath_lab_workload'
    ],
    canManageRoles: [CATH_LAB_STAFF],
    canViewData: 'cath_lab_department',
    description: 'Cath Lab Incharge - Cath Lab Work Allocation',
    color: '#0284c7',
    maxUsers: null,
    requiresApproval: true
  },
  [CATH_LAB_STAFF]: {
    level: 66,
    permissions: [
      'view_patients',
      'access_basic_records',
      'assist_cath_lab_workflow',
      'view_cath_lab_workload'
    ],
    canManageRoles: [],
    canViewData: 'cath_lab_department',
    description: 'Cath Lab Staff - Cath Lab Support',
    color: '#0ea5e9',
    maxUsers: null,
    requiresApproval: true
  },
  [PHARMACY_STAFF]: {
    level: 60,
    permissions: [
      'view_prescriptions',
      'manage_pharmacy_orders',
      'access_medication_history',
      'dispense_medications',
      'manage_inventory',
      'view_drug_interactions'
    ],
    canManageRoles: [],
    canViewData: 'pharmacy_only',
    description: 'Pharmacy Staff - Medication Management',
    color: '#7c3aed',
    maxUsers: 20,
    requiresApproval: true
  },
  [LAB_STAFF]: {
    level: 60,
    permissions: [
      'manage_investigations',
      'upload_lab_results',
      'view_test_requests',
      'process_specimens',
      'generate_reports',
      'manage_lab_equipment'
    ],
    canManageRoles: [],
    canViewData: 'lab_only',
    description: 'Laboratory Staff - Test Management',
    color: '#ea580c',
    maxUsers: 15,
    requiresApproval: true
  },
  [HR_STAFF]: {
    level: 50,
    permissions: [
      'view_staff',
      'manage_staff_basic',
      'view_attendance',
      'generate_hr_reports',
      'manage_schedules',
      'process_payroll',
      'handle_grievances'
    ],
    canManageRoles: [
      ...ALL_NURSING_SUPERVISION_ROLES,
      GENERAL_STAFF,
      HOUSEKEEPING_STAFF,
      HOUSEKEEPING_INCHARGE,
      MAINTENANCE,
      RECEPTIONIST,
      RECEPTION_INCHARGE,
      BILLING_STAFF,
      BILLING_INCHARGE,
      FINANCE_INCHARGE,
      ADMISSION_OFFICER,
      IPD_COUNSELLOR,
      DRIVER,
      SECURITY,
      EMERGENCY_RESPONDER
    ],
    canViewData: 'hr_only',
    description: 'Human Resources - Staff Management',
    color: '#0891b2',
    maxUsers: 5,
    requiresApproval: true
  },
  [GENERAL_STAFF]: {
    level: 40,
    permissions: [
      'view_basic_info',
      'assist_patients',
      'manage_appointments_basic',
      'handle_inquiries',
      'update_contact_info',
      'schedule_follow_ups'
    ],
    canManageRoles: [],
    canViewData: 'limited',
    description: 'General Staff - Basic Operations',
    color: '#65a30d',
    maxUsers: 50,
    requiresApproval: false
  },
  [HOUSEKEEPING_STAFF]: {
    level: 35,
    permissions: [
      'view_assigned_housekeeping_requests',
      'complete_housekeeping_requests',
      'log_cleaning_proof'
    ],
    canManageRoles: [],
    canViewData: 'assigned_housekeeping_only',
    description: 'Housekeeping Staff - Cleaning Worklist',
    color: '#047857',
    maxUsers: 80,
    requiresApproval: false
  },
  [HOUSEKEEPING_INCHARGE]: {
    level: 45,
    permissions: [
      'view_housekeeping_workload',
      'assign_housekeeping_staff',
      'verify_housekeeping_requests',
      'redeploy_housekeeping_staff'
    ],
    canManageRoles: [HOUSEKEEPING_STAFF],
    canViewData: 'housekeeping_department',
    description: 'Housekeeping Incharge - Floor Assignment',
    color: '#0f766e',
    maxUsers: 10,
    requiresApproval: true
  },
  [MAINTENANCE]: {
    level: 35,
    permissions: ['view_assigned_maintenance_requests', 'complete_maintenance_requests'],
    canManageRoles: [],
    canViewData: 'assigned_maintenance_only',
    description: 'Maintenance Staff - Facilities Work',
    color: '#ca8a04',
    maxUsers: 40,
    requiresApproval: false
  },
  [PATIENT]: {
    level: 10,
    permissions: [
      'view_own_records',
      'book_appointments',
      'view_own_prescriptions',
      'submit_feedback',
      'access_patient_portal',
      'update_personal_info',
      'view_test_results',
      'download_reports'
    ],
    canManageRoles: [],
    canViewData: 'own_only',
    description: 'Patient - Personal Health Access',
    color: '#6b7280',
    maxUsers: null,
    requiresApproval: false
  }
};

// Check if user can manage role
export const canUserManageRole = (userRole, targetRole) => {
  if ([SUPER_ADMIN, ADMIN].includes(userRole)) {
    return true;
  }
  const roleData = ROLE_HIERARCHY[userRole];
  return roleData?.canManageRoles?.includes(targetRole) || false;
};

// Check if role has capacity
export const checkRoleCapacity = async (role, _db) => {
  const roleData = ROLE_HIERARCHY[role];
  if (!roleData.maxUsers) {
    return { hasCapacity: true, current: 0, max: null };
  }

  const result = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) FROM users WHERE role = $1 AND is_active = true',
    role
  );

  const current = parseInt(result[0].count);
  return {
    hasCapacity: current < roleData.maxUsers,
    current,
    max: roleData.maxUsers,
    available: roleData.maxUsers - current
  };
};

// Get manageable roles for user
export const getManageableRoles = userRole => {
  if ([SUPER_ADMIN, ADMIN].includes(userRole)) {
    return Object.keys(ROLE_HIERARCHY);
  }
  return ROLE_HIERARCHY[userRole]?.canManageRoles || [];
};

// Check permission
export const hasPermission = (userRole, permission) => {
  const roleData = ROLE_HIERARCHY[userRole];
  if (!roleData) {
    return false;
  }
  if (roleData.permissions.includes('*')) {
    return true;
  }
  return roleData.permissions.includes(permission);
};

// Get role level
export const getRoleLevel = role => {
  return ROLE_HIERARCHY[role]?.level || 0;
};

// Compare role levels
export const isHigherRole = (role1, role2) => {
  return getRoleLevel(role1) > getRoleLevel(role2);
};

// Format role for display
export const formatRole = role => {
  return role
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

// Generate role badge HTML
export const generateRoleBadge = role => {
  const roleData = ROLE_HIERARCHY[role];
  if (!roleData) {
    return '';
  }

  return `<span style="
    background: ${roleData.color}; 
    color: white; 
    padding: 4px 12px; 
    border-radius: 12px; 
    font-size: 0.875rem;
    font-weight: 500;
  ">${formatRole(role)}</span>`;
};

// Validate role transition
export const validateRoleTransition = (fromRole, toRole) => {
  const errors = [];

  // Check if same role
  if (fromRole === toRole) {
    errors.push('Source and target roles are the same');
  }

  // Check if valid roles
  if (!ROLE_HIERARCHY[fromRole]) {
    errors.push('Invalid source role');
  }
  if (!ROLE_HIERARCHY[toRole]) {
    errors.push('Invalid target role');
  }

  // Check for dangerous transitions
  if (fromRole === PATIENT && toRole === ADMIN) {
    errors.push('Direct transition from PATIENT to ADMIN requires additional approval');
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

// Get role statistics
export const calculateRoleStatistics = users => {
  const stats = {
    byRole: {},
    totalUsers: users.length,
    activeUsers: 0,
    inactiveUsers: 0,
    roleDistribution: []
  };

  // Initialize role counts
  Object.keys(ROLE_HIERARCHY).forEach(role => {
    stats.byRole[role] = { total: 0, active: 0, inactive: 0 };
  });

  // Calculate statistics
  users.forEach(user => {
    if (stats.byRole[user.role]) {
      stats.byRole[user.role].total++;
      if (user.is_active) {
        stats.byRole[user.role].active++;
        stats.activeUsers++;
      } else {
        stats.byRole[user.role].inactive++;
        stats.inactiveUsers++;
      }
    }
  });

  // Calculate distribution
  Object.entries(stats.byRole).forEach(([role, counts]) => {
    if (counts.total > 0) {
      stats.roleDistribution.push({
        role,
        count: counts.total,
        percentage: Math.round((counts.total / stats.totalUsers) * 100),
        ...ROLE_HIERARCHY[role]
      });
    }
  });

  // Sort by level
  stats.roleDistribution.sort((a, b) => b.level - a.level);

  return stats;
};
