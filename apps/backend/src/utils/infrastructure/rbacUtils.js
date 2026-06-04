// utils/infrastructure/rbacUtils.js
import prisma from '../../lib/prisma.js';
import { getRbacRoleHierarchyFromPolicy } from '../../config/rolePolicyGraph.js';

const SUPER_ADMIN = 'SUPER_ADMIN';
const ADMIN = 'ADMIN';
const PATIENT = 'PATIENT';

// Role hierarchy configuration
export const ROLE_HIERARCHY = getRbacRoleHierarchyFromPolicy();

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
