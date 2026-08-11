// src/routes/admin/services/attendanceService.js
import { tableExists, safeQuery } from './common.js';

/**
 * Attendance analytics over a period, optionally filtered by department.
 * Returns an array of { period, total_present, late_arrivals, early_departures, avg_hours_worked }.
 */
export async function getAttendanceAnalytics({
  department = null,
  startDate = null,
  endDate = null,
  groupBy = 'day',
} = {}) {
  const hasAttendance = await tableExists('staff_attendance');
  const hasStaff = await tableExists('staff');
  if (!hasAttendance || !hasStaff) {
    return {
      analytics: [],
      parameters: { department, start_date: startDate, end_date: endDate, group_by: groupBy },
    };
  }

  // Build dynamic SQL with optional department filter
  let sql = `
    SELECT 
      DATE_TRUNC($1, a.check_in_time) AS period,
      COUNT(DISTINCT a.staff_id)::int AS total_present,
      COUNT(DISTINCT a.staff_id) FILTER (WHERE a.check_in_time::time > '09:30:00')::int AS late_arrivals,
      COUNT(DISTINCT a.staff_id) FILTER (WHERE a.check_out_time::time < '17:00:00')::int AS early_departures,
      ROUND(AVG(EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600), 2)::float AS avg_hours_worked
    FROM staff_attendance a
    JOIN staff s ON a.staff_id = s.id
    WHERE
      a.check_in_time >= COALESCE($2::timestamp, CURRENT_DATE - INTERVAL '30 days')
      AND a.check_in_time <= COALESCE($3::timestamp, CURRENT_DATE)
  `;
  const params = [groupBy, startDate, endDate];
  if (department) {
    sql += ` AND s.department = $4`;
    params.push(department);
  }
  sql += ` GROUP BY period ORDER BY period DESC`;

  const rows = await safeQuery(sql, params, 'attendance.analytics');
  return {
    analytics: rows,
    parameters: { department, start_date: startDate, end_date: endDate, group_by: groupBy },
  };
}

/**
 * Returns staff with suspicious patterns (late >3 days, early leave >3 days, missing checkout >0).
 */
export async function getAttendanceAnomalies() {
  const hasAttendance = await tableExists('staff_attendance');
  const hasStaff = await tableExists('staff');
  if (!hasAttendance || !hasStaff) {
    return { anomalies: [], total: 0 };
  }

  const anomalies = await safeQuery(
    `
    WITH anomalies AS (
      SELECT 
        s.id,
        s.name,
        s.department,
        s.employee_id,
        COUNT(*) FILTER (WHERE a.check_in_time::time > '09:30:00')::int AS late_days,
        COUNT(*) FILTER (WHERE a.check_out_time::time < '17:00:00')::int AS early_leave_days,
        COUNT(*) FILTER (WHERE a.check_out_time IS NULL)::int AS missing_checkout_days
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
    SELECT id, name, department, employee_id, late_days, early_leave_days, missing_checkout_days FROM anomalies ORDER BY late_days DESC, early_leave_days DESC
    `,
    [],
    'attendance.anomalies'
  );

  return { anomalies, total: anomalies.length };
}

/**
 * List all staff who checked in late on a given date, optionally filtered by department.
 */
export async function getLateArrivals(date, department = null) {
  const hasAttendance = await tableExists('staff_attendance');
  const hasStaff = await tableExists('staff');
  if (!hasAttendance || !hasStaff) {
    return { date, lateArrivals: [], total: 0 };
  }

  const params = [date];
  let sql = `
    SELECT
      s.name,
      s.employee_id,
      s.department,
      a.check_in_time,
      (a.check_in_time::time - '09:30:00'::time)::text AS late_by
    FROM staff_attendance a
    JOIN staff s ON a.staff_id = s.id
    WHERE
      a.check_in_time::date = $1
      AND a.check_in_time::time > '09:30:00'
  `;
  if (department) {
    sql += ` AND s.department = $2`;
    params.push(department);
  }
  sql += ` ORDER BY a.check_in_time DESC`;

  const rows = await safeQuery(sql, params, 'attendance.lateArrivals');
  return { date, lateArrivals: rows, total: rows.length };
}

/**
 * List all staff who left early on a given date, optionally filtered by department.
 */
export async function getEarlyDepartures(date, department = null) {
  const hasAttendance = await tableExists('staff_attendance');
  const hasStaff = await tableExists('staff');
  if (!hasAttendance || !hasStaff) {
    return { date, earlyDepartures: [], total: 0 };
  }

  const params = [date];
  let sql = `
    SELECT
      s.name,
      s.employee_id,
      s.department,
      a.check_out_time,
      ('17:00:00'::time - a.check_out_time::time)::text AS left_early_by
    FROM staff_attendance a
    JOIN staff s ON a.staff_id = s.id
    WHERE
      a.check_out_time::date = $1
      AND a.check_out_time::time < '17:00:00'
  `;
  if (department) {
    sql += ` AND s.department = $2`;
    params.push(department);
  }
  sql += ` ORDER BY a.check_out_time`;

  const rows = await safeQuery(sql, params, 'attendance.earlyDepartures');
  return { date, earlyDepartures: rows, total: rows.length };
}

/**
 * Report staff who have not checked in on a given date and are not on approved leave.
 */
export async function getAbsentReport(date, department = null) {
  const hasStaff = await tableExists('staff');
  if (!hasStaff) {
    return { date, absentStaff: [], total: 0 };
  }

  const params = [date];
  let sql = `
    SELECT
      s.name,
      s.employee_id,
      s.department,
      u.phone,
      CASE
        WHEN la.id IS NOT NULL THEN 'On Leave'
        ELSE 'Absent Without Notice'
      END AS status
    FROM staff s
    LEFT JOIN users u
      ON u.uid = s.user_id
    LEFT JOIN staff_attendance a
      ON s.id = a.staff_id
      AND a.check_in_time::date = $1
    LEFT JOIN leave_applications la
      ON s.id = la.staff_id
      AND la.status = 'approved'
      AND $1 BETWEEN la.start_date AND la.end_date
    WHERE
      s.is_active = true
      AND a.id IS NULL
  `;
  if (department) {
    sql += ` AND s.department = $2`;
    params.push(department);
  }
  sql += ` ORDER BY s.department, s.name`;

  const rows = await safeQuery(sql, params, 'attendance.absentReport');
  return { date, absentStaff: rows, total: rows.length };
}

export default {
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
};
