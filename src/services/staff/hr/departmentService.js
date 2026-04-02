// src/services/staff/hr/departmentService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

/**
 * Get comprehensive department staff summary
 * @param {string} department - Department name
 * @returns {Object} Department statistics and staff list
 */
export const getDepartmentStaffSummary = async (department) => {
  // Basic department statistics
  const departmentStats = await prisma.$queryRawUnsafe(`
    SELECT 
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.employment_type = 'FULL_TIME' THEN 1 END) as full_time,
      COUNT(CASE WHEN s.employment_type = 'PART_TIME' THEN 1 END) as part_time,
      COUNT(CASE WHEN s.employment_type = 'CONTRACT' THEN 1 END) as contract,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as average_salary,
      MIN(s.salary) FILTER (WHERE s.salary IS NOT NULL) as min_salary,
      MAX(s.salary) FILTER (WHERE s.salary IS NOT NULL) as max_salary
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1
  `, [department]);

  // Staff by position
  const positionBreakdown = await prisma.$queryRawUnsafe(`
    SELECT 
      s.position,
      COUNT(*) as count,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as avg_salary
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1 AND s.is_active = true
    GROUP BY s.position
    ORDER BY count DESC
  `, [department]);

  // Staff by shift
  const shiftBreakdown = await prisma.$queryRawUnsafe(`
    SELECT 
      s.shift_type,
      COUNT(*) as count
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1 AND s.is_active = true AND s.shift_type IS NOT NULL
    GROUP BY s.shift_type
    ORDER BY count DESC
  `, [department]);

  // Experience distribution
  const experienceDistribution = await prisma.$queryRawUnsafe(`
    SELECT 
      CASE
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '1 year' THEN '0-1 years'
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '3 years' THEN '1-3 years'
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '5 years' THEN '3-5 years'
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '10 years' THEN '5-10 years'
        ELSE '10+ years'
      END as experience_range,
      COUNT(*) as count
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1 AND s.is_active = true
    GROUP BY experience_range
    ORDER BY 
      CASE experience_range
        WHEN '0-1 years' THEN 1
        WHEN '1-3 years' THEN 2
        WHEN '3-5 years' THEN 3
        WHEN '5-10 years' THEN 4
        ELSE 5
      END
  `, [department]);

  // Recent attendance
  const attendanceMetrics = await prisma.$queryRawUnsafe(`
    SELECT 
      COUNT(DISTINCT sa.staff_id) as staff_present_today,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) as avg_hours_today
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    WHERE s.department = $1 
      AND DATE(sa.check_in_time) = CURRENT_DATE
      AND sa.check_out_time IS NOT NULL
  `, [department]);

  // Performance metrics
  const performanceMetrics = await prisma.$queryRawUnsafe(`
    SELECT 
      AVG(s.performance_rating) as avg_performance,
      COUNT(CASE WHEN s.performance_rating >= 4.0 THEN 1 END) as high_performers,
      COUNT(CASE WHEN s.performance_rating < 3.0 THEN 1 END) as needs_improvement
    FROM staff s
    WHERE s.department = $1 AND s.is_active = true AND s.performance_rating IS NOT NULL
  `, [department]);

  // Staff list
  const staffList = await prisma.$queryRawUnsafe(`
    SELECT 
      u.id, u.name, u.email, u.phone,
      s.employee_id, s.position, s.shift_type, s.employment_type,
      s.hire_date, s.performance_rating,
      CASE 
        WHEN sa.check_in_time IS NOT NULL AND sa.check_out_time IS NULL THEN 'present'
        WHEN sa.check_in_time IS NOT NULL THEN 'checked_out'
        ELSE 'absent'
      END as attendance_status
    FROM users u
    JOIN staff s ON u.id = s.user_id
    LEFT JOIN staff_attendance sa ON s.user_id = sa.staff_id 
      AND DATE(sa.check_in_time) = CURRENT_DATE
    WHERE s.department = $1 AND s.is_active = true
    ORDER BY s.position, u.name
  `, [department]);

  const stats = departmentStats[0];
  const attendance = attendanceMetrics[0];
  const performance = performanceMetrics[0];

  return {
    department,
    overview: {
      total_staff: parseInt(stats.total_staff) || 0,
      active_staff: parseInt(stats.active_staff) || 0,
      full_time: parseInt(stats.full_time) || 0,
      part_time: parseInt(stats.part_time) || 0,
      contract: parseInt(stats.contract) || 0,
      attendance_today: parseInt(attendance.staff_present_today) || 0,
      attendance_rate: stats.active_staff > 0 ? 
        Math.round((attendance.staff_present_today / stats.active_staff) * 100) : 0,
      avg_hours_today: attendance.avg_hours_today ? 
        Math.round(attendance.avg_hours_today * 10) / 10 : 0
    },
    salary: {
      average: stats.average_salary ? Math.round(stats.average_salary) : null,
      minimum: stats.min_salary ? Math.round(stats.min_salary) : null,
      maximum: stats.max_salary ? Math.round(stats.max_salary) : null
    },
    performance: {
      average_rating: performance.avg_performance ? 
        Math.round(performance.avg_performance * 10) / 10 : null,
      high_performers: parseInt(performance.high_performers) || 0,
      needs_improvement: parseInt(performance.needs_improvement) || 0
    },
    positionBreakdown: positionBreakdown.rows.map(pos => ({
      position: pos.position,
      count: parseInt(pos.count),
      avg_salary: pos.avg_salary ? Math.round(pos.avg_salary) : null
    })),
    shiftBreakdown: shiftBreakdown.rows,
    experienceDistribution: experienceDistribution.rows,
    staffList: staffList.rows.map(staff => ({
      ...staff,
      hire_date: new Date(staff.hire_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      tenure: Math.floor((new Date() - new Date(staff.hire_date)) / (365.25 * 24 * 60 * 60 * 1000)),
      performance_rating: staff.performance_rating ? 
        Math.round(staff.performance_rating * 10) / 10 : null
    }))
  };
};

/**
 * Get attendance analytics across departments
 * @param {Object} queryParams - Query parameters including filters
 * @returns {Object} Attendance analytics data
 */
export const getAttendanceAnalytics = async (queryParams) => {
  const { department, start_date, end_date, group_by } = queryParams;

  let whereClause = 'WHERE sa.check_in_time IS NOT NULL';
  let paramIndex = 1;

  if (department) {
    whereClause += ` AND s.department = $${paramIndex}`;
    queryParams.push(department);
    paramIndex++;
  }

  if (start_date && end_date) {
    whereClause += ` AND DATE(sa.check_in_time) BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
    queryParams.push(start_date, end_date);
    paramIndex += 2;
  }

  // Attendance overview
  const overview = await prisma.$queryRawUnsafe(`
    SELECT 
      COUNT(DISTINCT sa.staff_id) as unique_staff,
      COUNT(*) as total_check_ins,
      COUNT(CASE WHEN sa.check_out_time IS NOT NULL THEN 1 END) as completed_shifts,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
        FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours_worked,
      COUNT(CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 1 END) as late_arrivals,
      COUNT(CASE WHEN sa.overtime_hours > 0 THEN 1 END) as overtime_shifts
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    ${whereClause}
  `, queryParams);

  // Group by time period
  let groupByClause;
  let dateFormat;
  
  switch (group_by) {
    case 'week':
      groupByClause = "DATE_TRUNC('week', sa.check_in_time)";
      dateFormat = "to_char(DATE_TRUNC('week', sa.check_in_time), 'DD-MM-YYYY')";
      break;
    case 'month':
      groupByClause = "DATE_TRUNC('month', sa.check_in_time)";
      dateFormat = "to_char(DATE_TRUNC('month', sa.check_in_time), 'Mon YYYY')";
      break;
    default: // day
      groupByClause = "DATE(sa.check_in_time)";
      dateFormat = "to_char(DATE(sa.check_in_time), 'DD-MM-YYYY')";
  }

  const trendsData = await prisma.$queryRawUnsafe(`
    SELECT 
      ${dateFormat} as period,
      COUNT(DISTINCT sa.staff_id) as unique_staff,
      COUNT(*) as total_check_ins,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
        FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours,
      COUNT(CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 1 END) as late_arrivals,
      SUM(sa.overtime_hours) as total_overtime_hours
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    ${whereClause}
    GROUP BY ${groupByClause}
    ORDER BY ${groupByClause} DESC
    LIMIT 30
  `, queryParams);

  // Department comparison (if not filtering by department)
  let departmentComparison = [];
  if (!department) {
    const deptResult = await prisma.$queryRawUnsafe(`
      SELECT 
        s.department,
        COUNT(DISTINCT sa.staff_id) as unique_staff,
        COUNT(*) as total_check_ins,
        AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
          FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours,
        COUNT(CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 1 END) as late_arrivals
      FROM staff_attendance sa
      JOIN staff s ON sa.staff_id = s.user_id
      WHERE sa.check_in_time IS NOT NULL
        ${start_date && end_date ? `AND DATE(sa.check_in_time) BETWEEN $1 AND $2` : ''}
      GROUP BY s.department
      ORDER BY total_check_ins DESC
    `, start_date && end_date ? [start_date, end_date] : []);
    
    departmentComparison = deptResult.rows;
  }

  // Punctuality analysis
  const punctualityData = await prisma.$queryRawUnsafe(`
    SELECT 
      CASE 
        WHEN TIME(sa.check_in_time) <= '09:00:00' THEN 'on_time'
        WHEN TIME(sa.check_in_time) <= '09:30:00' THEN 'slightly_late'
        WHEN TIME(sa.check_in_time) <= '10:00:00' THEN 'late'
        ELSE 'very_late'
      END as punctuality,
      COUNT(*) as count
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    ${whereClause}
    GROUP BY punctuality
    ORDER BY 
      CASE punctuality
        WHEN 'on_time' THEN 1
        WHEN 'slightly_late' THEN 2
        WHEN 'late' THEN 3
        ELSE 4
      END
  `, queryParams);

  // Top performers (most consistent attendance)
  const topPerformers = await prisma.$queryRawUnsafe(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      COUNT(*) as days_present,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
        FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours,
      COUNT(CASE WHEN TIME(sa.check_in_time) <= '09:00:00' THEN 1 END) as on_time_days,
      SUM(sa.overtime_hours) as total_overtime
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    GROUP BY u.name, s.employee_id, s.department
    HAVING COUNT(*) > 5
    ORDER BY days_present DESC, on_time_days DESC
    LIMIT 10
  `, queryParams);

  const overviewData = overview[0];

  return {
    filters: {
      department: department || 'All Departments',
      date_range: start_date && end_date ? 
        { start: start_date, end: end_date } : 'All Time',
      grouping: group_by
    },
    summary: {
      unique_staff: parseInt(overviewData.unique_staff) || 0,
      total_check_ins: parseInt(overviewData.total_check_ins) || 0,
      completed_shifts: parseInt(overviewData.completed_shifts) || 0,
      avg_hours_worked: overviewData.avg_hours_worked ? 
        Math.round(overviewData.avg_hours_worked * 10) / 10 : 0,
      late_arrivals: parseInt(overviewData.late_arrivals) || 0,
      late_arrival_rate: overviewData.total_check_ins > 0 ?
        Math.round((overviewData.late_arrivals / overviewData.total_check_ins) * 100) : 0,
      overtime_shifts: parseInt(overviewData.overtime_shifts) || 0
    },
    trends: trendsData.rows.map(trend => ({
      period: trend.period,
      unique_staff: parseInt(trend.unique_staff),
      total_check_ins: parseInt(trend.total_check_ins),
      avg_hours: trend.avg_hours ? Math.round(trend.avg_hours * 10) / 10 : 0,
      late_arrivals: parseInt(trend.late_arrivals),
      total_overtime_hours: parseFloat(trend.total_overtime_hours) || 0
    })),
    departmentComparison: departmentComparison.map(dept => ({
      department: dept.department,
      unique_staff: parseInt(dept.unique_staff),
      total_check_ins: parseInt(dept.total_check_ins),
      avg_hours: dept.avg_hours ? Math.round(dept.avg_hours * 10) / 10 : 0,
      late_arrivals: parseInt(dept.late_arrivals),
      punctuality_score: dept.total_check_ins > 0 ?
        Math.round(((dept.total_check_ins - dept.late_arrivals) / dept.total_check_ins) * 100) : 0
    })),
    punctualityBreakdown: punctualityData.rows,
    topPerformers: topPerformers.rows.map(performer => ({
      ...performer,
      avg_hours: performer.avg_hours ? Math.round(performer.avg_hours * 10) / 10 : 0,
      punctuality_rate: performer.days_present > 0 ?
        Math.round((performer.on_time_days / performer.days_present) * 100) : 0,
      total_overtime: parseFloat(performer.total_overtime) || 0
    }))
  };
};