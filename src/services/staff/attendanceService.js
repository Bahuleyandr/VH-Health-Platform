import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { calculateWorkingHours } from '../../utils/staff/attendanceCalculator.js';
import { getStaffShift, classifyAttendance, calculateOvertime } from './shiftService.js';

const CAMPUS_CONFIG = {
  latitude: 13.02936,  // Venkataeswara Hospitals, Nandanam, Chennai
  longitude: 80.24409,
  radiusMeters: 200,
  wifiSSIDs: ['VHHealth-Staff', 'VHHealth-Internal'],
};

function isWithinCampus(location) {
  if (!location) return { valid: false, reason: 'No location provided' };
  if (location.wifiSSID && CAMPUS_CONFIG.wifiSSIDs.includes(location.wifiSSID)) {
    return { valid: true, method: 'wifi', ssid: location.wifiSSID };
  }
  if (location.latitude && location.longitude) {
    const R = 6371000;
    const lat1 = CAMPUS_CONFIG.latitude * Math.PI / 180;
    const lat2 = location.latitude * Math.PI / 180;
    const dLat = (location.latitude - CAMPUS_CONFIG.latitude) * Math.PI / 180;
    const dLon = (location.longitude - CAMPUS_CONFIG.longitude) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    if (distance <= CAMPUS_CONFIG.radiusMeters) {
      return { valid: true, method: 'gps', distanceMeters: Math.round(distance) };
    }
    return { valid: false, reason: `Outside campus (${Math.round(distance)}m away)`, distanceMeters: Math.round(distance) };
  }
  return { valid: false, reason: 'No GPS or WiFi data' };
}

