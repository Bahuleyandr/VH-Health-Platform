// src/services/userQueries.js - Centralized User Database Queries

import prisma from '../lib/prisma.js';
import { normalizePhone } from '../utils/phoneUtils.js';

/**
 * User CRUD Queries
 */

export async function insertUser(userData) {
  const query = `
    INSERT INTO users (
      phone, name, email, gender, address, birthday, anniversary,
      role, department, specialty, employee_id, license_number,
      emergency_contact, blood_group, allergies, medical_history,
      status, registered_at, created_by
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      'active', NOW(), $17
    ) RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at`;

  return prisma.$queryRawUnsafe(query, 
    userData.phone, userData.name, userData.email, userData.gender,
    userData.address, userData.birthday, userData.anniversary,
    userData.role, userData.department, userData.specialty,
    userData.employeeId, userData.licenseNumber, userData.emergencyContact,
    userData.bloodGroup, userData.allergies, userData.medicalHistory,
    userData.createdBy
  );
}

export async function updateUser(whereClause, whereValue, updateData, updatedBy) {
  const updateFields = [];
  const updateValues = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updateData)) {
    updateFields.push(`${key} = $${paramIndex}`);
    updateValues.push(value);
    paramIndex++;
  }

  updateFields.push(`updated_at = NOW()`, `updated_by = $${paramIndex}`);
  updateValues.push(updatedBy);

  const query = `
    UPDATE users 
    SET ${updateFields.join(', ')}
    WHERE ${whereClause} = $${paramIndex + 1}
    RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at`;

  return prisma.$queryRawUnsafe(query, ...updateValues, whereValue);
}

// Safe column list for user queries — never includes encrypted_password, pin_hash, password_hash
const USER_SAFE_COLUMNS = `id, uid, phone, name, email, gender, address, birthday, anniversary,
  profile_picture, role, department, specialty, employee_id, license_number,
  emergency_contact, blood_group, allergies, medical_history, is_active, status,
  registered_at, updated_at, last_login, last_sign_in_at, firebase_uid`;

export async function getUserByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  return prisma.$queryRawUnsafe(`SELECT ${USER_SAFE_COLUMNS} FROM users WHERE phone = $1`, normalizedPhone);
}

export async function getUserByUid(uid) {
  return prisma.$queryRawUnsafe(`SELECT ${USER_SAFE_COLUMNS} FROM users WHERE uid = $1`, uid);
}

export async function getUserByEmployeeId(employeeId) {
  return prisma.$queryRawUnsafe(`SELECT ${USER_SAFE_COLUMNS} FROM users WHERE employee_id = $1`, employeeId);
}

/**
 * User Listing Queries
 */

export async function buildUserListQuery(filters, requestingUserRole, requestingUserId) {
  let whereClause = 'WHERE 1=1';
  const params = [filters.limit, filters.offset];
  let paramIndex = 3;

  // Role-based access control
  if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
    whereClause += ` AND (u.role = 'PATIENT' OR u.uid = $${paramIndex})`;
    params.push(requestingUserId);
    paramIndex++;
  }

  // Apply filters
  if (filters.searchQuery) {
    whereClause += ` AND (LOWER(u.name) LIKE $${paramIndex} OR u.phone LIKE $${paramIndex} OR u.employee_id LIKE $${paramIndex})`;
    params.push(`%${filters.searchQuery.toLowerCase()}%`);
    paramIndex++;
  }

  if (filters.role) {
    whereClause += ` AND u.role = $${paramIndex}`;
    params.push(filters.role);
    paramIndex++;
  }

  if (filters.department) {
    whereClause += ` AND u.department = $${paramIndex}`;
    params.push(filters.department);
    paramIndex++;
  }

  if (filters.status) {
    whereClause += ` AND u.status = $${paramIndex}`;
    params.push(filters.status);
    paramIndex++;
  }

  if (filters.specialty) {
    whereClause += ` AND u.specialty = $${paramIndex}`;
    params.push(filters.specialty);
    paramIndex++;
  }

  // Validate sort column
  const allowedSortColumns = ['name', 'registered_at', 'role', 'department', 'last_login'];
  const sortBy = allowedSortColumns.includes(filters.sortBy) ? filters.sortBy : 'registered_at';
  const sortOrder = filters.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const query = `
    SELECT 
      u.id, u.uid, u.phone, u.name, u.email, u.gender, u.role, u.department,
      u.specialty, u.employee_id, u.status, u.registered_at, u.last_login,
      u.emergency_contact, u.blood_group,
      ur.role_description,
      COUNT(DISTINCT ual.id) as activity_count,
      MAX(ual.created_at) as last_activity
    FROM users u
    LEFT JOIN user_roles ur ON u.role = ur.role_name
    LEFT JOIN user_action_logs ual ON u.uid = ual.user_id
    ${whereClause}
    GROUP BY u.id, ur.role_description
    ORDER BY u.${sortBy} ${sortOrder}
    LIMIT $1 OFFSET $2`;

  const countQuery = `SELECT COUNT(*) FROM users u ${whereClause}`;

  return {
    query,
    countQuery,
    params,
    countParams: params.slice(2)
  };
}

