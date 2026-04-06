// utils/infrastructure/rbacUtils.js
import prisma from '../../lib/prisma.js';
import { 
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF, 
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF 
} from '../../utils/roles.js';

// Role hierarchy configuration
export const ROLE_HIERARCHY = {
  [ADMIN]: {
    level: 100,
    permissions: ['*'], // All permissions
    canManageRoles: [ADMIN, DOCTOR, NURSING_STAFF, PHARMACY_STAFF, LAB_STAFF, HR_STAFF, GENERAL_STAFF, PATIENT],
    canViewData: 'all',
    description: 'System Administrator - Full Access',
    color: '#dc2626',
    maxUsers: null,
    requiresApproval: false
  },
  [DOCTOR]: {
    level: 80,
    permissions: [
      'view_patients', 'manage_appointments', 'access_records',
      'create_prescriptions', 'view_investigations', 'create_consultations',
      'access_medical_records', 'create_treatment_plans'
    ],
    canManageRoles: [PATIENT],
    canViewData: 'departmental',
    description: 'Medical Doctor - Clinical Access',
    color: '#2563eb',
    maxUsers: null,
    requiresApproval: true
  },
  [NURSING_STAFF]: {
    level: 70,
    permissions: [
      'view_patients', 'manage_appointments', 'access_basic_records',
      'assist_consultations', 'manage_investigations', 'update_patient_vitals',
      'schedule_procedures'
    ],
    canManageRoles: [PATIENT],
    canViewData: 'ward_based',
    description: 'Nursing Staff - Patient Care',
    color: '#059669',
    maxUsers: null,
    requiresApproval: true
  },
  [PHARMACY_STAFF]: {
    level: 60,
    permissions: [
      'view_prescriptions', 'manage_pharmacy_orders', 'access_medication_history',
      'dispense_medications', 'manage_inventory', 'view_drug_interactions'
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
      'manage_investigations', 'upload_lab_results', 'view_test_requests',
      'process_specimens', 'generate_reports', 'manage_lab_equipment'
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
      'view_staff', 'manage_staff_basic', 'view_attendance', 'generate_hr_reports',
      'manage_schedules', 'process_payroll', 'handle_grievances'
    ],
    canManageRoles: [GENERAL_STAFF],
    canViewData: 'hr_only',
    description: 'Human Resources - Staff Management',
    color: '#0891b2',
    maxUsers: 5,
    requiresApproval: true
  },
  [GENERAL_STAFF]: {
    level: 40,
    permissions: [
      'view_basic_info', 'assist_patients', 'manage_appointments_basic',
      'handle_inquiries', 'update_contact_info', 'schedule_follow_ups'
    ],
    canManageRoles: [],
    canViewData: 'limited',
    description: 'General Staff - Basic Operations',
    color: '#65a30d',
    maxUsers: 50,
    requiresApproval: false
  },
  [PATIENT]: {
    level: 10,
    permissions: [
      'view_own_records', 'book_appointments', 'view_own_prescriptions',
      'submit_feedback', 'access_patient_portal', 'update_personal_info',
      'view_test_results', 'download_reports'
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
  if (userRole === ADMIN) {return true;}
  const roleData = ROLE_HIERARCHY[userRole];
  return roleData?.canManageRoles?.includes(targetRole) || false;
};

// Check if role has capacity
export const checkRoleCapacity = async (role, _db) => {
  const roleData = ROLE_HIERARCHY[role];
  if (!roleData.maxUsers) {return { hasCapacity: true, current: 0, max: null };}
  
  const result = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) FROM users WHERE role = $1 AND is_active = true',
    [role]
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
export const getManageableRoles = (userRole) => {
  if (userRole === ADMIN) {
    return Object.keys(ROLE_HIERARCHY);
  }
  return ROLE_HIERARCHY[userRole]?.canManageRoles || [];
};

// Check permission
export const hasPermission = (userRole, permission) => {
  const roleData = ROLE_HIERARCHY[userRole];
  if (!roleData) {return false;}
  if (roleData.permissions.includes('*')) {return true;}
  return roleData.permissions.includes(permission);
};

// Get role level
export const getRoleLevel = (role) => {
  return ROLE_HIERARCHY[role]?.level || 0;
};

// Compare role levels
export const isHigherRole = (role1, role2) => {
  return getRoleLevel(role1) > getRoleLevel(role2);
};

// Format role for display
export const formatRole = (role) => {
  return role.replace(/_/g, ' ').toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

// Generate role badge HTML
export const generateRoleBadge = (role) => {
  const roleData = ROLE_HIERARCHY[role];
  if (!roleData) {return '';}
  
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
export const calculateRoleStatistics = (users) => {
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