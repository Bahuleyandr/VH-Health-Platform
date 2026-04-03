// src/controllers/staff/staffAdminAttendanceController.js
import prisma from '../../lib/prisma.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// Attendance Analytics
export const getAttendanceAnalytics = async (req, res) => {
  try {
    const { department, start_date, end_date, group_by = 'day' } = req.query;
    
    const analytics = await prisma.$queryRawUnsafe(`
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

// Attendance Anomalies
export const getAttendanceAnomalies = async (req, res) => {
  try {
    const anomalies = await prisma.$queryRawUnsafe(`
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
      SELECT staff_uid, name, late_days, early_leave_days, absent_days FROM anomalies ORDER BY late_days DESC, early_leave_days DESC
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
    
    const lateArrivals = await prisma.$queryRawUnsafe(`
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
    
    const earlyDepartures = await prisma.$queryRawUnsafe(`
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
    
    const absentStaff = await prisma.$queryRawUnsafe(`
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

// Bulk Attendance Correction
export const bulkAttendanceCorrection = async (req, res) => {
  try {
    const { corrections } = req.body; // Array of {staff_id, date, check_in, check_out}
    const correctedBy = req.user?.uid;

    const results = await Promise.all(
      corrections.map(async (correction) => {
        try {
          await prisma.$queryRawUnsafe(`
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
          logger.error(`Bulk attendance correction failed for staff ${correction.staff_id}:`, err);
          return { staff_id: correction.staff_id, status: 'failed', error: 'Failed to process correction' };
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

// Override Attendance
export const overrideAttendance = async (req, res) => {
  try {
    const { staff_id, date, check_in, check_out, reason } = req.body;
    const overriddenBy = req.user?.uid;

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO staff_attendance (staff_id, check_in_time, check_out_time, override_reason, overridden_by, created_by)
      VALUES ($1, $2, $3, $4, $5, $5)
      ON CONFLICT (staff_id, check_in_time::date)
      DO UPDATE SET 
        check_in_time = $2,
        check_out_time = $3,
        override_reason = $4,
        overridden_by = $5,
        updated_at = NOW()
      RETURNING id, staff_uid, check_in_time, check_out_time, status, created_at
    `, [staff_id, check_in, check_out, reason, overriddenBy]);

    success(res, result[0], 'Attendance override successful');
  } catch (err) {
    logger.error('Override Attendance Error:', err);
    error(res, 'Failed to override attendance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
