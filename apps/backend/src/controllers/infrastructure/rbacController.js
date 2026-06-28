// controllers/infrastructure/rbacController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { RBACService } from '../../services/infrastructure/rbacService.js';
import { rowsToCsv } from '../../utils/csv.js';
import { success, error } from '../../utils/responseHelper.js';

// Get public role information
export const getPublicRoles = async (req, res) => {
  try {
    const publicRoleInfo = await RBACService.getAvailableRoles({ role: 'PUBLIC' });
    
    success(res, {
      roles: publicRoleInfo.roles.map(role => ({
        role: role.role,
        description: role.description,
        level: role.level,
        color: role.color,
        requiresApproval: role.requiresApproval
      })),
      totalRoles: publicRoleInfo.totalRoles,
      hierarchy: 'Higher level = More permissions',
      lastUpdated: new Date().toLocaleDateString('en-GB')
    }, 'Public role information retrieved');
  } catch (err) {
    logger.error('[GetPublicRoles]:', err);
    error(res, 'Failed to retrieve public role information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get all available roles with details
export const getRoles = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid || 'anonymous',
      role: req.user?.role
    };
    
    const rolesData = await RBACService.getAvailableRoles(userInfo);
    success(res, rolesData, 'Available roles retrieved');
  } catch (err) {
    logger.error('[GetRoles]:', err);
    error(res, 'Failed to fetch roles', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getPolicy = async (_req, res) => {
  try {
    success(res, RBACService.getPolicy(), 'Role policy retrieved');
  } catch (err) {
    logger.error('[GetRolePolicy]:', err);
    error(res, 'Failed to fetch role policy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get users grouped by role
export const getUsersByRole = async (req, res) => {
  try {
    const filters = {
      includeInactive: req.query.includeInactive === 'true',
      role: req.query.role,
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100)
    };
    
    const userInfo = {
      uid: req.user?.uid || 'anonymous',
      role: req.user?.role
    };
    
    const usersData = await RBACService.getUsersByRole(filters, userInfo);
    success(res, usersData, 'Users by role retrieved');
  } catch (err) {
    logger.error('[GetUsersByRole]:', err);
    error(res, 'Failed to fetch users by role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get permissions matrix
export const getPermissions = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid || 'anonymous',
      role: req.user?.role
    };
    
    const permissionsData = RBACService.getPermissionsMatrix(userInfo);
    success(res, permissionsData, 'Permissions matrix retrieved');
  } catch (err) {
    logger.error('[GetPermissions]:', err);
    error(res, 'Failed to fetch permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get RBAC analytics
export const getRBACAnalytics = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { days = 30 } = req.query;
    const userInfo = {
      uid: req.user?.uid || 'anonymous'
    };
    
    const analyticsData = await RBACService.getRBACAnalytics(days, userInfo);
    success(res, analyticsData, 'RBAC analytics retrieved');
  } catch (err) {
    logger.error('[GetRBACAnalytics]:', err);
    error(res, 'Failed to fetch RBAC analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Assign role to user
export const assignRole = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }
  
  try {
    const assignmentData = req.body;
    const adminInfo = {
      uid: req.user?.uid,
      role: req.user?.role
    };
    
    const result = await RBACService.assignRole(assignmentData, adminInfo);
    success(res, result, result.unchanged ? 'Role unchanged' : 'Role assigned successfully');
  } catch (err) {
    logger.error('[AssignRole]:', err);
    
    if (err.message.includes('Insufficient permissions')) {
      return error(res, err.message, HTTP_STATUS.FORBIDDEN);
    }
    if (err.message.includes('not found')) {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    if (err.message.includes('capacity exceeded')) {
      return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
    }
    
    error(res, 'Failed to assign role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk role assignment
export const bulkAssignRoles = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }
  
  try {
    const bulkData = req.body;
    const adminInfo = {
      uid: req.user?.uid,
      role: req.user?.role
    };
    
    const result = await RBACService.bulkAssignRoles(bulkData, adminInfo);
    success(res, result, 'Bulk role assignment completed');
  } catch (err) {
    logger.error('[BulkAssignRoles]:', err);
    error(res, 'Failed to process bulk assignment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get comprehensive audit log (Admin only)
export const getAuditLog = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const filters = req.query;
    const adminInfo = {
      uid: req.user?.uid
    };
    
    const auditData = await RBACService.getAuditLog(filters, adminInfo);
    success(res, auditData, 'Role audit log retrieved');
  } catch (err) {
    logger.error('[GetAuditLog]:', err);
    error(res, 'Failed to fetch audit log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get security alerts (Admin only)
export const getSecurityAlerts = async (req, res) => {
  try {
    const adminInfo = {
      uid: req.user?.uid
    };
    
    const alertsData = await RBACService.getSecurityAlerts(adminInfo);
    success(res, alertsData, 'Security alerts retrieved');
  } catch (err) {
    logger.error('[GetSecurityAlerts]:', err);
    error(res, 'Failed to fetch security alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get role migration report (Admin only)
export const getMigrationReport = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { days = 30 } = req.query;
    const adminInfo = {
      uid: req.user?.uid
    };
    
    const reportData = await RBACService.getRBACAnalytics(days, adminInfo);
    
    // Transform analytics data into migration report format
    const migrationReport = {
      reportPeriod: `${days} days`,
      roleChanges: reportData.recentRoleChanges,
      roleDistribution: reportData.roleDistribution,
      capacityUtilization: reportData.roleCapacity,
      summary: {
        totalTransitions: reportData.recentRoleChanges.length,
        uniqueUsers: new Set(reportData.recentRoleChanges.map(c => c.phone)).size,
        mostActiveRole: reportData.roleDistribution[0]?.role || 'N/A'
      },
      generatedAt: new Date().toLocaleDateString('en-GB'),
      requestedBy: adminInfo.uid
    };
    
    success(res, { migrationReport }, 'Role migration report generated');
  } catch (err) {
    logger.error('[GetMigrationReport]:', err);
    error(res, 'Failed to generate migration report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Toggle user status (Admin only)
export const toggleUserStatus = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }
  
  try {
    const statusData = req.body;
    const adminInfo = {
      uid: req.user?.uid
    };
    
    const result = await RBACService.toggleUserStatus(statusData, adminInfo);
    success(res, result, `User account ${result.action}ed successfully`);
  } catch (err) {
    logger.error('[ToggleUserStatus]:', err);
    
    if (err.message.includes('not found')) {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to update user status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Mass role update (Admin only)
export const massRoleUpdate = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }
  
  try {
    const { fromRole, toRole, reason = 'Mass role update', dryRun = false } = req.body;
    const adminInfo = {
      uid: req.user?.uid
    };
    
    // For dry run, we'll use the analytics service to preview the impact
    if (dryRun) {
      const analyticsData = await RBACService.getUsersByRole({ 
        role: fromRole, 
        includeInactive: false 
      }, adminInfo);
      
      const affectedUsers = analyticsData.usersByRole
        .find(r => r.role === fromRole.toUpperCase())
        ?.users || [];
        
      return success(res, {
        dryRun: true,
        affectedUsers,
        count: affectedUsers.length,
        fromRole: fromRole.toUpperCase(),
        toRole: toRole.toUpperCase(),
        estimatedImpact: {
          usersAffected: affectedUsers.length,
          capacityCheck: 'Check role capacity before executing'
        }
      }, 'Dry run completed - no changes made');
    }
    
    // Perform actual mass update
    const assignments = [];
    const analyticsData = await RBACService.getUsersByRole({ 
      role: fromRole, 
      includeInactive: false 
    }, adminInfo);
    
    const usersToUpdate = analyticsData.usersByRole
      .find(r => r.role === fromRole.toUpperCase())
      ?.users || [];
      
    usersToUpdate.forEach(user => {
      assignments.push({
        phone: user.phone,
        role: toRole
      });
    });
    
    const result = await RBACService.bulkAssignRoles({
      assignments,
      reason
    }, adminInfo);
    
    success(res, {
      massUpdate: {
        fromRole: fromRole.toUpperCase(),
        toRole: toRole.toUpperCase(),
        updatedCount: result.successful.length,
        failedCount: result.failed.length,
        reason
      },
      details: result,
      executedBy: adminInfo.uid,
      executedAt: new Date().toLocaleDateString('en-GB')
    }, `Mass role update completed - ${result.successful.length} users updated`);
    
  } catch (err) {
    logger.error('[MassRoleUpdate]:', err);
    
    if (err.message.includes('capacity')) {
      return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
    }
    
    error(res, 'Failed to perform mass role update', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Export RBAC data (Admin only)
export const exportRBACData = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { format = 'json', includeAudit = false, includeInactive = false } = req.query;
    const adminInfo = {
      uid: req.user?.uid
    };
    
    // Get users data
    const usersData = await RBACService.getUsersByRole({
      includeInactive: includeInactive === 'true',
      limit: 10000
    }, adminInfo);
    
    // Flatten users from all roles
    const allUsers = [];
    usersData.usersByRole.forEach(roleGroup => {
      roleGroup.users.forEach(user => {
        allUsers.push({
          ...user,
          role: roleGroup.role
        });
      });
    });
    
    const exportData = {
      exportedAt: new Date().toLocaleDateString('en-GB'),
      exportedBy: adminInfo.uid,
      totalUsers: allUsers.length,
      roleHierarchy: usersData.roleHierarchy,
      users: allUsers,
      exportOptions: { format, includeAudit, includeInactive }
    };
    
    // Include audit log if requested
    if (includeAudit === 'true') {
      const auditData = await RBACService.getAuditLog({ limit: 1000 }, adminInfo);
      exportData.auditLog = auditData.auditLog;
    }
    
    if (format === 'csv') {
      // CAN-005: build through the formula-neutralizing helper — user name/email
      // are attacker-influenceable and must never be interpolated raw.
      const headers = ['UID', 'Phone', 'Name', 'Email', 'Role', 'IsActive', 'RegisteredAt', 'LastLogin', 'RoleUpdatedAt'];
      const rows = allUsers.map((user) => [
        user.uid, user.phone, user.name || '', user.email || '', user.role,
        user.is_active, user.registered_at, user.last_login || '', user.role_updated_at || '',
      ]);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=rbac_export.csv');
      return res.send(rowsToCsv(headers, rows));
    }
    
    success(res, exportData, 'RBAC data exported successfully');
  } catch (err) {
    logger.error('[ExportRBACData]:', err);
    error(res, 'Failed to export RBAC data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get my role information
export const getMyRole = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid,
      role: req.user?.role,
      phone: req.user?.phone
    };
    
    if (!userInfo.role) {
      return error(res, 'User role not found', HTTP_STATUS.BAD_REQUEST);
    }
    
    const roleData = await RBACService.getMyRoleInfo(userInfo);
    success(res, roleData, 'Role information retrieved');
  } catch (err) {
    logger.error('[GetMyRole]:', err);
    error(res, 'Failed to fetch role information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get my permissions
export const getMyPermissions = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid,
      role: req.user?.role
    };
    
    if (!userInfo.role) {
      return error(res, 'User role not found', HTTP_STATUS.BAD_REQUEST);
    }
    
    const permissionsData = RBACService.getMyPermissions(userInfo);
    success(res, permissionsData, 'Permissions retrieved');
  } catch (err) {
    logger.error('[GetMyPermissions]:', err);
    error(res, 'Failed to fetch permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
