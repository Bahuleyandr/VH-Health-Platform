// src/services/staff/hr/dashboardService.js
import { STAFF_ROLES } from '../../../config/staffConfig.js';
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function getTimeframeWindow(timeframe) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (timeframe) {
    case 'last_month':
      return {
        start: new Date(year, month - 1, 1),
        end: new Date(year, month, 1),
      };
    case 'current_quarter': {
      const quarterStartMonth = Math.floor(month / 3) * 3;
      return {
        start: new Date(year, quarterStartMonth, 1),
        end: new Date(year, quarterStartMonth + 3, 1),
      };
    }
    case 'current_year':
      return {
        start: new Date(year, 0, 1),
        end: new Date(year + 1, 0, 1),
      };
    case 'current_month':
    default:
      return {
        start: new Date(year, month, 1),
        end: new Date(year, month + 1, 1),
      };
  }
}

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

function isLateArrival(row) {
  if (Number(row.minutes_late) > 0) return true;
  const status = String(row.attendance_status || '').toLowerCase();
  if (status.includes('late')) return true;
  if (!row.check_in_time) return false;
  const hour = row.check_in_time.getHours() + row.check_in_time.getMinutes() / 60;
  return hour > 9.5;
}

/**
 * Get comprehensive HR dashboard data including staff overview,
 * department breakdown, attendance trends, and performance metrics.
 * @param {string} timeframe - Time period for data aggregation (reserved).
 * @returns {Object} Dashboard data with multiple sections.
 */
