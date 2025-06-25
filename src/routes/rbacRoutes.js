// src/routes/rbacRoutes.js - ENHANCED VERSION WITH COMPREHENSIVE RBAC MANAGEMENT
import express from 'express';
import { validationResult } from 'express-validator';
import * as rbacController from '../controllers/rbacController.js';
import { wrapAutoRBAC, wrapRoutes, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { body } from 'express-validator';
import { 
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF, 
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF 
} from '../utils/roles.js';

const router = express.Router();
console.log('✅ Enhanced rbacRoutes loaded');

// ✅ All available roles in the system
const ALL_ROLES = [
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF,
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF
];

// ✅ Enhanced role hierarchy with detailed permissions and access levels
const ROLE_HIERARCHY = {
  [ADMIN]: {
    level: 100,
    permissions: ['*'], // All permissions
    canManageRoles: ALL_ROLES,
    canViewData: 'all',
    description: 'System Administrator - Full Access',
    color: '#dc2626', // Red
    maxUsers: null, // No limit
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
    color: '#2563eb', // Blue
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
    color: '#059669', // Green
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
    color: '#7c3aed', // Purple
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
    color: '#ea580c', // Orange
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
    color: '#0891b2', // Cyan
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
    color: '#65a30d', // Lime
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
    color: '#6b7280', // Gray
    maxUsers: null,
    requiresApproval: false
  }
};

// ✅ Validation schemas
const roleAssignmentValidator = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('role').isIn(ALL_ROLES).withMessage('Invalid role specified'),
  body('reason').optional().isLength({ max: 500 }).withMessage('Reason too long')
];

const bulkAssignmentValidator = [
  body('assignments').isArray({ min: 1 }).withMessage('Assignments array required'),
  body('assignments.*.phone').notEmpty().withMessage('Phone required for each assignment'),
  body('assignments.*.role').isIn(ALL_ROLES).withMessage('Valid role required for each assignment')
];

