// src/controllers/staff/staffAdminController.js
import db from '../../config/database.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as attendanceService from '../../services/staff/attendanceService.js';
import * as hrService from '../../services/staff/hr/index.js';
import * as staffService from '../../services/staff/staffService.js';
import { success, error } from '../../utils/responseHelper.js';

// Staff Admin Dashboard
export const getStaffAdminDashboard = async (req, res) => {
  try {
    const dashboardData = await db.query(`
      WITH staff_stats AS (
        SELECT 
          COUNT(DISTINCT s.id) as total_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.is_active = true) as active_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.on_leave = true) as on_leave,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'nursing') as nursing_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'pharmacy') as pharmacy_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'lab') as lab_staff,
          COUNT(DISTINCT s.id) FILTER (WHERE s.department = 'administrative') as admin_staff
        FROM staff s
      ),
      attendance_today AS (
        SELECT 
          COUNT(DISTINCT staff_id) as present_today,
          COUNT(DISTINCT staff_id) FILTER (WHERE check_in_time::time > '09:30:00') as late_today,
          COUNT(DISTINCT staff_id) FILTER (WHERE check_out_time IS NULL) as currently_on_site
        FROM staff_attendance
        WHERE check_in_time::date = CURRENT_DATE
      ),
      hr_pending AS (
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending_reviews,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_leaves
        FROM (
          SELECT status FROM performance_reviews WHERE status = 'pending'
          UNION ALL
          SELECT status FROM leave_applications WHERE status = 'pending'
        ) hr_actions
      )
      SELECT 
        to_json(staff_stats.*) as staff,
        to_json(attendance_today.*) as attendance,
        to_json(hr_pending.*) as hr_actions
      FROM staff_stats, attendance_today, hr_pending
    `);

    const recentActivity = await db.query(`
      SELECT 
        'attendance' as type,
        CONCAT(s.name, ' checked in') as description,
        a.check_in_time as timestamp
      FROM staff_attendance a
      JOIN staff s ON a.staff_id = s.id
      WHERE a.check_in_time >= NOW() - INTERVAL '24 hours'
      ORDER BY a.check_in_time DESC
      LIMIT 10
    `);

    success(res, {
      overview: dashboardData.rows[0],
      recentActivity: recentActivity.rows,
      lastUpdated: new Date()
    }, 'Staff admin dashboard loaded successfully');
  } catch (err) {
    logger.error('Staff Admin Dashboard Error:', err);
    error(res, 'Failed to load staff admin dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Attendance Analytics
export const getAttendanceAnalytics = async (req, res) => {
  try {
    const { department, start_date, end_date, group_by = 'day' } = req.query;
    
    const analytics = await db.query(`
      SELECT 
        DATE_TRUNC($1, a.check_in_time) as period,
        COUNT(DISTINCT a.staff_id) as total_present,
        COUNT(DISTINCT a.staff_id) FILTER (WHERE a.check_in_time::time > '09:30:00') as late_arrivals,
        COUNT(DISTINCT a.staff_id) FILTER (WHERE a.check_out_time::time < '17:00:00') as early_departures,
        ROUND(AVG(EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600), 2) as avg_hours_worked
      FROM staff_attendance a
      JOIN staff s ON a.staff_id = s.id
      WHERE 
        a.check_in_time >= COALESCE($2::timestamp, CURRENT_DATE - INTERVAL '30 days')
        AND a.check_in_time <= COALESCE($3::timestamp, CURRENT_DATE)
        ${department ? 'AND s.department = $4' : ''}
      GROUP BY period
      ORDER BY period DESC
    `, [group_by, start_date, end_date, ...(department ? [department] : [])]);

    success(res, {
      analytics: analytics.rows,
      parameters: { department, start_date, end_date, group_by }
    }, 'Attendance analytics retrieved successfully');
  } catch (err) {
    logger.error('Attendance Analytics Error:', err);
    error(res, 'Failed to retrieve attendance analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Performance Analytics
export const getPerformanceAnalytics = async (req, res) => {
  try {
    const { department, timeframe = 'quarterly' } = req.query;
    
    const analytics = await db.query(`
      SELECT 
        s.department,
        COUNT(DISTINCT pr.staff_id) as reviewed_staff,
        ROUND(AVG(pr.rating), 2) as avg_rating,
        COUNT(*) FILTER (WHERE pr.rating >= 4) as high_performers,
        COUNT(*) FILTER (WHERE pr.rating < 3) as needs_improvement
      FROM performance_reviews pr
      JOIN staff s ON pr.staff_id = s.id
      WHERE 
        pr.created_at >= CURRENT_DATE - INTERVAL '${timeframe === 'quarterly' ? '3 months' : '1 year'}'
        ${department ? 'AND s.department = $1' : ''}
      GROUP BY s.department
    `, department ? [department] : []);

    success(res, {
      analytics: analytics.rows,
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
    const analytics = await db.query(`
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
      departments: analytics.rows
    }, 'Department analytics retrieved successfully');
  } catch (err) {
    logger.error('Department Analytics Error:', err);
    error(res, 'Failed to retrieve department analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Leave Patterns
export const getLeavePatterns = async (req, res) => {
  try {
    const { department, year = new Date().getFullYear() } = req.query;
    
    const patterns = await db.query(`
      SELECT 
        EXTRACT(MONTH FROM la.start_date) as month,
        la.leave_type,
        COUNT(*) as leave_count,
        SUM(la.end_date - la.start_date + 1) as total_days
      FROM leave_applications la
      JOIN staff s ON la.staff_id = s.id
      WHERE 
        EXTRACT(YEAR FROM la.start_date) = $1
        AND la.status = 'approved'
        ${department ? 'AND s.department = $2' : ''}
      GROUP BY month, la.leave_type
      ORDER BY month, la.leave_type
    `, department ? [year, department] : [year]);

    success(res, {
      patterns: patterns.rows,
      year
    }, 'Leave patterns retrieved successfully');
  } catch (err) {
    logger.error('Leave Patterns Error:', err);
    error(res, 'Failed to retrieve leave patterns', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Attendance Anomalies
export const getAttendanceAnomalies = async (req, res) => {
  try {
    const anomalies = await db.query(`
      WITH anomalies AS (
        SELECT 
          s.id,
          s.name,
          s.department,
          s.employee_id,
          COUNT(*) FILTER (WHERE a.check_in_time::time > '09:30:00') as late_days,
          COUNT(*) FILTER (WHERE a.check_out_time::time < '17:00:00') as early_leave_days,
          COUNT(*) FILTER (WHERE a.check_out_time IS NULL) as missing_checkout_days
        FROM staff s
        LEFT JOIN staff_attendance a ON s.id = a.staff_id
        WHERE 
          a.check_in_time >= CURRENT_DATE - INTERVAL '30 days'
          AND s.is_active = true
        GROUP BY s.id, s.name, s.department, s.employee_id
        HAVING 
          COUNT(*) FILTER (WHERE a.check_in_time::time > '09:30:00') > 3
          OR COUNT(*) FILTER (WHERE a.check_out_time::time < '17:00:00') > 3
          OR COUNT(*) FILTER (WHERE a.check_out_time IS NULL) > 0
      )
      SELECT * FROM anomalies ORDER BY late_days DESC, early_leave_days DESC
    `);

    success(res, {
      anomalies: anomalies.rows,
      total: anomalies.rows.length
    }, 'Attendance anomalies retrieved successfully');
  } catch (err) {
    logger.error('Attendance Anomalies Error:', err);
    error(res, 'Failed to retrieve attendance anomalies', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Late Arrivals Report
export const getLateArrivals = async (req, res) => {
  try {
    const { date = new Date().toISOString().split('T')[0], department } = req.query;
    
    const lateArrivals = await db.query(`
      SELECT 
        s.name,
        s.employee_id,
        s.department,
        a.check_in_time,
        a.check_in_time::time - '09:30:00'::time as late_by
      FROM staff_attendance a
      JOIN staff s ON a.staff_id = s.id
      WHERE 
        a.check_in_time::date = $1
        AND a.check_in_time::time > '09:30:00'
        ${department ? 'AND s.department = $2' : ''}
      ORDER BY a.check_in_time DESC
    `, department ? [date, department] : [date]);

    success(res, {
      date,
      lateArrivals: lateArrivals.rows,
      total: lateArrivals.rows.length
    }, 'Late arrivals report retrieved successfully');
  } catch (err) {
    logger.error('Late Arrivals Error:', err);
    error(res, 'Failed to retrieve late arrivals', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Early Departures Report
export const getEarlyDepartures = async (req, res) => {
  try {
    const { date = new Date().toISOString().split('T')[0], department } = req.query;
    
    const earlyDepartures = await db.query(`
      SELECT 
        s.name,
        s.employee_id,
        s.department,
        a.check_out_time,
        '17:00:00'::time - a.check_out_time::time as left_early_by
      FROM staff_attendance a
      JOIN staff s ON a.staff_id = s.id
      WHERE 
        a.check_out_time::date = $1
        AND a.check_out_time::time < '17:00:00'
        ${department ? 'AND s.department = $2' : ''}
      ORDER BY a.check_out_time
    `, department ? [date, department] : [date]);

    success(res, {
      date,
      earlyDepartures: earlyDepartures.rows,
      total: earlyDepartures.rows.length
    }, 'Early departures report retrieved successfully');
  } catch (err) {
    logger.error('Early Departures Error:', err);
    error(res, 'Failed to retrieve early departures', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Absent Report
export const getAbsentReport = async (req, res) => {
  try {
    const { date = new Date().toISOString().split('T')[0], department } = req.query;
    
    const absentStaff = await db.query(`
      SELECT 
        s.name,
        s.employee_id,
        s.department,
        s.phone,
        CASE 
          WHEN la.id IS NOT NULL THEN 'On Leave'
          ELSE 'Absent Without Notice'
        END as status
      FROM staff s
      LEFT JOIN staff_attendance a ON s.id = a.staff_id 
        AND a.check_in_time::date = $1
      LEFT JOIN leave_applications la ON s.id = la.staff_id 
        AND la.status = 'approved'
        AND $1 BETWEEN la.start_date AND la.end_date
      WHERE 
        s.is_active = true
        AND a.id IS NULL
        ${department ? 'AND s.department = $2' : ''}
      ORDER BY s.department, s.name
    `, department ? [date, department] : [date]);

    success(res, {
      date,
      absentStaff: absentStaff.rows,
      total: absentStaff.rows.length
    }, 'Absent staff report retrieved successfully');
  } catch (err) {
    logger.error('Absent Report Error:', err);
    error(res, 'Failed to retrieve absent report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get Pending Reviews
export const getPendingReviews = async (req, res) => {
  try {
    const pendingReviews = await db.query(`
      SELECT 
        pr.id,
        pr.staff_id,
        s.name as staff_name,
        s.department,
        pr.review_period,
        pr.created_at,
        DATE_PART('day', NOW() - pr.created_at) as pending_days
      FROM performance_reviews pr
      JOIN staff s ON pr.staff_id = s.id
      WHERE pr.status = 'pending'
      ORDER BY pr.created_at ASC
    `);

    success(res, {
      pendingReviews: pendingReviews.rows,
      total: pendingReviews.rows.length
    }, 'Pending reviews retrieved successfully');
  } catch (err) {
    logger.error('Pending Reviews Error:', err);
    error(res, 'Failed to retrieve pending reviews', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get All Leave Requests
export const getAllLeaveRequests = async (req, res) => {
  try {
    const { status = 'pending', department } = req.query;
    
    const leaveRequests = await db.query(`
      SELECT 
        la.id,
        la.staff_id,
        s.name as staff_name,
        s.department,
        la.leave_type,
        la.start_date,
        la.end_date,
        la.reason,
        la.status,
        la.created_at,
        la.end_date - la.start_date + 1 as total_days
      FROM leave_applications la
      JOIN staff s ON la.staff_id = s.id
      WHERE 
        la.status = $1
        ${department ? 'AND s.department = $2' : ''}
      ORDER BY la.created_at DESC
    `, department ? [status, department] : [status]);

    success(res, {
      leaveRequests: leaveRequests.rows,
      total: leaveRequests.rows.length,
      status
    }, 'Leave requests retrieved successfully');
  } catch (err) {
    logger.error('Leave Requests Error:', err);
    error(res, 'Failed to retrieve leave requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get Onboarding Status
export const getOnboardingStatus = async (req, res) => {
  try {
    const onboardingStatus = await db.query(`
      SELECT 
        s.id,
        s.name,
        s.department,
        s.join_date,
        COUNT(ot.id) as total_tasks,
        COUNT(ot.id) FILTER (WHERE ot.completed = true) as completed_tasks,
        ROUND(100.0 * COUNT(ot.id) FILTER (WHERE ot.completed = true) / NULLIF(COUNT(ot.id), 0), 2) as completion_percentage
      FROM staff s
      LEFT JOIN onboarding_tasks ot ON s.id = ot.staff_id
      WHERE s.join_date >= CURRENT_DATE - INTERVAL '90 days'
      GROUP BY s.id, s.name, s.department, s.join_date
      ORDER BY s.join_date DESC
    `);

    success(res, {
      onboardingStatus: onboardingStatus.rows
    }, 'Onboarding status retrieved successfully');
  } catch (err) {
    logger.error('Onboarding Status Error:', err);
    error(res, 'Failed to retrieve onboarding status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Efficiency Report
export const getEfficiencyReport = async (req, res) => {
  try {
    const { department, start_date, end_date } = req.query;
    
    const efficiency = await db.query(`
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
      LEFT JOIN performance_reviews pr ON s.id = pr.staff_id
        AND pr.created_at >= CURRENT_DATE - INTERVAL '3 months'
      WHERE 
        s.is_active = true
        ${department ? 'AND s.department = $3' : ''}
      GROUP BY s.department
    `, department ? [start_date, end_date, department] : [start_date, end_date]);

    success(res, {
      efficiency: efficiency.rows,
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
    
    const overtime = await db.query(`
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
        EXTRACT(MONTH FROM a.check_in_time) = $1
        AND EXTRACT(YEAR FROM a.check_in_time) = $2
        ${department ? 'AND s.department = $3' : ''}
      GROUP BY s.name, s.employee_id, s.department
      HAVING SUM(CASE 
        WHEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 > 8 
        THEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 - 8 
        ELSE 0 
      END) > 0
      ORDER BY total_overtime_hours DESC
    `, department ? [month, year, department] : [month, year]);

    success(res, {
      overtime: overtime.rows,
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
    
    const turnover = await db.query(`
      WITH monthly_turnover AS (
        SELECT 
          EXTRACT(MONTH FROM s.updated_at) as month,
          s.department,
          COUNT(*) FILTER (WHERE s.is_active = false) as left_count,
          COUNT(*) FILTER (WHERE s.join_date >= DATE_TRUNC('month', s.updated_at)) as joined_count
        FROM staff s
        WHERE EXTRACT(YEAR FROM s.updated_at) = $1
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
    `, [year]);

    success(res, {
      turnover: turnover.rows,
      year
    }, 'Turnover report generated successfully');
  } catch (err) {
    logger.error('Turnover Report Error:', err);
    error(res, 'Failed to generate turnover report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Advanced Staff Search
export const advancedStaffSearch = async (req, res) => {
  try {
    const { 
      search,
      department,
      shift,
      role,
      attendance_rate_min,
      has_pending_review,
      on_leave,
      sort_by = 'name',
      order = 'ASC',
      page = 1,
      limit = 20
    } = req.query;

    let query = `
      SELECT 
        s.*,
        u.name,
        u.phone,
        u.email,
        COALESCE(att.attendance_rate, 0) as attendance_rate,
        COALESCE(pr.pending_reviews, 0) as pending_reviews,
        CASE WHEN la.id IS NOT NULL THEN true ELSE false END as currently_on_leave
      FROM staff s
      JOIN users u ON s.user_id = u.uid
      LEFT JOIN (
        SELECT 
          staff_id,
          ROUND(100.0 * COUNT(*) / 30, 2) as attendance_rate
        FROM staff_attendance
        WHERE check_in_time >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY staff_id
      ) att ON s.id = att.staff_id
      LEFT JOIN (
        SELECT staff_id, COUNT(*) as pending_reviews
        FROM performance_reviews
        WHERE status = 'pending'
        GROUP BY staff_id
      ) pr ON s.id = pr.staff_id
      LEFT JOIN leave_applications la ON s.id = la.staff_id
        AND la.status = 'approved'
        AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
      WHERE s.is_active = true
    `;

    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      query += ` AND (u.name ILIKE $${paramCount} OR s.employee_id ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    if (department) {
      paramCount++;
      query += ` AND s.department = $${paramCount}`;
      params.push(department);
    }

    if (shift) {
      paramCount++;
      query += ` AND s.shift = $${paramCount}`;
      params.push(shift);
    }

    if (role) {
      paramCount++;
      query += ` AND u.role = $${paramCount}`;
      params.push(role);
    }

    if (attendance_rate_min) {
      paramCount++;
      query += ` AND COALESCE(att.attendance_rate, 0) >= $${paramCount}`;
      params.push(attendance_rate_min);
    }

    if (has_pending_review === 'true') {
      query += ` AND COALESCE(pr.pending_reviews, 0) > 0`;
    }

    if (on_leave === 'true') {
      query += ` AND la.id IS NOT NULL`;
    } else if (on_leave === 'false') {
      query += ` AND la.id IS NULL`;
    }

    query += ` ORDER BY ${sort_by} ${order}`;
    query += ` LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, (page - 1) * limit);

    const result = await db.query(query, params);

    // Get total count
    const countQuery = query.replace(/SELECT[\s\S]*FROM/, 'SELECT COUNT(*) FROM').replace(/ORDER BY[\s\S]*$/, '');
    const countResult = await db.query(countQuery, params.slice(0, -2));

    success(res, {
      staff: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    }, 'Staff search completed successfully');
  } catch (err) {
    logger.error('Advanced Search Error:', err);
    error(res, 'Failed to search staff', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Export Staff Data
export const exportStaffData = async (req, res) => {
  try {
    const { type } = req.params;
    const { department, start_date, end_date, format = 'csv' } = req.query;

    let data;
    switch (type) {
      case 'attendance':
        data = await exportAttendanceData(department, start_date, end_date);
        break;
      case 'performance':
        data = await exportPerformanceData(department, start_date, end_date);
        break;
      case 'leave':
        data = await exportLeaveData(department, start_date, end_date);
        break;
      case 'payroll':
        data = await exportPayrollData(department, start_date, end_date);
        break;
      default:
        return error(res, 'Invalid export type', HTTP_STATUS.BAD_REQUEST);
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=staff_${type}_${new Date().toISOString().split('T')[0]}.csv`);
      return res.send(data);
    }

    success(res, { data }, `${type} data exported successfully`);
  } catch (err) {
    logger.error('Export Error:', err);
    error(res, 'Failed to export data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk Attendance Correction
export const bulkAttendanceCorrection = async (req, res) => {
  try {
    const { corrections } = req.body; // Array of {staff_id, date, check_in, check_out}
    const correctedBy = req.user?.uid;

    const results = await Promise.all(
      corrections.map(async (correction) => {
        try {
          await db.query(`
            UPDATE staff_attendance
            SET 
              check_in_time = $2,
              check_out_time = $3,
              updated_by = $4,
              updated_at = NOW()
            WHERE staff_id = $1 AND check_in_time::date = $5
          `, [correction.staff_id, correction.check_in, correction.check_out, correctedBy, correction.date]);
          
          return { staff_id: correction.staff_id, status: 'success' };
        } catch (err) {
          return { staff_id: correction.staff_id, status: 'failed', error: err.message };
        }
      })
    );

    success(res, {
      corrections: results,
      total: corrections.length,
      successful: results.filter(r => r.status === 'success').length
    }, 'Bulk attendance correction completed');
  } catch (err) {
    logger.error('Bulk Correction Error:', err);
    error(res, 'Failed to correct attendance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk Shift Assignment
export const bulkShiftAssignment = async (req, res) => {
  try {
    const { assignments } = req.body; // Array of {staff_id, shift}
    const assignedBy = req.user?.uid;

    const results = await Promise.all(
      assignments.map(async (assignment) => {
        try {
          await db.query(`
            UPDATE staff
            SET 
              shift = $2,
              updated_by = $3,
              updated_at = NOW()
            WHERE id = $1
          `, [assignment.staff_id, assignment.shift, assignedBy]);
          
          return { staff_id: assignment.staff_id, status: 'success' };
        } catch (err) {
          return { staff_id: assignment.staff_id, status: 'failed', error: err.message };
        }
      })
    );

    success(res, {
      assignments: results,
      total: assignments.length,
      successful: results.filter(r => r.status === 'success').length
    }, 'Bulk shift assignment completed');
  } catch (err) {
    logger.error('Bulk Assignment Error:', err);
    error(res, 'Failed to assign shifts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk Leave Approval
export const bulkLeaveApproval = async (req, res) => {
  try {
    const { leave_ids, action = 'approve' } = req.body;
    const approvedBy = req.user?.uid;
    const status = action === 'approve' ? 'approved' : 'rejected';

    const result = await db.query(`
      UPDATE leave_applications
      SET 
        status = $1,
        approved_by = $2,
        approved_at = NOW()
      WHERE id = ANY($3::int[])
      RETURNING id
    `, [status, approvedBy, leave_ids]);

    success(res, {
      processed: result.rows.length,
      action,
      leave_ids
    }, `${result.rows.length} leave requests ${status}`);
  } catch (err) {
    logger.error('Bulk Leave Approval Error:', err);
    error(res, 'Failed to process leave requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Override Attendance
export const overrideAttendance = async (req, res) => {
  try {
    const { staff_id, date, check_in, check_out, reason } = req.body;
    const overriddenBy = req.user?.uid;

    const result = await db.query(`
      INSERT INTO staff_attendance (staff_id, check_in_time, check_out_time, override_reason, overridden_by, created_by)
      VALUES ($1, $2, $3, $4, $5, $5)
      ON CONFLICT (staff_id, check_in_time::date)
      DO UPDATE SET 
        check_in_time = $2,
        check_out_time = $3,
        override_reason = $4,
        overridden_by = $5,
        updated_at = NOW()
      RETURNING *
    `, [staff_id, check_in, check_out, reason, overriddenBy]);

    success(res, result.rows[0], 'Attendance override successful');
  } catch (err) {
    logger.error('Override Attendance Error:', err);
    error(res, 'Failed to override attendance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Override Leave Balance
export const overrideLeaveBalance = async (req, res) => {
  try {
    const { staff_id, leave_type, new_balance, reason } = req.body;
    const overriddenBy = req.user?.uid;

    await db.query(`
      INSERT INTO leave_balance_overrides (staff_id, leave_type, new_balance, reason, overridden_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [staff_id, leave_type, new_balance, reason, overriddenBy]);

    success(res, {
      staff_id,
      leave_type,
      new_balance,
      reason
    }, 'Leave balance override successful');
  } catch (err) {
    logger.error('Override Leave Balance Error:', err);
    error(res, 'Failed to override leave balance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Generate Payroll Data
export const generatePayrollData = async (req, res) => {
  try {
    const { month, year, department } = req.body;
    
    const payrollData = await db.query(`
      SELECT 
        s.employee_id,
        u.name,
        s.department,
        s.base_salary,
        COUNT(DISTINCT a.check_in_time::date) as days_worked,
        SUM(
          CASE 
            WHEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 > 8 
            THEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 - 8 
            ELSE 0 
          END
        ) as overtime_hours,
        COUNT(DISTINCT la.id) as leaves_taken
      FROM staff s
      JOIN users u ON s.user_id = u.uid
      LEFT JOIN staff_attendance a ON s.id = a.staff_id
        AND EXTRACT(MONTH FROM a.check_in_time) = $1
        AND EXTRACT(YEAR FROM a.check_in_time) = $2
      LEFT JOIN leave_applications la ON s.id = la.staff_id
        AND la.status = 'approved'
        AND EXTRACT(MONTH FROM la.start_date) = $1
        AND EXTRACT(YEAR FROM la.start_date) = $2
      WHERE 
        s.is_active = true
        ${department ? 'AND s.department = $3' : ''}
      GROUP BY s.employee_id, u.name, s.department, s.base_salary
      ORDER BY s.department, u.name
    `, department ? [month, year, department] : [month, year]);

    success(res, {
      payrollData: payrollData.rows,
      month,
      year,
      generatedAt: new Date()
    }, 'Payroll data generated successfully');
  } catch (err) {
    logger.error('Generate Payroll Error:', err);
    error(res, 'Failed to generate payroll data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Sync Biometric Data
export const syncBiometricData = async (req, res) => {
  try {
    // This would integrate with actual biometric system
    // For now, returning mock response
    
    success(res, {
      synced: 0,
      failed: 0,
      lastSync: new Date(),
      message: 'Biometric sync feature not yet implemented'
    }, 'Biometric sync initiated');
  } catch (err) {
    logger.error('Biometric Sync Error:', err);
    error(res, 'Failed to sync biometric data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update Staff Status
export const updateStaffStatus = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { is_active, on_leave, reason } = req.body;
    const updatedBy = req.user?.uid;

    const result = await db.query(`
      UPDATE staff
      SET 
        is_active = COALESCE($2, is_active),
        on_leave = COALESCE($3, on_leave),
        status_reason = $4,
        updated_by = $5,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [staffId, is_active, on_leave, reason, updatedBy]);

    if (result.rows.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result.rows[0], 'Staff status updated successfully');
  } catch (err) {
    logger.error('Update Staff Status Error:', err);
    error(res, 'Failed to update staff status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Approve Performance Review
export const approvePerformanceReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { comments, final_rating } = req.body;
    const approvedBy = req.user?.uid;

    const result = await db.query(`
      UPDATE performance_reviews
      SET 
        status = 'approved',
        approved_by = $2,
        approved_at = NOW(),
        approver_comments = $3,
        final_rating = COALESCE($4, rating)
      WHERE id = $1
      RETURNING *
    `, [reviewId, approvedBy, comments, final_rating]);

    if (result.rows.length === 0) {
      return error(res, 'Performance review not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result.rows[0], 'Performance review approved successfully');
  } catch (err) {
    logger.error('Approve Review Error:', err);
    error(res, 'Failed to approve performance review', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Approve Leave Request
export const approveLeaveRequest = async (req, res) => {
  try {
    const { leaveId } = req.params;
    const { comments } = req.body;
    const approvedBy = req.user?.uid;

    const result = await db.query(`
      UPDATE leave_applications
      SET 
        status = 'approved',
        approved_by = $2,
        approved_at = NOW(),
        approver_comments = $3
      WHERE id = $1
      RETURNING *
    `, [leaveId, approvedBy, comments]);

    if (result.rows.length === 0) {
      return error(res, 'Leave request not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result.rows[0], 'Leave request approved successfully');
  } catch (err) {
    logger.error('Approve Leave Error:', err);
    error(res, 'Failed to approve leave request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Archive Staff Member
export const archiveStaffMember = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { reason } = req.body;
    const archivedBy = req.user?.uid;

    const result = await db.query(`
      UPDATE staff
      SET 
        is_active = false,
        archived = true,
        archived_at = NOW(),
        archived_by = $2,
        archive_reason = $3
      WHERE id = $1
      RETURNING id, employee_id
    `, [staffId, archivedBy, reason]);

    if (result.rows.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result.rows[0], 'Staff member archived successfully');
  } catch (err) {
    logger.error('Archive Staff Error:', err);
    error(res, 'Failed to archive staff member', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Purge Old Records
export const purgeOldRecords = async (req, res) => {
  try {
    const { older_than_days = 365, record_type = 'attendance' } = req.body;
    const purgedBy = req.user?.uid;

    let result;
    switch (record_type) {
      case 'attendance':
        result = await db.query(`
          DELETE FROM staff_attendance
          WHERE check_in_time < NOW() - INTERVAL '${older_than_days} days'
          RETURNING id
        `);
        break;
      case 'reviews':
        result = await db.query(`
          DELETE FROM performance_reviews
          WHERE created_at < NOW() - INTERVAL '${older_than_days} days'
          AND status = 'completed'
          RETURNING id
        `);
        break;
      default:
        return error(res, 'Invalid record type', HTTP_STATUS.BAD_REQUEST);
    }

    // Log the purge operation
    await db.query(`
      INSERT INTO audit_logs (action, entity_type, performed_by, details)
      VALUES ('purge', $1, $2, $3)
    `, [record_type, purgedBy, { deleted_count: result.rows.length, older_than_days }]);

    success(res, {
      purged: result.rows.length,
      record_type,
      older_than_days
    }, `${result.rows.length} old records purged successfully`);
  } catch (err) {
    logger.error('Purge Records Error:', err);
    error(res, 'Failed to purge old records', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Helper functions for exports
async function exportAttendanceData(department, start_date, end_date) {
  const data = await db.query(`
    SELECT 
      s.employee_id,
      u.name,
      s.department,
      a.check_in_time::date as date,
      a.check_in_time::time as check_in,
      a.check_out_time::time as check_out,
      EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 as hours_worked
    FROM staff_attendance a
    JOIN staff s ON a.staff_id = s.id
    JOIN users u ON s.user_id = u.uid
    WHERE 
      a.check_in_time >= COALESCE($1::timestamp, CURRENT_DATE - INTERVAL '30 days')
      AND a.check_in_time <= COALESCE($2::timestamp, CURRENT_DATE)
      ${department ? 'AND s.department = $3' : ''}
    ORDER BY a.check_in_time DESC
  `, department ? [start_date, end_date, department] : [start_date, end_date]);

  // Convert to CSV format
  const headers = ['Employee ID', 'Name', 'Department', 'Date', 'Check In', 'Check Out', 'Hours Worked'];
  const rows = data.rows.map(row => [
    row.employee_id,
    row.name,
    row.department,
    row.date,
    row.check_in,
    row.check_out,
    row.hours_worked?.toFixed(2) || ''
  ]);

  return [headers, ...rows].map(row => row.join(',')).join('\n');
}

async function exportPerformanceData(department, start_date, end_date) {
  // Similar implementation for performance data
  return 'Performance data export not yet implemented';
}

async function exportLeaveData(department, start_date, end_date) {
  // Similar implementation for leave data
  return 'Leave data export not yet implemented';
}

async function exportPayrollData(department, start_date, end_date) {
  // Similar implementation for payroll data
  return 'Payroll data export not yet implemented';
}

export default {
  getStaffAdminDashboard,
  getAttendanceAnalytics,
  getPerformanceAnalytics,
  getDepartmentAnalytics,
  getLeavePatterns,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
  getPendingReviews,
  getAllLeaveRequests,
  getOnboardingStatus,
  getEfficiencyReport,
  getOvertimeReport,
  getTurnoverReport,
  advancedStaffSearch,
  exportStaffData,
  bulkAttendanceCorrection,
  bulkShiftAssignment,
  bulkLeaveApproval,
  overrideAttendance,
  overrideLeaveBalance,
  generatePayrollData,
  syncBiometricData,
  updateStaffStatus,
  approvePerformanceReview,
  approveLeaveRequest,
  archiveStaffMember,
  purgeOldRecords
};