// src/services/user/adminUserService.js
// Migrated from raw pg to Prisma ORM

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export class AdminUserService {
  static async getUserAnalytics(timeframe = '30d') {
    let intervalDays;
    switch (timeframe) {
      case '7d': intervalDays = 7; break;
      case '30d': intervalDays = 30; break;
      case '90d': intervalDays = 90; break;
      case '1y': intervalDays = 365; break;
      default: intervalDays = 30;
    }

    const [userStats, roleDistribution, registrationTrends, ageDistribution] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE registered_at > NOW() - (${intervalDays} || ' days')::interval)::int AS new_users,
          COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days')::int AS active_users_7d,
          COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days')::int AS active_users_30d,
          COUNT(DISTINCT CASE WHEN last_login > NOW() - INTERVAL '24 hours' THEN id END)::int AS daily_active_users
        FROM users
      `,
      prisma.$queryRaw`
        SELECT role, COUNT(*)::int AS count,
               COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days')::int AS active_count
        FROM users
        GROUP BY role
        ORDER BY count DESC
      `,
      prisma.$queryRaw`
        SELECT DATE(registered_at) AS date, COUNT(*)::int AS registrations
        FROM users
        WHERE registered_at > NOW() - (${intervalDays} || ' days')::interval
        GROUP BY DATE(registered_at)
        ORDER BY date DESC
      `,
      prisma.$queryRaw`
        SELECT
          CASE
            WHEN EXTRACT(YEAR FROM AGE(birthday)) < 18 THEN 'Under 18'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 18 AND 30 THEN '18-30'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 31 AND 50 THEN '31-50'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 51 AND 70 THEN '51-70'
            WHEN EXTRACT(YEAR FROM AGE(birthday)) > 70 THEN 'Over 70'
            ELSE 'Unknown'
          END AS age_group,
          COUNT(*)::int AS count
        FROM users
        WHERE role = 'PATIENT' AND birthday IS NOT NULL
        GROUP BY age_group
        ORDER BY count DESC
      `,
    ]);

    return {
      timeframe,
      overallStats: userStats[0],
      roleDistribution,
      registrationTrends,
      ageDistribution,
      generatedAt: new Date().toISOString(),
    };
  }

  static async getActivityAudit(filters = {}) {
    const {
      userId,
      action,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = filters;

    const offset = (page - 1) * limit;
    const conditions = [Prisma.sql`1=1`];

    if (userId) conditions.push(Prisma.sql`al.uid = ${userId}::uuid`);
    if (action) conditions.push(Prisma.sql`al.action = ${action.toUpperCase()}`);
    if (startDate) conditions.push(Prisma.sql`al.created_at >= ${new Date(startDate)}`);
    if (endDate) conditions.push(Prisma.sql`al.created_at <= ${new Date(endDate)}`);

    const whereClause = Prisma.join(conditions, ' AND ');

    const [logs, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          al.id, al.uid, al.action, al.metadata,
          al.ip_address, al.created_at,
          u.name AS user_name, u.phone AS user_phone, u.role AS user_role
        FROM audit_logs al
        LEFT JOIN users u ON al.uid = u.uid
        WHERE ${whereClause}
        ORDER BY al.created_at DESC
        LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM audit_logs al
        WHERE ${whereClause}
      `,
    ]);

    const totalCount = countRows[0].count;

    return {
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  }

  static async getInactiveUsersReport(inactiveDays = 30) {
    const daysInt = parseInt(inactiveDays);
    const rows = await prisma.$queryRaw`
      SELECT
        u.uid, u.id, u.phone, u.name, u.email, u.role,
        u.registered_at, u.last_login,
        EXTRACT(DAY FROM NOW() - u.last_login)::int AS days_inactive,
        CASE
          WHEN u.last_login IS NULL THEN 'Never logged in'
          WHEN u.last_login < NOW() - INTERVAL '90 days' THEN 'Very inactive'
          WHEN u.last_login < NOW() - INTERVAL '60 days' THEN 'Inactive'
          WHEN u.last_login < NOW() - INTERVAL '30 days' THEN 'Becoming inactive'
          ELSE 'Recently active'
        END AS activity_status
      FROM users u
      WHERE u.last_login < NOW() - (${daysInt} || ' days')::interval
         OR u.last_login IS NULL
      ORDER BY u.last_login ASC NULLS FIRST
    `;

    return {
      inactiveUsers: rows,
      totalInactive: rows.length,
      criteria: {
        inactiveDays,
        reportDate: new Date().toISOString(),
      },
    };
  }

  static async reactivateUser(userId, reactivatedBy) {
    let userRows;
    if (/^\d+$/.test(String(userId))) {
      userRows = await prisma.$queryRaw`
        SELECT uid, role, id FROM users WHERE id = ${parseInt(userId)}
      `;
    } else {
      userRows = await prisma.$queryRaw`
        SELECT uid, role, id FROM users WHERE uid = ${String(userId)}::uuid
      `;
    }

    if (userRows.length === 0) {
      throw new Error('User not found');
    }

    const userRecord = userRows[0];

    if (['NURSE', 'PHARMACY_STAFF', 'LAB_STAFF'].includes(userRecord.role)) {
      await prisma.$queryRaw`
        UPDATE staff SET is_active = true, updated_at = NOW() WHERE user_id = ${userRecord.id}
      `;
    } else if (userRecord.role === 'DOCTOR') {
      await prisma.$queryRaw`
        UPDATE doctors SET is_available = true, updated_at = NOW() WHERE user_id = ${userRecord.id}
      `;
    }

    await prisma.audit_logs.create({
      data: {
        uid: reactivatedBy || null,
        action: 'USER_REACTIVATED',
        metadata: { reactivatedBy, user_id: userRecord.id },
      },
    });

    logger.info(`User reactivated: ${userRecord.uid} by ${reactivatedBy}`);
    return userRecord;
  }

  static async generateReport(reportType, filters = {}) {
    let reportData;

    switch (reportType) {
      case 'user-summary':
        reportData = await this.getUserAnalytics(filters.timeframe);
        break;

      case 'inactive-users':
        reportData = await this.getInactiveUsersReport(filters.inactiveDays);
        break;

      case 'role-distribution': {
        const roleData = await prisma.$queryRaw`
          SELECT
            role,
            COUNT(*)::int AS total_users,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days')::int AS active_7d,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days')::int AS active_30d,
            COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days')::int AS new_users_30d
          FROM users
          GROUP BY role
          ORDER BY total_users DESC
        `;
        reportData = { roleDistribution: roleData };
        break;
      }

      case 'user-growth': {
        const growthData = await prisma.$queryRaw`
          SELECT
            DATE_TRUNC('month', registered_at) AS month,
            COUNT(*)::int AS registrations,
            COUNT(*) FILTER (WHERE role = 'PATIENT')::int AS patients,
            COUNT(*) FILTER (WHERE role = 'DOCTOR')::int AS doctors,
            COUNT(*) FILTER (WHERE role IN ('NURSE', 'PHARMACY_STAFF', 'LAB_STAFF'))::int AS staff
          FROM users
          WHERE registered_at > NOW() - INTERVAL '1 year'
          GROUP BY DATE_TRUNC('month', registered_at)
          ORDER BY month DESC
        `;
        reportData = { userGrowth: growthData };
        break;
      }

      default:
        throw new Error('Invalid report type');
    }

    return {
      reportType,
      reportData,
      filters,
      generatedAt: new Date().toISOString(),
      generatedBy: filters.generatedBy,
    };
  }

  static async getSystemInfo() {
    const [userCount, tableInfo, dbVersion] = await Promise.all([
      prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM users`,
      prisma.$queryRaw`
        SELECT table_name,
               pg_size_pretty(pg_total_relation_size((quote_ident(table_schema)||'.'||quote_ident(table_name))::regclass)) AS size
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY pg_total_relation_size((quote_ident(table_schema)||'.'||quote_ident(table_name))::regclass) DESC
        LIMIT 10
      `,
      prisma.$queryRaw`SELECT version()`,
    ]);

    return {
      database: {
        version: dbVersion[0].version,
        totalUsers: userCount[0].count,
        topTables: tableInfo,
      },
      api: {
        version: process.env.API_VERSION || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        uptime: process.uptime(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  static async getDashboardData(adminId) {
    const [userStats, recentActivity, systemHealth] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(CASE WHEN role = 'DOCTOR' THEN 1 END)::int AS doctors,
          COUNT(CASE WHEN role = 'PATIENT' THEN 1 END)::int AS patients,
          COUNT(CASE WHEN role IN ('NURSE', 'PHARMACY_STAFF', 'LAB_STAFF') THEN 1 END)::int AS staff,
          COUNT(CASE WHEN registered_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END)::int AS new_users_30d,
          COUNT(CASE WHEN last_login >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END)::int AS active_users_7d
        FROM users
      `,
      prisma.$queryRaw`
        SELECT
          'registrations' AS activity_type,
          COUNT(*)::int AS count,
          DATE(registered_at) AS date
        FROM users
        WHERE registered_at >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY DATE(registered_at)
        ORDER BY date DESC
      `,
      prisma.$queryRaw`
        SELECT
          COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '1 hour')::int AS active_sessions,
          COUNT(DISTINCT role)::int AS active_roles
        FROM users
        WHERE last_login > NOW() - INTERVAL '1 hour'
      `,
    ]);

    return {
      userStatistics: userStats[0],
      recentActivity,
      systemHealth: systemHealth[0],
      dashboardGeneratedAt: new Date().toISOString(),
      dashboardGeneratedFor: adminId,
    };
  }
}