export const getHRDashboardData = async (timeframe = 'current_month') => {
  const staffRoles = Object.values(STAFF_ROLES).filter(
    (role) => !['SUPER_ADMIN', 'ADMIN'].includes(role),
  );
  const { start, end } = getTimeframeWindow(timeframe);

  // Load all staff rows (joined with users by the batch-90 FK) plus
  // their aggregate inputs. For the few-hundred-row staff scale this
  // codebase expects, a single findMany + JS reduce is clearer than
  // stringing together Prisma's groupBy + conditional-aggregate APIs
  // (which don't natively support `COUNT FILTER (WHERE …)` predicates).
  const staffRows = await prisma.users.findMany({
    where: { role: { in: staffRoles } },
    select: {
      id: true,
      uid: true,
      staff: {
        select: {
          id: true,
          user_id: true,
          is_active: true,
          hire_date: true,
          last_check_in: true,
          last_check_out: true,
          salary: true,
          department: true,
        },
        take: 1,
      },
    },
  });

  const todayStart = startOfToday();
  const tomorrowStart = startOfTomorrow();
  const todayAttendanceRows = await prisma.staff_attendance.findMany({
    where: {
      check_in_time: { gte: todayStart, lt: tomorrowStart },
    },
    select: {
      staff_id: true,
      staff_uid: true,
      check_in_time: true,
      check_out_time: true,
      attendance_status: true,
      minutes_late: true,
    },
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
  const overview = {
    total_staff: 0,
    active_staff: 0,
    inactive_staff: 0,
    new_hires_30_days: 0,
    present_today: 0,
    currently_checked_in: 0,
    late_arrivals_today: 0,
    salary_sum: 0,
    salary_count: 0,
  };
  const deptAgg = new Map();
  const userIdToActiveKey = new Map();
  const staffPkToActiveKey = new Map();
  const activeStaffByKey = new Map();

  for (const u of staffRows) {
    const s = u.staff[0];
    if (!s) continue;
    const staffKey = String(u.uid);
    overview.total_staff += 1;
    if (s.is_active) {
      overview.active_staff += 1;
      userIdToActiveKey.set(u.id, staffKey);
      if (s.id != null) staffPkToActiveKey.set(s.id, staffKey);
      activeStaffByKey.set(staffKey, {
        department: s.department,
      });
    } else {
      overview.inactive_staff += 1;
    }
    if (s.hire_date && s.hire_date >= thirtyDaysAgo) overview.new_hires_30_days += 1;
    if (s.salary != null) {
      overview.salary_sum += Number(s.salary);
      overview.salary_count += 1;
    }

    if (!s.is_active || !s.department) continue;
    const d = deptAgg.get(s.department) ?? {
      department: s.department,
      total_staff: 0,
      active_staff: 0,
      present_today: 0,
      salary_sum: 0,
      salary_count: 0,
    };
    d.total_staff += 1;
    d.active_staff += 1;
    if (s.salary != null) {
      d.salary_sum += Number(s.salary);
      d.salary_count += 1;
    }
    deptAgg.set(s.department, d);
  }

  const presentTodayKeys = new Set();
  const currentlyCheckedInKeys = new Set();
  let lateArrivalsToday = 0;
  for (const row of todayAttendanceRows) {
    const key = (row.staff_uid && activeStaffByKey.has(String(row.staff_uid)))
      ? String(row.staff_uid)
      : (userIdToActiveKey.get(row.staff_id) ?? staffPkToActiveKey.get(row.staff_id));
    if (!key) continue;
    presentTodayKeys.add(key);
    if (!row.check_out_time) currentlyCheckedInKeys.add(key);
    if (isLateArrival(row)) lateArrivalsToday += 1;
  }
  overview.present_today = presentTodayKeys.size;
  overview.currently_checked_in = currentlyCheckedInKeys.size;
  overview.late_arrivals_today = lateArrivalsToday;

  for (const key of presentTodayKeys) {
    const department = activeStaffByKey.get(key)?.department;
    if (!department) continue;
    const d = deptAgg.get(department);
    if (d) d.present_today += 1;
  }

  const averageSalary = overview.salary_count > 0
    ? overview.salary_sum / overview.salary_count : null;
  const departmentStats = [...deptAgg.values()]
    .sort((a, b) => b.total_staff - a.total_staff)
    .map((d) => ({
      department: d.department,
      total_staff: d.total_staff,
      active_staff: d.active_staff,
      present_today: d.present_today,
      avg_salary: d.salary_count > 0 ? d.salary_sum / d.salary_count : null,
    }));

  // Recent attendance trends (last 7 days with both check-in + check-out).
  let attendanceTrends = [];
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);
    const completedRows = await prisma.staff_attendance.findMany({
      where: {
        check_in_time: { gte: sevenDaysAgo },
        check_out_time: { not: null },
      },
      select: { staff_id: true, check_in_time: true, check_out_time: true },
    });
    const trendAgg = new Map();
    for (const row of completedRows) {
      const key = row.check_in_time.toISOString().slice(0, 10);
      const hours = (row.check_out_time.getTime() - row.check_in_time.getTime()) / 3_600_000;
      const bucket = trendAgg.get(key) ?? { date: row.check_in_time, staffSet: new Set(), hoursSum: 0, count: 0 };
      bucket.staffSet.add(row.staff_id);
      bucket.hoursSum += hours;
      bucket.count += 1;
      trendAgg.set(key, bucket);
    }
    attendanceTrends = [...trendAgg.values()]
      .sort((a, b) => b.date - a.date)
      .slice(0, 7)
      .map((bucket) => ({
        date: bucket.date.toLocaleDateString('en-GB', {
          day: '2-digit', month: '2-digit', year: 'numeric',
        }),
        unique_staff: bucket.staffSet.size,
        avg_hours: bucket.count > 0 ? Math.round((bucket.hoursSum / bucket.count) * 100) / 100 : 0,
      }));
  } catch (attendanceError) {
    logger.warn('Attendance trends unavailable:', attendanceError.message);
  }

  // Performance metrics.
  let performanceMetrics = null;
  try {
    const perfRows = await prisma.staff.findMany({
      where: { is_active: true, performance_rating: { not: null } },
      select: { performance_rating: true },
    });
    if (perfRows.length > 0) {
      let sum = 0, high = 0, low = 0;
      for (const row of perfRows) {
        const rating = Number(row.performance_rating);
        sum += rating;
        if (rating >= 4.0) high += 1;
        if (rating < 3.0) low += 1;
      }
      performanceMetrics = {
        avg_performance_rating: Math.round((sum / perfRows.length) * 100) / 100,
        high_performers: high,
        low_performers: low,
      };
    }
  } catch (performanceError) {
    logger.warn('Performance metrics unavailable:', performanceError.message);
  }

  // Upcoming reviews — active staff whose hire_date + 1 year falls
  // in the next 30 days. Filter in JS after loading the minimal set.
  let upcomingTasks = [];
  try {
    const now = new Date();
    const horizon = new Date(Date.now() + 30 * DAY_MS);
    const reviewCandidates = await prisma.users.findMany({
      where: {
        staff: {
          some: { is_active: true, hire_date: { not: null } },
        },
      },
      select: {
        name: true,
        staff: {
          where: { is_active: true },
          select: { employee_id: true, hire_date: true },
          take: 1,
        },
      },
    });
    upcomingTasks = reviewCandidates
      .map((u) => {
        const s = u.staff[0];
        if (!s?.hire_date) return null;
        const dueDate = new Date(s.hire_date);
        dueDate.setFullYear(dueDate.getFullYear() + 1);
        if (dueDate < now || dueDate > horizon) return null;
        return {
          task_type: 'performance_review',
          staff_name: u.name,
          employee_id: s.employee_id,
          due_date: dueDate.toLocaleDateString('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
          }),
          _dueSort: dueDate,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a._dueSort - b._dueSort)
      .slice(0, 10)
      .map(({ _dueSort, ...rest }) => rest);
  } catch (tasksError) {
    logger.warn('Upcoming tasks unavailable:', tasksError.message);
  }

  let leaveSummary = {
    total: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
    currently_on_leave: 0,
  };
  try {
    const leaveRows = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (
          WHERE start_date < ${end}::date
            AND end_date >= ${start}::date
        )::int AS total,
        COUNT(*) FILTER (
          WHERE LOWER(status) = 'approved'
            AND start_date < ${end}::date
            AND end_date >= ${start}::date
        )::int AS approved,
        COUNT(*) FILTER (
          WHERE LOWER(status) = 'rejected'
            AND start_date < ${end}::date
            AND end_date >= ${start}::date
        )::int AS rejected,
        COUNT(*) FILTER (
          WHERE LOWER(status) = 'pending'
        )::int AS pending,
        COUNT(*) FILTER (
          WHERE LOWER(status) = 'approved'
            AND CURRENT_DATE BETWEEN start_date AND end_date
        )::int AS currently_on_leave
      FROM leave_applications
    `;
    if (leaveRows[0]) leaveSummary = leaveRows[0];
  } catch (leaveError) {
    logger.warn('Leave summary unavailable:', leaveError.message);
  }

  return {
    overview: {
      total_staff: overview.total_staff,
      active_staff: overview.active_staff,
      inactive_staff: overview.inactive_staff,
      new_hires_30_days: overview.new_hires_30_days,
      present_today: overview.present_today,
      currently_checked_in: overview.currently_checked_in,
      late_arrivals_today: overview.late_arrivals_today,
      average_salary: averageSalary != null ? Math.round(averageSalary) : null,
      attendance_rate: overview.active_staff > 0
        ? Math.round((overview.present_today / overview.active_staff) * 100) : 0,
    },
    attendance: {
      date: todayStart.toISOString().slice(0, 10),
      presentToday: overview.present_today,
      currentlyCheckedIn: overview.currently_checked_in,
      lateArrivals: overview.late_arrivals_today,
      absentees: Math.max(
        overview.active_staff - overview.present_today - Number(leaveSummary.currently_on_leave || 0),
        0,
      ),
      averageAttendanceRate: overview.active_staff > 0
        ? Math.round((overview.present_today / overview.active_staff) * 100) : 0,
      source: 'staff_attendance_today',
    },
    departmentBreakdown: departmentStats.map((dept) => ({
      ...dept,
      avg_salary: dept.avg_salary != null ? Math.round(dept.avg_salary) : null,
      attendance_rate: dept.active_staff > 0
        ? Math.round((dept.present_today / dept.active_staff) * 100) : 0,
      staffing_status: dept.active_staff > 0 && (dept.present_today / dept.active_staff) >= 0.8
        ? 'adequate' : 'understaffed',
    })),
    attendanceTrends,
    leaves: leaveSummary,
    performanceMetrics,
    upcomingTasks,
    alerts: {
      low_attendance: departmentStats.filter(
        (d) => d.active_staff > 0 && (d.present_today / d.active_staff) < 0.7,
      ).length,
      upcoming_reviews: upcomingTasks.length,
      new_hires_need_onboarding: overview.new_hires_30_days,
    },
    lastUpdated: new Date().toISOString(),
  };
};
