// src/controllers/userController.js - Hospital User Management Controller

import { validationResult } from 'express-validator';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import * as userService from '../services/userService.js';
import * as auditService from '../services/userAuditService.js';
import * as userQueries from '../services/userQueries.js';
import * as userUtils from '../utils/userUtils.js';
import { HOSPITAL_ROLES, USER_ACTIONS } from '../config/userConfig.js';
import logger from '../logging/logger.js';
import { format } from 'date-fns';

/**
 * Create or update user profile
 */
export async function createOrUpdateProfile(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const userData = req.body;
    const requestingUser = req.user;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const result = await userService.createOrUpdateUser(userData, requestingUser);
    const { user, operation, userId } = result;

    // Log the action
    await auditService.logUserAction(
      requestingUser.uid,
      operation === 'create' ? USER_ACTIONS.CREATED : USER_ACTIONS.UPDATED,
      userId,
      `${operation === 'create' ? 'Created' : 'Updated'} user profile: ${user.name} (${user.role})`,
      ipAddress
    );

    // Format response
    const formattedUser = userUtils.formatUserData(user, requestingUser.role, requestingUser.uid);

    logger.info(`👤 User ${operation}: ${user.name} (${user.role}) | By: ${requestingUser.uid} (${requestingUser.role})`);

    success(res, {
      user: formattedUser,
      operation,
      roleAssignment: {
        role: user.role,
        department: user.department,
        level: HOSPITAL_ROLES[user.role]?.level,
        description: HOSPITAL_ROLES[user.role]?.description
      },
      requestedBy: requestingUser.uid
    }, `User profile ${operation}d successfully`);

  } catch (err) {
    logger.error('User Profile Operation Error:', err);
    error(res, err.message || 'Failed to process user profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Bulk import users
 */
export async function bulkImportUsers(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { users, notifyUsers = false } = req.body;
    const requestingUser = req.user;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Only admin and HR can bulk import
    if (!['ADMIN', 'HR_MANAGER'].includes(requestingUser.role)) {
      return error(res, 'Only administrators can perform bulk user import', HTTP_STATUS.FORBIDDEN);
    }

    const result = await userService.bulkImportUsers(users, { notifyUsers }, requestingUser);

    // Log bulk operation
    await auditService.logUserAction(
      requestingUser.uid,
      'bulk_import_completed',
      null,
      `Bulk import: ${result.successCount}/${users.length} users created`,
      ipAddress
    );

    logger.info(`👥 Bulk user import: ${result.successCount}/${users.length} users created | By: ${requestingUser.uid}`);

    success(res, {
      importSummary: {
        totalUsers: users.length,
        successful: result.successCount,
        failed: result.errors.length,
        successRate: `${((result.successCount / users.length) * 100).toFixed(1)}%`
      },
      createdUsers: result.results,
      failedUsers: result.errors,
      options: { notifyUsers },
      performedBy: requestingUser.uid,
      performedAt: new Date().toISOString(),
      performedAtFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
      requestedBy: requestingUser.uid
    }, `Bulk user import completed: ${result.successCount}/${users.length} users created successfully`);

  } catch (err) {
    logger.error('Bulk User Import Error:', err);
    error(res, 'Failed to perform bulk user import', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * List users with filtering
 */
export async function listUsers(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const {
      page = 1, limit = 50, query: searchQuery, role, department, status = 'active',
      specialty, sortBy = 'registered_at', sortOrder = 'DESC'
    } = req.query;

    const requestingUser = req.user;
    const offset = (page - 1) * limit;

    const filters = {
      searchQuery, role, department, status, specialty, sortBy, sortOrder,
      limit: parseInt(limit), offset: parseInt(offset)
    };

    const { query, countQuery, params, countParams } = await userQueries.buildUserListQuery(
      filters, requestingUser.role, requestingUser.uid
    );

    const [users, total] = await Promise.all([
      db.query(query, params),
      db.query(countQuery, countParams)
    ]);

    // Format users based on access level
    const formattedUsers = users.rows.map(user => 
      userUtils.formatUserData(user, requestingUser.role, requestingUser.uid)
    );

    // Statistics for admin/HR
    let statistics = null;
    if (['ADMIN', 'HR_MANAGER'].includes(requestingUser.role)) {
      statistics = userUtils.calculateUserStats(users.rows);
    }

    success(res, {
      users: formattedUsers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total.rows[0].count),
        totalPages: Math.ceil(total.rows[0].count / limit)
      },
      filters,
      statistics,
      userAccess: {
        role: requestingUser.role,
        canViewAll: ['ADMIN', 'HR_MANAGER'].includes(requestingUser.role),
        canManageRoles: ['ADMIN', 'HR_MANAGER'].includes(requestingUser.role)
      },
      requestedBy: requestingUser.uid
    }, 'Hospital users retrieved successfully');

  } catch (err) {
    logger.error('List Hospital Users Error:', err);
    error(res, 'Failed to fetch hospital users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Get user by identifier
 */
export async function getUserById(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { identifier } = req.params;
    const requestingUser = req.user;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const result = await userService.getUserByIdentifier(identifier);
    
    if (!result) {
      return error(res, 'Hospital user not found', HTTP_STATUS.NOT_FOUND);
    }

    const { user, searchedBy } = result;

    // Access control check
    if (!userUtils.canUserAccessOtherUser(requestingUser.role, user.role, requestingUser.uid, user.uid)) {
      return error(res, 'Access denied to this user profile', HTTP_STATUS.FORBIDDEN);
    }

    // Log profile access
    await auditService.logUserAction(
      requestingUser.uid,
      USER_ACTIONS.PROFILE_VIEWED,
      user.uid,
      `Viewed profile: ${user.name} (${user.role})`,
      ipAddress
    );

    // Get recent activity (admin/HR or own profile)
    let recentActivity = [];
    if (['ADMIN', 'HR_MANAGER'].includes(requestingUser.role) || requestingUser.uid === user.uid) {
      recentActivity = await auditService.getUserActivityLogs(user.uid);
    }

    // Format user data
    const formattedUser = userUtils.formatUserData(user, requestingUser.role, requestingUser.uid);
    formattedUser.recentActivity = recentActivity.map(activity => ({
      ...activity,
      createdAt: format(new Date(activity.created_at), 'dd-MM-yyyy HH:mm'),
      ipAddress: requestingUser.role === 'ADMIN' ? activity.ip_address : undefined
    }));

    success(res, {
      user: formattedUser,
      accessLevel: {
        isOwnProfile: user.uid === requestingUser.uid,
        canEdit: userUtils.canUserEditOtherUser(requestingUser.role, user.role, requestingUser.uid, user.uid),
        canViewSensitive: userUtils.validateUserAccess('VIEW', requestingUser.role),
        canChangeRole: userUtils.validateUserAccess('CHANGE_ROLE', requestingUser.role)
      },
      searchedBy,
      requestedBy: requestingUser.uid
    }, 'Hospital user profile retrieved successfully');

  } catch (err) {
    logger.error('Get Hospital User Error:', err);
    error(res, 'Failed to fetch hospital user profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Get users by role
 */
export async function getUsersByRole(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { role } = req.params;
    const { includeInactive = false } = req.query;
    const requestingUser = req.user;

    // Access control for sensitive roles
    if (!['ADMIN', 'HR_MANAGER', 'CHIEF_DOCTOR', 'HEAD_NURSE'].includes(requestingUser.role)) {
      if (role !== 'PATIENT' && !['DOCTOR', 'NURSING_STAFF'].includes(role)) {
        return error(res, 'Insufficient permissions to view this role', HTTP_STATUS.FORBIDDEN);
      }
    }

    const result = await userQueries.getUsersByRole(role, includeInactive === 'true');

    // Format results based on access level
    const formattedUsers = result.rows.map(user => 
      userUtils.formatUserData(user, requestingUser.role, requestingUser.uid)
    );

    const roleInfo = HOSPITAL_ROLES[role];

    success(res, {
      role,
      roleInfo,
      users: formattedUsers,
      summary: {
        totalCount: formattedUsers.length,
        activeCount: formattedUsers.filter(u => u.status === 'active').length,
        inactiveCount: formattedUsers.filter(u => u.status !== 'active').length,
        recentlyActive: formattedUsers.filter(u => u.activity_count > 0).length
      },
      filters: { includeInactive },
      userAccess: {
        role: requestingUser.role,
        canViewSensitive: userUtils.validateUserAccess('VIEW', requestingUser.role)
      },
      requestedBy: requestingUser.uid
    }, `Hospital ${role} users retrieved successfully`);

  } catch (err) {
    logger.error('Get Users by Role Error:', err);
    error(res, 'Failed to fetch users by role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Get users by department
 */
export async function getUsersByDepartment(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { department } = req.params;
    const { roleFilter } = req.query;
    const requestingUser = req.user;

    // Access control
    if (!['ADMIN', 'HR_MANAGER', 'CHIEF_DOCTOR', 'HEAD_NURSE'].includes(requestingUser.role)) {
      return error(res, 'Insufficient permissions to view department users', HTTP_STATUS.FORBIDDEN);
    }

    const result = await userQueries.getUsersByDepartment(department, roleFilter);

    // Group by role
    const usersByRole = {};
    let totalUsers = 0;

    result.rows.forEach(user => {
      if (!usersByRole[user.role]) {
        usersByRole[user.role] = [];
      }
      
      const formattedUser = userUtils.formatUserData(user, requestingUser.role, requestingUser.uid);
      usersByRole[user.role].push(formattedUser);
      totalUsers++;
    });

    // Department statistics
    const statsResult = await userQueries.getDepartmentStats();
    const deptStats = statsResult.rows.filter(stat => stat.department === department);

    success(res, {
      department,
      usersByRole,
      departmentStatistics: deptStats,
      summary: {
        totalUsers,
        uniqueRoles: Object.keys(usersByRole).length,
        mostCommonRole: Object.entries(usersByRole).sort((a, b) => b[1].length - a[1].length)[0]?.[0] || 'None'
      },
      filters: { roleFilter },
      requestedBy: requestingUser.uid
    }, `Hospital ${department} department users retrieved successfully`);

  } catch (err) {
    logger.error('Get Department Users Error:', err);
    error(res, 'Failed to fetch department users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Search users
 */
export async function searchUsers(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { 
      q: searchQuery, searchType = 'all', role, department, 
      limit = 20 
    } = req.query;
    
    const requestingUser = req.user;

    const result = await userQueries.searchUsers(
      searchQuery, searchType, { role, department },
      requestingUser.role, requestingUser.uid, parseInt(limit)
    );

    // Format results based on access level
    const formattedUsers = result.rows.map(user => 
      userUtils.formatUserData(user, requestingUser.role, requestingUser.uid)
    );

    success(res, {
      searchQuery,
      searchType,
      filters: { role, department },
      results: formattedUsers,
      summary: {
        totalResults: formattedUsers.length,
        limitReached: formattedUsers.length >= parseInt(limit),
        searchScope: ['ADMIN', 'HR_MANAGER'].includes(requestingUser.role) ? 'all_users' : 'limited_access'
      },
      requestedBy: requestingUser.uid
    }, `User search completed: ${formattedUsers.length} results found`);

  } catch (err) {
    logger.error('User Search Error:', err);
    error(res, 'Failed to search users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Update user profile
 */
export async function updateUser(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { identifier } = req.params;
    const updateData = req.body;
    const requestingUser = req.user;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const result = await userService.updateUser(identifier, updateData, requestingUser);
    const { user, previousData, updatedFields } = result;

    // Log the update
    await auditService.logUserAction(
      requestingUser.uid,
      USER_ACTIONS.UPDATED,
      user.uid,
      `Updated fields: ${updatedFields.join(', ')}`,
      ipAddress
    );

    // Special logging for role changes
    if (updateData.role && updateData.role !== previousData.role) {
      await auditService.logUserAction(
        requestingUser.uid,
        USER_ACTIONS.ROLE_CHANGED,
        user.uid,
        `Role changed from ${previousData.role} to ${updateData.role}`,
        ipAddress
      );
    }

    // Format response
    const formattedUser = userUtils.formatUserData(user, requestingUser.role, requestingUser.uid);

    logger.info(`✏️ User updated: ${user.name} | Fields: ${updatedFields.join(', ')} | By: ${requestingUser.uid}`);

    success(res, {
      user: formattedUser,
      updatedFields,
      changesSummary: {
        totalFields: updatedFields.length,
        roleChanged: updateData.role && updateData.role !== previousData.role,
        updatedBy: requestingUser.uid,
        updatedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
      },
      requestedBy: requestingUser.uid
    }, 'Hospital user profile updated successfully');

  } catch (err) {
    logger.error('Update Hospital User Error:', err);
    error(res, err.message || 'Failed to update hospital user profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Change user status
 */
export async function changeUserStatus(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { identifier } = req.params;
    const { status, reason } = req.body;
    const requestingUser = req.user;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const result = await userService.changeUserStatus(identifier, status, reason, requestingUser);
    const { user, previousStatus, newStatus } = result;

    // Log status change
    await auditService.logUserAction(
      requestingUser.uid,
      USER_ACTIONS.STATUS_CHANGED,
      user.uid,
      `Status changed from ${previousStatus} to ${newStatus}: ${reason}`,
      ipAddress
    );

    logger.info(`🔄 User status changed: ${user.name} (${previousStatus} → ${newStatus}) | By: ${requestingUser.uid}`);

    success(res, {
      user: {
        uid: user.uid,
        name: user.name,
        role: user.role,
        previousStatus,
        newStatus,
        statusChangedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
      },
      statusChange: {
        previousStatus,
        newStatus,
        reason,
        changedBy: requestingUser.uid,
        changedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
      },
      requestedBy: requestingUser.uid
    }, `User status changed to ${newStatus} successfully`);

  } catch (err) {
    logger.error('Change User Status Error:', err);
    error(res, err.message || 'Failed to change user status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Deactivate user
 */
export async function deactivateUser(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { identifier } = req.params;
    const { reason, transferDataTo } = req.body;
    const requestingUser = req.user;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Only admin can deactivate users
    if (requestingUser.role !== 'ADMIN') {
      return error(res, 'Only administrators can deactivate users', HTTP_STATUS.FORBIDDEN);
    }

    const result = await userService.deactivateUser(identifier, reason, transferDataTo, requestingUser);
    const { deactivatedUser } = result;

    // Log deactivation
    await auditService.logUserAction(
      requestingUser.uid,
      USER_ACTIONS.DEACTIVATED,
      deactivatedUser.uid,
      `User deactivated: ${reason}${transferDataTo ? ` | Data transferred to: ${transferDataTo}` : ''}`,
      ipAddress
    );

    logger.warn(`🗑️ User deactivated: ${deactivatedUser.name} (${deactivatedUser.role}) | Reason: ${reason} | By: ${requestingUser.uid}`);

    success(res, {
      deactivatedUser: {
        uid: deactivatedUser.uid,
        name: deactivatedUser.name,
        role: deactivatedUser.role,
        department: deactivatedUser.department,
        previousStatus: deactivatedUser.status,
        deactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
      },
      deactivationDetails: {
        reason,
        transferDataTo,
        deactivatedBy: requestingUser.uid,
        deactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm'),
        canReactivate: true,
        retentionPeriod: '7 years (as per hospital policy)'
      },
      requestedBy: requestingUser.uid
    }, 'Hospital user deactivated successfully');

  } catch (err) {
    logger.error('Deactivate User Error:', err);
    error(res, err.message || 'Failed to deactivate hospital user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}