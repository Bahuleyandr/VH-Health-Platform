// src/services/user/adminUserService.js
import db from '../../config/database.js';
import { USER_CONFIG } from '../../config/userConfig.js';
import logger from '../../logging/logger.js';

export class AdminUserService {
  // Get user analytics
  static async getUserAnalytics(timeframe = '30d') {
    let interval;
    switch (timeframe) {
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      case '90d': interval = '90 days'; break;
      case '1y': interval = '1 year'; break;
      default: interval = '30 days';
    }
    
    const [userStats, roleDistribution, registrationTrends, ageDistribution] = await Promise.all([
      // Overall user statistics
      db.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '${interval}') as new_users,
          COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_users_7d,
          COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days') as active_users_30d,
          COUNT(DISTINCT CASE WHEN last_login > NOW() - INTERVAL '24 hours' THEN id END) as daily_active_users
        FROM users
      `),
      
      // Role distribution
      db.query(`
        SELECT role, COUNT(*) as count,
               COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_count
        FROM users 
        GROUP BY role
        ORDER BY count DESC
      `),
      
      // Registration trends
      db.query(`
        SELECT DATE(registered_at) as date, COUNT(*) as registrations
        FROM users 
        WHERE registered_at > NOW() - INTERVAL '${interval}'
        GROUP BY DATE(registered_at)
        ORDER BY date DESC
      `),
      
      // Age distribution for patients
      db.query(`
        SELECT 
          CASE 
            WHEN EXTRACT(YEAR FROM AGE(birthday)) < 18 THEN 'Under 18'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 18 AND 30 THEN '18-30'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 31 AND 50 THEN '31-50'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 51 AND 70 THEN '51-70'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) > 70 THEN 'Over 70'
            ELSE 'Unknown'
          END as age_group,
          COUNT(*) as count
        FROM users 
        WHERE role = 'PATIENT' AND birthday IS NOT NULL
        GROUP BY age_group
        ORDER BY count DESC
      `)
    ]);
    
    return {
      timeframe,
      overallStats: userStats.rows[0],
      roleDistribution: roleDistribution.rows,
      registrationTrends: registrationTrends.rows,
      ageDistribution: ageDistribution.rows,
      generatedAt: new Date().toISOString()
    };
  }
  
  // Get user activity audit
  static async getActivityAudit(filters = {}) {
    const {
      userId,
      action,
      startDate,
      endDate,
      page = 1,
      limit = 50
    } = filters;
    
    const offset = (page - 1) * limit;
    const params = [];
    let whereConditions = [];
    
    let query = `
      SELECT 
        al.id, al.user_id, al.action, al.details, 
        al.ip_address, al.user_agent, al.created_at,
        u.name as user_name, u.phone as user_phone, u.role as user_role
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
    `;
    
    if (userId) {
      whereConditions.push(`al.user_id = $${params.length + 1}`);
      params.push(userId);
    }
    
    if (action) {
      whereConditions.push(`al.action = $${params.length + 1}`);
      params.push(action.toUpperCase());
    }
    
    if (startDate) {
      whereConditions.push(`al.created_at >= $${params.length + 1}`);
      params.push(startDate);
    }
    
    if (endDate) {
      whereConditions.push(`al.created_at <= $${params.length + 1}`);
      params.push(endDate);
    }
    
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    query += ' ORDER BY al.created_at DESC';
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM audit_logs al';
    if (whereConditions.length > 0) {
      countQuery += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    const countResult = await db.query(countQuery, params.slice(0, -2));
    const totalCount = parseInt(countResult.rows[0].count);
    
    return {
      logs: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }
  
  // Get inactive users report
  static async getInactiveUsersReport(inactiveDays = 30) {
    const result = await db.query(`
      SELECT 
        u.uid, u.id, u.phone, u.name, u.email, u.role,
        u.registered_at, u.last_login,
        EXTRACT(DAY FROM NOW() - u.last_login) as days_inactive,
        CASE 
          WHEN u.last_login IS NULL THEN 'Never logged in'
          WHEN u.last_login < NOW() - INTERVAL '90 days' THEN 'Very inactive'
          WHEN u.last_login < NOW() - INTERVAL '60 days' THEN 'Inactive'
          WHEN u.last_login < NOW() - INTERVAL '30 days' THEN 'Becoming inactive'
          ELSE 'Recently active'
        END as activity_status
      FROM users u
      WHERE u.last_login < NOW() - INTERVAL '${inactiveDays} days' 
         OR u.last_login IS NULL
      ORDER BY u.last_login ASC NULLS FIRST
    `);
    
    return {
      inactiveUsers: result.rows,
      totalInactive: result.rows.length,
      criteria: {
        inactiveDays,
        reportDate: new Date().toISOString()
      }
    };
  }
  
  // Reactivate user
  static async reactivateUser(userId, reactivatedBy) {
    const user = await db.query(
      'SELECT uid, role, id FROM users WHERE id = $1 OR uid = $1',
      [userId]
    );
    
    if (user.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const userRecord = user.rows[0];
    
    // Update status based on role
    if (['NURSE', 'PHARMACY_STAFF', 'LAB_STAFF'].includes(userRecord.role)) {
      await db.query(
        'UPDATE staff SET is_active = true, updated_at = NOW() WHERE user_id = $1',
        [userRecord.id]
      );
    } else if (userRecord.role === 'DOCTOR') {
      await db.query(
        'UPDATE doctors SET is_available = true, updated_at = NOW() WHERE user_id = $1',
        [userRecord.id]
      );
    }
    
    // Log reactivation
    await db.query(
      `INSERT INTO audit_logs (user_id, action, details, created_at, created_by)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [userRecord.id, 'USER_REACTIVATED', JSON.stringify({ reactivatedBy }), reactivatedBy]
    );
    
