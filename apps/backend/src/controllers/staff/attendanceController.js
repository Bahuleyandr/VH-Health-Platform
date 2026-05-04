import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as attendanceService from '../../services/staff/attendanceService.js';
import { success, error } from '../../utils/responseHelper.js';

async function resolveStaffRef(req) {
  if (req.user?.uid) {
    const user = await prisma.users.findUnique({
      where: { uid: req.user.uid },
      select: { id: true, uid: true },
    });
    if (user) return user;
  }

  const staffId = Number.parseInt(req.params.id, 10);
  if (Number.isInteger(staffId) && staffId > 0) {
    return prisma.users.findUnique({
      where: { id: staffId },
      select: { id: true, uid: true },
    });
  }

  return null;
}

async function resolveCurrentUserRef(req) {
  if (!req.user?.uid) return null;
  return prisma.users.findUnique({
    where: { uid: req.user.uid },
    select: { id: true, uid: true },
  });
}

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
    const staffId = Number.parseInt(id, 10);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return error(res, 'Valid staff id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const endDate = new Date(y, m, 0).toISOString().split('T')[0];
    const startDateObj = new Date(`${startDate}T00:00:00.000Z`);
    const endDateExclusive = new Date(Date.UTC(y, m, 1));
    const endDateObj = new Date(`${endDate}T23:59:59.999Z`);

    const attendance = await prisma.staff_attendance.findMany({
      where: {
        staff_id: staffId,
        check_in_time: {
          gte: startDateObj,
          lt: endDateExclusive,
        },
      },
      select: {
        check_in_time: true,
        check_out_time: true,
      },
      orderBy: { check_in_time: 'asc' },
    });

    let leaves = [];
    try {
      leaves = await prisma.leave_applications.findMany({
        where: {
          staff_id: staffId,
          status: 'approved',
          start_date: { lte: endDateObj },
          end_date: { gte: startDateObj },
        },
        select: {
          start_date: true,
          end_date: true,
          leave_type: true,
        },
      });
    } catch (leaveErr) {
      logger.warn('Attendance calendar leave overlay skipped:', leaveErr);
    }

    // Build day-by-day map
    const attendanceMap = {};
    for (const row of attendance) {
      const dateStr = row.check_in_time.toISOString().split('T')[0];
      const hoursWorked = row.check_in_time && row.check_out_time
        ? (row.check_out_time.getTime() - row.check_in_time.getTime()) / 3_600_000
        : 0;
      const checkInHour = row.check_in_time.getUTCHours();
      const checkInMinute = row.check_in_time.getUTCMinutes();
      attendanceMap[dateStr] = {
        status: 'present',
        checkIn: row.check_in_time,
        checkOut: row.check_out_time,
        hoursWorked: hoursWorked.toFixed(1),
        isLate: checkInHour > 9 || (checkInHour === 9 && checkInMinute > 15),
      };
    }
    
    // Mark leave days
    for (const leave of leaves) {
      const d = new Date(leave.start_date);
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
    const current = new Date(startDate);
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
    const staffId = Number.parseInt(id, 10);
    const { date, reason, check_in_time, check_out_time } = req.body;

    if (!Number.isInteger(staffId) || staffId <= 0) {
      return error(res, 'Invalid staff id', HTTP_STATUS.BAD_REQUEST);
    }
    if (!date || !reason) {
      return error(res, 'date and reason are required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO attendance_regularization (staff_id, date, reason, requested_check_in, requested_check_out, status, created_at)
      VALUES ($1::int, $2::date, $3, $4::timestamptz, $5::timestamptz, 'pending', NOW())
      ON CONFLICT (staff_id, date) DO UPDATE SET reason=$3, requested_check_in=$4, requested_check_out=$5, status='pending', created_at=NOW()
      RETURNING id, staff_id, date, reason, requested_check_in, requested_check_out, status, created_at
    `, staffId, date, reason, check_in_time || null, check_out_time || null);

    success(res, result[0], 'Regularization request submitted');
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
    const staff = await resolveStaffRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    // Find today's active attendance record
    const today = new Date().toISOString().split('T')[0];
    const att = await prisma.$queryRawUnsafe(
      `SELECT id FROM staff_attendance WHERE staff_id=$1 AND DATE(check_in_time)=$2::date AND check_out_time IS NULL`,
      staff.id, today
    );

    if (att.length === 0) {
      return error(res, 'No active check-in found', HTTP_STATUS.BAD_REQUEST);
    }

    // Check no open break exists
    const openBreak = await prisma.$queryRawUnsafe(
      `SELECT id FROM staff_breaks WHERE staff_id=$1 AND break_end IS NULL`, staff.id);

    if (openBreak.length > 0) {
      return error(res, 'Break already in progress', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO staff_breaks (attendance_id, staff_id, staff_uid, break_start)
      VALUES ($1, $2, $3::uuid, NOW())
      RETURNING id, attendance_id, staff_id, staff_uid, break_start, break_end, duration_minutes
    `, att[0].id, staff.id, staff.uid);

    success(res, result[0], 'Break started');
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
    const staff = await resolveStaffRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    const openBreak = await prisma.$queryRawUnsafe(
      `SELECT id, break_start FROM staff_breaks WHERE staff_id=$1 AND break_end IS NULL`, staff.id);

    if (openBreak.length === 0) {
      return error(res, 'No active break', HTTP_STATUS.BAD_REQUEST);
    }

    const breakId = openBreak[0].id;
    const result = await prisma.$queryRawUnsafe(`
      UPDATE staff_breaks SET break_end=NOW(),
        duration_minutes=EXTRACT(EPOCH FROM (NOW() - break_start))/60
      WHERE id=$1 RETURNING id, attendance_id, staff_id, staff_uid, break_start, break_end, duration_minutes
    `, breakId);

    success(res, result[0], `Break ended — ${Math.round(result[0].duration_minutes)} minutes`);
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
    const staff = await resolveStaffRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const today = new Date().toISOString().split('T')[0];

    const breaks = await prisma.$queryRawUnsafe(`
      SELECT b.*,
        COALESCE(b.duration_minutes, EXTRACT(EPOCH FROM (NOW() - b.break_start))/60) as duration_minutes_calc
      FROM staff_breaks b
      WHERE b.staff_id=$1 AND DATE(b.break_start)=$2::date
      ORDER BY b.break_start
    `, staff.id, today);

    const totalBreakMinutes = breaks.reduce((sum, b) => sum + parseFloat(b.duration_minutes_calc || 0), 0);
    success(res, { breaks: breaks, totalBreakMinutes: Math.round(totalBreakMinutes) }, 'Breaks fetched');
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
    const staff = await resolveStaffRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const { date, dispute_type, description, requested_check_in, requested_check_out, evidence_url } = req.body;

    if (!date || !dispute_type || !description) {
      return error(res, 'date, dispute_type, and description are required', HTTP_STATUS.BAD_REQUEST);
    }

    const validTypes = ['missed_checkin', 'missed_checkout', 'wrong_time', 'app_failure', 'other'];
    if (!validTypes.includes(dispute_type)) {
      return error(res, `dispute_type must be one of: ${validTypes.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO attendance_disputes
        (staff_id, staff_uid, dispute_date, dispute_type, reason, requested_check_in, requested_check_out, evidence_url)
      VALUES ($1, $2::uuid, $3::date, $4, $5, $6::timestamptz, $7::timestamptz, $8)
      ON CONFLICT (staff_id, dispute_date) DO UPDATE SET
        dispute_type=$4,
        reason=$5,
        requested_check_in=$6::timestamptz,
        requested_check_out=$7::timestamptz,
        evidence_url=$8,
        status='pending',
        resolution=NULL,
        reviewer_comment=NULL,
        reviewed_by=NULL,
        reviewed_by_uid=NULL,
        reviewed_at=NULL,
        updated_at=NOW()
      RETURNING id, staff_id, staff_uid, dispute_date, dispute_type, reason,
        requested_check_in, requested_check_out, evidence_url, status, resolution, created_at
    `, staff.id, staff.uid, date, dispute_type, description, requested_check_in || null, requested_check_out || null, evidence_url || null);

    success(res, result[0], 'Dispute submitted. HR will review within 24 hours.');
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
    const staff = await resolveStaffRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const disputes = await prisma.$queryRawUnsafe(`
      SELECT d.id, d.staff_id, d.staff_uid, d.dispute_date, d.dispute_type, d.reason,
        d.requested_check_in, d.requested_check_out, d.evidence_url,
        d.status, d.resolution, d.reviewer_comment, d.reviewed_by, d.reviewed_at,
        u.name as reviewer_name
      FROM attendance_disputes d
      LEFT JOIN users u ON d.reviewed_by = u.id
      WHERE d.staff_id = $1 ORDER BY d.dispute_date DESC LIMIT 30
    `, staff.id);

    success(res, disputes, 'Disputes fetched');
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
    const disputes = await prisma.$queryRawUnsafe(`
      SELECT d.id, d.staff_id, d.staff_uid, d.dispute_date, d.dispute_type, d.reason,
        d.requested_check_in, d.requested_check_out, d.evidence_url,
        d.status, d.resolution, d.reviewer_comment, d.reviewed_by, d.reviewed_at,
        u.name as staff_name, s.employee_id, s.department
      FROM attendance_disputes d
      JOIN users u ON d.staff_id = u.id
      LEFT JOIN staff s ON u.uid = s.user_id
      WHERE d.status = 'pending' ORDER BY d.dispute_date DESC
    `);

    success(res, disputes, 'Pending disputes fetched');
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
    const reviewer = await resolveCurrentUserRef(req);
    if (!reviewer) {
      return error(res, 'Reviewer not found', HTTP_STATUS.NOT_FOUND);
    }
    const { status, reviewer_comment, apply_correction } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return error(res, 'status must be approved or rejected', HTTP_STATUS.BAD_REQUEST);
    }

    const dispute = await prisma.$queryRawUnsafe(`
      SELECT id, staff_id, staff_uid, dispute_date, dispute_type, reason,
        requested_check_in, requested_check_out, status, resolution, reviewed_by, created_at
      FROM attendance_disputes
      WHERE id=$1::int
    `, id);
    if (dispute.length === 0) return error(res, 'Dispute not found', HTTP_STATUS.NOT_FOUND);

    const d = dispute[0];

    // If approved and correction requested, update attendance record
    if (status === 'approved' && apply_correction !== false) {
      if (d.requested_check_in || d.requested_check_out) {
        const existingAtt = await prisma.$queryRawUnsafe(
          `SELECT id FROM staff_attendance WHERE staff_id=$1 AND DATE(check_in_time)=$2::date`,
          d.staff_id, d.dispute_date
        );

        if (existingAtt.length > 0) {
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

          vals.push(existingAtt[0].id);
          if (updates.length) {
            await prisma.$queryRawUnsafe(`UPDATE staff_attendance SET ${updates.join(', ')} WHERE id=$${idx}`, ...vals);
          }
        } else if (d.requested_check_in) {
          await prisma.$queryRawUnsafe(
            `INSERT INTO staff_attendance (staff_id, staff_uid, check_in_time, check_out_time) VALUES ($1, $2::uuid, $3, $4)`,
            d.staff_id, d.staff_uid, d.requested_check_in, d.requested_check_out || null
          );
        }
      }
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE attendance_disputes
      SET status=$1,
        reviewer_comment=$2,
        reviewed_by=$3,
        reviewed_by_uid=$4::uuid,
        reviewed_at=NOW(),
        resolved_by=$3,
        resolution=COALESCE($2, resolution),
        updated_at=NOW()
      WHERE id=$5::int
      RETURNING id, staff_id, staff_uid, dispute_date, dispute_type, reason,
        requested_check_in, requested_check_out, evidence_url,
        status, resolution, reviewer_comment, reviewed_by, reviewed_at, created_at
    `, status, reviewer_comment || null, reviewer.id, reviewer.uid, id);

    success(res, result[0], `Dispute ${status}`);
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
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const whereClause = staff_id ? 'WHERE gb.staff_id = $2::int' : '';
    const params = staff_id ? [safeLimit, Number(staff_id)] : [safeLimit];

    const breaches = await prisma.$queryRawUnsafe(`
      SELECT gb.*, u.name as staff_name FROM geofence_breaches gb
      JOIN users u ON gb.staff_id = u.id
      ${whereClause}
      ORDER BY gb.occurred_at DESC LIMIT $1::int
    `, ...params);

    success(res, breaches, 'Geofence breaches fetched');
  } catch (err) {
    logger.error('Get Breaches Error:', err);
    error(res, 'Failed to fetch breaches', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
