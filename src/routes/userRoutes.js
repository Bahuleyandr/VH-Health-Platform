// src/routes/userRoutes.js - Enhanced Hospital-Grade User Management System

import express from 'express';
import { validationResult, body, query, param } from 'express-validator';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import pool from '../db.js';
import * as userController from '../controllers/userController.js';
import { userProfileValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import crypto from 'crypto';
import { format } from 'date-fns';

const router = express.Router();

// ✅ Hospital roles and departments
const HOSPITAL_ROLES = {
  // Administrative
  'ADMIN': { level: 1, description: 'System Administrator', department: 'Administration' },
  'HR_MANAGER': { level: 2, description: 'Human Resources Manager', department: 'Human Resources' },
  
  // Medical Staff
  'CHIEF_DOCTOR': { level: 2, description: 'Chief Medical Officer', department: 'Medical' },
  'DOCTOR': { level: 3, description: 'Medical Doctor', department: 'Medical' },
  'SPECIALIST': { level: 3, description: 'Medical Specialist', department: 'Medical' },
  'RESIDENT': { level: 4, description: 'Medical Resident', department: 'Medical' },
  
  // Nursing Staff
  'HEAD_NURSE': { level: 3, description: 'Head of Nursing', department: 'Nursing' },
  'NURSING_STAFF': { level: 4, description: 'Registered Nurse', department: 'Nursing' },
  'NURSE_ASSISTANT': { level: 5, description: 'Nursing Assistant', department: 'Nursing' },
  
  // Support Staff
  'PHARMACIST': { level: 4, description: 'Licensed Pharmacist', department: 'Pharmacy' },
  'PHARMACY_STAFF': { level: 5, description: 'Pharmacy Technician', department: 'Pharmacy' },
  'LAB_TECHNICIAN': { level: 4, description: 'Laboratory Technician', department: 'Laboratory' },
  'LAB_STAFF': { level: 5, description: 'Laboratory Assistant', department: 'Laboratory' },
  'RADIOLOGIST': { level: 3, description: 'Radiologist', department: 'Radiology' },
  'RADIOLOGY_TECH': { level: 4, description: 'Radiology Technician', department: 'Radiology' },
  
  // Other Staff
  'RECEPTIONIST': { level: 5, description: 'Front Desk Receptionist', department: 'Administration' },
  'SECURITY': { level: 6, description: 'Security Personnel', department: 'Security' },
  'MAINTENANCE': { level: 6, description: 'Maintenance Staff', department: 'Facilities' },
  'CLEANER': { level: 6, description: 'Cleaning Staff', department: 'Housekeeping' },
  
  // Patients and External
  'PATIENT': { level: 7, description: 'Hospital Patient', department: 'Patient Care' },
  'VISITOR': { level: 8, description: 'Hospital Visitor', department: 'External' },
  'CONTRACTOR': { level: 8, description: 'External Contractor', department: 'External' }
};

const HOSPITAL_DEPARTMENTS = [
  'Administration', 'Human Resources', 'Medical', 'Nursing', 'Pharmacy', 
  'Laboratory', 'Radiology', 'Emergency', 'Surgery', 'ICU', 'Pediatrics',
  'Cardiology', 'Oncology', 'Neurology', 'Orthopedics', 'Security',
  'Facilities', 'Housekeeping', 'Patient Care', 'External'
];

const SPECIALTIES = [
  'General Medicine', 'Cardiology', 'Neurology', 'Orthopedics', 'Pediatrics',
  'Oncology', 'Emergency Medicine', 'Anesthesiology', 'Surgery', 'Psychiatry',
  'Radiology', 'Pathology', 'Dermatology', 'Ophthalmology', 'ENT',
  'Gynecology', 'Urology', 'Endocrinology', 'Gastroenterology', 'Pulmonology'
];

// ✅ Validation schemas
const userValidation = [
  body('phone').optional().isMobilePhone('any').withMessage('Invalid phone number format'),
  body('name').optional().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  body('email').optional().isEmail().withMessage('Invalid email format'),
  body('role').optional().isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Invalid hospital role'),
  body('department').optional().isIn(HOSPITAL_DEPARTMENTS).withMessage('Invalid department'),
  body('specialty').optional().isIn(SPECIALTIES).withMessage('Invalid medical specialty'),
  body('employeeId').optional().isLength({ min: 3, max: 20 }).withMessage('Employee ID must be 3-20 characters'),
  body('licenseNumber').optional().isLength({ min: 5, max: 50 }).withMessage('License number must be 5-50 characters'),
  body('emergencyContact').optional().isMobilePhone('any').withMessage('Invalid emergency contact number'),
  body('birthday').optional().isISO8601().withMessage('Invalid date format (use YYYY-MM-DD)'),
  body('address').optional().isLength({ max: 500 }).withMessage('Address must be less than 500 characters')
];

const searchValidation = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
  query('role').optional().isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Invalid role filter'),
  query('department').optional().isIn(HOSPITAL_DEPARTMENTS).withMessage('Invalid department filter'),
  query('status').optional().isIn(['active', 'inactive', 'suspended', 'terminated']).withMessage('Invalid status filter')
];

const userIdValidation = [
  param('identifier').notEmpty().withMessage('User identifier is required')
];

// ✅ Utility functions
function generateEmployeeId(role, department) {
  const roleCode = role.substring(0, 3).toUpperCase();
  const deptCode = department.substring(0, 3).toUpperCase();
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `${roleCode}${deptCode}${randomNum}`;
}

function canUserAccessOtherUser(requestingUserRole, targetUserRole, requestingUserId, targetUserId) {
  // Admin can access everyone
  if (requestingUserRole === 'ADMIN' || requestingUserRole === 'HR_MANAGER') {
    return true;
  }
  
  // Users can always access their own data
  if (requestingUserId === targetUserId) {
    return true;
  }
  
  // Medical hierarchy access
  const requestingLevel = HOSPITAL_ROLES[requestingUserRole]?.level || 10;
  const targetLevel = HOSPITAL_ROLES[targetUserRole]?.level || 10;
  
  // Higher level roles can access lower level roles in medical hierarchy
  if (['CHIEF_DOCTOR', 'HEAD_NURSE'].includes(requestingUserRole) && requestingLevel < targetLevel) {
    return true;
  }
  
  // Doctors can access nursing staff and patients
  if (requestingUserRole === 'DOCTOR' && 
      ['NURSING_STAFF', 'NURSE_ASSISTANT', 'PATIENT'].includes(targetUserRole)) {
    return true;
  }
  
  // Nurses can access patients
  if (['NURSING_STAFF', 'HEAD_NURSE'].includes(requestingUserRole) && targetUserRole === 'PATIENT') {
    return true;
  }
  
  return false;
}

