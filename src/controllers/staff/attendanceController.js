import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as attendanceService from '../../services/staff/attendanceService.js';
import { success, error } from '../../utils/responseHelper.js';
import db from '../../config/database.js';

export const markAttendance = async (req, res) => {
  try {
    const markedBy = req.user?.uid;
    const markerRole = req.user?.role;
    const markerName = req.user?.name;
    
    const result = await attendanceService.markAttendance(
      req.body,
      markedBy,
      markerRole,
      markerName
    );
    
    success(res, result, `Attendance ${result.action} recorded successfully`);
  } catch (err) {
    logger.error('Mark Attendance Error:', err);
    
    if (err.message === 'INSUFFICIENT_PERMISSIONS') {
      error(res, 'Insufficient permissions to mark attendance', HTTP_STATUS.FORBIDDEN);
    } else if (err.message === 'STAFF_NOT_FOUND') {
      error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    } else if (err.message?.startsWith('OUTSIDE_CAMPUS:')) {
      error(res, err.message.replace('OUTSIDE_CAMPUS:', ''), HTTP_STATUS.FORBIDDEN);
    } else {
      error(res, 'Failed to record attendance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

export const getStaffAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.uid;
    const userRole = req.user?.role;
    const { days = 30, start_date, end_date } = req.query;

    const result = await attendanceService.getStaffAttendance(
      id,
      { days, start_date, end_date },
      userRole,
      userId
    );

    success(res, result, 'Attendance records fetched');
  } catch (err) {
    logger.error('Get Staff Attendance Error:', err);
    if (err.message === 'STAFF_NOT_FOUND') {
      error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    } else if (err.message === 'INSUFFICIENT_PERMISSIONS') {
      error(res, 'Access denied', HTTP_STATUS.FORBIDDEN);
    } else {
      error(res, 'Failed to fetch attendance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

export const getAttendanceCalendar = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const startDate = `${y}-${String(m).padStart(2,'0')}-01`;
    const endDate = new Date(y, m, 0).toISOString().split('T')[0];

    const [attendance, leaves] = await Promise.all([
      db.query(`SELECT DATE(check_in_time) as date, check_in_time, check_out_time,
        EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600 as hours_worked,
        CASE WHEN EXTRACT(HOUR FROM check_in_time) > 9 OR 
             (EXTRACT(HOUR FROM check_in_time) = 9 AND EXTRACT(MINUTE FROM check_in_time) > 15)
             THEN true ELSE false END as is_late
        FROM staff_attendance WHERE staff_id = $1 AND DATE(check_in_time) BETWEEN $2 AND $3`,
        [id, startDate, endDate]),
      db.query(`SELECT DATE(start_date) as start_date, DATE(end_date) as end_date, leave_type, status
        FROM leave_applications WHERE staff_id = $1 AND status = 'approved'
        AND start_date <= $3 AND end_date >= $2`, [id, startDate, endDate])
        .catch(() => ({ rows: [] }))
    ]);

    // Build day-by-day map
    const attendanceMap = {};
    for (const row of attendance.rows) {
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date);
      attendanceMap[dateStr] = {
        status: 'present',
        checkIn: row.check_in_time,
        checkOut: row.check_out_time,
        hoursWorked: parseFloat(row.hours_worked || 0).toFixed(1),
        isLate: row.is_late,
      };
    }
    
    // Mark leave days
    for (const leave of leaves.rows) {
      let d = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      while (d <= end) {
        const dateStr = d.toISOString().split('T')[0];
        if (!attendanceMap[dateStr]) {
          attendanceMap[dateStr] = { status: 'leave', leaveType: leave.leave_type };
        }
        d.setDate(d.getDate() + 1);
      }
    }

    // Fill remaining working days as absent
    const days = [];
    let current = new Date(startDate);
    const endDt = new Date(endDate);
    while (current <= endDt) {
      const dateStr = current.toISOString().split('T')[0];
      const dayOfWeek = current.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        days.push({
          date: dateStr,
          ...(attendanceMap[dateStr] || { status: 'absent' })
        });
      } else {
        days.push({ date: dateStr, status: 'weekend' });
      }
      current.setDate(current.getDate() + 1);
    }

    const present = days.filter(d => d.status === 'present').length;
    const absent = days.filter(d => d.status === 'absent').length;
    const leave = days.filter(d => d.status === 'leave').length;

    success(res, { month: m, year: y, days, summary: { present, absent, leave } }, 'Attendance calendar fetched');
  } catch (err) {
    logger.error('Get Attendance Calendar Error:', err);
    error(res, 'Failed to fetch attendance calendar', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const requestRegularization = async (req, res) => {
  try {
    const { id } = req.params;
    const { date, reason, check_in_time, check_out_time } = req.body;

    if (!date || !reason) {
      return error(res, 'date and reason are required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await db.query(`
      INSERT INTO attendance_regularization (staff_id, date, reason, requested_check_in, requested_check_out, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      ON CONFLICT (staff_id, date) DO UPDATE SET reason=$3, requested_check_in=$4, requested_check_out=$5, status='pending', created_at=NOW()
      RETURNING *
    `, [id, date, reason, check_in_time || null, check_out_time || null]);

    success(res, result.rows[0], 'Regularization request submitted');
  } catch (err) {
    logger.error('Regularization Error:', err);
    error(res, 'Failed to submit regularization request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
