// src/routes/rbacRoutes.js - Enhanced Role-Based Access Control Management

import express from 'express';
import * as rbacController from '../controllers/rbacController.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS } from '../config/responseCodes.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { 
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF, 
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF 
} from '../utils/roles.js';

const router = express.Router();

// ✅ All available roles in the system
const ALL_ROLES = [
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF,
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF
];

// ✅ Role hierarchy and permissions
const ROLE_HIERARCHY = {
  [ADMIN]: {
    level: 100,
    permissions: ['*'], // All permissions
    canManageRoles: ALL_ROLES,
    description: 'System Administrator - Full Access'
  },
  [DOCTOR]: {
    level: 80,
    permissions: [
      'view_patients', 'manage_appointments', 'access_records',
      'create_prescriptions', 'view_investigations', 'create_consultations'
    ],
    canManageRoles: [PATIENT],
    description: 'Medical Doctor - Clinical Access'
  },
  [NURSING_STAFF]: {
    level: 70,
    permissions: [
      'view_patients', 'manage_appointments', 'access_basic_records',
      'assist_consultations', 'manage_investigations'
    ],
    canManageRoles: [PATIENT],
    description: 'Nursing Staff - Patient Care'
  },
  [PHARMACY_STAFF]: {
    level: 60,
    permissions: [
      'view_prescriptions', 'manage_pharmacy_orders', 'access_medication_history'
    ],
    canManageRoles: [],
    description: 'Pharmacy Staff - Medication Management'
  },
  [LAB_STAFF]: {
    level: 60,
    permissions: [
      'manage_investigations', 'upload_lab_results', 'view_test_requests'
    ],
    canManageRoles: [],
    description: 'Laboratory Staff - Test Management'
  },
  [HR_STAFF]: {
    level: 50,
    permissions: [
      'view_staff', 'manage_staff_basic', 'view_attendance', 'generate_hr_reports'
    ],
    canManageRoles: [GENERAL_STAFF],
    description: 'Human Resources - Staff Management'
  },
  [GENERAL_STAFF]: {
    level: 40,
    permissions: [
      'view_basic_info', 'assist_patients', 'manage_appointments_basic'
    ],
    canManageRoles: [],
    description: 'General Staff - Basic Operations'
  },
  [PATIENT]: {
    level: 10,
    permissions: [
      'view_own_records', 'book_appointments', 'view_own_prescriptions',
      'submit_feedback', 'access_patient_portal'
    ],
    canManageRoles: [],
    description: 'Patient - Personal Health Access'
  }
};