    logger.info(`User reactivated: ${userRecord.uid} by ${reactivatedBy}`);
    
    return userRecord;
  }
  
  // Generate user report
  static async generateReport(reportType, filters = {}) {
    let reportData;
    
    switch (reportType) {
      case 'user-summary':
        reportData = await this.getUserAnalytics(filters.timeframe);
        break;
        
      case 'inactive-users':
        reportData = await this.getInactiveUsersReport(filters.inactiveDays);
        break;
        
      case 'role-distribution':
        const roleData = await db.query(`
          SELECT 
            role,
            COUNT(*) as total_users,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_7d,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days') as active_30d,
            COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days') as new_users_30d
          FROM users
          GROUP BY role
          ORDER BY total_users DESC
        `);
        reportData = { roleDistribution: roleData.rows };
        break;
        
      case 'user-growth':
        const growthData = await db.query(`
          SELECT 
            DATE_TRUNC('month', registered_at) as month,
            COUNT(*) as registrations,
            COUNT(*) FILTER (WHERE role = 'PATIENT') as patients,
            COUNT(*) FILTER (WHERE role = 'DOCTOR') as doctors,
            COUNT(*) FILTER (WHERE role IN ('NURSE', 'PHARMACY_STAFF', 'LAB_STAFF')) as staff
          FROM users
          WHERE registered_at > NOW() - INTERVAL '1 year'
          GROUP BY DATE_TRUNC('month', registered_at)
          ORDER BY month DESC
        `);
        reportData = { userGrowth: growthData.rows };
        break;
        
      default:
        throw new Error('Invalid report type');
    }
    
    return {
      reportType,
      reportData,
      filters,
      generatedAt: new Date().toISOString(),
      generatedBy: filters.generatedBy
    };
  }
  
  // Get system information
  static async getSystemInfo() {
    const [userCount, tableInfo, dbVersion] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM users'),
      db.query(`
        SELECT table_name, 
               pg_size_pretty(pg_total_relation_size(table_name::regclass)) as size
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY pg_total_relation_size(table_name::regclass) DESC
        LIMIT 10
      `),
      db.query('SELECT version()')
    ]);
    
    return {
      database: {
        version: dbVersion.rows[0].version,
        totalUsers: parseInt(userCount.rows[0].count),
        topTables: tableInfo.rows
      },
      api: {
        version: process.env.API_VERSION || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        uptime: process.uptime()
      },
      timestamp: new Date().toISOString()
    };
  }
  
  // Admin dashboard data
  static async getDashboardData(adminId) {
    const [userStats, recentActivity, systemHealth] = await Promise.all([
      // User statistics
      db.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN role = 'DOCTOR' THEN 1 END) as doctors,
          COUNT(CASE WHEN role = 'PATIENT' THEN 1 END) as patients,
          COUNT(CASE WHEN role IN ('NURSE', 'PHARMACY_STAFF', 'LAB_STAFF') THEN 1 END) as staff,
          COUNT(CASE WHEN registered_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_users_30d,
          COUNT(CASE WHEN last_login >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as active_users_7d
        FROM users
      `),
      
      // Recent activity
      db.query(`
        SELECT 
          'registrations' as activity_type,
          COUNT(*) as count,
          DATE(registered_at) as date
        FROM users
        WHERE registered_at >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY DATE(registered_at)
        ORDER BY date DESC
      `),
      
      // System health (simplified)
      db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '1 hour') as active_sessions,
          COUNT(DISTINCT role) as active_roles
        FROM users
        WHERE last_login > NOW() - INTERVAL '1 hour'
      `)
    ]);
    
    return {
      userStatistics: userStats.rows[0],
      recentActivity: recentActivity.rows,
      systemHealth: systemHealth.rows[0],
      dashboardGeneratedAt: new Date().toISOString(),
      dashboardGeneratedFor: adminId
    };
  }
}