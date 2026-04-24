// services/infrastructure/rbacService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import {
  ROLE_HIERARCHY,
  canUserManageRole,
  checkRoleCapacity,
  getManageableRoles,
  hasPermission,
  validateRoleTransition
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
      const roleStats = await prisma.$queryRawUnsafe(`
        SELECT role,
               COUNT(*)                                   AS user_count,
               COUNT(CASE WHEN is_active = true THEN 1 END) AS active_count
        FROM users
        GROUP BY role
      `).catch(() => ({ rows: [] }));

      const rolesWithDetails = ALL_ROLES.map(role => {
        const stats = roleStats.find(r => r.role === role) || { user_count: 0, active_count: 0 };
        const roleData = ROLE_HIERARCHY[role] || {};
        const activeCount = parseInt(stats.active_count) || 0;

        return {
          role,
          ...roleData,
          currentUsers: parseInt(stats.user_count) || 0,
          activeUsers: activeCount,
          isAtCapacity: roleData.maxUsers ? activeCount >= roleData.maxUsers : false,
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

      const conds = [];
      const params = [];

      if (!includeInactive) {
        conds.push('u.is_active = true');
      }

      if (role && ALL_ROLES.includes(role.toUpperCase())) {
        params.push(role.toUpperCase());
        conds.push(`u.role = $${params.length}`);
      }

      // Role-based filtering for non-admin users
      if (userInfo.role !== ADMIN) {
        const manageable = getManageableRoles(userInfo.role) || [];
        if (manageable.length > 0) {
          params.push(manageable);
          conds.push(`u.role = ANY($${params.length})`); // parameterized array
        } else {
          params.push(userInfo.role);
          conds.push(`u.role = $${params.length}`);
        }
      }

      const whereClause = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      params.push(parseInt(limit));
      const result = await prisma.$queryRawUnsafe(`
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
        LIMIT $${params.length}
      `, params);

      const usersByRole = result.map(row => ({
        role: row.role,
        userCount: parseInt(row.user_count),
        roleDetails: ROLE_HIERARCHY[row.role],
        users: Array.isArray(row.users) ? row.users.slice(0, 50) : [],
        totalUsers: Array.isArray(row.users) ? row.users.length : 0
      }));

      return {
        usersByRole,
        totalUsers: result.reduce((sum, row) => sum + parseInt(row.user_count), 0),
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
      const allPermissions = new Set();
      Object.values(ROLE_HIERARCHY).forEach(roleData => {
        if (!roleData) return;
        if (roleData.permissions?.includes('*')) {
          allPermissions.add('*');
        } else {
          (roleData.permissions || []).forEach(perm => allPermissions.add(perm));
        }
      });

      const permissionsMatrix = {};
      ALL_ROLES.forEach(role => {
        const roleData = ROLE_HIERARCHY[role] || {};
        permissionsMatrix[role] = {
          permissions: roleData.permissions || [],
          level: roleData.level ?? 0,
          canManageRoles: roleData.canManageRoles || [],
          canViewData: roleData.canViewData ?? 'none',
          hasAllPermissions: (roleData.permissions || []).includes('*'),
          description: roleData.description || '',
          color: roleData.color || '#999999'
        };
      });

      const myRole = ROLE_HIERARCHY[userInfo.role] || {};
      const roleComparison = ALL_ROLES.map(role => ({
        role,
        canManage: canUserManageRole(userInfo.role, role),
        hasHigherLevel: (ROLE_HIERARCHY[role]?.level ?? 0) > (myRole.level ?? 0),
        accessLevel: ROLE_HIERARCHY[role]?.level ?? 0
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
        prisma.$queryRawUnsafe(`
          SELECT role,
                 COUNT(*) as count,
                 COUNT(CASE WHEN is_active = true THEN 1 END) as active_count
          FROM users
          GROUP BY role
        `),
        prisma.$queryRawUnsafe(`
          SELECT 
            ura.phone, ura.old_role, ura.new_role, 
            TO_CHAR(ura.changed_at, 'DD-MM-YYYY HH24:MI') as changed_at,
            ura.changed_by_uid, u.name as changed_by_name, ura.reason
          FROM user_role_audit ura
          LEFT JOIN users u ON ura.changed_by_uid = u.uid
          ORDER BY ura.changed_at DESC
          LIMIT 20
        `).catch(() => ({ rows: [] })),
        prisma.$queryRawUnsafe(`
          SELECT role, COUNT(*) as active_count
          FROM users
          WHERE last_login > NOW() - INTERVAL '7 days'
            AND is_active = true
          GROUP BY role
        `).catch(() => ({ rows: [] })),
        prisma.$queryRawUnsafe(`
          SELECT role,
                 COUNT(*) as new_count,
                 array_agg(TO_CHAR(registered_at, 'DD-MM-YYYY')) as registration_dates
          FROM users
          WHERE registered_at > NOW() - INTERVAL '${days} days'
          GROUP BY role
        `).catch(() => ({ rows: [] }))
      ]);

      const roleCapacity = roleDistribution.map(row => {
        const roleData = ROLE_HIERARCHY[row.role] || {};
        const activeCount = parseInt(row.active_count) || 0;
        const max = roleData.maxUsers ?? null;
        return {
          role: row.role,
          activeUsers: activeCount,
          totalUsers: parseInt(row.count) || 0,
          maxCapacity: max,
          utilizationPercent: max ? Math.round((activeCount / max) * 100) : null,
          isNearCapacity: max ? activeCount >= (max * 0.8) : false,
          description: roleData.description || ''
        };
      });

      return {
        roleDistribution: roleDistribution,
        roleCapacity,
        recentRoleChanges: recentRoleChanges,
        activeUsersByRole: activeUsersByRole,
        newRegistrations: newRegistrations,
        analyticsPeriod: `${days} days`,
        generatedAt: formatDateDDMMYYYY(new Date()),
        requestedBy: userInfo.uid
      };
    } catch (error) {
      logger.error('RBAC analytics error:', error);
      throw error;
    }
  }

  // Assign role to user — runs under prisma.$transaction. Errors roll back
  // the UPDATE + audit INSERT atomically.
  static async assignRole(data, adminInfo) {
    const { phone, role, reason = 'Admin assignment' } = data;
    const normalizedPhone = normalizePhone(phone);
    const targetRole = role.toUpperCase();

    if (!canUserManageRole(adminInfo.role, targetRole)) {
      throw new Error('Insufficient permissions to assign this role');
    }

    // Capacity + user lookup can be done outside the transaction (both are
    // read-only; no isolation concern). Capacity-vs-change race is accepted
    // — a duplicate role assignment is harmless.
    const capacity = await checkRoleCapacity(targetRole);
    if (!capacity.hasCapacity) {
      throw new Error(`Role capacity exceeded. Maximum ${capacity.max} users allowed for ${targetRole}`);
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const userResult = await tx.$queryRawUnsafe(
          'SELECT uid, role, name FROM users WHERE phone = $1',
          normalizedPhone
        );
        if (userResult.length === 0) throw new Error('User not found');

        const user = userResult[0];
        const oldRole = user.role;

        if (oldRole === targetRole) {
          // No-op: short-circuit before writing.
          return { phone: normalizedPhone, role: targetRole, unchanged: true };
        }

        const validation = validateRoleTransition(oldRole, targetRole);
        if (!validation.valid) {
          throw new Error(`Invalid role transition: ${validation.errors.join(', ')}`);
        }

        await tx.$executeRawUnsafe(
          'UPDATE users SET role = $1, role_updated_at = NOW() WHERE phone = $2',
          targetRole, normalizedPhone
        );

        await tx.$executeRawUnsafe(
          `INSERT INTO user_role_audit (
            phone, old_role, new_role, changed_by_uid, reason, changed_at
          ) VALUES ($1, $2, $3, $4::uuid, $5, NOW())`,
          normalizedPhone, oldRole, targetRole, adminInfo.uid, reason
        );

        return {
          phone: normalizedPhone,
          userName: user.name,
          oldRole,
          newRole: targetRole,
          changedBy: adminInfo.uid,
          changedByRole: adminInfo.role,
          reason,
          timestamp: formatDateDDMMYYYY(new Date()),
        };
      });

      if (!result.unchanged) {
        logger.info(`🔄 Role changed: ${normalizedPhone} from ${result.oldRole} to ${result.newRole} by ${adminInfo.uid}`);
      }
      return result;
    } catch (error) {
      logger.error('Assign role error:', error);
      throw error;
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

        results.push({ phone: assignment.phone, ...result });
      } catch (err) {
        errors.push({ phone: assignment.phone, error: err.message });
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

  // Get audit log (fixed param numbering & safe WHERE reuse)
  static async getAuditLog(filters, adminInfo) {
    try {
      const { page = 1, limit = 100, phone, role, startDate, endDate, action_type } = filters;
      const offset = (page - 1) * limit;

      // Build WHERE with a local parameter array (same for list & count)
      const conds = [];
      const vals = [];
      const add = (frag, value, extraValues = []) => {
        // Replace $X markers with correct $1..$n
        const idxStart = vals.length + 1;
        let i = idxStart;
        const fragReplaced = frag.replace(/\$X/g, () => `$${i++}`);
        vals.push(value, ...extraValues);
        conds.push(fragReplaced);
      };

      if (phone) add('ura.phone = $X', normalizePhone(phone));
      if (role && ALL_ROLES.includes(role.toUpperCase())) {
        // same value twice for old/new
        add('(ura.old_role = $X OR ura.new_role = $X)', role.toUpperCase(), [role.toUpperCase()]);
      }
      if (startDate) add('ura.changed_at >= $X', startDate);
      if (endDate) add('ura.changed_at <= $X', endDate);
      if (action_type) add('ura.action_type = $X', action_type);

      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      // Main page
      const auditLog = await prisma.$queryRawUnsafe(`
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
        ${where}
        ORDER BY ura.changed_at DESC
        LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}
      `, ...vals, parseInt(limit), offset).catch(() => ({ rows: [] }));

      // Count with same WHERE & same param list
      const total = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) FROM user_role_audit ura ${where}`,
        vals
      ).catch(() => ({ rows: [{ count: 0 }] }));

      return {
        auditLog: auditLog,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(total[0].count || 0),
          totalPages: Math.ceil((parseInt(total[0].count || 0)) / limit)
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
        prisma.$queryRawUnsafe(`
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

        prisma.$queryRawUnsafe(`
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

        prisma.$queryRawUnsafe(`
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

        prisma.$queryRawUnsafe(`
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

      const totalAlerts = suspiciousChanges.length +
                          privilegeEscalations.length +
                          nonAdminChanges.length +
                          capacityAlerts.length;

      let alertLevel = 'low';
      if (totalAlerts > 10) alertLevel = 'high';
      else if (totalAlerts > 5) alertLevel = 'medium';

      return {
        securityAlerts: {
          suspiciousChanges: suspiciousChanges,
          privilegeEscalations: privilegeEscalations,
          nonAdminChanges: nonAdminChanges,
          capacityAlerts: capacityAlerts
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

  // Toggle user status (lock/unlock) — atomic UPDATE + audit INSERT under
  // prisma.$transaction; thrown errors roll back the UPDATE.
  static async toggleUserStatus(data, adminInfo) {
    const { phone, action, reason = 'Admin action' } = data;
    const normalizedPhone = normalizePhone(phone);
    const isActive = action === 'unlock';

    try {
      const user = await prisma.$transaction(async (tx) => {
        const result = await tx.$queryRawUnsafe(
          `UPDATE users SET
            is_active = $1,
            status_updated_at = NOW(),
            status_updated_by = $2::uuid,
            status_reason = $3
           WHERE phone = $4
           RETURNING uid, name, role, is_active`,
          isActive, adminInfo.uid, reason, normalizedPhone
        );

        if (result.length === 0) throw new Error('User not found');
        const row = result[0];

        await tx.$executeRawUnsafe(
          `INSERT INTO user_role_audit (
            phone, old_role, new_role, changed_by_uid, reason, changed_at, action_type
          ) VALUES ($1, $2, $3, $4::uuid, $5, NOW(), $6)`,
          normalizedPhone, row.role, row.role, adminInfo.uid, reason, `user_${action}`
        );

        return row;
      });

      logger.info(`🔒 User account ${action}ed: ${normalizedPhone} by admin ${adminInfo.uid}`);

      return {
        phone: normalizedPhone,
        action,
        isActive,
        user: {
          uid: user.uid,
          name: user.name,
          role: user.role,
          isActive: user.is_active,
        },
        reason,
        actionBy: adminInfo.uid,
        actionAt: formatDateDDMMYYYY(new Date()),
      };
    } catch (error) {
      logger.error('Toggle user status error:', error);
      throw error;
    }
  }

  // Get my role information
  static async getMyRoleInfo(userInfo) {
    try {
      const roleInfo = ROLE_HIERARCHY[userInfo.role];
      if (!roleInfo) throw new Error('Role information not found');

      const roleHistory = await prisma.$queryRawUnsafe(
        `SELECT old_role, new_role, 
                TO_CHAR(changed_at, 'DD-MM-YYYY HH24:MI') as changed_at, 
                reason 
         FROM user_role_audit 
         WHERE phone = $1
         ORDER BY changed_at DESC 
         LIMIT 5`,
        userInfo.phone
      ).catch(() => ({ rows: [] }));

      const roleStats = await prisma.$queryRawUnsafe(
        'SELECT COUNT(*) as total_users FROM users WHERE role = $1 AND is_active = true',
        userInfo.role
      ).catch(() => ({ rows: [{ total_users: 0 }] }));

      return {
        currentRole: userInfo.role,
        roleDetails: {
          ...roleInfo,
          totalUsersWithRole: parseInt(roleStats[0].total_users || 0)
        },
        roleHistory: roleHistory,
        capabilities: {
          canViewRoles: hasPermission(userInfo.role, 'view_roles') || (roleInfo.level ?? 0) >= 50,
          canManageUsers: (roleInfo.canManageRoles || []).length > 0,
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
      if (!roleInfo) throw new Error('Role information not found');

      const hasAllPermissions = (roleInfo.permissions || []).includes('*');

      const permissionCategories = {
        medical: (roleInfo.permissions || []).filter(p => p.includes('patient') || p.includes('record') || p.includes('medical')),
        administrative: (roleInfo.permissions || []).filter(p => p.includes('manage') || p.includes('admin')),
        operational: (roleInfo.permissions || []).filter(p => p.includes('view') || p.includes('access')),
        system: (roleInfo.permissions || []).filter(p => p.includes('system') || p === '*')
      };

      return {
        user: { uid: userInfo.uid, role: userInfo.role },
        roleDetails: {
          level: roleInfo.level,
          description: roleInfo.description,
          color: roleInfo.color
        },
        permissions: {
          all: roleInfo.permissions || [],
          hasAllPermissions,
          categorized: permissionCategories
        },
        management: {
          canManageRoles: roleInfo.canManageRoles || [],
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
