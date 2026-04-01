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
      RETURNING id, staff_id, date, reason, requested_check_in, requested_check_out, status, created_at
    `, [id, date, reason, check_in_time || null, check_out_time || null]);

    success(res, result.rows[0], 'Regularization request submitted');
  } catch (err) {
    logger.error('Regularization Error:', err);
    error(res, 'Failed to submit regularization request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ===== BREAK TRACKING =====

/**
 * Start a break for current staff member
 */
export const startBreak = async (req, res) => {
  try {
    const staffId = req.user?.uid || req.params.id;

    // Find today's active attendance record
    const today = new Date().toISOString().split('T')[0];
    const att = await db.query(
      `SELECT id FROM staff_attendance WHERE staff_id=$1 AND DATE(check_in_time)=$2 AND check_out_time IS NULL`,
      [staffId, today]
    );

    if (att.rows.length === 0) {
      return error(res, 'No active check-in found', HTTP_STATUS.BAD_REQUEST);
    }

    // Check no open break exists
    const openBreak = await db.query(
      `SELECT id FROM staff_breaks WHERE staff_id=$1 AND break_end IS NULL`,
      [staffId]
    );

    if (openBreak.rows.length > 0) {
      return error(res, 'Break already in progress', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await db.query(`
      INSERT INTO staff_breaks (attendance_id, staff_id, break_start) VALUES ($1, $2, NOW()) RETURNING id, attendance_id, staff_id, break_start, break_end, duration_minutes
    `, [att.rows[0].id, staffId]);

    success(res, result.rows[0], 'Break started');
  } catch (err) {
    logger.error('Start Break Error:', err);
    error(res, 'Failed to start break', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * End a break for current staff member
 */
export const endBreak = async (req, res) => {
  try {
    const staffId = req.user?.uid || req.params.id;

    const openBreak = await db.query(
      `SELECT id, break_start FROM staff_breaks WHERE staff_id=$1 AND break_end IS NULL`,
      [staffId]
    );

    if (openBreak.rows.length === 0) {
      return error(res, 'No active break', HTTP_STATUS.BAD_REQUEST);
    }

    const breakId = openBreak.rows[0].id;
    const result = await db.query(`
      UPDATE staff_breaks SET break_end=NOW(),
        duration_minutes=EXTRACT(EPOCH FROM (NOW() - break_start))/60
      WHERE id=$1 RETURNING id, attendance_id, staff_id, break_start, break_end, duration_minutes
    `, [breakId]);

    success(res, result.rows[0], `Break ended — ${Math.round(result.rows[0].duration_minutes)} minutes`);
  } catch (err) {
    logger.error('End Break Error:', err);
    error(res, 'Failed to end break', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get today's breaks for current staff member
 */
export const getTodayBreaks = async (req, res) => {
  try {
    const staffId = req.user?.uid || req.params.id;
    const today = new Date().toISOString().split('T')[0];

    const breaks = await db.query(`
      SELECT b.*,
        COALESCE(b.duration_minutes, EXTRACT(EPOCH FROM (NOW() - b.break_start))/60) as duration_minutes_calc
      FROM staff_breaks b
      WHERE b.staff_id=$1 AND DATE(b.break_start)=$2
      ORDER BY b.break_start
    `, [staffId, today]);

    const totalBreakMinutes = breaks.rows.reduce((sum, b) => sum + parseFloat(b.duration_minutes_calc || 0), 0);
    success(res, { breaks: breaks.rows, totalBreakMinutes: Math.round(totalBreakMinutes) }, 'Breaks fetched');
  } catch (err) {
    logger.error('Get Breaks Error:', err);
    error(res, 'Failed to fetch breaks', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ===== ATTENDANCE DISPUTES =====

/**
 * Submit an attendance dispute
 */
export const submitDispute = async (req, res) => {
  try {
    const staffId = req.user?.uid || req.params.id;
    const { date, dispute_type, description, requested_check_in, requested_check_out, evidence_url } = req.body;

    if (!date || !dispute_type || !description) {
      return error(res, 'date, dispute_type, and description are required', HTTP_STATUS.BAD_REQUEST);
    }

    const validTypes = ['missed_checkin', 'missed_checkout', 'wrong_time', 'app_failure', 'other'];
    if (!validTypes.includes(dispute_type)) {
      return error(res, `dispute_type must be one of: ${validTypes.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }

    const result = await db.query(`
      INSERT INTO attendance_disputes (staff_id, date, dispute_type, description, requested_check_in, requested_check_out, evidence_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (staff_id, date) DO UPDATE SET dispute_type=$3, description=$4, requested_check_in=$5, requested_check_out=$6, evidence_url=$7, status='pending', created_at=NOW()
      RETURNING id, staff_uid, dispute_date, reason, status, resolution, created_at
    `, [staffId, date, dispute_type, description, requested_check_in || null, requested_check_out || null, evidence_url || null]);

    success(res, result.rows[0], 'Dispute submitted. HR will review within 24 hours.');
  } catch (err) {
    logger.error('Submit Dispute Error:', err);
    error(res, 'Failed to submit dispute', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get my disputes
 */
export const getMyDisputes = async (req, res) => {
  try {
    const staffId = req.user?.uid || req.params.id;
    const disputes = await db.query(`
      SELECT d.id, d.staff_uid, d.dispute_date, d.reason, d.status, d.resolution, d.resolved_by, d.created_at,
        u.name as reviewer_name
      FROM attendance_disputes d
      LEFT JOIN users u ON d.reviewed_by = u.id
      WHERE d.staff_id = $1 ORDER BY d.date DESC LIMIT 30
    `, [staffId]);

    success(res, disputes.rows, 'Disputes fetched');
  } catch (err) {
    logger.error('Get Disputes Error:', err);
    error(res, 'Failed to fetch disputes', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get all pending disputes (Admin/HR only)
 */
export const getPendingDisputes = async (req, res) => {
  try {
    const disputes = await db.query(`
      SELECT d.id, d.staff_uid, d.dispute_date, d.reason, d.status, d.resolution, d.resolved_by, d.created_at,
        u.name as staff_name, u.employee_id, s.department
      FROM attendance_disputes d
      JOIN users u ON d.staff_id = u.id
      LEFT JOIN staff s ON u.id = s.user_id
      WHERE d.status = 'pending' ORDER BY d.date DESC
    `);

    success(res, disputes.rows, 'Pending disputes fetched');
  } catch (err) {
    logger.error('Get Pending Disputes Error:', err);
    error(res, 'Failed to fetch disputes', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Resolve a dispute (HR/Admin only)
 */
export const resolveDispute = async (req, res) => {
  try {
    const { id } = req.params;
    const reviewerId = req.user?.uid;
    const { status, reviewer_comment, apply_correction } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return error(res, 'status must be approved or rejected', HTTP_STATUS.BAD_REQUEST);
    }

    const dispute = await db.query('SELECT id, staff_uid, dispute_date, reason, status, resolution, resolved_by, created_at FROM attendance_disputes WHERE id=$1', [id]);
    if (dispute.rows.length === 0) return error(res, 'Dispute not found', HTTP_STATUS.NOT_FOUND);

    const d = dispute.rows[0];

    // If approved and correction requested, update attendance record
    if (status === 'approved' && apply_correction !== false) {
      if (d.requested_check_in || d.requested_check_out) {
        const existingAtt = await db.query(
          `SELECT id FROM staff_attendance WHERE staff_id=$1 AND DATE(check_in_time)=$2`,
          [d.staff_id, d.date]
        );

        if (existingAtt.rows.length > 0) {
          const updates = [];
          const vals = [];
          let idx = 1;

          if (d.requested_check_in) {
            updates.push(`check_in_time=$${idx++}`);
            vals.push(d.requested_check_in);
          }
          if (d.requested_check_out) {
            updates.push(`check_out_time=$${idx++}`);
            vals.push(d.requested_check_out);
          }

          vals.push(existingAtt.rows[0].id);
          if (updates.length) {
            await db.query(`UPDATE staff_attendance SET ${updates.join(', ')} WHERE id=$${idx}`, vals);
          }
        } else if (d.requested_check_in) {
          await db.query(
            `INSERT INTO staff_attendance (staff_id, check_in_time, check_out_time) VALUES ($1, $2, $3)`,
            [d.staff_id, d.requested_check_in, d.requested_check_out || null]
          );
        }
      }
    }

    const result = await db.query(`
      UPDATE attendance_disputes SET status=$1, reviewer_comment=$2, reviewed_by=$3, reviewed_at=NOW()
      WHERE id=$4 RETURNING id, staff_uid, dispute_date, reason, status, resolution, created_at
    `, [status, reviewer_comment || null, reviewerId, id]);

    success(res, result.rows[0], `Dispute ${status}`);
  } catch (err) {
    logger.error('Resolve Dispute Error:', err);
    error(res, 'Failed to resolve dispute', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get geofence breaches (Admin/HR only)
 */
export const getGeofenceBreaches = async (req, res) => {
  try {
    const { limit = 50, staff_id } = req.query;
    const whereClause = staff_id ? 'WHERE gb.staff_id = $2' : '';
    const params = staff_id ? [parseInt(limit), staff_id] : [parseInt(limit)];

    const breaches = await db.query(`
      SELECT gb.*, u.name as staff_name FROM geofence_breaches gb
      JOIN users u ON gb.staff_id = u.id
      ${whereClause}
      ORDER BY gb.occurred_at DESC LIMIT $1
    `, params);

    success(res, breaches.rows, 'Geofence breaches fetched');
  } catch (err) {
    logger.error('Get Breaches Error:', err);
    error(res, 'Failed to fetch breaches', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
