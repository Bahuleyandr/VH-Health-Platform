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

// Compute server-local day bounds for `DATE(check_in_time) = today`
// equivalent. Postgres and Node agree on the server's local tz.
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfTomorrow() {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

// Fetch the users row + associated staff row via the users↔staff
// relation declared in migration 090 (staff.user_id → users.uid FK).
// Replaces the batch-49 two-call helper with a single include read.
async function fetchStaffRow(staffId) {
  const user = await prisma.users.findUnique({
    where: { id: Number(staffId) },
    select: {
      id: true,
      uid: true,
      name: true,
      staff: {
        select: { shift: true, department: true, employee_id: true },
        take: 1,
      },
    },
  });
  if (!user || user.staff.length === 0) return null;
  const [staff] = user.staff;
  return {
    id: user.id,
    uid: user.uid,
    name: user.name,
    shift: staff.shift,
    department: staff.department,
    employee_id: staff.employee_id,
  };
}

export const markAttendance = async (data, markedBy, markerRole, markerName) => {
  const {
    staff_id, check_in_time, check_out_time,
    location, notes, break_duration_minutes = 0,
    attendance_type = 'regular',
  } = data;

  // Verify permission to mark attendance
  const canMarkAttendance = ['ADMIN', 'HR_STAFF'].includes(markerRole) ||
                           parseInt(staff_id) === markedBy;

  if (!canMarkAttendance) {
    throw new Error('INSUFFICIENT_PERMISSIONS');
  }

  const staff = await fetchStaffRow(staff_id);
  if (!staff) {
    throw new Error('STAFF_NOT_FOUND');
  }

  // Check if attendance already exists for today (server-local day bounds).
  const todayStart = startOfToday();
  const tomorrowStart = startOfTomorrow();
  const existing = await prisma.staff_attendance.findFirst({
    where: {
      staff_id: Number(staff_id),
      check_in_time: { gte: todayStart, lt: tomorrowStart },
    },
    select: { id: true },
  });

  // Enforce geofence on check-in (not check-out to avoid getting stuck).
  if (!check_out_time && !existing) {
    const locationCheck = isWithinCampus(location);
    if (!locationCheck.valid && process.env.ENFORCE_GEOFENCE !== 'false') {
      throw new Error(`OUTSIDE_CAMPUS:${locationCheck.reason}`);
    }
  }

  const locationJson = location ? JSON.stringify(location) : null;

  let result;
  if (existing) {
    // COALESCE-style update: only write the fields the caller provided.
    const updateData = { updated_by: markedBy, updated_at: new Date() };
    if (check_out_time) updateData.check_out_time = new Date(); // server-authoritative
    if (locationJson !== null) updateData.location = locationJson;
    if (notes != null) updateData.notes = notes;
    if (break_duration_minutes != null) updateData.break_duration_minutes = break_duration_minutes;

    result = await prisma.staff_attendance.update({
      where: { id: existing.id },
      data: updateData,
      select: {
        id: true, staff_id: true, check_in_time: true, check_out_time: true,
        attendance_status: true, location: true, created_at: true,
      },
    });
  } else {
    // Always use server NOW() for check-in / out to prevent client-side tampering.
    result = await prisma.staff_attendance.create({
      data: {
        staff_id: Number(staff_id),
        check_in_time: new Date(),
        check_out_time: check_out_time ? new Date() : null,
        location: locationJson,
        notes: notes ?? null,
        break_duration_minutes,
        attendance_type,
        marked_by: markedBy,
      },
      select: {
        id: true, staff_id: true, check_in_time: true, check_out_time: true,
        attendance_status: true, location: true, created_at: true,
      },
    });
  }

  // Update staff's last check-in/out times (conditional spread).
  if (check_in_time || check_out_time) {
    const staffUpdate = {};
    if (check_in_time) staffUpdate.last_check_in = new Date(check_in_time);
    if (check_out_time) staffUpdate.last_check_out = new Date(check_out_time);
    await prisma.staff.updateMany({
      where: { user_id: staff.uid },
      data: staffUpdate,
    });
  }

  // Calculate working hours if both times are provided.
  let hoursWorked = 0;
  if (result.check_in_time && result.check_out_time) {
    hoursWorked = calculateWorkingHours(
      result.check_in_time,
      result.check_out_time,
      break_duration_minutes,
    );
  }

  // Enrich with shift classification. Before batch 88 the classification
  // columns didn't exist and this write was swallowed by a try/catch; the
  // columns exist now and the classification UPDATE is first-class.
  const shift = await getStaffShift(staff_id);
  if (shift) {
    const classification = classifyAttendance(shift, result.check_in_time);
    const overtime = result.check_out_time
      ? calculateOvertime(shift, result.check_in_time, result.check_out_time)
      : 0;
    await prisma.staff_attendance.update({
      where: { id: result.id },
      data: {
        attendance_status: classification.status,
        minutes_late: classification.minutesLate,
        overtime_hours: overtime,
      },
    });
  }

  // Log attendance activity.
  await prisma.attendance_logs.create({
    data: {
      staff_id: Number(staff_id),
      action: check_out_time ? 'CHECK_OUT' : 'CHECK_IN',
      marked_by: markedBy,
      location: locationJson,
      hours_worked: hoursWorked,
    },
  });

  logger.info(`⏰ Attendance marked for ${staff.name} (${staff_id}) by ${markerName}: ${check_out_time ? 'CHECK_OUT' : 'CHECK_IN'}`);

  return {
    attendance: {
      ...result,
      check_in_time: result.check_in_time ? result.check_in_time.toLocaleString('en-IN') : null,
      check_out_time: result.check_out_time ? result.check_out_time.toLocaleString('en-IN') : null,
      hours_worked: hoursWorked,
      staff_name: staff.name,
      department: staff.department,
      shift: staff.shift,
    },
    markedBy: markerName,
    action: check_out_time ? 'check_out' : 'check_in',
  };
};

export const getStaffAttendance = async (staffId, filters, userRole, userId) => {
  const { days, start_date, end_date } = filters;

  const staff = await fetchStaffRow(staffId);
  if (!staff) {
    throw new Error('STAFF_NOT_FOUND');
  }

  // Check access permissions.
  const canViewAttendance = ['ADMIN', 'HR_STAFF', 'DOCTOR'].includes(userRole) ||
                           userId === staff.uid;
  if (!canViewAttendance) {
    throw new Error('INSUFFICIENT_PERMISSIONS');
  }

  // Build date filter. Explicit start/end trumps the relative `days`.
  let checkInFilter;
  if (start_date && end_date) {
    const start = new Date(start_date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(end_date);
    end.setHours(23, 59, 59, 999);
    checkInFilter = { gte: start, lte: end };
  } else {
    const daysInt = Math.max(1, parseInt(days) || 30);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysInt);
    checkInFilter = { gte: cutoff };
  }

  const attendanceRows = await prisma.staff_attendance.findMany({
    where: {
      staff_id: Number(staffId),
      check_in_time: checkInFilter,
    },
    select: {
      check_in_time: true,
      check_out_time: true,
      attendance_status: true,
      location: true,
      notes: true,
      overtime_hours: true,
      break_duration_minutes: true,
    },
    orderBy: { check_in_time: 'desc' },
  });

  // Format attendance records.
  const attendanceRecords = attendanceRows.map((record) => {
    const hoursWorked = record.check_in_time && record.check_out_time
      ? (record.check_out_time.getTime() - record.check_in_time.getTime()) / 3_600_000
      : null;
    return {
      date: record.check_in_time ? record.check_in_time.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }) : null,
      check_in_time: record.check_in_time ? record.check_in_time.toLocaleString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }) : null,
      check_out_time: record.check_out_time ? record.check_out_time.toLocaleString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }) : null,
      status: record.attendance_status,
      location: record.location,
      notes: record.notes,
      hours_worked: hoursWorked != null ? Math.round(hoursWorked * 100) / 100 : null,
      overtime_hours: record.overtime_hours ? Number(record.overtime_hours) : 0,
      break_duration_minutes: record.break_duration_minutes || 0,
    };
  });

  // Calculate statistics.
  const stats = {
    total_days: attendanceRecords.length,
    total_hours: attendanceRecords.reduce((sum, record) => sum + (record.hours_worked || 0), 0),
    total_overtime: attendanceRecords.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
    average_hours_per_day: 0,
    attendance_rate: 0,
    punctuality_rate: 0,
  };

  if (stats.total_days > 0) {
    stats.average_hours_per_day = Math.round((stats.total_hours / stats.total_days) * 100) / 100;

    // Calculate expected working days (5-day week).
    const periodStart = start_date ? new Date(start_date) : new Date(Date.now() - (parseInt(days) || 30) * 24 * 60 * 60 * 1000);
    const periodEnd = end_date ? new Date(end_date) : new Date();
    const totalPossibleDays = Math.ceil((periodEnd - periodStart) / (24 * 60 * 60 * 1000));
    const expectedWorkingDays = Math.max(1, Math.floor(totalPossibleDays * 5 / 7));

    stats.attendance_rate = Math.round((stats.total_days / expectedWorkingDays) * 100);
  }

  return {
    staffInfo: {
      id: parseInt(staffId),
      uid: staff.uid,
      name: staff.name,
      employee_id: staff.employee_id,
      department: staff.department,
    },
    attendanceRecords,
    statistics: stats,
    period: {
      days: parseInt(days),
      start_date: start_date || null,
      end_date: end_date || null,
    },
    accessLevel: userRole,
    dataAvailability: attendanceRecords.length > 0,
  };
};
