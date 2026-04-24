// src/services/staff/hr/departmentService.js
import prisma from '../../../lib/prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;
const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : null;

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

function lateCategory(checkInTime) {
  // Matches the pre-ORM thresholds: on_time ≤ 09:00, slightly_late ≤ 09:30,
  // late ≤ 10:00, else very_late.
  const h = checkInTime.getHours() + checkInTime.getMinutes() / 60;
  if (h <= 9) return 'on_time';
  if (h <= 9.5) return 'slightly_late';
  if (h <= 10) return 'late';
  return 'very_late';
}

/**
 * Get comprehensive department staff summary
 * @param {string} department - Department name
 * @returns {Object} Department statistics and staff list
 */
export const getDepartmentStaffSummary = async (department) => {
  const allStaff = await prisma.staff.findMany({
    where: { department },
    select: {
      id: true,
      user_id: true,
      employee_id: true,
      position: true,
      shift_type: true,
      employment_type: true,
      hire_date: true,
      performance_rating: true,
      salary: true,
      is_active: true,
      users: {
        select: { id: true, name: true, email: true, phone: true },
      },
    },
  });

  // Today's attendance for staff in this department, keyed by
  // whichever id the row carries (staff_id int or staff_uid uuid).
  const todayStart = startOfToday();
  const tomorrowStart = startOfTomorrow();
  const staffUidSet = new Set(allStaff.map((s) => s.user_id).filter(Boolean));
  const userIdSet = new Set(allStaff.map((s) => s.users?.id).filter((x) => x != null));
  const todayAttendance = await prisma.staff_attendance.findMany({
    where: {
      check_in_time: { gte: todayStart, lt: tomorrowStart },
      OR: [
        ...(staffUidSet.size > 0 ? [{ staff_uid: { in: [...staffUidSet] } }] : []),
        ...(userIdSet.size > 0 ? [{ staff_id: { in: [...userIdSet] } }] : []),
      ],
    },
    select: {
      staff_id: true,
      staff_uid: true,
      check_in_time: true,
      check_out_time: true,
    },
  });
  const attendanceByUid = new Map();
  const attendanceById = new Map();
  for (const row of todayAttendance) {
    if (row.staff_uid) attendanceByUid.set(row.staff_uid, row);
    if (row.staff_id != null) attendanceById.set(row.staff_id, row);
  }

  // Aggregate: total / active / employment_type breakdowns / salary extremes.
  const stats = {
    total_staff: allStaff.length,
    active_staff: 0,
    full_time: 0,
    part_time: 0,
    contract: 0,
    salary_sum: 0, salary_count: 0,
    salary_min: null, salary_max: null,
  };
  const activeStaff = [];
  for (const s of allStaff) {
    if (s.is_active) {
      stats.active_staff += 1;
      activeStaff.push(s);
    }
    if (s.employment_type === 'FULL_TIME') stats.full_time += 1;
    else if (s.employment_type === 'PART_TIME') stats.part_time += 1;
    else if (s.employment_type === 'CONTRACT') stats.contract += 1;
    if (s.salary != null) {
      const sal = Number(s.salary);
      stats.salary_sum += sal;
      stats.salary_count += 1;
      if (stats.salary_min == null || sal < stats.salary_min) stats.salary_min = sal;
      if (stats.salary_max == null || sal > stats.salary_max) stats.salary_max = sal;
    }
  }

  // Position breakdown (active only).
  const positionAgg = new Map();
  for (const s of activeStaff) {
    const key = s.position ?? '(unassigned)';
    const agg = positionAgg.get(key) ?? { position: s.position, count: 0, salary_sum: 0, salary_count: 0 };
    agg.count += 1;
    if (s.salary != null) {
      agg.salary_sum += Number(s.salary);
      agg.salary_count += 1;
    }
    positionAgg.set(key, agg);
  }
  const positionBreakdown = [...positionAgg.values()]
    .sort((a, b) => b.count - a.count)
    .map((agg) => ({
      position: agg.position,
      count: agg.count,
      avg_salary: agg.salary_count > 0 ? Math.round(agg.salary_sum / agg.salary_count) : null,
    }));

  // Shift breakdown (active + has shift_type).
  const shiftAgg = new Map();
  for (const s of activeStaff) {
    if (!s.shift_type) continue;
    shiftAgg.set(s.shift_type, (shiftAgg.get(s.shift_type) ?? 0) + 1);
  }
  const shiftBreakdown = [...shiftAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([shift_type, count]) => ({ shift_type, count }));

  // Experience distribution (active + hire_date set).
  const now = new Date();
  const expBuckets = new Map([
    ['0-1 years', 0], ['1-3 years', 0], ['3-5 years', 0], ['5-10 years', 0], ['10+ years', 0],
  ]);
  for (const s of activeStaff) {
    if (!s.hire_date) continue;
    const years = (now - s.hire_date) / YEAR_MS;
    const bucket = years < 1 ? '0-1 years'
      : years < 3 ? '1-3 years'
        : years < 5 ? '3-5 years'
          : years < 10 ? '5-10 years' : '10+ years';
    expBuckets.set(bucket, expBuckets.get(bucket) + 1);
  }
  const experienceDistribution = [...expBuckets.entries()]
    .filter(([, count]) => count > 0)
    .map(([experience_range, count]) => ({ experience_range, count }));

  // Today's attendance metrics.
  const presentToday = new Set();
  let completedHoursSum = 0;
  let completedHoursCount = 0;
  for (const s of activeStaff) {
    const att = (s.user_id && attendanceByUid.get(s.user_id))
      ?? (s.users?.id != null && attendanceById.get(s.users.id));
    if (!att) continue;
    presentToday.add(s.id);
    if (att.check_out_time) {
      completedHoursSum += (att.check_out_time.getTime() - att.check_in_time.getTime()) / 3_600_000;
      completedHoursCount += 1;
    }
  }
  const staffPresentToday = presentToday.size;
  const avgHoursToday = completedHoursCount > 0 ? completedHoursSum / completedHoursCount : 0;

  // Performance metrics (active + rated).
  const perfAgg = { sum: 0, count: 0, high: 0, low: 0 };
  for (const s of activeStaff) {
    if (s.performance_rating == null) continue;
    const rating = Number(s.performance_rating);
    perfAgg.sum += rating;
    perfAgg.count += 1;
    if (rating >= 4.0) perfAgg.high += 1;
    if (rating < 3.0) perfAgg.low += 1;
  }

  // Staff list.
  const staffList = activeStaff
    .sort((a, b) => (a.position ?? '').localeCompare(b.position ?? '')
      || (a.users?.name ?? '').localeCompare(b.users?.name ?? ''))
    .map((s) => {
      const att = (s.user_id && attendanceByUid.get(s.user_id))
        ?? (s.users?.id != null && attendanceById.get(s.users.id));
      const attendance_status = !att ? 'absent'
        : att.check_out_time ? 'checked_out' : 'present';
      return {
        id: s.users?.id,
        name: s.users?.name ?? null,
        email: s.users?.email ?? null,
        phone: s.users?.phone ?? null,
        employee_id: s.employee_id,
        position: s.position,
        shift_type: s.shift_type,
        employment_type: s.employment_type,
        hire_date: fmtDate(s.hire_date),
        tenure: s.hire_date ? Math.floor((now - s.hire_date) / YEAR_MS) : 0,
        performance_rating: s.performance_rating
          ? Math.round(Number(s.performance_rating) * 10) / 10 : null,
        attendance_status,
      };
    });

  return {
    department,
    overview: {
      total_staff: stats.total_staff,
      active_staff: stats.active_staff,
      full_time: stats.full_time,
      part_time: stats.part_time,
      contract: stats.contract,
      attendance_today: staffPresentToday,
      attendance_rate: stats.active_staff > 0
        ? Math.round((staffPresentToday / stats.active_staff) * 100) : 0,
      avg_hours_today: Math.round(avgHoursToday * 10) / 10,
    },
    salary: {
      average: stats.salary_count > 0 ? Math.round(stats.salary_sum / stats.salary_count) : null,
      minimum: stats.salary_min != null ? Math.round(stats.salary_min) : null,
      maximum: stats.salary_max != null ? Math.round(stats.salary_max) : null,
    },
    performance: {
      average_rating: perfAgg.count > 0
        ? Math.round((perfAgg.sum / perfAgg.count) * 10) / 10 : null,
      high_performers: perfAgg.high,
      needs_improvement: perfAgg.low,
    },
    positionBreakdown,
    shiftBreakdown,
    experienceDistribution,
    staffList,
  };
};

