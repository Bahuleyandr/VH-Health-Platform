// src/services/staff/hr/dashboardService.js
import { STAFF_ROLES } from '../../../config/staffConfig.js';
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

/**
 * Get comprehensive HR dashboard data including staff overview,
 * department breakdown, attendance trends, and performance metrics
 * @param {string} timeframe - Time period for data aggregation
 * @returns {Object} Dashboard data with multiple sections
 */
export const getHRDashboardData = async (_timeframe) => {
  // Staff overview statistics
  const staffOverview = await prisma.$queryRawUnsafe(`
    SELECT 
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.is_active = false THEN 1 END) as inactive_staff,
      COUNT(CASE WHEN s.hire_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_hires_30_days,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as currently_checked_in,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as average_salary
    FROM users u
    JOIN staff s ON u.uid = s.user_id
    WHERE u.role = ANY($1)
  `, Object.values(STAFF_ROLES));

  // Department staffing levels
  const departmentStats = await prisma.$queryRawUnsafe(`
    SELECT 
      s.department,
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as present_today,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as avg_salary
    FROM users u
    JOIN staff s ON u.uid = s.user_id
    WHERE u.role = ANY($1) AND s.is_active = true
    GROUP BY s.department
    ORDER BY total_staff DESC
  `, Object.values(STAFF_ROLES));

  // Recent attendance trends
  let attendanceTrends = [];
  try {
    const attendanceResult = await prisma.$queryRawUnsafe(`
      SELECT 
        DATE(check_in_time) as date,
        COUNT(DISTINCT staff_id) as unique_staff,
        AVG(EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600) as avg_hours
      FROM staff_attendance
      WHERE check_in_time >= CURRENT_DATE - INTERVAL '7 days'
        AND check_out_time IS NOT NULL
      GROUP BY DATE(check_in_time)
      ORDER BY date DESC
      LIMIT 7
    `);

    attendanceTrends = attendanceResult.map(row => ({
      ...row,
      date: new Date(row.date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      avg_hours: row.avg_hours ? Math.round(row.avg_hours * 100) / 100 : 0
    }));
  } catch (attendanceError) {
    logger.warn('Attendance trends unavailable:', attendanceError.message);
  }

  // Performance metrics
  let performanceMetrics = null;
  try {
    const performanceResult = await prisma.$queryRawUnsafe(`
      SELECT 
        AVG(performance_rating) as avg_performance_rating,
        COUNT(CASE WHEN performance_rating >= 4.0 THEN 1 END) as high_performers,
        COUNT(CASE WHEN performance_rating < 3.0 THEN 1 END) as low_performers
      FROM staff
      WHERE performance_rating IS NOT NULL AND is_active = true
    `);

    if (performanceResult[0].avg_performance_rating) {
      performanceMetrics = {
        ...performanceResult[0],
        avg_performance_rating: Math.round(performanceResult[0].avg_performance_rating * 100) / 100
      };
    }
  } catch (performanceError) {
    logger.warn('Performance metrics unavailable:', performanceError.message);
  }

  // Upcoming reviews and tasks
  let upcomingTasks = [];
  try {
    const tasksResult = await prisma.$queryRawUnsafe(`
      SELECT 
        'performance_review' as task_type,
        u.name as staff_name,
        s.employee_id,
        s.hire_date + INTERVAL '1 year' as due_date
      FROM users u
      JOIN staff s ON u.uid = s.user_id
      WHERE s.is_active = true
        AND s.hire_date + INTERVAL '1 year' BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
      ORDER BY due_date ASC
      LIMIT 10
    `);

    upcomingTasks = tasksResult.map(task => ({
      ...task,
      due_date: new Date(task.due_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      })
    }));
  } catch (tasksError) {
    logger.warn('Upcoming tasks unavailable:', tasksError.message);
  }

  return {
    overview: {
      ...staffOverview[0],
      average_salary: staffOverview[0].average_salary ? 
        Math.round(staffOverview[0].average_salary) : null,
      attendance_rate: staffOverview[0].total_staff > 0 ? 
        Math.round((staffOverview[0].currently_checked_in / staffOverview[0].total_staff) * 100) : 0
    },
    departmentBreakdown: departmentStats.map(dept => ({
      ...dept,
      avg_salary: dept.avg_salary ? Math.round(dept.avg_salary) : null,
      attendance_rate: dept.active_staff > 0 ? Math.round((dept.present_today / dept.active_staff) * 100) : 0,
      staffing_status: dept.present_today / dept.active_staff >= 0.8 ? 'adequate' : 'understaffed'
    })),
    attendanceTrends,
    performanceMetrics,
    upcomingTasks,
    alerts: {
      low_attendance: departmentStats.filter(d => (d.present_today / d.active_staff) < 0.7).length,
      upcoming_reviews: upcomingTasks.length,
      new_hires_need_onboarding: parseInt(staffOverview[0].new_hires_30_days) || 0
    },
    lastUpdated: new Date().toISOString()
  };
};