export const markAttendance = async (data, markedBy, markerRole, markerName) => {
  const { 
    staff_id, check_in_time, check_out_time, 
    location, notes, break_duration_minutes = 0,
    attendance_type = 'regular'
  } = data;

  // Verify permission to mark attendance
  const canMarkAttendance = ['ADMIN', 'HR_STAFF'].includes(markerRole) || 
                           parseInt(staff_id) === markedBy;

  if (!canMarkAttendance) {
    throw new Error('INSUFFICIENT_PERMISSIONS');
  }

  // Verify staff member exists
  const staffCheck = await prisma.$queryRawUnsafe(
    'SELECT u.id, u.name, s.shift, s.department FROM users u JOIN staff s ON u.id = s.user_id WHERE u.id = $1',
    [staff_id]
  );

  if (staffCheck.length === 0) {
    throw new Error('STAFF_NOT_FOUND');
  }

  const staff = staffCheck[0];

  // Check if attendance already exists for today
  const today = new Date().toISOString().split('T')[0];
  const existingAttendance = await prisma.$queryRawUnsafe(
    'SELECT id FROM staff_attendance WHERE staff_id = $1 AND DATE(check_in_time) = $2',
    [staff_id, today]
  );

  // Enforce geofence on check-in (not check-out to avoid getting stuck)
  if (!check_out_time && existingAttendance.length === 0) {
    const locationCheck = isWithinCampus(location);
    if (!locationCheck.valid && process.env.ENFORCE_GEOFENCE !== 'false') {
      throw new Error(`OUTSIDE_CAMPUS:${locationCheck.reason}`);
    }
  }

  let result;
  if (existingAttendance.length > 0) {
    // Update existing attendance
    result = await prisma.$queryRawUnsafe(`
      UPDATE staff_attendance SET
        check_out_time = COALESCE($1, check_out_time),
        location = COALESCE($2, location),
        notes = COALESCE($3, notes),
        break_duration_minutes = COALESCE($4, break_duration_minutes),
        updated_by = $5,
        updated_at = NOW()
      WHERE staff_id = $6 AND DATE(check_in_time) = $7
      RETURNING id, staff_id, check_in_time, check_out_time, status, location, created_at
    `, [
      check_out_time, 
      location ? JSON.stringify(location) : null, 
      notes, 
      break_duration_minutes, 
      markedBy, 
      staff_id, 
      today
    ]);
  } else {
    // Create new attendance record
    result = await prisma.$queryRawUnsafe(`
      INSERT INTO staff_attendance (
        staff_id, check_in_time, check_out_time, location,
        notes, break_duration_minutes, attendance_type, marked_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id, staff_id, check_in_time, check_out_time, status, location, created_at
    `, [
      staff_id, 
      check_in_time || new Date(),
      check_out_time,
      location ? JSON.stringify(location) : null,
      notes, 
      break_duration_minutes, 
      attendance_type, 
      markedBy
    ]);
  }

  // Update staff's last check-in/out times
  await prisma.$queryRawUnsafe(`
    UPDATE staff SET 
      last_check_in = CASE WHEN $1 IS NOT NULL THEN $1 ELSE last_check_in END,
      last_check_out = CASE WHEN $2 IS NOT NULL THEN $2 ELSE last_check_out END
    WHERE user_id = $3
  `, [check_in_time, check_out_time, staff_id]);

  // Calculate working hours if both times are provided
  let hoursWorked = 0;
  if (result[0].check_in_time && result[0].check_out_time) {
    hoursWorked = calculateWorkingHours(
      result[0].check_in_time, 
      result[0].check_out_time,
      break_duration_minutes
    );
  }

  // Enrich with shift classification
  const shift = await getStaffShift(staff_id);
  if (shift && result[0]) {
    const classification = classifyAttendance(shift, result[0].check_in_time);
    const overtime = result[0].check_out_time
      ? calculateOvertime(shift, result[0].check_in_time, result[0].check_out_time)
      : 0;

    // Update record with classification
    await prisma.$queryRawUnsafe(`
      UPDATE staff_attendance SET attendance_status=$1, minutes_late=$2, overtime_hours=$3
      WHERE id=$4
    `, [classification.status, classification.minutesLate, overtime, result[0].id])
      .catch(e => logger.warn('Attendance classification update failed (columns may not exist yet):', e.message));
  }

  // Log attendance activity
  await prisma.$queryRawUnsafe(
    `INSERT INTO attendance_logs (
      staff_id, action, marked_by, location, hours_worked, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      staff_id,
      check_out_time ? 'CHECK_OUT' : 'CHECK_IN',
      markedBy,
      location ? JSON.stringify(location) : null,
      hoursWorked
    ]
  );

  logger.info(`⏰ Attendance marked for ${staff.name} (${staff_id}) by ${markerName}: ${check_out_time ? 'CHECK_OUT' : 'CHECK_IN'}`);

  return {
    attendance: {
      ...result[0],
      check_in_time: result[0].check_in_time ? result[0].check_in_time.toLocaleString('en-IN') : null,
      check_out_time: result[0].check_out_time ? result[0].check_out_time.toLocaleString('en-IN') : null,
      hours_worked: hoursWorked,
      staff_name: staff.name,
      department: staff.department,
      shift: staff.shift
    },
    markedBy: markerName,
    action: check_out_time ? 'check_out' : 'check_in'
  };
};

export const getStaffAttendance = async (staffId, filters, userRole, userId) => {
  const { days, start_date, end_date } = filters;

  // Verify staff member exists
  const staffCheck = await prisma.$queryRawUnsafe(`
    SELECT u.uid, u.name, s.employee_id, s.department
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE u.id = $1
  `, [staffId]);

  if (staffCheck.length === 0) {
    throw new Error('STAFF_NOT_FOUND');
  }

  const staff = staffCheck[0];

  // Check access permissions
  const canViewAttendance = ['ADMIN', 'HR_STAFF', 'DOCTOR'].includes(userRole) || 
                           userId === staff.uid;

  if (!canViewAttendance) {
    throw new Error('INSUFFICIENT_PERMISSIONS');
  }

  // Build date filter
  let dateFilter;
  let dateParams;
  if (start_date && end_date) {
    dateFilter = 'AND check_in_time::date BETWEEN $2 AND $3';
    dateParams = [staffId, start_date, end_date];
  } else {
    dateFilter = `AND check_in_time >= CURRENT_DATE - INTERVAL '${days} days'`;
    dateParams = [staffId];
  }

  // Get attendance records
  const attendanceResult = await prisma.$queryRawUnsafe(`
    SELECT 
      DATE(check_in_time) as date,
      check_in_time, check_out_time,
      EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600 as hours_worked,
      status, location, notes,
      overtime_hours, break_duration_minutes
    FROM staff_attendance 
    WHERE staff_id = $1 ${dateFilter}
    ORDER BY check_in_time DESC
  `, dateParams);

  // Format attendance records
  const attendanceRecords = attendanceResult.map(record => ({
    ...record,
    date: record.date ? new Date(record.date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }) : null,
    check_in_time: record.check_in_time ? new Date(record.check_in_time).toLocaleString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) : null,
    check_out_time: record.check_out_time ? new Date(record.check_out_time).toLocaleString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) : null,
    hours_worked: record.hours_worked ? Math.round(record.hours_worked * 100) / 100 : null,
    overtime_hours: record.overtime_hours || 0,
    break_duration_minutes: record.break_duration_minutes || 0
  }));

  // Calculate statistics
  const stats = {
    total_days: attendanceRecords.length,
    total_hours: attendanceRecords.reduce((sum, record) => sum + (record.hours_worked || 0), 0),
    total_overtime: attendanceRecords.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
    average_hours_per_day: 0,
    attendance_rate: 0,
    punctuality_rate: 0
  };

  if (stats.total_days > 0) {
    stats.average_hours_per_day = Math.round((stats.total_hours / stats.total_days) * 100) / 100;
    
    // Calculate expected working days
    const periodStart = start_date ? new Date(start_date) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const periodEnd = end_date ? new Date(end_date) : new Date();
    const totalPossibleDays = Math.ceil((periodEnd - periodStart) / (24 * 60 * 60 * 1000));
    const expectedWorkingDays = Math.max(1, Math.floor(totalPossibleDays * 5/7)); // Assume 5-day work week
    
    stats.attendance_rate = Math.round((stats.total_days / expectedWorkingDays) * 100);
  }

  return {
    staffInfo: {
      id: parseInt(staffId),
      uid: staff.uid,
      name: staff.name,
      employee_id: staff.employee_id,
      department: staff.department
    },
    attendanceRecords,
    statistics: stats,
    period: {
      days: parseInt(days),
      start_date: start_date || null,
      end_date: end_date || null
    },
    accessLevel: userRole,
    dataAvailability: attendanceRecords.length > 0
  };
};