/**
 * Get attendance analytics across departments
 * @param {Object} queryParams - Query parameters including filters
 * @returns {Object} Attendance analytics data
 */
export const getAttendanceAnalytics = async (queryParams) => {
  const { department, start_date, end_date, group_by } = queryParams;

  const attendanceWhere = { check_in_time: { not: null } };
  if (start_date && end_date) {
    const start = new Date(start_date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(end_date);
    end.setHours(23, 59, 59, 999);
    attendanceWhere.check_in_time = { not: null, gte: start, lte: end };
  }

  const attendanceRows = await prisma.staff_attendance.findMany({
    where: attendanceWhere,
    select: {
      staff_id: true,
      staff_uid: true,
      check_in_time: true,
      check_out_time: true,
      overtime_hours: true,
    },
  });

  // Load staff rows keyed by both user_id (uuid) and id (int) so we
  // can resolve either side of the pre-ORM `sa.staff_id = s.user_id`
  // type-mismatched JOIN.
  const uids = [...new Set(attendanceRows.map((r) => r.staff_uid).filter(Boolean))];
  const ids = [...new Set(attendanceRows.map((r) => r.staff_id).filter((x) => x != null))];
  const [staffByUid, staffById] = await Promise.all([
    uids.length > 0
      ? prisma.staff.findMany({
        where: { user_id: { in: uids } },
        select: {
          id: true, user_id: true, department: true, employee_id: true,
          users: { select: { name: true } },
        },
      })
      : [],
    ids.length > 0
      ? prisma.users.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, name: true,
          staff: { select: { department: true, employee_id: true }, take: 1 },
        },
      })
      : [],
  ]);
  const uidMap = new Map(staffByUid.map((s) => [s.user_id, {
    department: s.department, employee_id: s.employee_id, name: s.users?.name ?? null,
  }]));
  const idMap = new Map(staffById.map((u) => [u.id, {
    department: u.staff[0]?.department ?? null,
    employee_id: u.staff[0]?.employee_id ?? null,
    name: u.name,
  }]));

  // Annotate each attendance row with its staff context.
  const annotated = attendanceRows.map((row) => {
    const staff = (row.staff_uid && uidMap.get(row.staff_uid))
      ?? (row.staff_id != null && idMap.get(row.staff_id))
      ?? null;
    return { row, staff };
  }).filter(({ staff }) => staff
    && (!department || staff.department === department));

  // Summary / overview.
  const uniqueStaffIds = new Set();
  let totalCheckIns = 0;
  let completedShifts = 0;
  let hoursSum = 0;
  let hoursCount = 0;
  let lateArrivals = 0;
  let overtimeShifts = 0;
  for (const { row } of annotated) {
    uniqueStaffIds.add(row.staff_uid ?? `id:${row.staff_id}`);
    totalCheckIns += 1;
    if (row.check_out_time) {
      completedShifts += 1;
      hoursSum += (row.check_out_time.getTime() - row.check_in_time.getTime()) / 3_600_000;
      hoursCount += 1;
    }
    const hour = row.check_in_time.getHours() + row.check_in_time.getMinutes() / 60;
    if (hour > 9.5) lateArrivals += 1;
    if (row.overtime_hours && Number(row.overtime_hours) > 0) overtimeShifts += 1;
  }

  // Time-grouped trend.
  const trendAgg = new Map();
  const bucketKey = (d) => {
    if (group_by === 'week') {
      const w = new Date(d);
      w.setHours(0, 0, 0, 0);
      w.setDate(w.getDate() - w.getDay()); // Sunday-start week
      return { key: w.toISOString(), label: fmtDate(w), sortDate: w };
    }
    if (group_by === 'month') {
      const m = new Date(d.getFullYear(), d.getMonth(), 1);
      return { key: m.toISOString(), label: m.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), sortDate: m };
    }
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return { key: day.toISOString(), label: fmtDate(day), sortDate: day };
  };
  for (const { row } of annotated) {
    const { key, label, sortDate } = bucketKey(row.check_in_time);
    const bucket = trendAgg.get(key) ?? {
      period: label, sortDate, uniq: new Set(), total: 0,
      hoursSum: 0, hoursCount: 0, late: 0, overtimeSum: 0,
    };
    bucket.uniq.add(row.staff_uid ?? `id:${row.staff_id}`);
    bucket.total += 1;
    if (row.check_out_time) {
      bucket.hoursSum += (row.check_out_time.getTime() - row.check_in_time.getTime()) / 3_600_000;
      bucket.hoursCount += 1;
    }
    const hour = row.check_in_time.getHours() + row.check_in_time.getMinutes() / 60;
    if (hour > 9.5) bucket.late += 1;
    if (row.overtime_hours) bucket.overtimeSum += Number(row.overtime_hours);
    trendAgg.set(key, bucket);
  }
  const trends = [...trendAgg.values()]
    .sort((a, b) => b.sortDate - a.sortDate)
    .slice(0, 30)
    .map((bucket) => ({
      period: bucket.period,
      unique_staff: bucket.uniq.size,
      total_check_ins: bucket.total,
      avg_hours: bucket.hoursCount > 0 ? Math.round((bucket.hoursSum / bucket.hoursCount) * 10) / 10 : 0,
      late_arrivals: bucket.late,
      total_overtime_hours: Math.round(bucket.overtimeSum * 100) / 100,
    }));

  // Department comparison (skip when a department filter was specified).
  let departmentComparison = [];
  if (!department) {
    const deptAgg = new Map();
    for (const { row, staff } of annotated) {
      const dept = staff.department ?? '(unknown)';
      const agg = deptAgg.get(dept) ?? {
        department: dept, uniq: new Set(), total: 0,
        hoursSum: 0, hoursCount: 0, late: 0,
      };
      agg.uniq.add(row.staff_uid ?? `id:${row.staff_id}`);
      agg.total += 1;
      if (row.check_out_time) {
        agg.hoursSum += (row.check_out_time.getTime() - row.check_in_time.getTime()) / 3_600_000;
        agg.hoursCount += 1;
      }
      const hour = row.check_in_time.getHours() + row.check_in_time.getMinutes() / 60;
      if (hour > 9.5) agg.late += 1;
      deptAgg.set(dept, agg);
    }
    departmentComparison = [...deptAgg.values()]
      .sort((a, b) => b.total - a.total)
      .map((agg) => ({
        department: agg.department,
        unique_staff: agg.uniq.size,
        total_check_ins: agg.total,
        avg_hours: agg.hoursCount > 0 ? Math.round((agg.hoursSum / agg.hoursCount) * 10) / 10 : 0,
        late_arrivals: agg.late,
        punctuality_score: agg.total > 0
          ? Math.round(((agg.total - agg.late) / agg.total) * 100) : 0,
      }));
  }

  // Punctuality breakdown.
  const punctAgg = new Map([
    ['on_time', 0], ['slightly_late', 0], ['late', 0], ['very_late', 0],
  ]);
  for (const { row } of annotated) {
    const cat = lateCategory(row.check_in_time);
    punctAgg.set(cat, punctAgg.get(cat) + 1);
  }
  const punctualityBreakdown = [...punctAgg.entries()]
    .filter(([, count]) => count > 0)
    .map(([punctuality, count]) => ({ punctuality, count }));

  // Top performers (>5 days present, sorted by present + on-time).
  const perfAgg = new Map();
  for (const { row, staff } of annotated) {
    const key = `${staff.employee_id ?? row.staff_uid ?? row.staff_id}`;
    const agg = perfAgg.get(key) ?? {
      name: staff.name,
      employee_id: staff.employee_id,
      department: staff.department,
      days: 0,
      hoursSum: 0, hoursCount: 0,
      onTime: 0,
      overtimeSum: 0,
    };
    agg.days += 1;
    if (row.check_out_time) {
      agg.hoursSum += (row.check_out_time.getTime() - row.check_in_time.getTime()) / 3_600_000;
      agg.hoursCount += 1;
    }
    const hour = row.check_in_time.getHours() + row.check_in_time.getMinutes() / 60;
    if (hour <= 9) agg.onTime += 1;
    if (row.overtime_hours) agg.overtimeSum += Number(row.overtime_hours);
    perfAgg.set(key, agg);
  }
  const topPerformers = [...perfAgg.values()]
    .filter((agg) => agg.days > 5)
    .sort((a, b) => b.days - a.days || b.onTime - a.onTime)
    .slice(0, 10)
    .map((agg) => ({
      name: agg.name,
      employee_id: agg.employee_id,
      department: agg.department,
      days_present: agg.days,
      avg_hours: agg.hoursCount > 0 ? Math.round((agg.hoursSum / agg.hoursCount) * 10) / 10 : 0,
      on_time_days: agg.onTime,
      total_overtime: Math.round(agg.overtimeSum * 100) / 100,
      punctuality_rate: agg.days > 0 ? Math.round((agg.onTime / agg.days) * 100) : 0,
    }));

  return {
    filters: {
      department: department || 'All Departments',
      date_range: start_date && end_date ? { start: start_date, end: end_date } : 'All Time',
      grouping: group_by,
    },
    summary: {
      unique_staff: uniqueStaffIds.size,
      total_check_ins: totalCheckIns,
      completed_shifts: completedShifts,
      avg_hours_worked: hoursCount > 0 ? Math.round((hoursSum / hoursCount) * 10) / 10 : 0,
      late_arrivals: lateArrivals,
      late_arrival_rate: totalCheckIns > 0 ? Math.round((lateArrivals / totalCheckIns) * 100) : 0,
      overtime_shifts: overtimeShifts,
    },
    trends,
    departmentComparison,
    punctualityBreakdown,
    topPerformers,
  };
};
