// src/services/staff/hr/reportingService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

/**
 * Generate staff reports in various formats
 * @param {Object} reportParams - Report parameters
 * @returns {Object} Generated report data
 */
export const generateStaffReport = async (reportParams) => {
  const {
    report_type,
    department,
    start_date,
    end_date,
    format,
    generatedBy
  } = reportParams;

  let reportData;
  
  switch (report_type) {
    case 'attendance':
      reportData = await generateAttendanceReport(department, start_date, end_date);
      break;
    case 'performance':
      reportData = await generatePerformanceReportData(department, start_date, end_date);
      break;
    case 'leave':
      reportData = await generateLeaveReport(department, start_date, end_date);
      break;
    case 'payroll':
      reportData = await generatePayrollReport(department, start_date, end_date);
      break;
    default:
      throw new Error('Invalid report type');
  }

  if (format === 'csv') {
    return {
      data: convertToCSV(reportData)
    };
  }

  return {
    report_type,
    department: department || 'All Departments',
    date_range: { start_date, end_date },
    generated_by: generatedBy,
    generated_at: new Date().toISOString(),
    data: reportData
  };
};

/**
 * Generate attendance report data
 * @private
 */
const generateAttendanceReport = async (department, start_date, end_date) => {
  let whereClause = 'WHERE sa.check_in_time IS NOT NULL';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }
  
  if (start_date && end_date) {
    const paramOffset = queryParams.length;
    whereClause += ` AND DATE(sa.check_in_time) BETWEEN $${paramOffset + 1} AND $${paramOffset + 2}`;
    queryParams.push(start_date, end_date);
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      s.position,
      DATE(sa.check_in_time) as date,
      sa.check_in_time,
      sa.check_out_time,
      EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600 as hours_worked,
      sa.overtime_hours,
      CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 'Late' ELSE 'On Time' END as punctuality
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY date DESC, u.name
  `, queryParams);

  return result.rows.map(row => ({
    ...row,
    date: new Date(row.date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }),
    check_in_time: new Date(row.check_in_time).toLocaleTimeString('en-IN'),
    check_out_time: row.check_out_time ? 
      new Date(row.check_out_time).toLocaleTimeString('en-IN') : 'Not checked out',
    hours_worked: row.hours_worked ? Math.round(row.hours_worked * 10) / 10 : 0,
    overtime_hours: row.overtime_hours || 0
  }));
};

/**
 * Generate performance report data
 * @private
 */
const generatePerformanceReportData = async (department, start_date, end_date) => {
  let whereClause = 'WHERE s.is_active = true';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      s.position,
      s.performance_rating,
      s.last_review_date
    FROM staff s
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY s.department, u.name
  `, queryParams);

  return result.rows.map(row => ({
    ...row,
    performance_rating: row.performance_rating ? 
      Math.round(row.performance_rating * 10) / 10 : 'Not rated',
    last_review_date: row.last_review_date ? 
      new Date(row.last_review_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }) : 'Never reviewed'
  }));
};

/**
 * Generate leave report data
 * @private
 */
const generateLeaveReport = async (department, start_date, end_date) => {
  let whereClause = 'WHERE la.staff_id IS NOT NULL';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }
  
  if (start_date && end_date) {
    const paramOffset = queryParams.length;
    whereClause += ` AND la.start_date BETWEEN $${paramOffset + 1} AND $${paramOffset + 2}`;
    queryParams.push(start_date, end_date);
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      la.leave_type,
      la.start_date,
      la.end_date,
      la.days_taken,
      la.status,
      la.reason
    FROM leave_applications la
    JOIN staff s ON la.staff_id = s.user_id
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY la.start_date DESC, u.name
  `, queryParams);

  return result.rows.map(row => ({
    ...row,
    start_date: new Date(row.start_date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }),
    end_date: new Date(row.end_date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    })
  }));
};

/**
 * Generate payroll report data
 * @private
 */
const generatePayrollReport = async (department, start_date, end_date) => {
  let whereClause = 'WHERE s.is_active = true';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      s.position,
      s.employment_type,
      s.salary,
      s.bank_details
    FROM staff s
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY s.department, u.name
  `, queryParams);

  return result.rows.map(row => ({
    name: row.name,
    employee_id: row.employee_id,
    department: row.department,
    position: row.position,
    employment_type: row.employment_type,
    monthly_salary: row.salary || 0,
    bank_account: row.bank_details?.account_number ? 
      `****${row.bank_details.account_number.slice(-4)}` : 'Not provided'
  }));
};

/**
 * Convert data to CSV format
 * @private
 */
const convertToCSV = (data) => {
  if (!data || data.length === 0) {
    return '';
  }
  
  const headers = Object.keys(data[0]);
  const csvHeaders = headers.join(',');
  
  const csvRows = data.map(row => {
    return headers.map(header => {
      const value = row[header];
      // Escape quotes and wrap in quotes if contains comma
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }).join(',');
  });
  
  return [csvHeaders, ...csvRows].join('\n');
};