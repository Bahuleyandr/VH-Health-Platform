// src/services/staff/hr/dashboardService.js
import { STAFF_ROLES } from '../../../config/staffConfig.js';
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Get comprehensive HR dashboard data including staff overview,
 * department breakdown, attendance trends, and performance metrics.
 * @param {string} timeframe - Time period for data aggregation (reserved).
 * @returns {Object} Dashboard data with multiple sections.
 */
export const getHRDashboardData = async (_timeframe) => {
  const staffRoles = Object.values(STAFF_ROLES);

  // Load all staff rows (joined with users by the batch-90 FK) plus
  // their aggregate inputs. For the few-hundred-row staff scale this
  // codebase expects, a single findMany + JS reduce is clearer than
  // stringing together Prisma's groupBy + conditional-aggregate APIs
  // (which don't natively support `COUNT FILTER (WHERE …)` predicates).
  const staffRows = await prisma.users.findMany({
    where: { role: { in: staffRoles } },
    select: {
      staff: {
        select: {
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

  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
  const overview = {
    total_staff: 0,
    active_staff: 0,
    inactive_staff: 0,
    new_hires_30_days: 0,
    currently_checked_in: 0,
    salary_sum: 0,
    salary_count: 0,
  };
  const deptAgg = new Map();

  for (const u of staffRows) {
    const s = u.staff[0];
    if (!s) continue;
    overview.total_staff += 1;
    if (s.is_active) overview.active_staff += 1;
    else overview.inactive_staff += 1;
    if (s.hire_date && s.hire_date >= thirtyDaysAgo) overview.new_hires_30_days += 1;
    if (s.last_check_in && !s.last_check_out) overview.currently_checked_in += 1;
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
    if (s.last_check_in && !s.last_check_out) d.present_today += 1;
    if (s.salary != null) {
      d.salary_sum += Number(s.salary);
      d.salary_count += 1;
    }
    deptAgg.set(s.department, d);
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

  return {
    overview: {
      total_staff: overview.total_staff,
      active_staff: overview.active_staff,
      inactive_staff: overview.inactive_staff,
      new_hires_30_days: overview.new_hires_30_days,
      currently_checked_in: overview.currently_checked_in,
      average_salary: averageSalary != null ? Math.round(averageSalary) : null,
      attendance_rate: overview.total_staff > 0
        ? Math.round((overview.currently_checked_in / overview.total_staff) * 100) : 0,
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
