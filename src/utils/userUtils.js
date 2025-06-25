// src/utils/userUtils.js - Hospital User Management Utilities

import { HOSPITAL_ROLES, ACCESS_MATRIX, RISK_LEVELS } from '../config/userConfig.js';
import { format } from 'date-fns';

/**
 * Generate a unique employee ID based on role and department
 */
export function generateEmployeeId(role, department) {
  const roleCode = role.substring(0, 3).toUpperCase();
  const deptCode = department.substring(0, 3).toUpperCase();
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `${roleCode}${deptCode}${randomNum}`;
}

/**
 * Check if a user can access another user's data
 */
export function canUserAccessOtherUser(requestingUserRole, targetUserRole, requestingUserId, targetUserId) {
  // Users can always access their own data
  if (requestingUserId === targetUserId) {
    return true;
  }

  // Get access matrix for requesting user's role
  const accessRights = ACCESS_MATRIX[requestingUserRole] || ACCESS_MATRIX.DEFAULT;
  
  // Check if role has wildcard access
  if (accessRights.canView.includes('*')) {
    return true;
  }

  // Check if specific role is in access list
  return accessRights.canView.includes(targetUserRole);
}

/**
 * Check if a user can edit another user's data
 */
export function canUserEditOtherUser(requestingUserRole, targetUserRole, requestingUserId, targetUserId) {
  // Users can edit their own basic data
  if (requestingUserId === targetUserId) {
    return true;
  }

  const accessRights = ACCESS_MATRIX[requestingUserRole] || ACCESS_MATRIX.DEFAULT;
  
  if (accessRights.canEdit.includes('*')) {
    return true;
  }

  return accessRights.canEdit.includes(targetUserRole);
}

/**
 * Get risk level for a user role
 */
export function getUserRiskLevel(role) {
  for (const [level, roles] of Object.entries(RISK_LEVELS)) {
    if (roles.includes(role)) {
      return level;
    }
  }
  return 'LOW';
}

/**
 * Format user data for response based on access level
 */
export function formatUserData(user, requestingUserRole, requestingUserId) {
  const isOwnProfile = user.uid === requestingUserId;
  const accessRights = ACCESS_MATRIX[requestingUserRole] || ACCESS_MATRIX.DEFAULT;
  const canViewSensitive = accessRights.canViewSensitive || isOwnProfile;

  const roleInfo = HOSPITAL_ROLES[user.role] || {};

  return {
    ...user,
    // Format dates
    birthday: user.birthday ? format(new Date(user.birthday), 'dd-MM-yyyy') : null,
    anniversary: user.anniversary ? format(new Date(user.anniversary), 'dd-MM-yyyy') : null,
    registered_at: user.registered_at ? format(new Date(user.registered_at), 'dd-MM-yyyy') : null,
    registeredAt: user.registered_at ? format(new Date(user.registered_at), 'dd-MM-yyyy') : null,
    last_login: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : null,
    lastLogin: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : null,
    lastActivity: user.last_activity ? format(new Date(user.last_activity), 'dd-MM-yyyy HH:mm') : null,
    updatedAt: user.updated_at ? format(new Date(user.updated_at), 'dd-MM-yyyy') : null,
    
    // Role information
    roleInfo,
    riskLevel: getUserRiskLevel(user.role),
    
    // Conditional sensitive data
    employee_id: canViewSensitive ? user.employee_id : undefined,
    license_number: canViewSensitive ? user.license_number : undefined,
    emergency_contact: canViewSensitive ? user.emergency_contact : undefined,
    medical_history: canViewSensitive ? user.medical_history : undefined,
    phone: canViewSensitive ? user.phone : maskPhone(user.phone),
    email: canViewSensitive ? user.email : undefined,
    
    // Clean up redundant fields
    password: undefined,
    created_at: undefined,
    updated_at: undefined
  };
}

/**
 * Mask phone number for privacy
 */
export function maskPhone(phone) {
  if (!phone) return 'XXXX';
  return `***-***-${phone.slice(-4)}`;
}

/**
 * Calculate user statistics
 */