async function logUserAction(userId, action, targetUserId = null, details = null, ipAddress = null) {
  try {
    await pool.query(`
      INSERT INTO user_action_logs (
        user_id, action, target_user_id, details, ip_address, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, action, targetUserId, details, ipAddress]);
  } catch (err) {
    logger.error('Failed to log user action:', err);
  }
}

// ✅ RBAC Protected User Routes
wrapAutoRBAC(router, 'userRoutes', {
  post: [
    // 👤 Create/Update User Profile
    [
      '/profile',
      userValidation,
      async (req, res) => {
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
            phone, name, email, gender, address, birthday, anniversary,
            role = 'PATIENT', department, specialty, employeeId, licenseNumber,
            emergencyContact, bloodGroup, allergies, medicalHistory
          } = req.body;

          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          // Role assignment validation
          if (role !== 'PATIENT' && !['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
            return error(res, 'Only administrators can assign staff roles', HTTP_STATUS.FORBIDDEN);
          }

          // Normalize phone
          const normalizedPhone = normalizePhone(phone);
          if (!normalizedPhone) {
            return error(res, 'Valid phone number is required', HTTP_STATUS.BAD_REQUEST);
          }

          // Auto-generate employee ID for staff
          const finalEmployeeId = (role !== 'PATIENT' && role !== 'VISITOR') 
            ? employeeId || generateEmployeeId(role, department || HOSPITAL_ROLES[role].department)
            : null;

          // Check for existing user
          const existingUser = await pool.query(
            'SELECT id, uid, role, name FROM users WHERE phone = $1',
            [normalizedPhone]
          );

          let userId, userUid, operation;

          if (existingUser.rows.length > 0) {
            // Update existing user
            const existing = existingUser.rows[0];
            userId = existing.id;
            userUid = existing.uid;
            operation = 'update';

            // Check if requesting user can update this user
            if (!canUserAccessOtherUser(requestingUserRole, existing.role, requestingUserId, userUid)) {
              return error(res, 'Insufficient permissions to update this user', HTTP_STATUS.FORBIDDEN);
            }

            const result = await pool.query(`
              UPDATE users SET 
                name = $1, email = $2, gender = $3, address = $4, birthday = $5,
                anniversary = $6, role = $7, department = $8, specialty = $9,
                employee_id = $10, license_number = $11, emergency_contact = $12,
                blood_group = $13, allergies = $14, medical_history = $15,
                updated_at = NOW(), updated_by = $16
              WHERE phone = $17
              RETURNING *
            `, [
              name, email, gender, address, birthday, anniversary, role, 
              department || HOSPITAL_ROLES[role].department, specialty, finalEmployeeId,
              licenseNumber, normalizePhone(emergencyContact), bloodGroup, allergies, 
              medicalHistory, requestingUserId, normalizedPhone
            ]);

            // Log the update
            await logUserAction(requestingUserId, 'user_updated', userUid, 
              `Updated user profile: ${name} (${role})`, ipAddress);

          } else {
            // Create new user
            operation = 'create';

            const result = await pool.query(`
              INSERT INTO users (
                phone, name, email, gender, address, birthday, anniversary,
                role, department, specialty, employee_id, license_number,
                emergency_contact, blood_group, allergies, medical_history,
                status, registered_at, created_by
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                'active', NOW(), $17
              ) RETURNING *
            `, [
              normalizedPhone, name, email, gender, address, birthday, anniversary,
              role, department || HOSPITAL_ROLES[role].department, specialty, finalEmployeeId,
              licenseNumber, normalizePhone(emergencyContact), bloodGroup, allergies,
              medicalHistory, requestingUserId
            ]);

            userId = result.rows[0].id;
            userUid = result.rows[0].uid;

            // Log the creation
            await logUserAction(requestingUserId, 'user_created', userUid, 
              `Created new user: ${name} (${role})`, ipAddress);
          }

          // Get updated user data
          const userResult = await pool.query(`
            SELECT 
              u.*, ur.role_description, ur.permissions,
              COUNT(DISTINCT ual.id) as total_actions,
              MAX(ual.created_at) as last_activity
            FROM users u
            LEFT JOIN user_roles ur ON u.role = ur.role_name
            LEFT JOIN user_action_logs ual ON u.uid = ual.user_id
            WHERE u.uid = $1
            GROUP BY u.id, ur.role_description, ur.permissions
          `, [userUid]);

          const userData = userResult.rows[0];

          // Format response
          const formattedUser = {
            ...userData,
            birthday: userData.birthday ? format(new Date(userData.birthday), 'dd-MM-yyyy') : null,
            anniversary: userData.anniversary ? format(new Date(userData.anniversary), 'dd-MM-yyyy') : null,
            registeredAt: userData.registered_at ? format(new Date(userData.registered_at), 'dd-MM-yyyy') : null,
            lastActivity: userData.last_activity ? format(new Date(userData.last_activity), 'dd-MM-yyyy HH:mm') : null,
            roleInfo: HOSPITAL_ROLES[userData.role] || null,
            // Remove sensitive data for non-admin users
            ...(requestingUserRole !== 'ADMIN' && {
              employee_id: undefined,
              license_number: undefined,
              emergency_contact: undefined,
              medical_history: undefined
            })
          };

          logger.info(`👤 User ${operation}: ${name} (${role}) | By: ${requestingUserId} (${requestingUserRole})`);

          success(res, {
            user: formattedUser,
            operation,
            roleAssignment: {
              role,
              department: department || HOSPITAL_ROLES[role].department,
              level: HOSPITAL_ROLES[role].level,
              description: HOSPITAL_ROLES[role].description
            },
            requestedBy: requestingUserId
          }, `User profile ${operation}d successfully`);

        } catch (err) {
          logger.error('User Profile Operation Error:', err);
          error(res, 'Failed to process user profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 👥 Bulk User Import (Admin/HR only)
    [
      '/bulk-import',
      [
        body('users').isArray({ min: 1, max: 50 }).withMessage('Users array required (1-50 users)'),
        body('users.*.phone').isMobilePhone('any').withMessage('Valid phone required for each user'),
        body('users.*.name').isLength({ min: 2, max: 100 }).withMessage('Valid name required for each user'),
        body('users.*.role').isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Valid role required for each user')
      ],
      async (req, res) => {
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
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          // Only admin and HR can bulk import
          if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
            return error(res, 'Only administrators can perform bulk user import', HTTP_STATUS.FORBIDDEN);
          }

          const results = [];
          const errors_list = [];
          let successCount = 0;

          // Process each user
          for (let i = 0; i < users.length; i++) {
            const userData = users[i];
            
            try {
              const normalizedPhone = normalizePhone(userData.phone);
              const department = userData.department || HOSPITAL_ROLES[userData.role].department;
              const employeeId = userData.employeeId || generateEmployeeId(userData.role, department);

              // Check if user exists
              const existing = await pool.query('SELECT uid FROM users WHERE phone = $1', [normalizedPhone]);

              if (existing.rows.length > 0) {
                errors_list.push({
                  index: i + 1,
                  phone: userData.phone,
                  name: userData.name,
                  error: 'User with this phone number already exists'
                });
                continue;
              }

              // Create user
              const result = await pool.query(`
                INSERT INTO users (
                  phone, name, email, gender, role, department, employee_id,
                  status, registered_at, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), $8)
                RETURNING uid, name, phone, role, employee_id
              `, [
                normalizedPhone, userData.name, userData.email, userData.gender,
                userData.role, department, employeeId, requestingUserId
              ]);

              results.push({
                index: i + 1,
                user: result.rows[0],
                status: 'created'
              });

              successCount++;

              // Log creation
              await logUserAction(requestingUserId, 'bulk_user_created', result.rows[0].uid, 
                `Bulk import: ${userData.name} (${userData.role})`, ipAddress);

            } catch (userError) {
              errors_list.push({
                index: i + 1,
                phone: userData.phone,
                name: userData.name,
                error: userError.message
              });
            }
          }

          // Log bulk operation
          await pool.query(`
            INSERT INTO bulk_operation_logs (
              operation_type, performed_by, total_items, success_count, 
              error_count, operation_details, performed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
          `, [
            'bulk_user_import', requestingUserId, users.length, successCount,
            errors_list.length, JSON.stringify({ notifyUsers })
          ]);

          logger.info(`👥 Bulk user import: ${successCount}/${users.length} users created | By: ${requestingUserId}`);

          success(res, {
            importSummary: {
              totalUsers: users.length,
              successful: successCount,
              failed: errors_list.length,
              successRate: `${((successCount / users.length) * 100).toFixed(1)}%`
            },
            createdUsers: results,
            failedUsers: errors_list,
            options: { notifyUsers },
            performedBy: requestingUserId,
            performedAt: new Date().toISOString(),
            performedAtFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
            requestedBy: requestingUserId
          }, `Bulk user import completed: ${successCount}/${users.length} users created successfully`);

        } catch (err) {
          logger.error('Bulk User Import Error:', err);
          error(res, 'Failed to perform bulk user import', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    // 📋 List Users with Advanced Filtering
    [
      '/',
      searchValidation,
      async (req, res) => {
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

          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;
          const offset = (page - 1) * limit;

          let whereClause = 'WHERE 1=1';
          const params = [limit, offset];
          let paramIndex = 3;

          // Role-based access control
          if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
            // Non-admin users can only see patients and their own profile
            whereClause += ` AND (u.role = 'PATIENT' OR u.uid = $${paramIndex})`;
            params.push(requestingUserId);
            paramIndex++;
          }

          // Apply filters
          if (searchQuery) {
            whereClause += ` AND (LOWER(u.name) LIKE $${paramIndex} OR u.phone LIKE $${paramIndex} OR u.employee_id LIKE $${paramIndex})`;
            params.push(`%${searchQuery.toLowerCase()}%`);
            paramIndex++;
          }

          if (role) {
            whereClause += ` AND u.role = $${paramIndex}`;
            params.push(role);
            paramIndex++;
          }

          if (department) {
            whereClause += ` AND u.department = $${paramIndex}`;
            params.push(department);
            paramIndex++;
          }

          if (status) {
            whereClause += ` AND u.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
          }

          if (specialty) {
            whereClause += ` AND u.specialty = $${paramIndex}`;
            params.push(specialty);
            paramIndex++;
          }

          // Validate sort column
          const allowedSortColumns = ['name', 'registered_at', 'role', 'department', 'last_login'];
          const finalSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'registered_at';
          const finalSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

          // Main query
          const users = await pool.query(`
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
            ORDER BY u.${finalSortBy} ${finalSortOrder}
            LIMIT $1 OFFSET $2
          `, params);

          // Count total
          const totalQuery = `SELECT COUNT(*) FROM users u ${whereClause}`;
          const total = await pool.query(totalQuery, params.slice(2));

          // Format users
          const formattedUsers = users.rows.map(user => {
            const roleInfo = HOSPITAL_ROLES[user.role] || {};
            const isOwnProfile = user.uid === requestingUserId;
            const canViewSensitive = ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole) || isOwnProfile;

            return {
              ...user,
              registeredAt: user.registered_at ? format(new Date(user.registered_at), 'dd-MM-yyyy') : null,
              lastLogin: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : null,
              lastActivity: user.last_activity ? format(new Date(user.last_activity), 'dd-MM-yyyy HH:mm') : null,
              roleInfo,
              // Hide sensitive data based on permissions
              employee_id: canViewSensitive ? user.employee_id : undefined,
              emergency_contact: canViewSensitive ? user.emergency_contact : undefined,
              email: canViewSensitive ? user.email : undefined,
              phone: canViewSensitive ? user.phone : `***-***-${user.phone?.slice(-4) || 'XXXX'}`
            };
          });

          // Statistics for admin/HR
          let statistics = null;
          if (['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
            const statsResult = await pool.query(`
              SELECT 
                COUNT(*) as total_users,
                COUNT(*) FILTER (WHERE status = 'active') as active_users,
                COUNT(*) FILTER (WHERE role != 'PATIENT') as staff_count,
                COUNT(*) FILTER (WHERE role = 'PATIENT') as patient_count,
                COUNT(DISTINCT department) as departments,
                COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days') as new_users_30d
              FROM users
              WHERE 1=1 ${whereClause.replace('WHERE 1=1', '')}
            `, params.slice(2));

            statistics = statsResult.rows[0];
          }

          success(res, {
            users: formattedUsers,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: parseInt(total.rows[0].count),
              totalPages: Math.ceil(total.rows[0].count / limit)
            },
            filters: { 
              searchQuery, role, department, status, specialty, sortBy: finalSortBy, sortOrder: finalSortOrder 
            },
            statistics,
            userAccess: {
              role: requestingUserRole,
              canViewAll: ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole),
              canManageRoles: ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)
            },
            requestedBy: requestingUserId
          }, 'Hospital users retrieved successfully');

        } catch (err) {
          logger.error('List Hospital Users Error:', err);
          error(res, 'Failed to fetch hospital users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 👤 Get User by ID/UID
    [
      '/:identifier',
      userIdValidation,
      async (req, res) => {
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
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          // Determine if identifier is UUID (uid) or phone
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

          const result = await pool.query(`
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
          `, [value]);

          if (result.rows.length === 0) {
            return error(res, 'Hospital user not found', HTTP_STATUS.NOT_FOUND);
          }

          const user = result.rows[0];

          // Access control check
          if (!canUserAccessOtherUser(requestingUserRole, user.role, requestingUserId, user.uid)) {
            return error(res, 'Access denied to this user profile', HTTP_STATUS.FORBIDDEN);
          }

          // Log profile access
          await logUserAction(requestingUserId, 'user_profile_viewed', user.uid, 
            `Viewed profile: ${user.name} (${user.role})`, ipAddress);

          // Get recent activity (admin/HR or own profile)
          let recentActivity = [];
          if (['ADMIN', 'HR_MANAGER'].includes(requestingUserRole) || requestingUserId === user.uid) {
            const activityResult = await pool.query(`
              SELECT 
                action, details, created_at, ip_address
              FROM user_action_logs 
              WHERE user_id = $1 
              ORDER BY created_at DESC 
              LIMIT 20
            `, [user.uid]);
            
            recentActivity = activityResult.rows.map(activity => ({
              ...activity,
              createdAt: format(new Date(activity.created_at), 'dd-MM-yyyy HH:mm'),
              ipAddress: ['ADMIN'].includes(requestingUserRole) ? activity.ip_address : undefined
            }));
          }

          // Format user data
          const roleInfo = HOSPITAL_ROLES[user.role] || {};
          const isOwnProfile = user.uid === requestingUserId;
          const canViewSensitive = ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole) || isOwnProfile;

          const formattedUser = {
            ...user,
            birthday: user.birthday ? format(new Date(user.birthday), 'dd-MM-yyyy') : null,
            anniversary: user.anniversary ? format(new Date(user.anniversary), 'dd-MM-yyyy') : null,
            registeredAt: user.registered_at ? format(new Date(user.registered_at), 'dd-MM-yyyy') : null,
            lastLogin: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : null,
            lastActivity: user.last_activity ? format(new Date(user.last_activity), 'dd-MM-yyyy HH:mm') : null,
            updatedAt: user.updated_at ? format(new Date(user.updated_at), 'dd-MM-yyyy') : null,
            roleInfo,
            recentActivity,
            // Conditional sensitive data
            employee_id: canViewSensitive ? user.employee_id : undefined,
            license_number: canViewSensitive ? user.license_number : undefined,
            emergency_contact: canViewSensitive ? user.emergency_contact : undefined,
            medical_history: canViewSensitive ? user.medical_history : undefined,
            phone: canViewSensitive ? user.phone : `***-***-${user.phone?.slice(-4) || 'XXXX'}`,
            email: canViewSensitive ? user.email : undefined
          };

          success(res, {
            user: formattedUser,
            accessLevel: {
              isOwnProfile,
              canEdit: isOwnProfile || ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole),
              canViewSensitive,
              canChangeRole: ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)
            },
            searchedBy: column,
            requestedBy: requestingUserId
          }, 'Hospital user profile retrieved successfully');

        } catch (err) {
          logger.error('Get Hospital User Error:', err);
          error(res, 'Failed to fetch hospital user profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🏥 Get Users by Role
    [
      '/role/:role',
      [
        param('role').isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Invalid hospital role'),
        query('includeInactive').optional().isBoolean()
      ],
      async (req, res) => {
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
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;

          // Access control for sensitive roles
          if (!['ADMIN', 'HR_MANAGER', 'CHIEF_DOCTOR', 'HEAD_NURSE'].includes(requestingUserRole)) {
            // Regular users can only see patients and public staff info
            if (role !== 'PATIENT' && !['DOCTOR', 'NURSING_STAFF'].includes(role)) {
              return error(res, 'Insufficient permissions to view this role', HTTP_STATUS.FORBIDDEN);
            }
          }

          let statusFilter = "AND u.status = 'active'";
          if (includeInactive && ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
            statusFilter = '';
          }

          const result = await pool.query(`
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
            ORDER BY u.name ASC
          `, [role]);

          // Format results based on access level
          const canViewSensitive = ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole);
          const formattedUsers = result.rows.map(user => ({
            ...user,
            registeredAt: user.registered_at ? format(new Date(user.registered_at), 'dd-MM-yyyy') : null,
            lastLogin: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : null,
            phone: canViewSensitive ? user.phone : `***-***-${user.phone?.slice(-4) || 'XXXX'}`,
            email: canViewSensitive ? user.email : undefined,
            employee_id: canViewSensitive ? user.employee_id : undefined
          }));

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
              role: requestingUserRole,
              canViewSensitive
            },
            requestedBy: requestingUserId
          }, `Hospital ${role} users retrieved successfully`);

        } catch (err) {
          logger.error('Get Users by Role Error:', err);
          error(res, 'Failed to fetch users by role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🏢 Get Users by Department
    [
      '/department/:department',
      [
        param('department').isIn(HOSPITAL_DEPARTMENTS).withMessage('Invalid hospital department'),
        query('roleFilter').optional().isIn(Object.keys(HOSPITAL_ROLES))
      ],
      async (req, res) => {
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
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;

          // Access control
          if (!['ADMIN', 'HR_MANAGER', 'CHIEF_DOCTOR', 'HEAD_NURSE'].includes(requestingUserRole)) {
            return error(res, 'Insufficient permissions to view department users', HTTP_STATUS.FORBIDDEN);
          }

          let roleClause = '';
          const params = [department];
          
          if (roleFilter) {
            roleClause = 'AND u.role = $2';
            params.push(roleFilter);
          }

          const result = await pool.query(`
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
            ORDER BY u.role, u.name
          `, params);

          // Group by role
          const usersByRole = {};
          let totalUsers = 0;

          result.rows.forEach(user => {
            if (!usersByRole[user.role]) {
              usersByRole[user.role] = [];
            }
            
            usersByRole[user.role].push({
              ...user,
              registeredAt: user.registered_at ? format(new Date(user.registered_at), 'dd-MM-yyyy') : null,
              lastLogin: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : null,
              phone: `***-***-${user.phone?.slice(-4) || 'XXXX'}` // Partially hide phone
            });
            
            totalUsers++;
          });

          // Department statistics
          const statsResult = await pool.query(`
            SELECT 
              role,
              COUNT(*) as count,
              COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_last_week
            FROM users
            WHERE department = $1 AND status = 'active'
            GROUP BY role
            ORDER BY count DESC
          `, [department]);

          success(res, {
            department,
            usersByRole,
            departmentStatistics: statsResult.rows,
            summary: {
              totalUsers,
              uniqueRoles: Object.keys(usersByRole).length,
              mostCommonRole: statsResult.rows[0]?.role || 'None',
              activeLastWeek: statsResult.rows.reduce((sum, stat) => sum + parseInt(stat.active_last_week), 0)
            },
            filters: { roleFilter },
            requestedBy: requestingUserId
          }, `Hospital ${department} department users retrieved successfully`);

        } catch (err) {
          logger.error('Get Department Users Error:', err);
          error(res, 'Failed to fetch department users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔍 Search Users with Advanced Filters
    [
      '/search',
      [
        query('q').notEmpty().withMessage('Search query is required'),
        query('searchType').optional().isIn(['name', 'phone', 'employee_id', 'email', 'all']),
        query('role').optional().isIn(Object.keys(HOSPITAL_ROLES)),
        query('department').optional().isIn(HOSPITAL_DEPARTMENTS)
      ],
      async (req, res) => {
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
          
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;

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
          if (role) {
            searchClause += ` AND u.role = $${paramIndex}`;
            searchParams.push(role);
            paramIndex++;
          }

          if (department) {
            searchClause += ` AND u.department = $${paramIndex}`;
            searchParams.push(department);
            paramIndex++;
          }

          // Role-based access control
          if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
            searchClause += ` AND (u.role = 'PATIENT' OR u.uid = $${paramIndex})`;
            searchParams.push(requestingUserId);
            paramIndex++;
          }

          const result = await pool.query(`
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
            LIMIT $${paramIndex}
          `, [...searchParams, limit]);

          // Format results based on access level
          const canViewSensitive = ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole);
          const formattedUsers = result.rows.map(user => {
            const roleInfo = HOSPITAL_ROLES[user.role] || {};
            return {
              ...user,
              registeredAt: user.registered_at ? format(new Date(user.registered_at), 'dd-MM-yyyy') : null,
              roleInfo,
              phone: canViewSensitive ? user.phone : `***-***-${user.phone?.slice(-4) || 'XXXX'}`,
              email: canViewSensitive ? user.email : undefined,
              employee_id: canViewSensitive ? user.employee_id : undefined
            };
          });

          success(res, {
            searchQuery,
            searchType,
            filters: { role, department },
            results: formattedUsers,
            summary: {
              totalResults: formattedUsers.length,
              limitReached: formattedUsers.length >= limit,
              searchScope: ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole) ? 'all_users' : 'limited_access'
            },
            requestedBy: requestingUserId
          }, `User search completed: ${formattedUsers.length} results found`);

        } catch (err) {
          logger.error('User Search Error:', err);
          error(res, 'Failed to search users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  put: [
    // ✏️ Update User Profile
    [
      '/:identifier',
      userIdValidation.concat(userValidation),
      async (req, res) => {
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
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          // Get target user
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
          const column = isUUID ? 'uid' : 'phone';
          const value = isUUID ? identifier : normalizePhone(identifier);

          const userResult = await pool.query(
            `SELECT uid, name, role, phone FROM users WHERE ${column} = $1`,
            [value]
          );

          if (userResult.rows.length === 0) {
            return error(res, 'Hospital user not found', HTTP_STATUS.NOT_FOUND);
          }

          const targetUser = userResult.rows[0];

          // Access control check
          if (!canUserAccessOtherUser(requestingUserRole, targetUser.role, requestingUserId, targetUser.uid)) {
            return error(res, 'Insufficient permissions to update this user', HTTP_STATUS.FORBIDDEN);
          }

          // Role change validation
          if (updateData.role && updateData.role !== targetUser.role) {
            if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
              return error(res, 'Only administrators can change user roles', HTTP_STATUS.FORBIDDEN);
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
                key === 'emergency_contact' ? normalizePhone(value) :
                key === 'birthday' || key === 'anniversary' ? value :
                value
              );
              paramIndex++;
            }
          }

          if (updateFields.length === 0) {
            return error(res, 'No valid fields to update', HTTP_STATUS.BAD_REQUEST);
          }

          // Add metadata
          updateFields.push(`updated_at = NOW()`, `updated_by = $${paramIndex}`);
          updateValues.push(requestingUserId);

          // Perform update
          const updateResult = await pool.query(`
            UPDATE users SET ${updateFields.join(', ')}
            WHERE ${column} = $${paramIndex + 1}
            RETURNING *
          `, [...updateValues, value]);

          const updatedUser = updateResult.rows[0];

          // Log the update
          const changedFields = Object.keys(updateData).filter(key => allowedFields.includes(key));
          await logUserAction(requestingUserId, 'user_updated', targetUser.uid, 
            `Updated fields: ${changedFields.join(', ')}`, ipAddress);

          // Special logging for role changes
          if (updateData.role && updateData.role !== targetUser.role) {
            await logUserAction(requestingUserId, 'role_changed', targetUser.uid, 
              `Role changed from ${targetUser.role} to ${updateData.role}`, ipAddress);
          }

          // Format response
          const roleInfo = HOSPITAL_ROLES[updatedUser.role] || {};
          const canViewSensitive = requestingUserId === targetUser.uid || ['ADMIN', 'HR_MANAGER'].includes(requestingUserRole);

          const formattedUser = {
            ...updatedUser,
            birthday: updatedUser.birthday ? format(new Date(updatedUser.birthday), 'dd-MM-yyyy') : null,
            anniversary: updatedUser.anniversary ? format(new Date(updatedUser.anniversary), 'dd-MM-yyyy') : null,
            updatedAt: format(new Date(updatedUser.updated_at), 'dd-MM-yyyy HH:mm'),
            roleInfo,
            // Hide sensitive data if needed
            employee_id: canViewSensitive ? updatedUser.employee_id : undefined,
            license_number: canViewSensitive ? updatedUser.license_number : undefined,
            emergency_contact: canViewSensitive ? updatedUser.emergency_contact : undefined,
            medical_history: canViewSensitive ? updatedUser.medical_history : undefined
          };

          logger.info(`✏️ User updated: ${targetUser.name} | Fields: ${changedFields.join(', ')} | By: ${requestingUserId}`);

          success(res, {
            user: formattedUser,
            updatedFields: changedFields,
            changesSummary: {
              totalFields: changedFields.length,
              roleChanged: updateData.role && updateData.role !== targetUser.role,
              updatedBy: requestingUserId,
              updatedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
            },
            requestedBy: requestingUserId
          }, 'Hospital user profile updated successfully');

        } catch (err) {
          logger.error('Update Hospital User Error:', err);
          error(res, 'Failed to update hospital user profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔄 Change User Status
    [
      '/:identifier/status',
      [
        ...userIdValidation,
        body('status').isIn(['active', 'inactive', 'suspended', 'terminated']).withMessage('Invalid status'),
        body('reason').isLength({ min: 10, max: 500 }).withMessage('Reason required (10-500 characters)')
      ],
      async (req, res) => {
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
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          // Only admin and HR can change status
          if (!['ADMIN', 'HR_MANAGER'].includes(requestingUserRole)) {
            return error(res, 'Only administrators can change user status', HTTP_STATUS.FORBIDDEN);
          }

          // Get target user
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
          const column = isUUID ? 'uid' : 'phone';
          const value = isUUID ? identifier : normalizePhone(identifier);

          const userResult = await pool.query(
            `SELECT uid, name, role, status, phone FROM users WHERE ${column} = $1`,
            [value]
          );

          if (userResult.rows.length === 0) {
            return error(res, 'Hospital user not found', HTTP_STATUS.NOT_FOUND);
          }

          const targetUser = userResult.rows[0];

          // Prevent changing admin status (unless by another admin)
          if (targetUser.role === 'ADMIN' && requestingUserRole !== 'ADMIN') {
            return error(res, 'Cannot change admin user status', HTTP_STATUS.FORBIDDEN);
          }

          // Update status
          const updateResult = await pool.query(`
            UPDATE users SET 
              status = $1, status_changed_at = NOW(), status_changed_by = $2,
              status_change_reason = $3, updated_at = NOW(), updated_by = $2
            WHERE ${column} = $4
            RETURNING *
          `, [status, requestingUserId, reason, value]);

          const updatedUser = updateResult.rows[0];

          // Log status change
          await logUserAction(requestingUserId, 'status_changed', targetUser.uid, 
            `Status changed from ${targetUser.status} to ${status}: ${reason}`, ipAddress);

          // Create status change record
          await pool.query(`
            INSERT INTO user_status_history (
              user_id, previous_status, new_status, changed_by, change_reason,
              changed_at, ip_address
            ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
          `, [targetUser.uid, targetUser.status, status, requestingUserId, reason, ipAddress]);

          logger.info(`🔄 User status changed: ${targetUser.name} (${targetUser.status} → ${status}) | By: ${requestingUserId}`);

          success(res, {
            user: {
              uid: updatedUser.uid,
              name: updatedUser.name,
              role: updatedUser.role,
              previousStatus: targetUser.status,
              newStatus: status,
              statusChangedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
            },
            statusChange: {
              previousStatus: targetUser.status,
              newStatus: status,
              reason,
              changedBy: requestingUserId,
              changedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
            },
            requestedBy: requestingUserId
          }, `User status changed to ${status} successfully`);

        } catch (err) {
          logger.error('Change User Status Error:', err);
          error(res, 'Failed to change user status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  delete: [
    // 🗑️ Deactivate User (Soft Delete)
    [
      '/:identifier',
      [
        ...userIdValidation,
        body('reason').isLength({ min: 10, max: 500 }).withMessage('Deletion reason required (10-500 characters)'),
        body('transferDataTo').optional().isUUID().withMessage('Transfer target must be valid UID')
      ],
      async (req, res) => {
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
          const requestingUserRole = req.user?.role;
          const requestingUserId = req.user?.uid;
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          // Only admin can deactivate users
          if (requestingUserRole !== 'ADMIN') {
            return error(res, 'Only administrators can deactivate users', HTTP_STATUS.FORBIDDEN);
          }

          // Get target user
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
          const column = isUUID ? 'uid' : 'phone';
          const value = isUUID ? identifier : normalizePhone(identifier);

          const userResult = await pool.query(
            `SELECT uid, name, role, status, phone, department FROM users WHERE ${column} = $1`,
            [value]
          );

          if (userResult.rows.length === 0) {
            return error(res, 'Hospital user not found', HTTP_STATUS.NOT_FOUND);
          }

          const targetUser = userResult.rows[0];

          // Prevent self-deletion
          if (targetUser.uid === requestingUserId) {
            return error(res, 'Cannot deactivate your own account', HTTP_STATUS.FORBIDDEN);
          }

          // Validate transfer target if specified
          if (transferDataTo) {
            const transferTarget = await pool.query(
              'SELECT uid, name, role, status FROM users WHERE uid = $1',
              [transferDataTo]
            );

            if (transferTarget.rows.length === 0) {
              return error(res, 'Transfer target user not found', HTTP_STATUS.NOT_FOUND);
            }

            if (transferTarget.rows[0].status !== 'active') {
              return error(res, 'Transfer target must be an active user', HTTP_STATUS.BAD_REQUEST);
            }
          }

          // Soft delete (deactivate)
          const deactivationResult = await pool.query(`
            UPDATE users SET 
              status = 'terminated',
              deactivated_at = NOW(),
              deactivated_by = $1,
              deactivation_reason = $2,
              data_transferred_to = $3,
              updated_at = NOW(),
              updated_by = $1
            WHERE ${column} = $4
            RETURNING *
          `, [requestingUserId, reason, transferDataTo, value]);

          // Log deactivation
          await logUserAction(requestingUserId, 'user_deactivated', targetUser.uid, 
            `User deactivated: ${reason}${transferDataTo ? ` | Data transferred to: ${transferDataTo}` : ''}`, ipAddress);

          // Create deactivation record
          await pool.query(`
            INSERT INTO user_deactivation_log (
              user_id, deactivated_by, deactivation_reason, data_transferred_to,
              deactivated_at, ip_address, user_data
            ) VALUES ($1, $2, $3, $4, NOW(), $5, $6)
          `, [
            targetUser.uid, requestingUserId, reason, transferDataTo, ipAddress,
            JSON.stringify({
              name: targetUser.name,
              role: targetUser.role,
              department: targetUser.department,
              phone: targetUser.phone
            })
          ]);

          // TODO: Handle data transfer logic here if transferDataTo is specified
          // This would involve reassigning files, appointments, etc.

          logger.warn(`🗑️ User deactivated: ${targetUser.name} (${targetUser.role}) | Reason: ${reason} | By: ${requestingUserId}`);

          success(res, {
            deactivatedUser: {
              uid: targetUser.uid,
              name: targetUser.name,
              role: targetUser.role,
              department: targetUser.department,
              previousStatus: targetUser.status,
              deactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
            },
            deactivationDetails: {
              reason,
              transferDataTo,
              deactivatedBy: requestingUserId,
              deactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm'),
              canReactivate: true,
              retentionPeriod: '7 years (as per hospital policy)'
            },
            requestedBy: requestingUserId
          }, 'Hospital user deactivated successfully');

        } catch (err) {
          logger.error('Deactivate User Error:', err);
          error(res, 'Failed to deactivate hospital user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ✅ Admin-Only Hospital User Management Routes
wrapRoutes(
  router,
  ['ADMIN'], // Admin only
  {
    get: [
      // 📊 Hospital User Analytics
      [
        '/admin/analytics',
        [
          query('timeframe').optional().isIn(['7d', '30d', '90d', '1y']).withMessage('Invalid timeframe'),
          query('department').optional().isIn(HOSPITAL_DEPARTMENTS)
        ],
        async (req, res) => {
          try {
            const { timeframe = '30d', department } = req.query;
            
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              case '1y': interval = '1 year'; break;
              default: interval = '30 days';
            }

            let departmentFilter = '';
            const params = [];
            if (department) {
              departmentFilter = 'AND department = $1';
              params.push(department);
            }

            // Overall user statistics
            const overallStats = await pool.query(`
              SELECT 
                COUNT(*) as total_users,
                COUNT(*) FILTER (WHERE status = 'active') as active_users,
                COUNT(*) FILTER (WHERE status = 'inactive') as inactive_users,
                COUNT(*) FILTER (WHERE status = 'suspended') as suspended_users,
                COUNT(*) FILTER (WHERE status = 'terminated') as terminated_users,
                COUNT(*) FILTER (WHERE role != 'PATIENT') as staff_count,
                COUNT(*) FILTER (WHERE role = 'PATIENT') as patient_count,
                COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '${interval}') as new_users,
                COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_last_week,
                COUNT(DISTINCT department) as total_departments,
                AVG(EXTRACT(days FROM NOW() - registered_at)) as avg_tenure_days
              FROM users
              WHERE 1=1 ${departmentFilter}
            `, params);

            // Role distribution
            const roleDistribution = await pool.query(`
              SELECT 
                role,
                COUNT(*) as user_count,
                COUNT(*) FILTER (WHERE status = 'active') as active_count,
                COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days') as active_last_month
              FROM users
              WHERE 1=1 ${departmentFilter}
              GROUP BY role
              ORDER BY user_count DESC
            `, params);

            // Department breakdown
            const departmentStats = await pool.query(`
              SELECT 
                department,
                COUNT(*) as total_users,
                COUNT(*) FILTER (WHERE status = 'active') as active_users,
                COUNT(DISTINCT role) as unique_roles,
                AVG(EXTRACT(days FROM NOW() - registered_at)) as avg_tenure_days
              FROM users
              WHERE role != 'PATIENT'
              GROUP BY department
              ORDER BY total_users DESC
            `);

            // Registration trends
            const registrationTrends = await pool.query(`
              SELECT 
                DATE(registered_at) as registration_date,
                COUNT(*) as new_registrations,
                COUNT(*) FILTER (WHERE role != 'PATIENT') as new_staff,
                COUNT(*) FILTER (WHERE role = 'PATIENT') as new_patients
              FROM users
              WHERE registered_at > NOW() - INTERVAL '${interval}' ${departmentFilter}
              GROUP BY DATE(registered_at)
              ORDER BY registration_date DESC
              LIMIT 30
            `, params);

            // Activity metrics
            const activityMetrics = await pool.query(`
              SELECT 
                DATE(ual.created_at) as activity_date,
                COUNT(DISTINCT ual.user_id) as active_users,
                COUNT(*) as total_actions,
                COUNT(*) FILTER (WHERE ual.action = 'user_login') as logins,
                COUNT(*) FILTER (WHERE ual.action LIKE '%_created') as creation_actions,
                COUNT(*) FILTER (WHERE ual.action LIKE '%_updated') as update_actions
              FROM user_action_logs ual
              JOIN users u ON ual.user_id = u.uid
              WHERE ual.created_at > NOW() - INTERVAL '${interval}' ${departmentFilter.replace('department', 'u.department')}
              GROUP BY DATE(ual.created_at)
              ORDER BY activity_date DESC
              LIMIT 30
            `, params);

            // Medical staff specialties (if no department filter or medical department)
            let specialtyStats = [];
            if (!department || department === 'Medical') {
              const specialtyResult = await pool.query(`
                SELECT 
                  specialty,
                  COUNT(*) as specialist_count,
                  COUNT(*) FILTER (WHERE status = 'active') as active_specialists
                FROM users
                WHERE role IN ('DOCTOR', 'SPECIALIST', 'RESIDENT') 
                  AND specialty IS NOT NULL
                GROUP BY specialty
                ORDER BY specialist_count DESC
              `);
              specialtyStats = specialtyResult.rows;
            }

            // Format results
            const formattedStats = {
              ...overallStats.rows[0],
              active_percentage: overallStats.rows[0].total_users > 0 
                ? ((overallStats.rows[0].active_users / overallStats.rows[0].total_users) * 100).toFixed(1)
                : '0.0',
              staff_percentage: overallStats.rows[0].total_users > 0
                ? ((overallStats.rows[0].staff_count / overallStats.rows[0].total_users) * 100).toFixed(1)
                : '0.0',
              avg_tenure_years: (overallStats.rows[0].avg_tenure_days / 365).toFixed(1)
            };

            const formattedTrends = registrationTrends.rows.map(trend => ({
              ...trend,
              registration_date_formatted: format(new Date(trend.registration_date), 'dd-MM-yyyy')
            }));

            const formattedActivity = activityMetrics.rows.map(activity => ({
              ...activity,
              activity_date_formatted: format(new Date(activity.activity_date), 'dd-MM-yyyy'),
              actions_per_user: activity.active_users > 0 
                ? (activity.total_actions / activity.active_users).toFixed(1)
                : '0.0'
            }));

            success(res, {
              timeframe,
              interval,
              department: department || 'All Departments',
              overallStatistics: formattedStats,
              roleDistribution: roleDistribution.rows,
              departmentBreakdown: departmentStats.rows,
              registrationTrends: formattedTrends,
              activityMetrics: formattedActivity,
              specialtyDistribution: specialtyStats,
              insights: {
                mostActiveRole: roleDistribution.rows[0]?.role || 'None',
                largestDepartment: departmentStats.rows[0]?.department || 'None',
                growthRate: formattedTrends.length > 0 
                  ? `${formattedTrends.reduce((sum, t) => sum + t.new_registrations, 0)} new users in ${timeframe}`
                  : 'No recent growth data',
                activityLevel: formattedStats.active_last_week > 0 
                  ? `${((formattedStats.active_last_week / formattedStats.active_users) * 100).toFixed(1)}% of active users were active last week`
                  : 'Low activity detected'
              },
              generatedAt: new Date().toISOString(),
              generatedAtFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
              requestedBy: req.user?.uid
            }, 'Hospital user analytics generated successfully');

          } catch (err) {
            logger.error('Hospital User Analytics Error:', err);
            error(res, 'Failed to generate hospital user analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔍 User Activity Audit
      [
        '/admin/activity-audit',
        [
          query('userId').optional().isUUID().withMessage('User ID must be valid UUID'),
          query('action').optional().isLength({ min: 1 }).withMessage('Action filter required'),
          query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be 1-365'),
          query('ipAddress').optional().isIP().withMessage('Invalid IP address format')
        ],
        async (req, res) => {
          try {
            const { userId, action, days = 30, ipAddress, limit = 100 } = req.query;

            let whereClause = 'WHERE ual.created_at > NOW() - INTERVAL $1';
            const params = [`${days} days`];
            let paramIndex = 2;

            if (userId) {
              whereClause += ` AND ual.user_id = ${paramIndex}`;
              params.push(userId);
              paramIndex++;
            }

            if (action) {
              whereClause += ` AND ual.action LIKE ${paramIndex}`;
              params.push(`%${action}%`);
              paramIndex++;
            }

            if (ipAddress) {
              whereClause += ` AND ual.ip_address = ${paramIndex}`;
              params.push(ipAddress);
              paramIndex++;
            }

            // Get activity logs with user details
            const activityLogs = await pool.query(`
              SELECT 
                ual.id, ual.user_id, ual.action, ual.target_user_id, ual.details,
                ual.ip_address, ual.created_at,
                u.name as user_name, u.role as user_role, u.department as user_department,
                tu.name as target_user_name, tu.role as target_user_role
              FROM user_action_logs ual
              LEFT JOIN users u ON ual.user_id = u.uid
              LEFT JOIN users tu ON ual.target_user_id = tu.uid
              ${whereClause}
              ORDER BY ual.created_at DESC
              LIMIT ${paramIndex}
            `, [...params, limit]);

            // Activity summary
            const activitySummary = await pool.query(`
              SELECT 
                ual.action,
                COUNT(*) as action_count,
                COUNT(DISTINCT ual.user_id) as unique_users,
                COUNT(DISTINCT ual.ip_address) as unique_ips,
                MIN(ual.created_at) as first_occurrence,
                MAX(ual.created_at) as last_occurrence
              FROM user_action_logs ual
              ${whereClause}
              GROUP BY ual.action
              ORDER BY action_count DESC
            `, params.slice(0, -1));

            // Suspicious activity detection
            const suspiciousActivity = await pool.query(`
              SELECT 
                ual.ip_address,
                ual.user_id,
                u.name as user_name,
                COUNT(*) as action_count,
                COUNT(DISTINCT ual.action) as unique_actions,
                MIN(ual.created_at) as first_activity,
                MAX(ual.created_at) as last_activity,
                ARRAY_AGG(DISTINCT ual.action) as actions_performed
              FROM user_action_logs ual
              LEFT JOIN users u ON ual.user_id = u.uid
              ${whereClause}
              GROUP BY ual.ip_address, ual.user_id, u.name
              HAVING COUNT(*) > 100 OR COUNT(DISTINCT ual.action) > 10
              ORDER BY action_count DESC
              LIMIT 20
            `, params.slice(0, -1));

            // Format results
            const formattedLogs = activityLogs.rows.map(log => ({
              ...log,
              created_at_formatted: format(new Date(log.created_at), 'dd-MM-yyyy HH:mm:ss'),
              risk_level: 
                log.action.includes('delete') || log.action.includes('deactivat') ? 'high' :
                log.action.includes('role_change') || log.action.includes('status') ? 'medium' :
                'low'
            }));

            const formattedSummary = activitySummary.rows.map(summary => ({
              ...summary,
              first_occurrence_formatted: format(new Date(summary.first_occurrence), 'dd-MM-yyyy HH:mm'),
              last_occurrence_formatted: format(new Date(summary.last_occurrence), 'dd-MM-yyyy HH:mm'),
              activity_frequency: summary.action_count / days
            }));

            const formattedSuspicious = suspiciousActivity.rows.map(activity => ({
              ...activity,
              first_activity_formatted: format(new Date(activity.first_activity), 'dd-MM-yyyy HH:mm'),
              last_activity_formatted: format(new Date(activity.last_activity), 'dd-MM-yyyy HH:mm'),
              activity_rate: activity.action_count / days,
              risk_score: Math.min(100, (activity.action_count / 10) + (activity.unique_actions * 5))
            }));

            success(res, {
              auditPeriod: `${days} days`,
              filters: { userId, action, ipAddress },
              activityLogs: formattedLogs,
              activitySummary: formattedSummary,
              suspiciousActivity: formattedSuspicious,
              statistics: {
                totalLogs: formattedLogs.length,
                uniqueUsers: new Set(formattedLogs.map(l => l.user_id)).size,
                uniqueIPs: new Set(formattedLogs.map(l => l.ip_address)).size,
                highRiskActions: formattedLogs.filter(l => l.risk_level === 'high').length,
                mostActiveUser: formattedLogs.length > 0 ? formattedLogs[0].user_name : 'None',
                suspiciousActivityCount: formattedSuspicious.length
              },
              securityRecommendations: [
                formattedSuspicious.length > 0 ? 'Review suspicious activity patterns' : null,
                formattedLogs.filter(l => l.risk_level === 'high').length > 10 ? 'High number of high-risk actions detected' : null,
                new Set(formattedLogs.map(l => l.ip_address)).size > 50 ? 'Many unique IP addresses - consider implementing IP restrictions' : null
              ].filter(Boolean),
              auditGenerated: new Date().toISOString(),
              auditGeneratedFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
              requestedBy: req.user?.uid
            }, 'Hospital user activity audit completed successfully');

          } catch (err) {
            logger.error('User Activity Audit Error:', err);
            error(res, 'Failed to generate user activity audit', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 👥 Inactive Users Report
      [
        '/admin/inactive-users',
        [
          query('inactiveDays').optional().isInt({ min: 1, max: 365 }).withMessage('Inactive days must be 1-365'),
          query('role').optional().isIn(Object.keys(HOSPITAL_ROLES)),
          query('includePatients').optional().isBoolean()
        ],
        async (req, res) => {
          try {
            const { inactiveDays = 90, role, includePatients = false } = req.query;

            let roleFilter = '';
            let patientFilter = includePatients ? '' : "AND role != 'PATIENT'";
            const params = [inactiveDays];
            let paramIndex = 2;

            if (role) {
              roleFilter = ` AND role = ${paramIndex}`;
              params.push(role);
              paramIndex++;
            }

            // Find inactive users
            const inactiveUsers = await pool.query(`
              SELECT 
                u.uid, u.name, u.phone, u.email, u.role, u.department,
                u.employee_id, u.status, u.registered_at, u.last_login,
                EXTRACT(days FROM NOW() - COALESCE(u.last_login, u.registered_at)) as days_inactive,
                COUNT(ual.id) as total_actions,
                MAX(ual.created_at) as last_activity
              FROM users u
              LEFT JOIN user_action_logs ual ON u.uid = ual.user_id
              WHERE u.status = 'active' 
                AND (u.last_login < NOW() - INTERVAL '${inactiveDays} days' OR u.last_login IS NULL)
                ${patientFilter} ${roleFilter}
              GROUP BY u.id
              ORDER BY days_inactive DESC
            `, params.slice(1));

            // Inactivity statistics by department
            const departmentStats = await pool.query(`
              SELECT 
                u.department,
                COUNT(*) as inactive_count,
                AVG(EXTRACT(days FROM NOW() - COALESCE(u.last_login, u.registered_at))) as avg_inactive_days,
                COUNT(*) FILTER (WHERE u.last_login IS NULL) as never_logged_in
              FROM users u
              WHERE u.status = 'active' 
                AND (u.last_login < NOW() - INTERVAL '${inactiveDays} days' OR u.last_login IS NULL)
                ${patientFilter} ${roleFilter}
              GROUP BY u.department
              ORDER BY inactive_count DESC
            `, params.slice(1));

            // Risk assessment for inactive staff
            const riskAssessment = await pool.query(`
              SELECT 
                CASE 
                  WHEN u.role IN ('ADMIN', 'CHIEF_DOCTOR', 'HEAD_NURSE') THEN 'Critical'
                  WHEN u.role IN ('DOCTOR', 'SPECIALIST', 'PHARMACIST') THEN 'High' 
                  WHEN u.role IN ('NURSING_STAFF', 'LAB_TECHNICIAN') THEN 'Medium'
                  ELSE 'Low'
                END as risk_level,
                COUNT(*) as user_count,
                AVG(EXTRACT(days FROM NOW() - COALESCE(u.last_login, u.registered_at))) as avg_inactive_days
              FROM users u
              WHERE u.status = 'active' 
                AND (u.last_login < NOW() - INTERVAL '${inactiveDays} days' OR u.last_login IS NULL)
                ${patientFilter} ${roleFilter}
              GROUP BY 
                CASE 
                  WHEN u.role IN ('ADMIN', 'CHIEF_DOCTOR', 'HEAD_NURSE') THEN 'Critical'
                  WHEN u.role IN ('DOCTOR', 'SPECIALIST', 'PHARMACIST') THEN 'High' 
                  WHEN u.role IN ('NURSING_STAFF', 'LAB_TECHNICIAN') THEN 'Medium'
                  ELSE 'Low'
                END
              ORDER BY 
                CASE 
                  WHEN risk_level = 'Critical' THEN 1
                  WHEN risk_level = 'High' THEN 2
                  WHEN risk_level = 'Medium' THEN 3
                  ELSE 4
                END
            `, params.slice(1));

            // Format results
            const formattedUsers = inactiveUsers.rows.map(user => ({
              ...user,
              registeredAt: format(new Date(user.registered_at), 'dd-MM-yyyy'),
              lastLogin: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : 'Never',
              lastActivity: user.last_activity ? format(new Date(user.last_activity), 'dd-MM-yyyy HH:mm') : 'No activity recorded',
              riskLevel: 
                ['ADMIN', 'CHIEF_DOCTOR', 'HEAD_NURSE'].includes(user.role) ? 'Critical' :
                ['DOCTOR', 'SPECIALIST', 'PHARMACIST'].includes(user.role) ? 'High' :
                ['NURSING_STAFF', 'LAB_TECHNICIAN'].includes(user.role) ? 'Medium' : 'Low',
              recommendedAction: 
                user.days_inactive > 180 ? 'Consider deactivation' :
                user.days_inactive > 120 ? 'Investigate and contact user' :
                'Monitor and remind',
              phone: `***-***-${user.phone?.slice(-4) || 'XXXX'}` // Partially hide phone
            }));

            success(res, {
              criteria: {
                inactiveDays,
                role: role || 'All roles',
                includePatients
              },
              inactiveUsers: formattedUsers,
              departmentBreakdown: departmentStats.rows,
              riskAssessment: riskAssessment.rows,
              summary: {
                totalInactiveUsers: formattedUsers.length,
                criticalRiskUsers: formattedUsers.filter(u => u.riskLevel === 'Critical').length,
                highRiskUsers: formattedUsers.filter(u => u.riskLevel === 'High').length,
                neverLoggedIn: formattedUsers.filter(u => u.lastLogin === 'Never').length,
                averageInactiveDays: formattedUsers.length > 0 
                  ? (formattedUsers.reduce((sum, u) => sum + u.days_inactive, 0) / formattedUsers.length).toFixed(0)
                  : 0,
                oldestInactiveUser: formattedUsers.length > 0 
                  ? `${formattedUsers[0].name} (${formattedUsers[0].days_inactive} days)`
                  : 'None'
              },
              recommendations: [
                formattedUsers.filter(u => u.riskLevel === 'Critical').length > 0 
                  ? `${formattedUsers.filter(u => u.riskLevel === 'Critical').length} critical users inactive - immediate action required`
                  : null,
                formattedUsers.filter(u => u.days_inactive > 180).length > 0
                  ? `${formattedUsers.filter(u => u.days_inactive > 180).length} users inactive for 6+ months - consider deactivation`
                  : null,
                formattedUsers.filter(u => u.lastLogin === 'Never').length > 0
                  ? `${formattedUsers.filter(u => u.lastLogin === 'Never').length} users have never logged in - review onboarding process`
                  : null,
                'Implement automated reminders for inactive users',
                'Review access permissions for long-term inactive accounts'
              ].filter(Boolean),
              reportGenerated: new Date().toISOString(),
              reportGeneratedFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
              requestedBy: req.user?.uid
            }, 'Hospital inactive users report generated successfully');

          } catch (err) {
            logger.error('Inactive Users Report Error:', err);
            error(res, 'Failed to generate inactive users report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // 🔄 Reactivate User
      [
        '/admin/reactivate/:userId',
        [
          param('userId').isUUID().withMessage('User ID must be valid UUID'),
          body('reason').isLength({ min: 10, max: 500 }).withMessage('Reactivation reason required (10-500 characters)')
        ],
        async (req, res) => {
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
            const { userId } = req.params;
            const { reason } = req.body;
            const adminUserId = req.user?.uid;
            const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

            // Get user details
            const userResult = await pool.query(
              'SELECT uid, name, role, status, deactivated_at FROM users WHERE uid = $1',
              [userId]
            );

            if (userResult.rows.length === 0) {
              return error(res, 'Hospital user not found', HTTP_STATUS.NOT_FOUND);
            }

            const user = userResult.rows[0];

            if (user.status === 'active') {
              return error(res, 'User is already active', HTTP_STATUS.BAD_REQUEST);
            }

            // Reactivate user
            const reactivationResult = await pool.query(`
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
              RETURNING *
            `, [adminUserId, reason, userId]);

            // Log reactivation
            await logUserAction(adminUserId, 'user_reactivated', userId, 
              `User reactivated: ${reason}`, ipAddress);

            // Create reactivation record
            await pool.query(`
              INSERT INTO user_reactivation_log (
                user_id, reactivated_by, reactivation_reason, reactivated_at, ip_address
              ) VALUES ($1, $2, $3, NOW(), $4)
            `, [userId, adminUserId, reason, ipAddress]);

            logger.info(`🔄 User reactivated: ${user.name} (${user.role}) | Reason: ${reason} | By: ${adminUserId}`);

            success(res, {
              reactivatedUser: {
                uid: user.uid,
                name: user.name,
                role: user.role,
                previousStatus: user.status,
                newStatus: 'active',
                reactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm'),
                deactivatedPeriod: user.deactivated_at 
                  ? `${Math.floor((new Date() - new Date(user.deactivated_at)) / (1000 * 60 * 60 * 24))} days`
                  : 'Unknown'
              },
              reactivationDetails: {
                reason,
                reactivatedBy: adminUserId,
                reactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
              },
              nextSteps: [
                'User should change password on next login',
                'Review and update user permissions if needed',
                'Verify user still has access to required systems',
                'Update emergency contacts and personal information'
              ],
              requestedBy: adminUserId
            }, 'Hospital user reactivated successfully');

          } catch (err) {
            logger.error('Reactivate User Error:', err);
            error(res, 'Failed to reactivate hospital user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 Generate User Report
      [
        '/admin/generate-report',
        [
          body('reportType').isIn(['department', 'role', 'activity', 'compliance', 'comprehensive']).withMessage('Invalid report type'),
          body('filters').optional().isObject().withMessage('Filters must be an object'),
          body('includeInactive').optional().isBoolean(),
          body('dateRange').optional().isObject().withMessage('Date range must be an object')
        ],
        async (req, res) => {
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
            const { reportType, filters = {}, includeInactive = false, dateRange } = req.body;
            const adminUserId = req.user?.uid;

            let statusFilter = includeInactive ? '' : "AND status = 'active'";
            let dateFilter = '';
            
            if (dateRange && dateRange.from && dateRange.to) {
              dateFilter = `AND registered_at BETWEEN '${dateRange.from}' AND '${dateRange.to}'`;
            }

            let reportData = {};

            switch (reportType) {
              case 'department':
                // Department-focused report
                const deptData = await pool.query(`
                  SELECT 
                    department,
                    COUNT(*) as total_users,
                    COUNT(*) FILTER (WHERE status = 'active') as active_users,
                    COUNT(*) FILTER (WHERE role != 'PATIENT') as staff_count,
                    COUNT(DISTINCT role) as unique_roles,
                    AVG(EXTRACT(days FROM NOW() - registered_at)) as avg_tenure_days,
                    COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days') as active_last_month
                  FROM users
                  WHERE 1=1 ${statusFilter} ${dateFilter}
                  GROUP BY department
                  ORDER BY total_users DESC
                `);

                reportData = {
                  type: 'Department Analysis',
                  departments: deptData.rows,
                  summary: {
                    totalDepartments: deptData.rows.length,
                    largestDepartment: deptData.rows[0]?.department || 'None',
                    smallestDepartment: deptData.rows[deptData.rows.length - 1]?.department || 'None'
                  }
                };
                break;

              case 'role':
                // Role-focused report
                const roleData = await pool.query(`
                  SELECT 
                    role,
                    COUNT(*) as user_count,
                    COUNT(*) FILTER (WHERE status = 'active') as active_count,
                    COUNT(*) FILTER (WHERE gender = 'male') as male_count,
                    COUNT(*) FILTER (WHERE gender = 'female') as female_count,
                    AVG(EXTRACT(days FROM NOW() - registered_at)) as avg_tenure_days,
                    MIN(registered_at) as first_registration,
                    MAX(registered_at) as latest_registration
                  FROM users
                  WHERE 1=1 ${statusFilter} ${dateFilter}
                  GROUP BY role
                  ORDER BY user_count DESC
                `);

                reportData = {
                  type: 'Role Distribution Analysis',
                  roles: roleData.rows.map(role => ({
                    ...role,
                    first_registration_formatted: role.first_registration 
                      ? format(new Date(role.first_registration), 'dd-MM-yyyy')
                      : null,
                    latest_registration_formatted: role.latest_registration
                      ? format(new Date(role.latest_registration), 'dd-MM-yyyy')
                      : null,
                    role_info: HOSPITAL_ROLES[role.role] || {}
                  })),
                  summary: {
                    totalRoles: roleData.rows.length,
                    mostCommonRole: roleData.rows[0]?.role || 'None',
                    leastCommonRole: roleData.rows[roleData.rows.length - 1]?.role || 'None'
                  }
                };
                break;

              case 'activity':
                // Activity-focused report  
                const activityData = await pool.query(`
                  SELECT 
                    u.uid, u.name, u.role, u.department, u.last_login,
                    COUNT(ual.id) as total_actions,
                    COUNT(DISTINCT DATE(ual.created_at)) as active_days,
                    MAX(ual.created_at) as last_activity,
                    ARRAY_AGG(DISTINCT ual.action) FILTER (WHERE ual.action IS NOT NULL) as actions_performed
                  FROM users u
                  LEFT JOIN user_action_logs ual ON u.uid = ual.user_id 
                    AND ual.created_at > NOW() - INTERVAL '90 days'
                  WHERE u.status = 'active' AND u.role != 'PATIENT'
                  GROUP BY u.id
                  ORDER BY total_actions DESC
                  LIMIT 50
                `);

                reportData = {
                  type: 'User Activity Report (90 days)',
                  activeUsers: activityData.rows.map(user => ({
                    ...user,
                    last_login_formatted: user.last_login 
                      ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm')
                      : 'Never',
                    last_activity_formatted: user.last_activity
                      ? format(new Date(user.last_activity), 'dd-MM-yyyy HH:mm')
                      : 'No activity',
                    activity_score: user.total_actions + (user.active_days * 2)
                  })),
                  summary: {
                    mostActiveUser: activityData.rows[0]?.name || 'None',
                    averageActionsPerUser: activityData.rows.length > 0
                      ? (activityData.rows.reduce((sum, u) => sum + u.total_actions, 0) / activityData.rows.length).toFixed(1)
                      : 0
                  }
                };
                break;

              case 'comprehensive':
                // Comprehensive report combining all data
                const [overallStats, deptStats, roleStats, recentActivity] = await Promise.all([
                  pool.query(`
                    SELECT 
                      COUNT(*) as total_users,
                      COUNT(*) FILTER (WHERE status = 'active') as active_users,
                      COUNT(*) FILTER (WHERE role != 'PATIENT') as staff_count,
                      COUNT(DISTINCT department) as departments,
                      COUNT(DISTINCT role) as roles,
                      AVG(EXTRACT(days FROM NOW() - registered_at)) as avg_tenure_days
                    FROM users
                    WHERE 1=1 ${statusFilter} ${dateFilter}
                  `),
                  pool.query(`
                    SELECT department, COUNT(*) as count
                    FROM users 
                    WHERE 1=1 ${statusFilter} ${dateFilter}
                    GROUP BY department 
                    ORDER BY count DESC 
                    LIMIT 10
                  `),
                  pool.query(`
                    SELECT role, COUNT(*) as count
                    FROM users 
                    WHERE 1=1 ${statusFilter} ${dateFilter}
                    GROUP BY role 
                    ORDER BY count DESC
                  `),
                  pool.query(`
                    SELECT DATE(created_at) as date, COUNT(*) as registrations
                    FROM users 
                    WHERE registered_at > NOW() - INTERVAL '30 days' ${statusFilter}
                    GROUP BY DATE(created_at) 
                    ORDER BY date DESC
                  `)
                ]);

                reportData = {
                  type: 'Comprehensive Hospital User Report',
                  overallStatistics: overallStats.rows[0],
                  departmentBreakdown: deptStats.rows,
                  roleDistribution: roleStats.rows,
                  recentRegistrations: recentActivity.rows.map(reg => ({
                    ...reg,
                    date_formatted: format(new Date(reg.date), 'dd-MM-yyyy')
                  })),
                  insights: {
                    largestDepartment: deptStats.rows[0]?.department || 'None',
                    mostCommonRole: roleStats.rows[0]?.role || 'None',
                    recentGrowth: recentActivity.rows.reduce((sum, r) => sum + r.registrations, 0)
                  }
                };
                break;

              default:
                return error(res, 'Invalid report type', HTTP_STATUS.BAD_REQUEST);
            }

            // Log report generation
            await logUserAction(adminUserId, 'report_generated', null, 
              `Generated ${reportType} report`, req.headers['x-forwarded-for']);

            success(res, {
              report: reportData,
              metadata: {
                reportType,
                generatedBy: adminUserId,
                generatedAt: new Date().toISOString(),
                generatedAtFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
                filters: {
                  ...filters,
                  includeInactive,
                  dateRange
                },
                recordCount: 
                  reportData.departments?.length ||
                  reportData.roles?.length ||
                  reportData.activeUsers?.length ||
                  reportData.overallStatistics?.total_users ||
                  0
              },
              requestedBy: adminUserId
            }, `Hospital ${reportType} report generated successfully`);

          } catch (err) {
            logger.error('Generate User Report Error:', err);
            error(res, 'Failed to generate hospital user report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// ✅ System Information Route
wrapRoutes(
  router,
  [], // Public access
  {
    get: [
      [
        '/system-info',
        async (req, res) => {
          try {
            success(res, {
              hospitalRoles: Object.entries(HOSPITAL_ROLES).map(([key, value]) => ({
                role: key,
                ...value
              })),
              departments: HOSPITAL_DEPARTMENTS,
              medicalSpecialties: SPECIALTIES,
              userManagementFeatures: [
                'Role-based access control',
                'Hospital hierarchy management', 
                'HIPAA compliance tracking',
                'User activity monitoring',
                'Automatic deactivation',
                'Bulk user operations',
                'Comprehensive reporting',
                'Audit trail logging'
              ],
              systemVersion: '2.0.0',
              lastUpdated: '2024-01-15'
            }, 'Hospital user management system information');

          } catch (err) {
            logger.error('System Info Error:', err);
            error(res, 'Failed to fetch system information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;