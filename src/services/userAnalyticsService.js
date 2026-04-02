// src/services/userAnalyticsService.js - Hospital User Analytics Service

import { format } from 'date-fns';
import prisma from '../lib/prisma.js';
import { HOSPITAL_ROLES, REPORT_TYPES } from '../config/userConfig.js';
import logger from '../logging/logger.js';

/**
 * Get overall user analytics
 */
export async function getUserAnalytics(timeframe = '30d', department = null) {
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

  try {
    // Overall user statistics
    const overallStats = await prisma.$queryRawUnsafe(`
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
    const roleDistribution = await prisma.$queryRawUnsafe(`
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
    const departmentStats = await prisma.$queryRawUnsafe(`
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
    const registrationTrends = await prisma.$queryRawUnsafe(`
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
    const activityMetrics = await prisma.$queryRawUnsafe(`
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

    return {
      timeframe,
      interval,
      department: department || 'All Departments',
      overallStatistics: overallStats[0],
      roleDistribution: roleDistribution.rows,
      departmentBreakdown: departmentStats.rows,
      registrationTrends: registrationTrends.rows,
      activityMetrics: activityMetrics.rows
    };
  } catch (err) {
    logger.error('Failed to get user analytics:', err);
    throw err;
  }
}

/**
 * Get inactive users report
 */
export async function getInactiveUsersReport(inactiveDays = 90, role = null, includePatients = false) {
  let roleFilter = '';
  const patientFilter = includePatients ? '' : "AND role != 'PATIENT'";
  const params = [inactiveDays];
  let paramIndex = 2;

  if (role) {
    roleFilter = ` AND role = $${paramIndex}`;
    params.push(role);
    paramIndex++;
  }

  try {
    // Find inactive users
    const inactiveUsers = await prisma.$queryRawUnsafe(`
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
    const departmentStats = await prisma.$queryRawUnsafe(`
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

    // Risk assessment
    const riskAssessment = await prisma.$queryRawUnsafe(`
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

    return {
      criteria: {
        inactiveDays,
        role,
        includePatients
      },
      inactiveUsers: inactiveUsers.rows,
      departmentBreakdown: departmentStats.rows,
      riskAssessment: riskAssessment.rows
    };
  } catch (err) {
    logger.error('Failed to get inactive users report:', err);
    throw err;
  }
}

/**
 * Generate comprehensive report
 */
export async function generateReport(reportType, filters = {}, options = {}) {
  const { includeInactive = false, dateRange } = options;
  
  const statusFilter = includeInactive ? '' : "AND status = 'active'";
  let dateFilter = '';
  
  if (dateRange && dateRange.from && dateRange.to) {
    dateFilter = `AND registered_at BETWEEN '${dateRange.from}' AND '${dateRange.to}'`;
  }

  let reportData = {};

  try {
    switch (reportType) {
      case REPORT_TYPES.DEPARTMENT:
        reportData = await generateDepartmentReport(statusFilter, dateFilter);
        break;

      case REPORT_TYPES.ROLE:
        reportData = await generateRoleReport(statusFilter, dateFilter);
        break;

      case REPORT_TYPES.ACTIVITY:
        reportData = await generateActivityReport();
        break;

      case REPORT_TYPES.COMPREHENSIVE:
        reportData = await generateComprehensiveReport(statusFilter, dateFilter);
        break;

      default:
        throw new Error('Invalid report type');
    }

    return reportData;
  } catch (err) {
    logger.error(`Failed to generate ${reportType} report:`, err);
    throw err;
  }
}

async function generateDepartmentReport(statusFilter, dateFilter) {
  const deptData = await prisma.$queryRawUnsafe(`
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

  return {
    type: 'Department Analysis',
    departments: deptData.rows,
    summary: {
      totalDepartments: deptData.rows.length,
      largestDepartment: deptData[0]?.department || 'None',
      smallestDepartment: deptData.rows[deptData.rows.length - 1]?.department || 'None'
    }
  };
}

async function generateRoleReport(statusFilter, dateFilter) {
  const roleData = await prisma.$queryRawUnsafe(`
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

  return {
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
      mostCommonRole: roleData[0]?.role || 'None',
      leastCommonRole: roleData.rows[roleData.rows.length - 1]?.role || 'None'
    }
  };
}

async function generateActivityReport() {
  const activityData = await prisma.$queryRawUnsafe(`
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

  return {
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
      mostActiveUser: activityData[0]?.name || 'None',
      averageActionsPerUser: activityData.rows.length > 0
        ? (activityData.rows.reduce((sum, u) => sum + u.total_actions, 0) / activityData.rows.length).toFixed(1)
        : 0
    }
  };
}

async function generateComprehensiveReport(statusFilter, dateFilter) {
  const [overallStats, deptStats, roleStats, recentActivity] = await Promise.all([
    prisma.$queryRawUnsafe(`
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
    prisma.$queryRawUnsafe(`
      SELECT department, COUNT(*) as count
      FROM users 
      WHERE 1=1 ${statusFilter} ${dateFilter}
      GROUP BY department 
      ORDER BY count DESC 
      LIMIT 10
    `),
    prisma.$queryRawUnsafe(`
      SELECT role, COUNT(*) as count
      FROM users 
      WHERE 1=1 ${statusFilter} ${dateFilter}
      GROUP BY role 
      ORDER BY count DESC
    `),
    prisma.$queryRawUnsafe(`
      SELECT DATE(registered_at) as date, COUNT(*) as registrations
      FROM users 
      WHERE registered_at > NOW() - INTERVAL '30 days' ${statusFilter}
      GROUP BY DATE(registered_at) 
      ORDER BY date DESC
    `)
  ]);

  return {
    type: 'Comprehensive Hospital User Report',
    overallStatistics: overallStats[0],
    departmentBreakdown: deptStats.rows,
    roleDistribution: roleStats.rows,
    recentRegistrations: recentActivity.rows.map(reg => ({
      ...reg,
      date_formatted: format(new Date(reg.date), 'dd-MM-yyyy')
    })),
    insights: {
      largestDepartment: deptStats[0]?.department || 'None',
      mostCommonRole: roleStats[0]?.role || 'None',
      recentGrowth: recentActivity.rows.reduce((sum, r) => sum + parseInt(r.registrations), 0)
    }
  };
}

/**
 * Get medical staff specialty distribution
 */
export async function getSpecialtyDistribution() {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        specialty,
        COUNT(*) as specialist_count,
        COUNT(*) FILTER (WHERE status = 'active') as active_specialists,
        AVG(EXTRACT(days FROM NOW() - registered_at)) as avg_tenure_days
      FROM users
      WHERE role IN ('DOCTOR', 'SPECIALIST', 'RESIDENT') 
        AND specialty IS NOT NULL
      GROUP BY specialty
      ORDER BY specialist_count DESC
    `);

    return result.rows;
  } catch (err) {
    logger.error('Failed to get specialty distribution:', err);
    throw err;
  }
}