// ==================== PUBLIC INFO ROUTES ====================
// Basic role information (no authentication required)
wrapRoutesWithValidation(
  router,
  [], // No roles = public access
  {
    get: [
      [
        '/public/roles',
        [],
        (req, res) => {
          const publicRoleInfo = ALL_ROLES.map(role => ({
            role,
            description: ROLE_HIERARCHY[role].description,
            level: ROLE_HIERARCHY[role].level,
            color: ROLE_HIERARCHY[role].color,
            requiresApproval: ROLE_HIERARCHY[role].requiresApproval
          }));

          success(res, {
            roles: publicRoleInfo,
            totalRoles: ALL_ROLES.length,
            hierarchy: 'Higher level = More permissions',
            lastUpdated: new Date().toLocaleDateString('en-GB') // dd-MM-YYYY format
          }, 'Public role information retrieved');
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

// ==================== BASIC RBAC ROUTES ====================
// Routes accessible by HR_STAFF, ADMIN
wrapAutoRBAC(router, 'rbacRoutes', {
  get: [
    // 📋 Get All Available Roles with Details
    [
      '/roles',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid || 'anonymous';
          const userRole = req.user?.role;
          
          // Get current role distribution
          const roleStats = await db.query(`
            SELECT role, COUNT(*) as user_count, 
                   COUNT(CASE WHEN is_active = true THEN 1 END) as active_count
            FROM users 
            GROUP BY role
          `).catch(() => ({ rows: [] }));

          const rolesWithDetails = ALL_ROLES.map(role => {
            const stats = roleStats.rows.find(r => r.role === role) || { user_count: 0, active_count: 0 };
            const roleData = ROLE_HIERARCHY[role];
            
            return {
              role,
              ...roleData,
              currentUsers: parseInt(stats.user_count) || 0,
              activeUsers: parseInt(stats.active_count) || 0,
              isAtCapacity: roleData.maxUsers ? stats.active_count >= roleData.maxUsers : false,
              canAssign: userRole === ADMIN || roleData.canManageRoles.includes(role)
            };
          });

          success(res, {
            roles: rolesWithDetails,
            totalRoles: ALL_ROLES.length,
            roleHierarchy: ROLE_HIERARCHY,
            requestedBy
          }, 'Available roles retrieved');

        } catch (err) {
          logger.error(`[GetRoles] ${err.stack || err.toString()}`);
          error(res, 'Failed to fetch roles', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 👥 Get Users Grouped by Role
    [
      '/users',
      async (req, res) => {
        try {
          const { includeInactive = false, role, limit = 100 } = req.query;
          const requestedBy = req.user?.uid || 'anonymous';
          const userRole = req.user?.role;

          let whereClause = 'WHERE 1=1';
          const params = [];

          if (!includeInactive) {
            whereClause += ' AND u.is_active = true';
          }

          if (role && ALL_ROLES.includes(role.toUpperCase())) {
            whereClause += ` AND u.role = $${params.length + 1}`;
            params.push(role.toUpperCase());
          }

          // Role-based filtering for non-admin users
          if (userRole !== ADMIN) {
            const managableRoles = ROLE_HIERARCHY[userRole]?.canManageRoles || [];
            if (managableRoles.length > 0) {
              const roleList = managableRoles.map(r => `'${r}'`).join(',');
              whereClause += ` AND u.role IN (${roleList})`;
            } else {
              // Can only see own role
              whereClause += ` AND u.role = '${userRole}'`;
            }
          }

          const result = await db.query(`
            SELECT 
              u.role,
              COUNT(*) as user_count,
              json_agg(
                json_build_object(
                  'uid', u.uid,
                  'phone', u.phone,
                  'name', u.name,
                  'email', u.email,
                  'registered_at', TO_CHAR(u.registered_at, 'DD-MM-YYYY'),
                  'last_login', TO_CHAR(u.last_login, 'DD-MM-YYYY HH24:MI'),
                  'is_active', u.is_active,
                  'role_updated_at', TO_CHAR(u.role_updated_at, 'DD-MM-YYYY')
                ) ORDER BY u.last_login DESC NULLS LAST
              ) as users
            FROM users u
            ${whereClause}
            GROUP BY u.role
            ORDER BY 
              CASE u.role 
                WHEN '${ADMIN}' THEN 1
                WHEN '${DOCTOR}' THEN 2
                WHEN '${NURSING_STAFF}' THEN 3
                WHEN '${PHARMACY_STAFF}' THEN 4
                WHEN '${LAB_STAFF}' THEN 5
                WHEN '${HR_STAFF}' THEN 6
                WHEN '${GENERAL_STAFF}' THEN 7
                WHEN '${PATIENT}' THEN 8
                ELSE 9
              END
            LIMIT $${params.length + 1}
          `, [...params, parseInt(limit)]);

          // Add role details and statistics
          const usersByRole = result.rows.map(row => ({
            role: row.role,
            userCount: parseInt(row.user_count),
            roleDetails: ROLE_HIERARCHY[row.role],
            users: row.users.slice(0, 50), // Limit users shown for performance
            totalUsers: row.users.length
          }));

          success(res, {
            usersByRole,
            totalUsers: result.rows.reduce((sum, row) => sum + parseInt(row.user_count), 0),
            filters: { includeInactive, role, limit },
            requestedBy
          }, 'Users by role retrieved');

        } catch (err) {
          logger.error(`[GetUsersByRole] ${err.stack || err.toString()}`);
          error(res, 'Failed to fetch users by role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔍 Role Permissions Matrix
    [
      '/permissions',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid || 'anonymous';
          const userRole = req.user?.role;

          // Get all unique permissions
          const allPermissions = new Set();
          Object.values(ROLE_HIERARCHY).forEach(roleData => {
            if (roleData.permissions.includes('*')) {
              allPermissions.add('*');
            } else {
              roleData.permissions.forEach(perm => allPermissions.add(perm));
            }
          });

          // Build permissions matrix
          const permissionsMatrix = {};
          ALL_ROLES.forEach(role => {
            const roleData = ROLE_HIERARCHY[role];
            permissionsMatrix[role] = {
              permissions: roleData.permissions,
              level: roleData.level,
              canManageRoles: roleData.canManageRoles,
              canViewData: roleData.canViewData,
              hasAllPermissions: roleData.permissions.includes('*'),
              description: roleData.description,
              color: roleData.color
            };
          });

          // Role comparison for current user
          const myRole = ROLE_HIERARCHY[userRole];
          const roleComparison = ALL_ROLES.map(role => ({
            role,
            canManage: myRole?.canManageRoles.includes(role) || userRole === ADMIN,
            hasHigherLevel: ROLE_HIERARCHY[role].level > (myRole?.level || 0),
            accessLevel: ROLE_HIERARCHY[role].level
          }));

          success(res, {
            permissionsMatrix,
            allPermissions: Array.from(allPermissions),
            roleHierarchy: ROLE_HIERARCHY,
            myPermissions: myRole,
            roleComparison,
            requestedBy
          }, 'Permissions matrix retrieved');

        } catch (err) {
          logger.error(`[GetPermissions] ${err.stack || err.toString()}`);
          error(res, 'Failed to fetch permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Role Statistics and Analytics
    [
      '/analytics',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid || 'anonymous';
          const { days = 30 } = req.query;

          const [roleDistribution, recentRoleChanges, activeUsersByRole, newRegistrations] = await Promise.all([
            // Role distribution
            db.query(`
              SELECT role, COUNT(*) as count,
                     COUNT(CASE WHEN is_active = true THEN 1 END) as active_count
              FROM users 
              GROUP BY role
            `),

            // Recent role changes
            db.query(`
              SELECT 
                ura.phone, ura.old_role, ura.new_role, 
                TO_CHAR(ura.changed_at, 'DD-MM-YYYY HH24:MI') as changed_at,
                ura.changed_by_uid, u.name as changed_by_name, ura.reason
              FROM user_role_audit ura
              LEFT JOIN users u ON ura.changed_by_uid = u.uid
              ORDER BY ura.changed_at DESC
              LIMIT 20
            `).catch(() => ({ rows: [] })),

            // Active users by role (last 7 days)
            db.query(`
              SELECT role, COUNT(*) as active_count
              FROM users 
              WHERE last_login > NOW() - INTERVAL '7 days'
                AND is_active = true
              GROUP BY role
            `).catch(() => ({ rows: [] })),

            // New registrations by role (configurable days)
            db.query(`
              SELECT role, COUNT(*) as new_count,
                     array_agg(TO_CHAR(registered_at, 'DD-MM-YYYY')) as registration_dates
              FROM users 
              WHERE registered_at > NOW() - INTERVAL '${days} days'
              GROUP BY role
            `).catch(() => ({ rows: [] }))
          ]);

          // Calculate role capacity utilization
          const roleCapacity = roleDistribution.rows.map(row => {
            const roleData = ROLE_HIERARCHY[row.role];
            const activeCount = parseInt(row.active_count);
            
            return {
              role: row.role,
              activeUsers: activeCount,
              totalUsers: parseInt(row.count),
              maxCapacity: roleData.maxUsers,
              utilizationPercent: roleData.maxUsers ? Math.round((activeCount / roleData.maxUsers) * 100) : null,
              isNearCapacity: roleData.maxUsers ? activeCount >= (roleData.maxUsers * 0.8) : false,
              description: roleData.description
            };
          });

          success(res, {
            roleDistribution: roleDistribution.rows,
            roleCapacity,
            recentRoleChanges: recentRoleChanges.rows,
            activeUsersByRole: activeUsersByRole.rows,
            newRegistrations: newRegistrations.rows,
            analyticsPeriod: `${days} days`,
            generatedAt: new Date().toLocaleDateString('en-GB'),
            requestedBy
          }, 'RBAC analytics retrieved');

        } catch (err) {
          logger.error(`[RBACAnalytics] ${err.stack || err.toString()}`);
          error(res, 'Failed to fetch RBAC analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  post: [
    // 👤 Assign Role to User
    [
      '/assign-role',
      roleAssignmentValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { phone, role, reason = 'Admin assignment' } = req.body;
          const adminUid = req.user?.uid;
          const adminRole = req.user?.role;

          const normalizedPhone = normalizePhone(phone);
          const targetRole = role.toUpperCase();

          // Check if admin has permission to assign this role
          const adminCanManage = ROLE_HIERARCHY[adminRole]?.canManageRoles?.includes(targetRole) || 
                                adminRole === ADMIN;

          if (!adminCanManage) {
            return error(res, 'Insufficient permissions to assign this role', HTTP_STATUS.FORBIDDEN);
          }

          // Check role capacity
          const roleData = ROLE_HIERARCHY[targetRole];
          if (roleData.maxUsers) {
            const currentCount = await db.query(
              'SELECT COUNT(*) FROM users WHERE role = $1 AND is_active = true',
              [targetRole]
            );
            
            if (parseInt(currentCount.rows[0].count) >= roleData.maxUsers) {
              return error(res, `Role capacity exceeded. Maximum ${roleData.maxUsers} users allowed for ${targetRole}`, HTTP_STATUS.BAD_REQUEST);
            }
          }

          // Check if user exists
          const userResult = await db.query(
            'SELECT uid, role, name FROM users WHERE phone = $1',
            [normalizedPhone]
          );

          if (userResult.rows.length === 0) {
            return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
          }

          const user = userResult.rows[0];
          const oldRole = user.role;

          if (oldRole === targetRole) {
            return success(res, { 
              phone: normalizedPhone, 
              role: targetRole,
              unchanged: true 
            }, 'Role unchanged');
          }

          // Update user role
          await db.query(
            'UPDATE users SET role = $1, role_updated_at = NOW() WHERE phone = $2',
            [targetRole, normalizedPhone]
          );

          // Log role change in audit table
          await db.query(
            `INSERT INTO user_role_audit (
              phone, old_role, new_role, changed_by_uid, reason, changed_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())`,
            [normalizedPhone, oldRole, targetRole, adminUid, reason]
          ).catch(() => {}); // Graceful fallback if audit table doesn't exist

          logger.info(`🔄 Role changed: ${normalizedPhone} from ${oldRole} to ${targetRole} by ${adminUid}`);

          success(res, {
            phone: normalizedPhone,
            userName: user.name,
            oldRole,
            newRole: targetRole,
            changedBy: adminUid,
            changedByRole: adminRole,
            reason,
            timestamp: new Date().toLocaleDateString('en-GB')
          }, 'Role assigned successfully');

        } catch (err) {
          logger.error(`[AssignRole] ${err.stack || err.toString()}`);
          error(res, 'Failed to assign role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔄 Bulk Role Assignment
    [
      '/bulk-assign',
      bulkAssignmentValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { assignments, reason = 'Bulk assignment' } = req.body;
          const adminUid = req.user?.uid;
          const adminRole = req.user?.role;

          const results = [];
          const errors = [];
          const roleCapacityCheck = {};

          // Pre-check role capacities
          for (const assignment of assignments) {
            const targetRole = assignment.role.toUpperCase();
            const roleData = ROLE_HIERARCHY[targetRole];
            
            if (roleData.maxUsers && !roleCapacityCheck[targetRole]) {
              const currentCount = await db.query(
                'SELECT COUNT(*) FROM users WHERE role = $1 AND is_active = true',
                [targetRole]
              );
              roleCapacityCheck[targetRole] = parseInt(currentCount.rows[0].count);
            }
          }

          for (const assignment of assignments) {
            try {
              const { phone, role } = assignment;
              const normalizedPhone = normalizePhone(phone);
              const targetRole = role.toUpperCase();

              // Check permissions
              const adminCanManage = ROLE_HIERARCHY[adminRole]?.canManageRoles?.includes(targetRole) || 
                                    adminRole === ADMIN;

              if (!adminCanManage) {
                errors.push({ phone, error: 'Insufficient permissions' });
                continue;
              }

              // Check capacity
              const roleData = ROLE_HIERARCHY[targetRole];
              if (roleData.maxUsers) {
                if (roleCapacityCheck[targetRole] >= roleData.maxUsers) {
                  errors.push({ phone, error: `Role ${targetRole} at capacity` });
                  continue;
                }
                roleCapacityCheck[targetRole]++;
              }

              // Get current user
              const userResult = await db.query(
                'SELECT uid, role, name FROM users WHERE phone = $1',
                [normalizedPhone]
              );

              if (userResult.rows.length === 0) {
                errors.push({ phone, error: 'User not found' });
                continue;
              }

              const user = userResult.rows[0];
              const oldRole = user.role;

              if (oldRole === targetRole) {
                results.push({ phone, status: 'unchanged', role: targetRole });
                continue;
              }

              // Update role
              await db.query(
                'UPDATE users SET role = $1, role_updated_at = NOW() WHERE phone = $2',
                [targetRole, normalizedPhone]
              );

              // Log audit
              await db.query(
                `INSERT INTO user_role_audit (
                  phone, old_role, new_role, changed_by_uid, reason, changed_at
                ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                [normalizedPhone, oldRole, targetRole, adminUid, reason]
              ).catch(() => {});

              results.push({
                phone,
                userName: user.name,
                status: 'updated',
                oldRole,
                newRole: targetRole
              });

            } catch (err) {
              errors.push({ phone: assignment.phone, error: err.message });
            }
          }

          logger.info(`📊 Bulk role assignment: ${results.length} successful, ${errors.length} failed`);

          success(res, {
            successful: results,
            failed: errors,
            summary: {
              total: assignments.length,
              successful: results.length,
              failed: errors.length
            },
            processedBy: adminUid,
            processedAt: new Date().toLocaleDateString('en-GB')
          }, 'Bulk role assignment completed');

        } catch (err) {
          logger.error(`[BulkAssign] ${err.stack || err.toString()}`);
          error(res, 'Failed to process bulk assignment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ==================== ADMIN ONLY ROUTES ====================
// Advanced RBAC Management (Admin Only)
wrapRoutes(
  router,
  [ADMIN],
  {
    get: [
      // 🔍 Comprehensive Role Audit Log
      [
        '/admin/audit-log',
        async (req, res) => {
          try {
            const { page = 1, limit = 100, phone, role, startDate, endDate, action_type } = req.query;
            const offset = (page - 1) * limit;
            const requestedBy = req.user?.uid;

            let whereClause = 'WHERE 1=1';
            const params = [parseInt(limit), offset];
            let paramIndex = 3;

            if (phone) {
              const normalizedPhone = normalizePhone(phone);
              whereClause += ` AND ura.phone = $${paramIndex}`;
              params.push(normalizedPhone);
              paramIndex++;
            }

            if (role && ALL_ROLES.includes(role.toUpperCase())) {
              whereClause += ` AND (ura.old_role = $${paramIndex} OR ura.new_role = $${paramIndex})`;
              params.push(role.toUpperCase());
              paramIndex++;
            }

            if (startDate) {
              whereClause += ` AND ura.changed_at >= $${paramIndex}`;
              params.push(startDate);
              paramIndex++;
            }

            if (endDate) {
              whereClause += ` AND ura.changed_at <= $${paramIndex}`;
              params.push(endDate);
              paramIndex++;
            }

            if (action_type) {
              whereClause += ` AND ura.action_type = $${paramIndex}`;
              params.push(action_type);
              paramIndex++;
            }

            const auditLog = await db.query(`
              SELECT 
                ura.id, ura.phone, ura.old_role, ura.new_role, 
                ura.changed_by_uid, ura.reason, 
                TO_CHAR(ura.changed_at, 'DD-MM-YYYY HH24:MI:SS') as changed_at,
                ura.action_type,
                u1.name as user_name,
                u2.name as changed_by_name,
                u2.role as changed_by_role
              FROM user_role_audit ura
              LEFT JOIN users u1 ON ura.phone = u1.phone
              LEFT JOIN users u2 ON ura.changed_by_uid = u2.uid
              ${whereClause}
              ORDER BY ura.changed_at DESC
              LIMIT $1 OFFSET $2`,
              params
            ).catch(() => ({ rows: [] }));

            const total = await db.query(
              `SELECT COUNT(*) FROM user_role_audit ura ${whereClause}`,
              params.slice(2)
            ).catch(() => ({ rows: [{ count: 0 }] }));

            success(res, {
              auditLog: auditLog.rows,
              pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total.rows[0].count),
                totalPages: Math.ceil(total.rows[0].count / limit)
              },
              filters: { phone, role, startDate, endDate, action_type },
              requestedBy
            }, 'Role audit log retrieved');

          } catch (err) {
            logger.error(`[AuditLog] ${err.stack || err.toString()}`);
            error(res, 'Failed to fetch audit log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🚨 Security Alerts for Role Changes
      [
        '/admin/security-alerts',
        async (req, res) => {
          try {
            const requestedBy = req.user?.uid;

            const [suspiciousChanges, privilegeEscalations, nonAdminChanges, capacityAlerts] = await Promise.all([
              // Suspicious role changes (multiple changes in short time)
              db.query(`
                SELECT 
                  phone, COUNT(*) as change_count,
                  array_agg(DISTINCT new_role) as roles_assigned,
                  array_agg(DISTINCT changed_by_uid) as changed_by_users,
                  TO_CHAR(MIN(changed_at), 'DD-MM-YYYY HH24:MI') as first_change,
                  TO_CHAR(MAX(changed_at), 'DD-MM-YYYY HH24:MI') as last_change
                FROM user_role_audit
                WHERE changed_at > NOW() - INTERVAL '24 hours'
                GROUP BY phone
                HAVING COUNT(*) > 2
                ORDER BY change_count DESC
              `).catch(() => ({ rows: [] })),

              // Privilege escalations to high-level roles
              db.query(`
                SELECT 
                  ura.phone, ura.old_role, ura.new_role, 
                  TO_CHAR(ura.changed_at, 'DD-MM-YYYY HH24:MI') as changed_at,
                  ura.changed_by_uid, u.name as changed_by_name
                FROM user_role_audit ura
                LEFT JOIN users u ON ura.changed_by_uid = u.uid
                WHERE ura.new_role IN ('${ADMIN}', '${DOCTOR}')
                  AND ura.changed_at > NOW() - INTERVAL '7 days'
                ORDER BY ura.changed_at DESC
              `).catch(() => ({ rows: [] })),

              // Role changes by non-admin users
              db.query(`
                SELECT 
                  ura.phone, ura.old_role, ura.new_role, 
                  TO_CHAR(ura.changed_at, 'DD-MM-YYYY HH24:MI') as changed_at,
                  ura.changed_by_uid, u.name as changed_by_name, u.role as changer_role
                FROM user_role_audit ura
                LEFT JOIN users u ON ura.changed_by_uid = u.uid
                WHERE u.role != '${ADMIN}'
                  AND ura.changed_at > NOW() - INTERVAL '7 days'
                ORDER BY ura.changed_at DESC
              `).catch(() => ({ rows: [] })),

              // Role capacity alerts
              db.query(`
                SELECT 
                  role, 
                  COUNT(*) as current_count,
                  CASE 
                    WHEN role = '${PHARMACY_STAFF}' THEN 20
                    WHEN role = '${LAB_STAFF}' THEN 15
                    WHEN role = '${HR_STAFF}' THEN 5
                    WHEN role = '${GENERAL_STAFF}' THEN 50
                    ELSE NULL
                  END as max_capacity
                FROM users 
                WHERE is_active = true 
                  AND role IN ('${PHARMACY_STAFF}', '${LAB_STAFF}', '${HR_STAFF}', '${GENERAL_STAFF}')
                GROUP BY role
                HAVING COUNT(*) >= CASE 
                  WHEN role = '${PHARMACY_STAFF}' THEN 16
                  WHEN role = '${LAB_STAFF}' THEN 12
                  WHEN role = '${HR_STAFF}' THEN 4
                  WHEN role = '${GENERAL_STAFF}' THEN 40
                  ELSE 999
                END
              `).catch(() => ({ rows: [] }))
            ]);

            success(res, {
              securityAlerts: {
                suspiciousChanges: suspiciousChanges.rows,
                privilegeEscalations: privilegeEscalations.rows,
                nonAdminChanges: nonAdminChanges.rows,
                capacityAlerts: capacityAlerts.rows
              },
              alertLevel: 'medium', // Can be dynamic based on alerts
              alertsGenerated: new Date().toLocaleDateString('en-GB'),
              requestedBy
            }, 'Security alerts retrieved');

          } catch (err) {
            logger.error(`[SecurityAlerts] ${err.stack || err.toString()}`);
            error(res, 'Failed to fetch security alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📈 Role Migration Report
      [
        '/admin/migration-report',
        async (req, res) => {
          try {
            const { days = 30 } = req.query;
            const requestedBy = req.user?.uid;

            const [roleChanges, commonTransitions, frequentChanges, trendAnalysis] = await Promise.all([
              // Role changes over time
              db.query(`
                SELECT 
                  TO_CHAR(changed_at, 'DD-MM-YYYY') as change_date,
                  old_role, new_role,
                  COUNT(*) as change_count
                FROM user_role_audit
                WHERE changed_at > NOW() - INTERVAL '${days} days'
                GROUP BY TO_CHAR(changed_at, 'DD-MM-YYYY'), old_role, new_role
                ORDER BY change_date DESC, change_count DESC
              `).catch(() => ({ rows: [] })),

              // Most common role transitions
              db.query(`
                SELECT 
                  old_role, new_role,
                  COUNT(*) as transition_count,
                  array_agg(DISTINCT changed_by_uid) as changers,
                  TO_CHAR(MAX(changed_at), 'DD-MM-YYYY') as last_transition
                FROM user_role_audit
                WHERE changed_at > NOW() - INTERVAL '${days} days'
                GROUP BY old_role, new_role
                ORDER BY transition_count DESC
                LIMIT 10
              `).catch(() => ({ rows: [] })),

              // Users with most role changes
              db.query(`
                SELECT 
                  ura.phone, u.name,
                  COUNT(*) as change_count,
                  array_agg(
                    json_build_object(
                      'from', ura.old_role,
                      'to', ura.new_role,
                      'date', TO_CHAR(ura.changed_at, 'DD-MM-YYYY'),
                      'reason', ura.reason
                    ) ORDER BY ura.changed_at
                  ) as change_history
                FROM user_role_audit ura
                LEFT JOIN users u ON ura.phone = u.phone
                WHERE ura.changed_at > NOW() - INTERVAL '${days} days'
                GROUP BY ura.phone, u.name
                ORDER BY change_count DESC
                LIMIT 10
              `).catch(() => ({ rows: [] })),

              // Trend analysis
              db.query(`
                SELECT 
                  new_role,
                  COUNT(*) as assignment_count,
                  COUNT(DISTINCT phone) as unique_users,
                  array_agg(DISTINCT old_role) as source_roles
                FROM user_role_audit
                WHERE changed_at > NOW() - INTERVAL '${days} days'
                GROUP BY new_role
                ORDER BY assignment_count DESC
              `).catch(() => ({ rows: [] }))
            ]);

            success(res, {
              migrationReport: {
                reportPeriod: `${days} days`,
                roleChanges: roleChanges.rows,
                commonTransitions: commonTransitions.rows,
                frequentChanges: frequentChanges.rows,
                trendAnalysis: trendAnalysis.rows
              },
              summary: {
                totalTransitions: roleChanges.rows.reduce((sum, row) => sum + parseInt(row.change_count), 0),
                uniqueUsers: new Set(frequentChanges.rows.map(row => row.phone)).size,
                mostActiveRole: trendAnalysis.rows[0]?.new_role || 'N/A'
              },
              generatedAt: new Date().toLocaleDateString('en-GB'),
              requestedBy
            }, 'Role migration report generated');

          } catch (err) {
            logger.error(`[MigrationReport] ${err.stack || err.toString()}`);
            error(res, 'Failed to generate migration report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // 🔒 Lock/Unlock User Account
      [
        '/admin/toggle-user-status',
        [
          body('phone').notEmpty().withMessage('Phone number is required'),
          body('action').isIn(['lock', 'unlock']).withMessage('Action must be lock or unlock'),
          body('reason').optional().isLength({ max: 500 }).withMessage('Reason too long')
        ],
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const { phone, action, reason = 'Admin action' } = req.body;
            const adminUid = req.user?.uid;

            const normalizedPhone = normalizePhone(phone);
            const isActive = action === 'unlock';

            // Update user status
            const result = await db.query(
              `UPDATE users SET 
                is_active = $1, 
                status_updated_at = NOW(),
                status_updated_by = $2,
                status_reason = $3
               WHERE phone = $4 
               RETURNING uid, name, role, is_active`,
              [isActive, adminUid, reason, normalizedPhone]
            );

            if (result.rows.length === 0) {
              return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
            }

            const user = result.rows[0];

            // Log the action
            await db.query(
              `INSERT INTO user_role_audit (
                phone, old_role, new_role, changed_by_uid, reason, changed_at, action_type
              ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
              [normalizedPhone, user.role, user.role, adminUid, reason, `user_${action}`]
            ).catch(() => {});

            logger.info(`🔒 User account ${action}ed: ${normalizedPhone} by admin ${adminUid}`);

            success(res, {
              phone: normalizedPhone,
              action,
              isActive,
              user: {
                uid: user.uid,
                name: user.name,
                role: user.role,
                isActive: user.is_active
              },
              reason,
              actionBy: adminUid,
              actionAt: new Date().toLocaleDateString('en-GB')
            }, `User account ${action}ed successfully`);

          } catch (err) {
            logger.error(`[ToggleUserStatus] ${err.stack || err.toString()}`);
            error(res, 'Failed to update user status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Mass Role Update
      [
        '/admin/mass-role-update',
        [
          body('fromRole').isIn(ALL_ROLES).withMessage('Valid from role required'),
          body('toRole').isIn(ALL_ROLES).withMessage('Valid to role required'),
          body('reason').optional().isLength({ max: 500 }).withMessage('Reason too long'),
          body('dryRun').optional().isBoolean().withMessage('Dry run must be boolean')
        ],
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const { fromRole, toRole, reason = 'Mass role update', dryRun = false } = req.body;
            const adminUid = req.user?.uid;

            const sourceRole = fromRole.toUpperCase();
            const targetRole = toRole.toUpperCase();

            // Get affected users
            const affectedUsers = await db.query(
              'SELECT uid, phone, name FROM users WHERE role = $1 AND is_active = true',
              [sourceRole]
            );

            // Check target role capacity
            const targetRoleData = ROLE_HIERARCHY[targetRole];
            if (targetRoleData.maxUsers && affectedUsers.rows.length > targetRoleData.maxUsers) {
              return error(res, 
                `Cannot update ${affectedUsers.rows.length} users to ${targetRole}. Maximum capacity: ${targetRoleData.maxUsers}`,
                HTTP_STATUS.BAD_REQUEST
              );
            }

            if (dryRun) {
              return success(res, {
                dryRun: true,
                affectedUsers: affectedUsers.rows,
                count: affectedUsers.rows.length,
                fromRole: sourceRole,
                toRole: targetRole,
                estimatedImpact: {
                  usersAffected: affectedUsers.rows.length,
                  capacityCheck: targetRoleData.maxUsers ? 
                    `${affectedUsers.rows.length}/${targetRoleData.maxUsers}` : 'No limit'
                }
              }, 'Dry run completed - no changes made');
            }

            // Perform mass update
            const updateResult = await db.query(
              'UPDATE users SET role = $1, role_updated_at = NOW() WHERE role = $2 AND is_active = true',
              [targetRole, sourceRole]
            );

            // Log each change
            for (const user of affectedUsers.rows) {
              await db.query(
                `INSERT INTO user_role_audit (
                  phone, old_role, new_role, changed_by_uid, reason, changed_at, action_type
                ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
                [user.phone, sourceRole, targetRole, adminUid, reason, 'mass_update']
              ).catch(() => {});
            }

            logger.info(`🔄 Mass role update: ${updateResult.rowCount} users changed from ${sourceRole} to ${targetRole}`);

            success(res, {
              massUpdate: {
                fromRole: sourceRole,
                toRole: targetRole,
                updatedCount: updateResult.rowCount,
                affectedUsers: affectedUsers.rows.map(u => ({ 
                  uid: u.uid, 
                  name: u.name, 
                  phone: u.phone 
                })),
                reason
              },
              executedBy: adminUid,
              executedAt: new Date().toLocaleDateString('en-GB')
            }, `Mass role update completed - ${updateResult.rowCount} users updated`);

          } catch (err) {
            logger.error(`[MassRoleUpdate] ${err.stack || err.toString()}`);
            error(res, 'Failed to perform mass role update', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 Export RBAC Data
      [
        '/admin/export',
        async (req, res) => {
          try {
            const { format = 'json', includeAudit = false, includeInactive = false } = req.query;
            const requestedBy = req.user?.uid;

            let userQuery = `
              SELECT 
                uid, phone, name, email, role, is_active,
                TO_CHAR(registered_at, 'DD-MM-YYYY') as registered_at, 
                TO_CHAR(last_login, 'DD-MM-YYYY HH24:MI') as last_login, 
                TO_CHAR(role_updated_at, 'DD-MM-YYYY') as role_updated_at
              FROM users
            `;

            if (!includeInactive) {
              userQuery += ' WHERE is_active = true';
            }

            userQuery += ' ORDER BY role, registered_at';

            const users = await db.query(userQuery);

            const exportData = {
              exportedAt: new Date().toLocaleDateString('en-GB'),
              exportedBy: requestedBy,
              totalUsers: users.rows.length,
              roleHierarchy: ROLE_HIERARCHY,
              users: users.rows,
              exportOptions: { format, includeAudit, includeInactive }
            };

            // Include audit log if requested
            if (includeAudit) {
              const auditLog = await db.query(`
                SELECT 
                  phone, old_role, new_role, changed_by_uid, reason, 
                  TO_CHAR(changed_at, 'DD-MM-YYYY HH24:MI') as changed_at,
                  action_type
                FROM user_role_audit 
                ORDER BY changed_at DESC
                LIMIT 1000
              `).catch(() => ({ rows: [] }));
              exportData.auditLog = auditLog.rows;
            }

            if (format === 'csv') {
              // Convert to CSV format
              let csv = 'UID,Phone,Name,Email,Role,IsActive,RegisteredAt,LastLogin,RoleUpdatedAt\n';
              users.rows.forEach(user => {
                csv += `${user.uid},${user.phone},"${user.name || ''}","${user.email || ''}",${user.role},${user.is_active},${user.registered_at},${user.last_login || ''},${user.role_updated_at || ''}\n`;
              });
              
              res.setHeader('Content-Type', 'text/csv');
              res.setHeader('Content-Disposition', 'attachment; filename=rbac_export.csv');
              return res.send(csv);
            }

            success(res, exportData, 'RBAC data exported successfully');

          } catch (err) {
            logger.error(`[RBACExport] ${err.stack || err.toString()}`);
            error(res, 'Failed to export RBAC data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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

// ==================== SELF-SERVICE ROUTES ====================
// Self-Service Role Information (All authenticated users)
wrapRoutes(
  router,
  [], // Any authenticated user
  {
    get: [
      // 📋 Get My Role Information
      [
        '/my-role',
        async (req, res) => {
          try {
            const userRole = req.user?.role;
            const userUid = req.user?.uid;
            const userPhone = req.user?.phone;

            if (!userRole) {
              return error(res, 'User role not found', HTTP_STATUS.BAD_REQUEST);
            }

            const roleInfo = ROLE_HIERARCHY[userRole];
            
            // Get recent role changes for this user
            const roleHistory = await db.query(
              `SELECT old_role, new_role, 
                      TO_CHAR(changed_at, 'DD-MM-YYYY HH24:MI') as changed_at, 
                      reason 
               FROM user_role_audit 
               WHERE phone = $1
               ORDER BY changed_at DESC 
               LIMIT 5`,
              [userPhone]
            ).catch(() => ({ rows: [] }));

            // Get role statistics
            const roleStats = await db.query(
              'SELECT COUNT(*) as total_users FROM users WHERE role = $1 AND is_active = true',
              [userRole]
            ).catch(() => ({ rows: [{ total_users: 0 }] }));

            success(res, {
              currentRole: userRole,
              roleDetails: {
                ...roleInfo,
                totalUsersWithRole: parseInt(roleStats.rows[0].total_users)
              },
              roleHistory: roleHistory.rows,
              capabilities: {
                canViewRoles: roleInfo.permissions.includes('*') || roleInfo.level >= 50,
                canManageUsers: roleInfo.canManageRoles.length > 0,
                dataAccessLevel: roleInfo.canViewData
              },
              lastChecked: new Date().toLocaleDateString('en-GB')
            }, 'Role information retrieved');

          } catch (err) {
            logger.error(`[MyRole] ${err.stack || err.toString()}`);
            error(res, 'Failed to fetch role information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔍 Check My Permissions
      [
        '/my-permissions',
        async (req, res) => {
          try {
            const userRole = req.user?.role;
            const userUid = req.user?.uid;
            const roleInfo = ROLE_HIERARCHY[userRole];

            if (!roleInfo) {
              return error(res, 'Role information not found', HTTP_STATUS.BAD_REQUEST);
            }

            const hasAllPermissions = roleInfo.permissions.includes('*');
            
            // Check specific permissions
            const permissionCategories = {
              medical: roleInfo.permissions.filter(p => p.includes('patient') || p.includes('record') || p.includes('medical')),
              administrative: roleInfo.permissions.filter(p => p.includes('manage') || p.includes('admin')),
              operational: roleInfo.permissions.filter(p => p.includes('view') || p.includes('access')),
              system: roleInfo.permissions.filter(p => p.includes('system') || p === '*')
            };
            
            success(res, {
              user: { uid: userUid, role: userRole },
              roleDetails: {
                level: roleInfo.level,
                description: roleInfo.description,
                color: roleInfo.color
              },
              permissions: {
                all: roleInfo.permissions,
                hasAllPermissions,
                categorized: permissionCategories
              },
              management: {
                canManageRoles: roleInfo.canManageRoles,
                dataAccessLevel: roleInfo.canViewData,
                maxUsers: roleInfo.maxUsers,
                requiresApproval: roleInfo.requiresApproval
              },
              lastChecked: new Date().toLocaleDateString('en-GB')
            }, 'Permissions retrieved');

          } catch (err) {
            logger.error(`[MyPermissions] ${err.stack || err.toString()}`);
            error(res, 'Failed to fetch permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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

export default router;