// src/services/userService.js - Hospital User Operations Service

import { HOSPITAL_ROLES } from '../config/userConfig.js';
import prisma from '../lib/prisma.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import * as userUtils from '../utils/userUtils.js';

/**
 * Create or update user profile
 */
export async function createOrUpdateUser(userData, requestingUser) {
  const {
    phone, name, email, gender, address, birthday, anniversary,
    role = 'PATIENT', department, specialty, employeeId, licenseNumber,
    emergencyContact, bloodGroup, allergies, medicalHistory
  } = userData;

  const requestingUserRole = requestingUser?.role;
  const requestingUserId = requestingUser?.uid;

  // Role assignment validation
  if (role !== 'PATIENT' && !['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
    throw new Error('Only administrators can assign staff roles');
  }

  // Normalize phone
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    throw new Error('Valid phone number is required');
  }

  // Auto-generate employee ID for staff
  const finalEmployeeId = (role !== 'PATIENT' && role !== 'VISITOR') 
    ? employeeId || userUtils.generateEmployeeId(role, department || HOSPITAL_ROLES[role].department)
    : null;

  // Check for existing user
  const existingUser = await prisma.$queryRawUnsafe(
    'SELECT id, uid, role, name FROM users WHERE phone = $1',
    normalizedPhone
  );

  let userId, userUid, operation;

  if (existingUser.length > 0) {
    // Update existing user
    const existing = existingUser[0];
    userId = existing.id;
    userUid = existing.uid;
    operation = 'update';

    // Check if requesting user can update this user
    if (!userUtils.canUserAccessOtherUser(requestingUserRole, existing.role, requestingUserId, userUid)) {
      throw new Error('Insufficient permissions to update this user');
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE users SET 
        name = $1, email = $2, gender = $3, address = $4, birthday = $5,
        anniversary = $6, role = $7, department = $8, specialty = $9,
        employee_id = $10, license_number = $11, emergency_contact = $12,
        blood_group = $13, allergies = $14, medical_history = $15,
        updated_at = NOW(), updated_by = $16
      WHERE phone = $17
      RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at
    `, 
      name, email, gender, address, birthday, anniversary, role, 
      department || HOSPITAL_ROLES[role].department, specialty, finalEmployeeId,
      licenseNumber, normalizePhone(emergencyContact), bloodGroup, allergies, 
      medicalHistory, requestingUserId, normalizedPhone
    );

  } else {
    // Create new user
    operation = 'create';

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO users (
        phone, name, email, gender, address, birthday, anniversary,
        role, department, specialty, employee_id, license_number,
        emergency_contact, blood_group, allergies, medical_history,
        status, registered_at, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        'active', NOW(), $17
      ) RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at
    `, 
      normalizedPhone, name, email, gender, address, birthday, anniversary,
      role, department || HOSPITAL_ROLES[role].department, specialty, finalEmployeeId,
      licenseNumber, normalizePhone(emergencyContact), bloodGroup, allergies,
      medicalHistory, requestingUserId
    );

    userId = result[0].id;
    userUid = result[0].uid;
  }

  // Get updated user data with additional info
  const userResult = await prisma.$queryRawUnsafe(`
    SELECT 
      u.*, ur.role_description, ur.permissions,
      COUNT(DISTINCT ual.id) as total_actions,
      MAX(ual.created_at) as last_activity
    FROM users u
    LEFT JOIN user_roles ur ON u.role = ur.role_name
    LEFT JOIN user_action_logs ual ON u.uid = ual.user_id
    WHERE u.uid = $1
    GROUP BY u.id, ur.role_description, ur.permissions
  `, userUid);

  return {
    user: userResult[0],
    operation,
    userId: userUid
  };
}

/**
 * Get user by identifier (UID, phone, or employee ID)
 */
