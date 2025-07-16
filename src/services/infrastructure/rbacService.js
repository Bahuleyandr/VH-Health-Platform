// services/infrastructure/rbacService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { 
  ROLE_HIERARCHY,
  canUserManageRole,
  checkRoleCapacity,
  getManageableRoles,
  hasPermission,
  validateRoleTransition,
  calculateRoleStatistics
} from '../../utils/infrastructure/rbacUtils.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { 
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF, 
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF 
} from '../../utils/roles.js';

const ALL_ROLES = [
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF,
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF
];

export class RBACService {
  // Get all available roles with details
  static async getAvailableRoles(userInfo) {
    try {
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
          canAssign: canUserManageRole(userInfo.role, role)
        };
      });
      
      return {
        roles: rolesWithDetails,
        totalRoles: ALL_ROLES.length,
        roleHierarchy: ROLE_HIERARCHY,
        requestedBy: userInfo.uid
      };
    } catch (error) {
      logger.error('Get available roles error:', error);
      throw error;
    }
  }
  
  // Get users grouped by role
  static async getUsersByRole(filters, userInfo) {
    try {
      const { includeInactive = false, role, limit = 100 } = filters;
      
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
      if (userInfo.role !== ADMIN) {
        const managableRoles = getManageableRoles(userInfo.role);
        if (managableRoles.length > 0) {
          const roleList = managableRoles.map(r => `'${r}'`).join(',');
          whereClause += ` AND u.role IN (${roleList})`;
        } else {
          // Can only see own role
          whereClause += ` AND u.role = '${userInfo.role}'`;
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
      
      return {
        usersByRole,
        totalUsers: result.rows.reduce((sum, row) => sum + parseInt(row.user_count), 0),
        filters: { includeInactive, role, limit },
        requestedBy: userInfo.uid
      };
    } catch (error) {
      logger.error('Get users by role error:', error);
      throw error;
    }
  }
  
  // Get permissions matrix
  static getPermissionsMatrix(userInfo) {
    try {
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
      const myRole = ROLE_HIERARCHY[userInfo.role];
      const roleComparison = ALL_ROLES.map(role => ({
        role,
        canManage: canUserManageRole(userInfo.role, role),
        hasHigherLevel: ROLE_HIERARCHY[role].level > (myRole?.level || 0),
        accessLevel: ROLE_HIERARCHY[role].level
      }));
      
      return {
        permissionsMatrix,
        allPermissions: Array.from(allPermissions),
        roleHierarchy: ROLE_HIERARCHY,
        myPermissions: myRole,
        roleComparison,
        requestedBy: userInfo.uid
      };
    } catch (error) {
      logger.error('Get permissions matrix error:', error);
      throw error;
    }
  }
  
  // Get RBAC analytics
  static async getRBACAnalytics(days = 30, userInfo) {
    try {
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
        
        // New registrations by role
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
      
      return {
        roleDistribution: roleDistribution.rows,
        roleCapacity,
        recentRoleChanges: recentRoleChanges.rows,
        activeUsersByRole: activeUsersByRole.rows,
        newRegistrations: newRegistrations.rows,
        analyticsPeriod: `${days} days`,
        generatedAt: formatDateDDMMYYYY(new Date()),
        requestedBy: userInfo.uid
      };
    } catch (error) {
      logger.error('RBAC analytics error:', error);
      throw error;
    }
  }
  
  // Assign role to user
  static async assignRole(data, adminInfo) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const { phone, role, reason = 'Admin assignment' } = data;
      const normalizedPhone = normalizePhone(phone);
      const targetRole = role.toUpperCase();
      
      // Check if admin has permission to assign this role
      if (!canUserManageRole(adminInfo.role, targetRole)) {
        throw new Error('Insufficient permissions to assign this role');
      }
      
      // Check role capacity
      const capacity = await checkRoleCapacity(targetRole, client);
      if (!capacity.hasCapacity) {
        throw new Error(`Role capacity exceeded. Maximum ${capacity.max} users allowed for ${targetRole}`);
      }
      
      // Check if user exists
      const userResult = await client.query(
        'SELECT uid, role, name FROM users WHERE phone = $1',
        [normalizedPhone]
      );
      
      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }
      
      const user = userResult.rows[0];
      const oldRole = user.role;
      
      if (oldRole === targetRole) {
        await client.query('COMMIT');
        return {
          phone: normalizedPhone,
          role: targetRole,
          unchanged: true
        };
      }
      
      // Validate role transition
      const validation = validateRoleTransition(oldRole, targetRole);
      if (!validation.valid) {
        throw new Error(`Invalid role transition: ${validation.errors.join(', ')}`);
      }
      
      // Update user role
      await client.query(
        'UPDATE users SET role = $1, role_updated_at = NOW() WHERE phone = $2',
        [targetRole, normalizedPhone]
      );
      
      // Log role change in audit table
      await client.query(
        `INSERT INTO user_role_audit (
          phone, old_role, new_role, changed_by_uid, reason, changed_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [normalizedPhone, oldRole, targetRole, adminInfo.uid, reason]
      );
      
      await client.query('COMMIT');
      
      logger.info(`🔄 Role changed: ${normalizedPhone} from ${oldRole} to ${targetRole} by ${adminInfo.uid}`);
      
      return {
        phone: normalizedPhone,
        userName: user.name,
        oldRole,
        newRole: targetRole,
        changedBy: adminInfo.uid,
        changedByRole: adminInfo.role,
        reason,
        timestamp: formatDateDDMMYYYY(new Date())
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Assign role error:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  // Bulk role assignment
  static async bulkAssignRoles(data, adminInfo) {
    const { assignments, reason = 'Bulk assignment' } = data;
    const results = [];
    const errors = [];
    
    for (const assignment of assignments) {
      try {
        const result = await this.assignRole({
          phone: assignment.phone,
          role: assignment.role,
          reason
        }, adminInfo);
        
        results.push({
          phone: assignment.phone,
          ...result
        });
      } catch (err) {
        errors.push({ 
          phone: assignment.phone, 
          error: err.message 
        });
      }
    }
    
    logger.info(`📊 Bulk role assignment: ${results.length} successful, ${errors.length} failed`);
    
    return {
      successful: results,
      failed: errors,
      summary: {
        total: assignments.length,
        successful: results.length,
        failed: errors.length
      },
      processedBy: adminInfo.uid,
      processedAt: formatDateDDMMYYYY(new Date())
    };
  }
  
  // Get audit log
  static async getAuditLog(filters, adminInfo) {
    try {
      const { page = 1, limit = 100, phone, role, startDate, endDate, action_type } = filters;
      const offset = (page - 1) * limit;
      
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
      
      return {
        auditLog: auditLog.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(total.rows[0].count),
          totalPages: Math.ceil(total.rows[0].count / limit)
        },
        filters,
        requestedBy: adminInfo.uid
      };
    } catch (error) {
      logger.error('Get audit log error:', error);
      throw error;
    }
  }
  
  // Get security alerts
  static async getSecurityAlerts(adminInfo) {
    try {
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
      
      // Determine alert level
      const totalAlerts = suspiciousChanges.rows.length + 
                         privilegeEscalations.rows.length + 
                         nonAdminChanges.rows.length + 
                         capacityAlerts.rows.length;
                         
      let alertLevel = 'low';
      if (totalAlerts > 10) {alertLevel = 'high';}
      else if (totalAlerts > 5) {alertLevel = 'medium';}
      
      return {
        securityAlerts: {
          suspiciousChanges: suspiciousChanges.rows,
          privilegeEscalations: privilegeEscalations.rows,
          nonAdminChanges: nonAdminChanges.rows,
          capacityAlerts: capacityAlerts.rows
        },
        alertLevel,
        totalAlerts,
        alertsGenerated: formatDateDDMMYYYY(new Date()),
        requestedBy: adminInfo.uid
      };
    } catch (error) {
      logger.error('Get security alerts error:', error);
      throw error;
    }
  }
  
  // Toggle user status (lock/unlock)
  static async toggleUserStatus(data, adminInfo) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const { phone, action, reason = 'Admin action' } = data;
      const normalizedPhone = normalizePhone(phone);
      const isActive = action === 'unlock';
      
      // Update user status
      const result = await client.query(
        `UPDATE users SET 
          is_active = $1, 
          status_updated_at = NOW(),
          status_updated_by = $2,
          status_reason = $3
         WHERE phone = $4 
         RETURNING uid, name, role, is_active`,
        [isActive, adminInfo.uid, reason, normalizedPhone]
      );
      
      if (result.rows.length === 0) {
        throw new Error('User not found');
      }
      
      const user = result.rows[0];
      
      // Log the action
      await client.query(
        `INSERT INTO user_role_audit (
          phone, old_role, new_role, changed_by_uid, reason, changed_at, action_type
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
        [normalizedPhone, user.role, user.role, adminInfo.uid, reason, `user_${action}`]
      );
      
      await client.query('COMMIT');
      
      logger.info(`🔒 User account ${action}ed: ${normalizedPhone} by admin ${adminInfo.uid}`);
      
      return {
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
        actionBy: adminInfo.uid,
        actionAt: formatDateDDMMYYYY(new Date())
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Toggle user status error:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  // Get my role information
  static async getMyRoleInfo(userInfo) {
    try {
      const roleInfo = ROLE_HIERARCHY[userInfo.role];
      
      if (!roleInfo) {
        throw new Error('Role information not found');
      }
      
      // Get recent role changes for this user
      const roleHistory = await db.query(
        `SELECT old_role, new_role, 
                TO_CHAR(changed_at, 'DD-MM-YYYY HH24:MI') as changed_at, 
                reason 
         FROM user_role_audit 
         WHERE phone = $1
         ORDER BY changed_at DESC 
         LIMIT 5`,
        [userInfo.phone]
      ).catch(() => ({ rows: [] }));
      
      // Get role statistics
      const roleStats = await db.query(
        'SELECT COUNT(*) as total_users FROM users WHERE role = $1 AND is_active = true',
        [userInfo.role]
      ).catch(() => ({ rows: [{ total_users: 0 }] }));
      
      return {
        currentRole: userInfo.role,
        roleDetails: {
          ...roleInfo,
          totalUsersWithRole: parseInt(roleStats.rows[0].total_users)
        },
        roleHistory: roleHistory.rows,
        capabilities: {
          canViewRoles: hasPermission(userInfo.role, 'view_roles') || roleInfo.level >= 50,
          canManageUsers: roleInfo.canManageRoles.length > 0,
          dataAccessLevel: roleInfo.canViewData
        },
        lastChecked: formatDateDDMMYYYY(new Date())
      };
    } catch (error) {
      logger.error('Get my role info error:', error);
      throw error;
    }
  }
  
  // Get my permissions
  static getMyPermissions(userInfo) {
    try {
      const roleInfo = ROLE_HIERARCHY[userInfo.role];
      
      if (!roleInfo) {
        throw new Error('Role information not found');
      }
      
      const hasAllPermissions = roleInfo.permissions.includes('*');
      
      // Check specific permissions
      const permissionCategories = {
        medical: roleInfo.permissions.filter(p => p.includes('patient') || p.includes('record') || p.includes('medical')),
        administrative: roleInfo.permissions.filter(p => p.includes('manage') || p.includes('admin')),
        operational: roleInfo.permissions.filter(p => p.includes('view') || p.includes('access')),
        system: roleInfo.permissions.filter(p => p.includes('system') || p === '*')
      };
      
      return {
        user: { uid: userInfo.uid, role: userInfo.role },
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
        lastChecked: formatDateDDMMYYYY(new Date())
      };
    } catch (error) {
      logger.error('Get my permissions error:', error);
      throw error;
    }
  }
}