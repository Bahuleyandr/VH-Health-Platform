// src/services/userAuditService.js - Hospital User Audit Service

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

/**
 * Log user action
 */
export async function logUserAction(userId, action, targetUserId = null, details = null, ipAddress = null) {
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO user_action_logs (
        user_id, action, target_user_id, details, ip_address, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
    `, userId, action, targetUserId, details, ipAddress);
  } catch (err) {
    logger.error('Failed to log user action:', err);
  }
}

/**
 * Get user activity logs
 */
export async function getUserActivityLogs(userId, limit = 20) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        action, details, created_at, ip_address
      FROM user_action_logs 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2
    `, userId, limit);
    
    return result;
  } catch (err) {
    logger.error('Failed to get user activity logs:', err);
    return [];
  }
}

/**
 * Get activity audit for admin
 */
export async function getActivityAudit(filters = {}) {
  const { userId, action, days = 30, ipAddress, limit = 100 } = filters;

  let whereClause = 'WHERE ual.created_at > NOW() - INTERVAL $1';
  const params = [`${days} days`];
  let paramIndex = 2;

  if (userId) {
    whereClause += ` AND ual.user_id = $${paramIndex}`;
    params.push(userId);
    paramIndex++;
  }

  if (action) {
    whereClause += ` AND ual.action LIKE $${paramIndex}`;
    params.push(`%${action}%`);
    paramIndex++;
  }

  if (ipAddress) {
    whereClause += ` AND ual.ip_address = $${paramIndex}`;
    params.push(ipAddress);
    paramIndex++;
  }

  try {
    const activityLogs = await prisma.$queryRawUnsafe(`
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
      LIMIT $${paramIndex}
    `, ...params, limit);

    return activityLogs;
  } catch (err) {
    logger.error('Failed to get activity audit:', err);
    throw err;
  }
}

/**
 * Get activity summary
 */
export async function getActivitySummary(days = 30) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        ual.action,
        COUNT(*) as action_count,
        COUNT(DISTINCT ual.user_id) as unique_users,
        COUNT(DISTINCT ual.ip_address) as unique_ips,
        MIN(ual.created_at) as first_occurrence,
        MAX(ual.created_at) as last_occurrence
      FROM user_action_logs ual
      WHERE ual.created_at > NOW() - INTERVAL '${days} days'
      GROUP BY ual.action
      ORDER BY action_count DESC
    `);

    return result;
  } catch (err) {
    logger.error('Failed to get activity summary:', err);
    throw err;
  }
}

/**
 * Detect suspicious activity
 */
export async function detectSuspiciousActivity(days = 30) {
  try {
    const result = await prisma.$queryRawUnsafe(`
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
      WHERE ual.created_at > NOW() - INTERVAL '${days} days'
      GROUP BY ual.ip_address, ual.user_id, u.name
      HAVING COUNT(*) > 100 OR COUNT(DISTINCT ual.action) > 10
      ORDER BY action_count DESC
      LIMIT 20
    `);

    return result;
  } catch (err) {
    logger.error('Failed to detect suspicious activity:', err);
    throw err;
  }
}

/**
 * Log bulk action
 */
export async function logBulkAction(action, performedBy, affectedUsers, details = null) {
  try {
    for (const userId of affectedUsers) {
      await logUserAction(performedBy, action, userId, details);
    }
  } catch (err) {
    logger.error('Failed to log bulk action:', err);
  }
}

/**
 * Get user access history
 */
export async function getUserAccessHistory(userId, days = 90) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        DATE(created_at) as access_date,
        COUNT(*) as action_count,
        COUNT(DISTINCT action) as unique_actions,
        MIN(created_at) as first_access,
        MAX(created_at) as last_access,
        ARRAY_AGG(DISTINCT action) as actions
      FROM user_action_logs
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY access_date DESC
    `, userId);

    return result;
  } catch (err) {
    logger.error('Failed to get user access history:', err);
    return [];
  }
}

/**
 * Clean old audit logs
 */
export async function cleanOldAuditLogs(retentionDays = 365) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      DELETE FROM user_action_logs
      WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
      RETURNING id
    `);

    logger.info(`Cleaned ${result.length} old audit logs`);
    return result.length;
  } catch (err) {
    logger.error('Failed to clean old audit logs:', err);
    throw err;
  }
}

/**
 * Get action statistics by role
 */
export async function getActionStatsByRole(days = 30) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        u.role,
        ual.action,
        COUNT(*) as count
      FROM user_action_logs ual
      JOIN users u ON ual.user_id = u.uid
      WHERE ual.created_at > NOW() - INTERVAL '${days} days'
      GROUP BY u.role, ual.action
      ORDER BY u.role, count DESC
    `);

    // Group by role
    const statsByRole = {};
    result.forEach(row => {
      if (!statsByRole[row.role]) {
        statsByRole[row.role] = {};
      }
      statsByRole[row.role][row.action] = parseInt(row.count);
    });

    return statsByRole;
  } catch (err) {
    logger.error('Failed to get action stats by role:', err);
    throw err;
  }
}

/**
 * Generate audit report
 */
export async function generateAuditReport(startDate, endDate, options = {}) {
  const { includeDetails = false, groupBy = 'user' } = options;

  try {
    let query;
    if (groupBy === 'user') {
      query = `
        SELECT 
          u.uid, u.name, u.role, u.department,
          COUNT(ual.id) as total_actions,
          COUNT(DISTINCT DATE(ual.created_at)) as active_days,
          COUNT(DISTINCT ual.action) as unique_actions,
          MIN(ual.created_at) as first_action,
          MAX(ual.created_at) as last_action
          ${includeDetails ? ', ARRAY_AGG(DISTINCT ual.action) as actions' : ''}
        FROM users u
        LEFT JOIN user_action_logs ual ON u.uid = ual.user_id
          AND ual.created_at BETWEEN $1 AND $2
        GROUP BY u.uid, u.name, u.role, u.department
        HAVING COUNT(ual.id) > 0
        ORDER BY total_actions DESC
      `;
    } else if (groupBy === 'action') {
      query = `
        SELECT 
          ual.action,
          COUNT(*) as total_count,
          COUNT(DISTINCT ual.user_id) as unique_users,
          COUNT(DISTINCT DATE(ual.created_at)) as days_active
        FROM user_action_logs ual
        WHERE ual.created_at BETWEEN $1 AND $2
        GROUP BY ual.action
        ORDER BY total_count DESC
      `;
    }

    const result = await prisma.$queryRawUnsafe(query, startDate, endDate);
    return result;
  } catch (err) {
    logger.error('Failed to generate audit report:', err);
    throw err;
  }
}