/**
 * User Search Queries
 */

export async function searchUsers(searchQuery, searchType, filters, requestingUserRole, requestingUserId, limit = 20) {
  let searchClause = '';
  let searchParams = [`%${searchQuery.toLowerCase()}%`];
  let paramIndex = 2;

  // Build search clause based on type
  switch (searchType) {
    case 'name':
      searchClause = 'AND LOWER(u.name) LIKE $1';
      break;
    case 'phone':
      searchClause = 'AND u.phone LIKE $1';
      searchParams = [`%${searchQuery}%`];
      break;
    case 'employee_id':
      searchClause = 'AND UPPER(u.employee_id) LIKE UPPER($1)';
      break;
    case 'email':
      searchClause = 'AND LOWER(u.email) LIKE $1';
      break;
    default: // 'all'
      searchClause = `AND (
        LOWER(u.name) LIKE $1 OR 
        u.phone LIKE $1 OR 
        UPPER(u.employee_id) LIKE UPPER($1) OR 
        LOWER(u.email) LIKE $1
      )`;
  }

  // Add additional filters
  if (filters.role) {
    searchClause += ` AND u.role = $${paramIndex}`;
    searchParams.push(filters.role);
    paramIndex++;
  }

  if (filters.department) {
    searchClause += ` AND u.department = $${paramIndex}`;
    searchParams.push(filters.department);
    paramIndex++;
  }

  // Role-based access control
  if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
    searchClause += ` AND (u.role = 'PATIENT' OR u.uid = $${paramIndex})`;
    searchParams.push(requestingUserId);
    paramIndex++;
  }

  const query = `
    SELECT 
      u.uid, u.name, u.phone, u.email, u.role, u.department,
      u.specialty, u.employee_id, u.status, u.registered_at,
      ur.role_description,
      CASE 
        WHEN LOWER(u.name) LIKE $1 THEN 1
        WHEN u.phone LIKE $1 THEN 2
        WHEN UPPER(u.employee_id) LIKE UPPER($1) THEN 3
        ELSE 4
      END as relevance_score
    FROM users u
    LEFT JOIN user_roles ur ON u.role = ur.role_name
    WHERE u.status = 'active' ${searchClause}
    ORDER BY relevance_score, u.name
    LIMIT $${paramIndex}`;

  return prisma.$queryRawUnsafe(query, ...searchParams, limit);
}

/**
 * Role and Department Queries
 */

export async function getUsersByRole(role, includeInactive = false) {
  const statusFilter = includeInactive ? '' : "AND u.status = 'active'";
  
  const query = `
    SELECT 
      u.uid, u.name, u.phone, u.email, u.department, u.specialty,
      u.employee_id, u.status, u.registered_at, u.last_login,
      ur.role_description,
      COUNT(DISTINCT ual.id) as activity_count
    FROM users u
    LEFT JOIN user_roles ur ON u.role = ur.role_name
    LEFT JOIN user_action_logs ual ON u.uid = ual.user_id AND ual.created_at > NOW() - INTERVAL '30 days'
    WHERE u.role = $1 ${statusFilter}
    GROUP BY u.id, ur.role_description
    ORDER BY u.name ASC`;

  return prisma.$queryRawUnsafe(query, role);
}