// ✅ Basic RBAC Routes
wrapAutoRBAC(router, 'rbacRoutes', {
  get: [
    // 📋 Get All Available Roles
    [
      '/roles',
      async (req, res) => {
        try {
          const rolesWithDetails = ALL_ROLES.map(role => ({
            role,
            ...ROLE_HIERARCHY[role],
            isActive: true
          }));

          success(res, {
            roles: rolesWithDetails,
            totalRoles: ALL_ROLES.length
          }, 'Available roles retrieved');

        } catch (err) {
          logger.error('Get Roles Error:', err);
          error(res, 'Failed to fetch roles', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 👥 Get Users Grouped by Role
    [
      '/users',
      async (req, res) => {
        try {
          const { includeInactive = false, role } = req.query;

          let whereClause = 'WHERE 1=1';
          const params = [];

          if (!includeInactive) {
            whereClause += ' AND u.is_active = true';
          }

          if (role && ALL_ROLES.includes(role.toUpperCase())) {
            whereClause += ` AND u.role = $${params.length + 1}`;
            params.push(role.toUpperCase());
          }

          const result = await pool.query(`
            SELECT 
              u.role,
              COUNT(*) as user_count,
              json_agg(
                json_build_object(
                  'uid', u.uid,
                  'phone', u.phone,
                  'name', u.name,
                  'email', u.email,
                  'registered_at', u.registered_at,
                  'last_login', u.last_login,
                  'is_active', u.is_active
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
          `, params);

          // Add role details
          const usersByRole = result.rows.map(row => ({
            role: row.role,
            userCount: parseInt(row.user_count),
            roleDetails: ROLE_HIERARCHY[row.role],
            users: row.users
          }));

          success(res, {
            usersByRole,
            totalUsers: result.rows.reduce((sum, row) => sum + parseInt(row.user_count), 0)
          }, 'Users by role retrieved');

        } catch (err) {
          logger.error('Get Users by Role Error:', err);
          error(res, 'Failed to fetch users by role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔍 Role Permissions Matrix
    [
      '/permissions',
      async (req, res) => {
        try {
          const permissionsMatrix = {};

          // Get all unique permissions
          const allPermissions = new Set();
          Object.values(ROLE_HIERARCHY).forEach(roleData => {
            if (roleData.permissions.includes('*')) {
              allPermissions.add('*');
            } else {
              roleData.permissions.forEach(perm => allPermissions.add(perm));
            }
          });

          // Build matrix
          ALL_ROLES.forEach(role => {
            permissionsMatrix[role] = {
              permissions: ROLE_HIERARCHY[role].permissions,
              level: ROLE_HIERARCHY[role].level,
              canManageRoles: ROLE_HIERARCHY[role].canManageRoles,
              hasAllPermissions: ROLE_HIERARCHY[role].permissions.includes('*')
            };
          });

          success(res, {
            permissionsMatrix,
            allPermissions: Array.from(allPermissions),
            roleHierarchy: ROLE_HIERARCHY
          }, 'Permissions matrix retrieved');

        } catch (err) {
          logger.error('Get Permissions Error:', err);
          error(res, 'Failed to fetch permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Role Statistics and Analytics
    [
      '/analytics',
      async (req, res) => {
        try {
          // Role distribution
          const roleDistribution = await pool.query(`
            SELECT role, COUNT(*) as count
            FROM users 
            WHERE is_active = true
            GROUP BY role
          `);

          // Recent role changes
          const recentRoleChanges = await pool.query(`
            SELECT 
              phone, old_role, new_role, changed_by_uid, changed_at,
              u.name as changed_by_name
            FROM user_role_audit ura
            LEFT JOIN users u ON ura.changed_by_uid = u.uid
            ORDER BY changed_at DESC
            LIMIT 20
          `);

          // Active users by role (last 7 days)
          const activeUsersByRole = await pool.query(`
            SELECT role, COUNT(*) as active_count
            FROM users 
            WHERE last_login > NOW() - INTERVAL '7 days'
              AND is_active = true
            GROUP BY role
          `);

          // New registrations by role (last 30 days)
          const newRegistrations = await pool.query(`
            SELECT role, COUNT(*) as new_count
            FROM users 
            WHERE registered_at > NOW() - INTERVAL '30 days'
            GROUP BY role
          `);

          success(res, {
            roleDistribution: roleDistribution.rows,
            recentRoleChanges: recentRoleChanges.rows,
            activeUsersByRole: activeUsersByRole.rows,
            newRegistrations: newRegistrations.rows,
            generatedAt: new Date().toISOString()
          }, 'RBAC analytics retrieved');

        } catch (err) {
          logger.error('RBAC Analytics Error:', err);
          error(res, 'Failed to fetch RBAC analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  post: [
    // 👤 Assign Role to User
    [
      '/assign-role',
      async (req, res) => {
        try {
          const { phone, role, reason = 'Admin assignment' } = req.body;
          const adminUid = req.user?.uid;
          const adminRole = req.user?.role;

          if (!phone || !role) {
            return error(res, 'Phone and role are required', HTTP_STATUS.BAD_REQUEST);
          }

          if (!ALL_ROLES.includes(role.toUpperCase())) {
            return error(res, 'Invalid role specified', HTTP_STATUS.BAD_REQUEST);
          }

          const normalizedPhone = normalizePhone(phone);
          const targetRole = role.toUpperCase();

          // Check if admin has permission to assign this role
          const adminCanManage = ROLE_HIERARCHY[adminRole]?.canManageRoles?.includes(targetRole) || 
                                adminRole === ADMIN;

          if (!adminCanManage) {
            return error(res, 'Insufficient permissions to assign this role', HTTP_STATUS.FORBIDDEN);
          }

          // Check if user exists
          const userResult = await pool.query(
            'SELECT uid, role FROM users WHERE phone = $1',
            [normalizedPhone]
          );

          if (userResult.rows.length === 0) {
            return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
          }

          const user = userResult.rows[0];
          const oldRole = user.role;

          if (oldRole === targetRole) {
            return success(res, { phone: normalizedPhone, role: targetRole }, 'Role unchanged');
          }

          // Update user role
          await pool.query(
            'UPDATE users SET role = $1, role_updated_at = NOW() WHERE phone = $2',
            [targetRole, normalizedPhone]
          );

          // Log role change in audit table
          await pool.query(
            `INSERT INTO user_role_audit (
              phone, old_role, new_role, changed_by_uid, reason, changed_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())`,
            [normalizedPhone, oldRole, targetRole, adminUid, reason]
          );

          logger.info(`🔄 Role changed: ${normalizedPhone} from ${oldRole} to ${targetRole} by ${adminUid}`);

          success(res, {
            phone: normalizedPhone,
            oldRole,
            newRole: targetRole,
            changedBy: adminUid,
            reason
          }, 'Role assigned successfully');

        } catch (err) {
          logger.error('Assign Role Error:', err);
          error(res, 'Failed to assign role', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔄 Bulk Role Assignment
    [
      '/bulk-assign',
      async (req, res) => {
        try {
          const { assignments, reason = 'Bulk assignment' } = req.body;
          const adminUid = req.user?.uid;
          const adminRole = req.user?.role;

          if (!Array.isArray(assignments) || assignments.length === 0) {
            return error(res, 'Assignments array is required', HTTP_STATUS.BAD_REQUEST);
          }

          const results = [];
          const errors = [];

          for (const assignment of assignments) {
            try {
              const { phone, role } = assignment;
              const normalizedPhone = normalizePhone(phone);
              const targetRole = role.toUpperCase();

              // Validate
              if (!ALL_ROLES.includes(targetRole)) {
                errors.push({ phone, error: 'Invalid role' });
                continue;
              }

              const adminCanManage = ROLE_HIERARCHY[adminRole]?.canManageRoles?.includes(targetRole) || 
                                    adminRole === ADMIN;

              if (!adminCanManage) {
                errors.push({ phone, error: 'Insufficient permissions' });
                continue;
              }

              // Get current user
              const userResult = await pool.query(
                'SELECT uid, role FROM users WHERE phone = $1',
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
              await pool.query(
                'UPDATE users SET role = $1, role_updated_at = NOW() WHERE phone = $2',
                [targetRole, normalizedPhone]
              );

              // Log audit
              await pool.query(
                `INSERT INTO user_role_audit (
                  phone, old_role, new_role, changed_by_uid, reason, changed_at
                ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                [normalizedPhone, oldRole, targetRole, adminUid, reason]
              );

              results.push({
                phone,
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
            }
          }, 'Bulk role assignment completed');

        } catch (err) {
          logger.error('Bulk Assign Error:', err);
          error(res, 'Failed to process bulk assignment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ✅ Advanced RBAC Management (Admin Only)
wrapRoutes(
  router,
  [ADMIN],
  {
    get: [
      // 🔍 Role Audit Log
      [
        '/admin/audit-log',
        async (req, res) => {
          try {
            const { page = 1, limit = 100, phone, role, startDate, endDate } = req.query;
            const offset = (page - 1) * limit;

            let whereClause = 'WHERE 1=1';
            const params = [limit, offset];
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

            const auditLog = await pool.query(`
              SELECT 
                ura.id, ura.phone, ura.old_role, ura.new_role, 
                ura.changed_by_uid, ura.reason, ura.changed_at,
                u1.name as user_name,
                u2.name as changed_by_name
              FROM user_role_audit ura
              LEFT JOIN users u1 ON ura.phone = u1.phone
              LEFT JOIN users u2 ON ura.changed_by_uid = u2.uid
              ${whereClause}
              ORDER BY ura.changed_at DESC
              LIMIT $1 OFFSET $2`,
              params
            );

            const total = await pool.query(
              `SELECT COUNT(*) FROM user_role_audit ura ${whereClause}`,
              params.slice(2)
            );

            success(res, {
              auditLog: auditLog.rows,
              pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total.rows[0].count),
                totalPages: Math.ceil(total.rows[0].count / limit)
              }
            }, 'Role audit log retrieved');

          } catch (err) {
            logger.error('Audit Log Error:', err);
            error(res, 'Failed to fetch audit log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🚨 Security Alerts for Role Changes
      [
        '/admin/security-alerts',
        async (req, res) => {
          try {
            // Suspicious role changes (multiple changes in short time)
            const suspiciousChanges = await pool.query(`
              SELECT 
                phone, COUNT(*) as change_count,
                array_agg(DISTINCT new_role) as roles_assigned,
                array_agg(DISTINCT changed_by_uid) as changed_by_users,
                MIN(changed_at) as first_change,
                MAX(changed_at) as last_change
              FROM user_role_audit
              WHERE changed_at > NOW() - INTERVAL '24 hours'
              GROUP BY phone
              HAVING COUNT(*) > 2
              ORDER BY change_count DESC
            `);

            // Privilege escalations to high-level roles
            const privilegeEscalations = await pool.query(`
              SELECT 
                ura.phone, ura.old_role, ura.new_role, ura.changed_at,
                ura.changed_by_uid, u.name as changed_by_name
              FROM user_role_audit ura
              LEFT JOIN users u ON ura.changed_by_uid = u.uid
              WHERE ura.new_role IN ('${ADMIN}', '${DOCTOR}')
                AND ura.changed_at > NOW() - INTERVAL '7 days'
              ORDER BY ura.changed_at DESC
            `);

            // Role changes by non-admin users
            const nonAdminChanges = await pool.query(`
              SELECT 
                ura.phone, ura.old_role, ura.new_role, ura.changed_at,
                ura.changed_by_uid, u.name as changed_by_name, u.role as changer_role
              FROM user_role_audit ura
              LEFT JOIN users u ON ura.changed_by_uid = u.uid
              WHERE u.role != '${ADMIN}'
                AND ura.changed_at > NOW() - INTERVAL '7 days'
              ORDER BY ura.changed_at DESC
            `);

            success(res, {
              suspiciousChanges: suspiciousChanges.rows,
              privilegeEscalations: privilegeEscalations.rows,
              nonAdminChanges: nonAdminChanges.rows,
              alertsGenerated: new Date().toISOString()
            }, 'Security alerts retrieved');

          } catch (err) {
            logger.error('Security Alerts Error:', err);
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

            // Role changes over time
            const roleChanges = await pool.query(`
              SELECT 
                DATE(changed_at) as change_date,
                old_role, new_role,
                COUNT(*) as change_count
              FROM user_role_audit
              WHERE changed_at > NOW() - INTERVAL '${days} days'
              GROUP BY DATE(changed_at), old_role, new_role
              ORDER BY change_date DESC, change_count DESC
            `);

            // Most common role transitions
            const commonTransitions = await pool.query(`
              SELECT 
                old_role, new_role,
                COUNT(*) as transition_count,
                array_agg(DISTINCT changed_by_uid) as changers
              FROM user_role_audit
              WHERE changed_at > NOW() - INTERVAL '${days} days'
              GROUP BY old_role, new_role
              ORDER BY transition_count DESC
              LIMIT 10
            `);

            // Users with most role changes
            const frequentChanges = await pool.query(`
              SELECT 
                ura.phone, u.name,
                COUNT(*) as change_count,
                array_agg(
                  json_build_object(
                    'from', ura.old_role,
                    'to', ura.new_role,
                    'date', ura.changed_at
                  ) ORDER BY ura.changed_at
                ) as change_history
              FROM user_role_audit ura
              LEFT JOIN users u ON ura.phone = u.phone
              WHERE ura.changed_at > NOW() - INTERVAL '${days} days'
              GROUP BY ura.phone, u.name
              ORDER BY change_count DESC
              LIMIT 10
            `);

            success(res, {
              reportPeriod: `${days} days`,
              roleChanges: roleChanges.rows,
              commonTransitions: commonTransitions.rows,
              frequentChanges: frequentChanges.rows,
              generatedAt: new Date().toISOString()
            }, 'Role migration report generated');

          } catch (err) {
            logger.error('Migration Report Error:', err);
            error(res, 'Failed to generate migration report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // 🔒 Lock/Unlock User Account
      [
        '/admin/toggle-user-status',
        async (req, res) => {
          try {
            const { phone, action, reason = 'Admin action' } = req.body; // action: 'lock' or 'unlock'
            const adminUid = req.user?.uid;

            if (!phone || !['lock', 'unlock'].includes(action)) {
              return error(res, 'Valid phone and action (lock/unlock) required', HTTP_STATUS.BAD_REQUEST);
            }

            const normalizedPhone = normalizePhone(phone);
            const isActive = action === 'unlock';

            // Update user status
            const result = await pool.query(
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
            await pool.query(
              `INSERT INTO user_role_audit (
                phone, old_role, new_role, changed_by_uid, reason, changed_at, action_type
              ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
              [normalizedPhone, user.role, user.role, adminUid, reason, `user_${action}`]
            );

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
              reason
            }, `User account ${action}ed successfully`);

          } catch (err) {
            logger.error('Toggle User Status Error:', err);
            error(res, 'Failed to update user status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Mass Role Update
      [
        '/admin/mass-role-update',
        async (req, res) => {
          try {
            const { fromRole, toRole, reason = 'Mass role update', dryRun = false } = req.body;
            const adminUid = req.user?.uid;

            if (!fromRole || !toRole) {
              return error(res, 'From role and to role are required', HTTP_STATUS.BAD_REQUEST);
            }

            if (!ALL_ROLES.includes(fromRole.toUpperCase()) || !ALL_ROLES.includes(toRole.toUpperCase())) {
              return error(res, 'Invalid role specified', HTTP_STATUS.BAD_REQUEST);
            }

            const sourceRole = fromRole.toUpperCase();
            const targetRole = toRole.toUpperCase();

            // Get affected users
            const affectedUsers = await pool.query(
              'SELECT uid, phone, name FROM users WHERE role = $1 AND is_active = true',
              [sourceRole]
            );

            if (dryRun) {
              return success(res, {
                dryRun: true,
                affectedUsers: affectedUsers.rows,
                count: affectedUsers.rows.length,
                fromRole: sourceRole,
                toRole: targetRole
              }, 'Dry run completed - no changes made');
            }

            // Perform mass update
            const updateResult = await pool.query(
              'UPDATE users SET role = $1, role_updated_at = NOW() WHERE role = $2 AND is_active = true',
              [targetRole, sourceRole]
            );

            // Log each change
            for (const user of affectedUsers.rows) {
              await pool.query(
                `INSERT INTO user_role_audit (
                  phone, old_role, new_role, changed_by_uid, reason, changed_at, action_type
                ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
                [user.phone, sourceRole, targetRole, adminUid, reason, 'mass_update']
              );
            }

            logger.info(`🔄 Mass role update: ${updateResult.rowCount} users changed from ${sourceRole} to ${targetRole}`);

            success(res, {
              fromRole: sourceRole,
              toRole: targetRole,
              updatedCount: updateResult.rowCount,
              affectedUsers: affectedUsers.rows,
              reason
            }, `Mass role update completed - ${updateResult.rowCount} users updated`);

          } catch (err) {
            logger.error('Mass Role Update Error:', err);
            error(res, 'Failed to perform mass role update', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 Export RBAC Data
      [
        '/admin/export',
        async (req, res) => {
          try {
            const { format = 'json', includeAudit = false } = req.query;

            // Get all users with roles
            const users = await pool.query(`
              SELECT 
                uid, phone, name, email, role, is_active,
                registered_at, last_login, role_updated_at
              FROM users 
              ORDER BY role, registered_at
            `);

            const exportData = {
              exportedAt: new Date().toISOString(),
              totalUsers: users.rows.length,
              roleHierarchy: ROLE_HIERARCHY,
              users: users.rows
            };

            // Include audit log if requested
            if (includeAudit) {
              const auditLog = await pool.query(`
                SELECT 
                  phone, old_role, new_role, changed_by_uid, reason, changed_at
                FROM user_role_audit 
                ORDER BY changed_at DESC
                LIMIT 1000
              `);
              exportData.auditLog = auditLog.rows;
            }

            if (format === 'csv') {
              // Convert to CSV format (simplified)
              let csv = 'UID,Phone,Name,Email,Role,IsActive,RegisteredAt,LastLogin\n';
              users.rows.forEach(user => {
                csv += `${user.uid},${user.phone},${user.name || ''},${user.email || ''},${user.role},${user.is_active},${user.registered_at},${user.last_login || ''}\n`;
              });
              
              res.setHeader('Content-Type', 'text/csv');
              res.setHeader('Content-Disposition', 'attachment; filename=rbac_export.csv');
              return res.send(csv);
            }

            success(res, exportData, 'RBAC data exported successfully');

          } catch (err) {
            logger.error('RBAC Export Error:', err);
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

// ✅ Self-Service Role Information (All authenticated users)
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

            if (!userRole) {
              return error(res, 'User role not found', HTTP_STATUS.BAD_REQUEST);
            }

            const roleInfo = ROLE_HIERARCHY[userRole];
            
            // Get recent role changes for this user
            const roleHistory = await pool.query(
              `SELECT old_role, new_role, changed_at, reason 
               FROM user_role_audit 
               WHERE phone = (SELECT phone FROM users WHERE uid = $1)
               ORDER BY changed_at DESC 
               LIMIT 5`,
              [userUid]
            );

            success(res, {
              currentRole: userRole,
              roleDetails: roleInfo,
              roleHistory: roleHistory.rows,
              canViewRoles: roleInfo.permissions.includes('*') || roleInfo.level >= 50
            }, 'Role information retrieved');

          } catch (err) {
            logger.error('My Role Error:', err);
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
            const roleInfo = ROLE_HIERARCHY[userRole];

            if (!roleInfo) {
              return error(res, 'Role information not found', HTTP_STATUS.BAD_REQUEST);
            }

            const hasAllPermissions = roleInfo.permissions.includes('*');
            
            success(res, {
              role: userRole,
              level: roleInfo.level,
              permissions: roleInfo.permissions,
              hasAllPermissions,
              canManageRoles: roleInfo.canManageRoles,
              description: roleInfo.description
            }, 'Permissions retrieved');

          } catch (err) {
            logger.error('My Permissions Error:', err);
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