export async function getUserByIdentifier(identifier) {
  // Determine identifier type
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const isPhone = /^\+?[1-9]\d{1,14}$/.test(identifier);
  
  let column, value;
  if (isUUID) {
    column = 'uid';
    value = identifier;
  } else if (isPhone) {
    column = 'phone';
    value = normalizePhone(identifier);
  } else {
    column = 'employee_id';
    value = identifier;
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT 
      u.*, ur.role_description, ur.permissions,
      COUNT(DISTINCT ual.id) as total_actions,
      MAX(ual.created_at) as last_activity,
      creator.name as created_by_name,
      updater.name as updated_by_name
    FROM users u
    LEFT JOIN user_roles ur ON u.role = ur.role_name
    LEFT JOIN user_action_logs ual ON u.uid = ual.user_id
    LEFT JOIN users creator ON u.created_by = creator.uid
    LEFT JOIN users updater ON u.updated_by = updater.uid
    WHERE u.${column} = $1
    GROUP BY u.id, ur.role_description, ur.permissions, creator.name, updater.name
  `, value);

  if (result.length === 0) {
    return null;
  }

  return {
    user: result[0],
    searchedBy: column
  };
}

/**
 * Update user profile
 */
export async function updateUser(identifier, updateData, requestingUser) {
  const userResult = await getUserByIdentifier(identifier);
  
  if (!userResult) {
    throw new Error('Hospital user not found');
  }

  const targetUser = userResult.user;
  const requestingUserRole = requestingUser?.role;
  const requestingUserId = requestingUser?.uid;

  // Access control check
  if (!userUtils.canUserEditOtherUser(requestingUserRole, targetUser.role, requestingUserId, targetUser.uid)) {
    throw new Error('Insufficient permissions to update this user');
  }

  // Role change validation
  if (updateData.role && updateData.role !== targetUser.role) {
    if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
      throw new Error('Only administrators can change user roles');
    }
  }

  // Build update query
  const updateFields = [];
  const updateValues = [];
  let paramIndex = 1;

  const allowedFields = [
    'name', 'email', 'gender', 'address', 'birthday', 'anniversary',
    'role', 'department', 'specialty', 'license_number', 'emergency_contact',
    'blood_group', 'allergies', 'medical_history'
  ];

  for (const [key, value] of Object.entries(updateData)) {
    if (allowedFields.includes(key) && value !== undefined) {
      updateFields.push(`${key} = $${paramIndex}`);
      updateValues.push(
        key === 'emergency_contact' ? normalizePhone(value) : value
      );
      paramIndex++;
    }
  }

  if (updateFields.length === 0) {
    throw new Error('No valid fields to update');
  }

  // Add metadata
  updateFields.push(`updated_at = NOW()`, `updated_by = $${paramIndex}`);
  updateValues.push(requestingUserId);

  // Perform update
  const column = userResult.searchedBy;
  const updateResult = await prisma.$queryRawUnsafe(`
    UPDATE users SET ${updateFields.join(', ')}
    WHERE ${column} = $${paramIndex + 1}
    RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at
  `, ...updateValues, targetUser[column]);

  return {
    user: updateResult[0],
    previousData: targetUser,
    updatedFields: Object.keys(updateData).filter(key => allowedFields.includes(key))
  };
}

/**
 * Change user status
 */
export async function changeUserStatus(identifier, newStatus, reason, requestingUser) {
  const userResult = await getUserByIdentifier(identifier);
  
  if (!userResult) {
    throw new Error('Hospital user not found');
  }

  const targetUser = userResult.user;
  const requestingUserRole = requestingUser?.role;
  const requestingUserId = requestingUser?.uid;

  // Only admin and HR can change status
  if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
    throw new Error('Only administrators can change user status');
  }

  // Prevent changing admin status (unless by another admin)
  if (targetUser.role === 'ADMIN' && requestingUserRole !== 'ADMIN') {
    throw new Error('Cannot change admin user status');
  }

  const column = userResult.searchedBy;
  const updateResult = await prisma.$queryRawUnsafe(`
    UPDATE users SET 
      status = $1, status_changed_at = NOW(), status_changed_by = $2,
      status_change_reason = $3, updated_at = NOW(), updated_by = $2
    WHERE ${column} = $4
    RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at
  `, newStatus, requestingUserId, reason, targetUser[column]);

  // Create status change record
  await prisma.$queryRawUnsafe(`
    INSERT INTO user_status_history (
      user_id, previous_status, new_status, changed_by, change_reason,
      changed_at, ip_address
    ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
  `, targetUser.uid, targetUser.status, newStatus, requestingUserId, reason, null);

  return {
    user: updateResult[0],
    previousStatus: targetUser.status,
    newStatus
  };
}

/**
 * Deactivate user (soft delete)
 */
export async function deactivateUser(identifier, reason, transferDataTo, requestingUser) {
  const userResult = await getUserByIdentifier(identifier);
  
  if (!userResult) {
    throw new Error('Hospital user not found');
  }

  const targetUser = userResult.user;
  const requestingUserId = requestingUser?.uid;

  // Prevent self-deletion
  if (targetUser.uid === requestingUserId) {
    throw new Error('Cannot deactivate your own account');
  }

  // Validate transfer target if specified
  if (transferDataTo) {
    const transferTarget = await prisma.$queryRawUnsafe(
      'SELECT uid, name, role, status FROM users WHERE uid = $1',
      transferDataTo
    );

    if (transferTarget.length === 0) {
      throw new Error('Transfer target user not found');
    }

    if (transferTarget[0].status !== 'active') {
      throw new Error('Transfer target must be an active user');
    }
  }

  const column = userResult.searchedBy;
  const deactivationResult = await prisma.$queryRawUnsafe(`
    UPDATE users SET 
      status = 'terminated',
      deactivated_at = NOW(),
      deactivated_by = $1,
      deactivation_reason = $2,
      data_transferred_to = $3,
      updated_at = NOW(),
      updated_by = $1
    WHERE ${column} = $4
    RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at
  `, requestingUserId, reason, transferDataTo, targetUser[column]);

  // Create deactivation record
  await prisma.$queryRawUnsafe(`
    INSERT INTO user_deactivation_log (
      user_id, deactivated_by, deactivation_reason, data_transferred_to,
      deactivated_at, ip_address, user_data
    ) VALUES ($1, $2, $3, $4, NOW(), $5, $6)
  `, 
    targetUser.uid, requestingUserId, reason, transferDataTo, null,
    JSON.stringify({
      name: targetUser.name,
      role: targetUser.role,
      department: targetUser.department,
      phone: targetUser.phone
    })
  );

  return {
    deactivatedUser: deactivationResult[0],
    transferDataTo
  };
}

/**
 * Reactivate user
 */
export async function reactivateUser(userId, reason, requestingUser) {
  const userResult = await prisma.$queryRawUnsafe(
    'SELECT uid, name, role, status, deactivated_at FROM users WHERE uid = $1',
    userId
  );

  if (userResult.length === 0) {
    throw new Error('Hospital user not found');
  }

  const user = userResult[0];

  if (user.status === 'active') {
    throw new Error('User is already active');
  }

  const requestingUserId = requestingUser?.uid;

  const reactivationResult = await prisma.$queryRawUnsafe(`
    UPDATE users SET 
      status = 'active',
      reactivated_at = NOW(),
      reactivated_by = $1,
      reactivation_reason = $2,
      deactivated_at = NULL,
      deactivated_by = NULL,
      deactivation_reason = NULL,
      updated_at = NOW(),
      updated_by = $1
    WHERE uid = $3
    RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at
  `, requestingUserId, reason, userId);

  // Create reactivation record
  await prisma.$queryRawUnsafe(`
    INSERT INTO user_reactivation_log (
      user_id, reactivated_by, reactivation_reason, reactivated_at, ip_address
    ) VALUES ($1, $2, $3, NOW(), $4)
  `, userId, requestingUserId, reason, null);

  return {
    reactivatedUser: reactivationResult[0],
    previousStatus: user.status,
    deactivatedPeriod: user.deactivated_at 
      ? Math.floor((new Date() - new Date(user.deactivated_at)) / (1000 * 60 * 60 * 24))
      : null
  };
}

/**
 * Bulk import users
 */
export async function bulkImportUsers(users, options, requestingUser) {
  const { notifyUsers = false } = options;
  const requestingUserId = requestingUser?.uid;
  const results = [];
  const errors = [];

  for (let i = 0; i < users.length; i++) {
    const userData = users[i];
    
    try {
      const normalizedPhone = normalizePhone(userData.phone);
      const department = userData.department || HOSPITAL_ROLES[userData.role].department;
      const employeeId = userData.employeeId || userUtils.generateEmployeeId(userData.role, department);

      // Check if user exists
      const existing = await prisma.$queryRawUnsafe('SELECT uid FROM users WHERE phone = $1', normalizedPhone);

      if (existing.length > 0) {
        errors.push({
          index: i + 1,
          phone: userData.phone,
          name: userData.name,
          error: 'User with this phone number already exists'
        });
        continue;
      }

      // Create user
      const result = await prisma.$queryRawUnsafe(`
        INSERT INTO users (
          phone, name, email, gender, role, department, employee_id,
          status, registered_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), $8)
        RETURNING uid, name, phone, role, employee_id
      `, 
        normalizedPhone, userData.name, userData.email, userData.gender,
        userData.role, department, employeeId, requestingUserId
      );

      results.push({
        index: i + 1,
        user: result[0],
        status: 'created'
      });

    } catch (userError) {
      errors.push({
        index: i + 1,
        phone: userData.phone,
        name: userData.name,
        error: userError.message
      });
    }
  }

  // Log bulk operation
  await prisma.$queryRawUnsafe(`
    INSERT INTO bulk_operation_logs (
      operation_type, performed_by, total_items, success_count, 
      error_count, operation_details, performed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `, 
    'bulk_user_import', requestingUserId, users.length, results.length,
    errors.length, JSON.stringify({ notifyUsers })
  );

  return {
    successCount: results.length,
    results,
    errors
  };
}