export async function getUsersByDepartment(department, roleFilter = null) {
  let roleClause = '';
  const params = [department];
  
  if (roleFilter) {
    roleClause = 'AND u.role = $2';
    params.push(roleFilter);
  }

  const query = `
    SELECT 
      u.uid, u.name, u.phone, u.role, u.specialty, u.employee_id,
      u.status, u.registered_at, u.last_login,
      ur.role_description,
      COUNT(DISTINCT ual.id) as recent_activity
    FROM users u
    LEFT JOIN user_roles ur ON u.role = ur.role_name
    LEFT JOIN user_action_logs ual ON u.uid = ual.user_id AND ual.created_at > NOW() - INTERVAL '7 days'
    WHERE u.department = $1 ${roleClause}
      AND u.status = 'active'
    GROUP BY u.id, ur.role_description
    ORDER BY u.role, u.name`;

  return prisma.$queryRawUnsafe(query, params);
}

/**
 * Status Management Queries
 */

export async function updateUserStatus(identifier, column, newStatus, changedBy, reason) {
  const query = `
    UPDATE users SET 
      status = $1, 
      status_changed_at = NOW(), 
      status_changed_by = $2,
      status_change_reason = $3, 
      updated_at = NOW(), 
      updated_by = $2
    WHERE ${column} = $4
    RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at`;

  return prisma.$queryRawUnsafe(query, newStatus, changedBy, reason, identifier);
}

export async function insertStatusHistory(userId, previousStatus, newStatus, changedBy, reason, ipAddress) {
  const query = `
    INSERT INTO user_status_history (
      user_id, previous_status, new_status, changed_by, change_reason,
      changed_at, ip_address
    ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)`;

  return prisma.$queryRawUnsafe(query, userId, previousStatus, newStatus, changedBy, reason, ipAddress);
}

/**
 * Deactivation Queries
 */

export async function deactivateUser(identifier, column, deactivatedBy, reason, transferTo = null) {
  const query = `
    UPDATE users SET 
      status = 'terminated',
      deactivated_at = NOW(),
      deactivated_by = $1,
      deactivation_reason = $2,
      data_transferred_to = $3,
      updated_at = NOW(),
      updated_by = $1
    WHERE ${column} = $4
    RETURNING id, uid, phone, name, email, role, status, registered_at, updated_at`;

  return prisma.$queryRawUnsafe(query, deactivatedBy, reason, transferTo, identifier);
}

export async function insertDeactivationLog(deactivationData) {
  const query = `
    INSERT INTO user_deactivation_log (
      user_id, deactivated_by, deactivation_reason, data_transferred_to,
      deactivated_at, ip_address, user_data
    ) VALUES ($1, $2, $3, $4, NOW(), $5, $6)`;

  return prisma.$queryRawUnsafe(query, 
    deactivationData.userId,
    deactivationData.deactivatedBy,
    deactivationData.reason,
    deactivationData.transferTo,
    deactivationData.ipAddress,
    JSON.stringify(deactivationData.userData)
  );
}

/**
 * Audit Log Queries
 */

export async function insertUserActionLog(logData) {
  const query = `
    INSERT INTO user_action_logs (
      user_id, action, target_user_id, details, ip_address, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`;

  return prisma.$queryRawUnsafe(query, 
    logData.userId,
    logData.action,
    logData.targetUserId,
    logData.details,
    logData.ipAddress
  );
}

export async function insertBulkOperationLog(operationData) {
  const query = `
    INSERT INTO bulk_operation_logs (
      operation_type, performed_by, total_items, success_count, 
      error_count, operation_details, performed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`;

  return prisma.$queryRawUnsafe(query, 
    operationData.operationType,
    operationData.performedBy,
    operationData.totalItems,
    operationData.successCount,
    operationData.errorCount,
    JSON.stringify(operationData.operationDetails)
  );
}

/**
 * Statistics Queries
 */

export async function getDepartmentStats() {
  const query = `
    SELECT 
      department,
      role,
      COUNT(*) as count,
      COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_last_week
    FROM users
    WHERE status = 'active'
    GROUP BY department, role
    ORDER BY department, count DESC`;

  return prisma.$queryRawUnsafe(query);
}

export async function getUserGrowthStats(days = 30) {
  const query = `
    SELECT
      DATE(registered_at) as registration_date,
      COUNT(*) as new_users,
      COUNT(*) FILTER (WHERE role != 'PATIENT') as new_staff,
      COUNT(*) FILTER (WHERE role = 'PATIENT') as new_patients
    FROM users
    WHERE registered_at > NOW() - make_interval(days => $1)
    GROUP BY DATE(registered_at)
    ORDER BY registration_date DESC`;

  return prisma.$queryRawUnsafe(query, parseInt(days, 10));
}