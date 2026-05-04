// src/controllers/staff/staffAdminAnalyticsController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// Performance Analytics
export const getPerformanceAnalytics = async (req, res) => {
  try {
    const { department, timeframe = 'quarterly' } = req.query;
    
    // Whitelist timeframe to prevent SQL injection via INTERVAL
    const intervalMap = { quarterly: '3 months', yearly: '1 year', monthly: '1 month' };
    const safeInterval = intervalMap[timeframe] || '1 year';
    
    const analytics = await prisma.$queryRawUnsafe(`
      SELECT 
        s.department,
        COUNT(DISTINCT pr.staff_id) as reviewed_staff,
        ROUND(AVG(pr.rating)::numeric, 2) as avg_rating,
        COUNT(*) FILTER (WHERE pr.rating >= 4) as high_performers,
        COUNT(*) FILTER (WHERE pr.rating < 3) as needs_improvement
      FROM staff_performance_reviews pr
      JOIN staff s ON pr.staff_id = s.id
      WHERE 
        pr.created_at >= CURRENT_DATE - INTERVAL '${safeInterval}'
        ${department ? 'AND s.department = $1' : ''}
      GROUP BY s.department
    `, ...(department ? [department] : []));

    success(res, {
      analytics: analytics,
      timeframe
    }, 'Performance analytics retrieved successfully');
  } catch (err) {
    logger.error('Performance Analytics Error:', err);
    error(res, 'Failed to retrieve performance analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Department Analytics
export const getDepartmentAnalytics = async (req, res) => {
  try {
    const analytics = await prisma.$queryRawUnsafe(`
      SELECT 
        s.department,
        COUNT(DISTINCT s.id) as total_staff,
        COUNT(DISTINCT s.id) FILTER (WHERE s.is_active = true) as active_staff,
        COUNT(DISTINCT a.staff_id) as present_today,
        COUNT(DISTINCT la.staff_id) as on_leave,
        ROUND(100.0 * COUNT(DISTINCT a.staff_id) / NULLIF(COUNT(DISTINCT s.id), 0), 2) as attendance_rate
      FROM staff s
      LEFT JOIN staff_attendance a ON s.id = a.staff_id AND a.check_in_time::date = CURRENT_DATE
      LEFT JOIN leave_applications la ON s.id = la.staff_id 
        AND la.status = 'approved' 
        AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
      GROUP BY s.department
      ORDER BY s.department
    `);

    success(res, {
      departments: analytics
    }, 'Department analytics retrieved successfully');
  } catch (err) {
    logger.error('Department Analytics Error:', err);
    error(res, 'Failed to retrieve department analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Efficiency Report
export const getEfficiencyReport = async (req, res) => {
  try {
    const { department, start_date, end_date } = req.query;
    
    const efficiency = await prisma.$queryRawUnsafe(`
      SELECT 
        s.department,
        COUNT(DISTINCT s.id) as staff_count,
        COUNT(DISTINCT a.staff_id) as avg_daily_attendance,
        ROUND(AVG(EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600), 2) as avg_hours_worked,
        COUNT(DISTINCT pr.staff_id) FILTER (WHERE pr.rating >= 4) as high_performers,
        ROUND(100.0 * COUNT(DISTINCT a.staff_id) / NULLIF(COUNT(DISTINCT s.id), 0), 2) as attendance_rate
      FROM staff s
      LEFT JOIN staff_attendance a ON s.id = a.staff_id
        AND a.check_in_time >= COALESCE($1::timestamp, CURRENT_DATE - INTERVAL '30 days')
        AND a.check_in_time <= COALESCE($2::timestamp, CURRENT_DATE)
      LEFT JOIN staff_performance_reviews pr ON s.id = pr.staff_id
        AND pr.created_at >= CURRENT_DATE - INTERVAL '3 months'
      WHERE 
        s.is_active = true
        ${department ? 'AND s.department = $3' : ''}
      GROUP BY s.department
    `, start_date || null, end_date || null, ...(department ? [department] : []));

    success(res, {
      efficiency: efficiency,
      parameters: { department, start_date, end_date }
    }, 'Efficiency report generated successfully');
  } catch (err) {
    logger.error('Efficiency Report Error:', err);
    error(res, 'Failed to generate efficiency report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Overtime Report
export const getOvertimeReport = async (req, res) => {
  try {
    const { department, month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
    
    const overtime = await prisma.$queryRawUnsafe(`
      SELECT 
        s.name,
        s.employee_id,
        s.department,
        COUNT(*) as days_worked,
        SUM(CASE 
          WHEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 > 8 
          THEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 - 8 
          ELSE 0 
        END) as total_overtime_hours
      FROM staff s
      JOIN staff_attendance a ON s.id = a.staff_id
      WHERE 
        EXTRACT(MONTH FROM a.check_in_time)::int = $1::int
        AND EXTRACT(YEAR FROM a.check_in_time)::int = $2::int
        ${department ? 'AND s.department = $3' : ''}
      GROUP BY s.name, s.employee_id, s.department
      HAVING SUM(CASE 
        WHEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 > 8 
        THEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 - 8 
        ELSE 0 
      END) > 0
      ORDER BY total_overtime_hours DESC
    `, month, year, ...(department ? [department] : []));

    success(res, {
      overtime: overtime,
      month,
      year
    }, 'Overtime report generated successfully');
  } catch (err) {
    logger.error('Overtime Report Error:', err);
    error(res, 'Failed to generate overtime report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Turnover Report
export const getTurnoverReport = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    
    const turnover = await prisma.$queryRawUnsafe(`
      WITH monthly_turnover AS (
        SELECT 
          EXTRACT(MONTH FROM s.updated_at) as month,
          s.department,
          COUNT(*) FILTER (WHERE s.is_active = false) as left_count,
          COUNT(*) FILTER (WHERE s.join_date >= DATE_TRUNC('month', s.updated_at)) as joined_count
        FROM staff s
        WHERE EXTRACT(YEAR FROM s.updated_at)::int = $1::int
        GROUP BY EXTRACT(MONTH FROM s.updated_at), s.department
      )
      SELECT 
        month,
        department,
        left_count,
        joined_count,
        left_count - joined_count as net_change
      FROM monthly_turnover
      ORDER BY month, department
    `, year);

    success(res, {
      turnover: turnover,
      year
    }, 'Turnover report generated successfully');
  } catch (err) {
    logger.error('Turnover Report Error:', err);
    error(res, 'Failed to generate turnover report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