export function calculateUserStats(users) {
  const stats = {
    total: users.length,
    byStatus: {},
    byRole: {},
    byDepartment: {},
    activeLastWeek: 0,
    newLastMonth: 0
  };

  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  users.forEach(user => {
    // Status counts
    stats.byStatus[user.status] = (stats.byStatus[user.status] || 0) + 1;
    
    // Role counts
    stats.byRole[user.role] = (stats.byRole[user.role] || 0) + 1;
    
    // Department counts
    stats.byDepartment[user.department] = (stats.byDepartment[user.department] || 0) + 1;
    
    // Activity counts
    if (user.last_login && new Date(user.last_login) > oneWeekAgo) {
      stats.activeLastWeek++;
    }
    
    if (user.registered_at && new Date(user.registered_at) > oneMonthAgo) {
      stats.newLastMonth++;
    }
  });

  return stats;
}

/**
 * Validate user access for operation
 */
export function validateUserAccess(operation, requestingUserRole, targetUserRole = null) {
  const accessRights = ACCESS_MATRIX[requestingUserRole] || ACCESS_MATRIX.DEFAULT;

  switch (operation) {
    case 'VIEW':
      return targetUserRole ? canUserAccessOtherUser(requestingUserRole, targetUserRole, null, null) : true;
    case 'EDIT':
      return targetUserRole ? canUserEditOtherUser(requestingUserRole, targetUserRole, null, null) : true;
    case 'DELETE':
      return accessRights.canDelete.includes('*') || 
             (targetUserRole && accessRights.canDelete.includes(targetUserRole));
    case 'CHANGE_ROLE':
      return accessRights.canChangeRole;
    case 'GENERATE_REPORT':
      return accessRights.canGenerateReports;
    default:
      return false;
  }
}

/**
 * Get recommended action for inactive user
 */
export function getInactiveUserRecommendation(daysInactive, role) {
  const riskLevel = getUserRiskLevel(role);
  
  if (daysInactive > 365) {
    return 'Immediate deactivation recommended';
  } else if (daysInactive > 180) {
    return riskLevel === 'CRITICAL' || riskLevel === 'HIGH' 
      ? 'Urgent: Contact user or consider deactivation'
      : 'Consider deactivation';
  } else if (daysInactive > 120) {
    return 'Investigate and contact user';
  } else if (daysInactive > 60) {
    return riskLevel === 'CRITICAL' || riskLevel === 'HIGH'
      ? 'Send reminder and verify access needed'
      : 'Monitor and remind';
  }
  
  return 'Monitor';
}

/**
 * Build search query parameters
 */
export function buildSearchQuery(searchTerm, searchType) {
  const searchQuery = `%${searchTerm.toLowerCase()}%`;
  
  switch (searchType) {
    case 'name':
      return { clause: 'LOWER(u.name) LIKE $1', params: [searchQuery] };
    case 'phone':
      return { clause: 'u.phone LIKE $1', params: [`%${searchTerm}%`] };
    case 'employee_id':
      return { clause: 'UPPER(u.employee_id) LIKE UPPER($1)', params: [`%${searchTerm}%`] };
    case 'email':
      return { clause: 'LOWER(u.email) LIKE $1', params: [searchQuery] };
    default: // 'all'
      return {
        clause: `(LOWER(u.name) LIKE $1 OR u.phone LIKE $1 OR UPPER(u.employee_id) LIKE UPPER($1) OR LOWER(u.email) LIKE $1)`,
        params: [searchQuery]
      };
  }
}

/**
 * Calculate activity score for user
 */
export function calculateActivityScore(totalActions, activeDays, lastActivity) {
  let score = totalActions + (activeDays * 2);
  
  // Bonus for recent activity
  if (lastActivity) {
    const daysSinceLastActivity = Math.floor((new Date() - new Date(lastActivity)) / (1000 * 60 * 60 * 24));
    if (daysSinceLastActivity < 7) {
      score += 10;
    } else if (daysSinceLastActivity < 30) {
      score += 5;
    }
  }
  
  return score;
}

/**
 * Determine user activity level
 */
export function getUserActivityLevel(lastLogin, totalActions) {
  if (!lastLogin) return 'Never Active';
  
  const daysSinceLogin = Math.floor((new Date() - new Date(lastLogin)) / (1000 * 60 * 60 * 24));
  
  if (daysSinceLogin <= 7 && totalActions > 10) {
    return 'Highly Active';
  } else if (daysSinceLogin <= 30) {
    return 'Active';
  } else if (daysSinceLogin <= 90) {
    return 'Moderately Active';
  } else if (daysSinceLogin <= 180) {
    return 'Low Activity';
  } else {
    return 'Inactive';
  }
}