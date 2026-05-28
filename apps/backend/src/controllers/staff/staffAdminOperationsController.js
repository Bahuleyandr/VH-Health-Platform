// src/controllers/staff/staffAdminOperationsController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

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
      sort_by,
      order
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
        SELECT staff_id, COUNT(*) FILTER (WHERE review_date IS NULL) as pending_reviews
        FROM staff_performance_reviews
        GROUP BY staff_id
      ) pr ON s.id = pr.staff_id
      LEFT JOIN leave_applications la ON s.id = la.staff_id
        AND LOWER(la.status) = 'approved'
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
      query += ` AND COALESCE(att.attendance_rate, 0) >= $${paramCount}::numeric`;
      params.push(Number(attendance_rate_min));
    }

    if (has_pending_review === 'true') {
      query += ` AND COALESCE(pr.pending_reviews, 0) > 0`;
    }

    if (on_leave === 'true') {
      query += ` AND la.id IS NOT NULL`;
    } else if (on_leave === 'false') {
      query += ` AND la.id IS NULL`;
    }

    const sortColumns = {
      name: 'u.name',
      employee_id: 's.employee_id',
      department: 's.department',
      shift: 's.shift',
      attendance_rate: 'attendance_rate',
      pending_reviews: 'pending_reviews',
    };
    const listQuery = parseListQuery(
      {
        ...req.query,
        sortBy: req.query.sortBy ?? sort_by,
        sortOrder: req.query.sortOrder ?? order,
      },
      {
        defaultLimit: 20,
        maxLimit: 100,
        defaultSortBy: 'name',
        defaultSortOrder: 'ASC',
        allowedSortFields: Object.keys(sortColumns),
      }
    );
    const sortColumn = sortColumns[listQuery.sortBy] || sortColumns.name;
    const sortOrder = listQuery.sortOrder;

    const filteredQuery = query;

    query += ` ORDER BY ${sortColumn} ${sortOrder}`;
    query += ` LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(listQuery.limit, listQuery.offset);

    const result = await prisma.$queryRawUnsafe(query, ...params);

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM (${filteredQuery}) staff_search_count`;
    const countResult = await prisma.$queryRawUnsafe(countQuery, ...params.slice(0, -2));

    success(res, {
      staff: result,
      pagination: buildPagination(countResult[0].count, listQuery.page, listQuery.limit)
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

// Bulk Shift Assignment
export const bulkShiftAssignment = async (req, res) => {
  try {
    const { assignments } = req.body; // Array of {staff_id, shift}
    const assignedBy = req.user?.uid;

    const results = await Promise.all(
      assignments.map(async (assignment) => {
        try {
          await prisma.$queryRawUnsafe(`
            UPDATE staff
            SET 
              shift = $2,
              updated_by = $3,
              updated_at = NOW()
            WHERE id = $1
          `, assignment.staff_id, assignment.shift, assignedBy);
          
          return { staff_id: assignment.staff_id, status: 'success' };
        } catch (err) {
          logger.error(`Bulk shift assignment failed for staff ${assignment.staff_id}:`, err);
          return { staff_id: assignment.staff_id, status: 'failed', error: 'Failed to process assignment' };
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

// Generate Payroll Data
export const generatePayrollData = async (req, res) => {
  try {
    const { month, year, department } = req.body;
    
    const payrollData = await prisma.$queryRawUnsafe(`
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
        AND EXTRACT(MONTH FROM a.check_in_time)::int = $1::int
        AND EXTRACT(YEAR FROM a.check_in_time)::int = $2::int
      LEFT JOIN leave_applications la ON s.id = la.staff_id
        AND LOWER(la.status) = 'approved'
        AND EXTRACT(MONTH FROM la.start_date)::int = $1::int
        AND EXTRACT(YEAR FROM la.start_date)::int = $2::int
      WHERE 
        s.is_active = true
        ${department ? 'AND s.department = $3' : ''}
      GROUP BY s.employee_id, u.name, s.department, s.base_salary
      ORDER BY s.department, u.name
    `, month, year, ...(department ? [department] : []));

    success(res, {
      payrollData: payrollData,
      month,
      year,
      generatedAt: new Date()
    }, 'Payroll data generated successfully');
  } catch (err) {
    logger.error('Generate Payroll Error:', err);
    error(res, 'Failed to generate payroll data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update Staff Status
export const updateStaffStatus = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { is_active, on_leave, reason } = req.body;
    const updatedBy = req.user?.uid;

    const result = await prisma.$queryRawUnsafe(`
      UPDATE staff
      SET 
        is_active = COALESCE($2, is_active),
        on_leave = COALESCE($3, on_leave),
        status_reason = $4,
        updated_by = $5,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, employee_id, department, shift, is_active, on_leave, status_reason, updated_by, updated_at
    `, staffId, is_active, on_leave, reason, updatedBy);

    if (result.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result[0], 'Staff status updated successfully');
  } catch (err) {
    logger.error('Update Staff Status Error:', err);
    error(res, 'Failed to update staff status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Archive Staff Member
export const archiveStaffMember = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { reason } = req.body;
    const archivedBy = req.user?.uid;

    const result = await prisma.$queryRawUnsafe(`
      UPDATE staff
      SET 
        is_active = false,
        archived = true,
        archived_at = NOW(),
        archived_by = $2,
        archive_reason = $3
      WHERE id = $1
      RETURNING id, employee_id
    `, staffId, archivedBy, reason);

    if (result.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result[0], 'Staff member archived successfully');
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

    // Sanitize: ensure older_than_days is a positive integer
    const safeDays = Math.max(1, Math.floor(Number(older_than_days) || 365));

    let result;
    switch (record_type) {
      case 'attendance':
        result = await prisma.$queryRawUnsafe(`
          DELETE FROM staff_attendance
          WHERE check_in_time < NOW() - make_interval(days => $1)
          RETURNING id
        `, safeDays);
        break;
      case 'reviews':
        result = await prisma.$queryRawUnsafe(`
          DELETE FROM staff_performance_reviews
          WHERE created_at < NOW() - make_interval(days => $1)
          AND review_date IS NOT NULL
          RETURNING id
        `, safeDays);
        break;
      default:
        return error(res, 'Invalid record type', HTTP_STATUS.BAD_REQUEST);
    }

    // Log the purge operation
    await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs (action, resource, uid, metadata)
       VALUES ('purge', $1, $2::uuid, $3::jsonb)`,
      record_type, purgedBy, JSON.stringify({ deleted_count: result.length, older_than_days })
    );

    success(res, {
      purged: result.length,
      record_type,
      older_than_days
    }, `${result.length} old records purged successfully`);
  } catch (err) {
    logger.error('Purge Records Error:', err);
    error(res, 'Failed to purge old records', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Helper functions for exports
async function exportAttendanceData(department, start_date, end_date) {
  const data = await prisma.$queryRawUnsafe(`
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
  `, start_date || null, end_date || null, ...(department ? [department] : []));

  // Convert to CSV format
  const headers = ['Employee ID', 'Name', 'Department', 'Date', 'Check In', 'Check Out', 'Hours Worked'];
  const rows = data.map(row => [
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

async function exportPerformanceData(_department, _start_date, _end_date) {
  // Similar implementation for performance data
  return 'Performance data export not yet implemented';
}

async function exportLeaveData(_department, _start_date, _end_date) {
  // Similar implementation for leave data
  return 'Leave data export not yet implemented';
}

async function exportPayrollData(_department, _start_date, _end_date) {
  // Similar implementation for payroll data
  return 'Payroll data export not yet implemented';
}
