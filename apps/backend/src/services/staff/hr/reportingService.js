// src/services/staff/hr/reportingService.js
import prisma from '../../../lib/prisma.js';

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : null;

/**
 * Generate staff reports in various formats
 * @param {Object} reportParams - Report parameters
 * @returns {Object} Generated report data
 */
export const generateStaffReport = async (reportParams) => {
  const {
    report_type,
    department,
    start_date,
    end_date,
    format,
    generatedBy,
  } = reportParams;

  let reportData;

  switch (report_type) {
    case 'attendance':
      reportData = await generateAttendanceReport(department, start_date, end_date);
      break;
    case 'performance':
      reportData = await generatePerformanceReportData(department);
      break;
    case 'leave':
      reportData = await generateLeaveReport(department, start_date, end_date);
      break;
    case 'payroll':
      reportData = await generatePayrollReport(department);
      break;
    default:
      throw new Error('Invalid report type');
  }

  if (format === 'csv') {
    return { data: convertToCSV(reportData) };
  }

  return {
    report_type,
    department: department || 'All Departments',
    date_range: { start_date, end_date },
    generated_by: generatedBy,
    generated_at: new Date().toISOString(),
    data: reportData,
  };
};

/**
 * Generate attendance report data
 * @private
 */
const generateAttendanceReport = async (department, start_date, end_date) => {
  const where = { check_in_time: { not: null } };
  if (start_date && end_date) {
    const start = new Date(start_date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(end_date);
    end.setHours(23, 59, 59, 999);
    where.check_in_time = { ...where.check_in_time, gte: start, lte: end };
  }

  // Load attendance rows and the staff+users data in parallel per-row
  // via include — no way to JOIN directly in Prisma since
  // staff_attendance doesn't declare a relation to staff yet. Fall
  // back to a two-step: attendance rows + one-shot staff lookup keyed
  // by staff_id.
  const rows = await prisma.staff_attendance.findMany({
    where,
    select: {
      staff_id: true,
      staff_uid: true,
      check_in_time: true,
      check_out_time: true,
      overtime_hours: true,
    },
    orderBy: { check_in_time: 'desc' },
  });

  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((x) => x != null))];
  const staffUids = [...new Set(rows.map((r) => r.staff_uid).filter((x) => x != null))];

  const [staffByUid, staffById] = await Promise.all([
    staffUids.length > 0
      ? prisma.staff.findMany({
        where: { user_id: { in: staffUids } },
        select: {
          user_id: true, employee_id: true, department: true, position: true,
          users: { select: { name: true } },
        },
      })
      : [],
    staffIds.length > 0
      ? prisma.staff.findMany({
        where: { id: { in: staffIds } },
        select: {
          id: true, employee_id: true, department: true, position: true,
          users: { select: { name: true } },
        },
      })
      : [],
  ]);

  const byUid = new Map(staffByUid.map((s) => [s.user_id, s]));
  const byId = new Map(staffById.map((s) => [s.id, s]));

  const withStaff = rows
    .map((row) => {
      const staff = byUid.get(row.staff_uid) ?? byId.get(row.staff_id);
      if (!staff) return null;
      if (department && staff.department !== department) return null;
      return { row, staff };
    })
    .filter(Boolean);

  return withStaff.map(({ row, staff }) => {
    const hoursWorked = row.check_in_time && row.check_out_time
      ? (row.check_out_time.getTime() - row.check_in_time.getTime()) / 3_600_000
      : null;
    const checkInHour = row.check_in_time.getHours() + row.check_in_time.getMinutes() / 60;
    const punctuality = checkInHour > 9.5 ? 'Late' : 'On Time';
    return {
      name: staff.users?.name ?? null,
      employee_id: staff.employee_id,
      department: staff.department,
      position: staff.position,
      date: row.check_in_time.toLocaleDateString('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric',
      }),
      check_in_time: row.check_in_time.toLocaleTimeString('en-IN'),
      check_out_time: row.check_out_time
        ? row.check_out_time.toLocaleTimeString('en-IN') : 'Not checked out',
      hours_worked: hoursWorked != null ? Math.round(hoursWorked * 10) / 10 : 0,
      overtime_hours: row.overtime_hours ? Number(row.overtime_hours) : 0,
      punctuality,
    };
  });
};

/**
 * Generate performance report data
 * @private
 */
const generatePerformanceReportData = async (department) => {
  const where = { is_active: true };
  if (department) where.department = department;

  const rows = await prisma.staff.findMany({
    where,
    select: {
      employee_id: true,
      department: true,
      position: true,
      performance_rating: true,
      last_review_date: true,
      users: { select: { name: true } },
    },
    orderBy: [{ department: 'asc' }],
  });

  return rows
    .sort((a, b) => (a.department ?? '').localeCompare(b.department ?? '')
      || (a.users?.name ?? '').localeCompare(b.users?.name ?? ''))
    .map((row) => ({
      name: row.users?.name ?? null,
      employee_id: row.employee_id,
      department: row.department,
      position: row.position,
      performance_rating: row.performance_rating
        ? Math.round(Number(row.performance_rating) * 10) / 10
        : 'Not rated',
      last_review_date: row.last_review_date
        ? fmtDate(row.last_review_date) : 'Never reviewed',
    }));
};

/**
 * Generate leave report data
 * @private
 */
const generateLeaveReport = async (department, start_date, end_date) => {
  // leave_applications.staff_id is Int (no declared relation to
  // users / staff). The pre-ORM raw query joined `staff s ON
  // la.staff_id = s.user_id`, which mismatches types (int vs uuid)
  // and would have errored at runtime. The typed rewrite loads
  // applications first, then resolves each staff_id through users.id.
  const appWhere = {};
  if (start_date && end_date) {
    const start = new Date(start_date);
    const end = new Date(end_date);
    appWhere.start_date = { gte: start, lte: end };
  }

  const applications = await prisma.leave_applications.findMany({
    where: appWhere,
    select: {
      staff_id: true,
      leave_type: true,
      start_date: true,
      end_date: true,
      days_taken: true,
      status: true,
      reason: true,
    },
    orderBy: { start_date: 'desc' },
  });

  const userIds = [...new Set(applications.map((a) => a.staff_id).filter((x) => x != null))];
  const users = userIds.length > 0
    ? await prisma.users.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        staff: {
          select: { employee_id: true, department: true },
          take: 1,
        },
      },
    })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  return applications
    .map((app) => {
      const u = userById.get(app.staff_id);
      if (!u || u.staff.length === 0) return null;
      const [staff] = u.staff;
      if (department && staff.department !== department) return null;
      return {
        name: u.name,
        employee_id: staff.employee_id,
        department: staff.department,
        leave_type: app.leave_type,
        start_date: fmtDate(app.start_date),
        end_date: fmtDate(app.end_date),
        days_taken: app.days_taken,
        status: app.status,
        reason: app.reason,
      };
    })
    .filter(Boolean);
};

/**
 * Generate payroll report data
 * @private
 */
const generatePayrollReport = async (department) => {
  const where = { is_active: true };
  if (department) where.department = department;

  const rows = await prisma.staff.findMany({
    where,
    select: {
      employee_id: true,
      department: true,
      position: true,
      employment_type: true,
      salary: true,
      bank_details: true,
      users: { select: { name: true } },
    },
    orderBy: [{ department: 'asc' }],
  });

  return rows
    .sort((a, b) => (a.department ?? '').localeCompare(b.department ?? '')
      || (a.users?.name ?? '').localeCompare(b.users?.name ?? ''))
    .map((row) => ({
      name: row.users?.name ?? null,
      employee_id: row.employee_id,
      department: row.department,
      position: row.position,
      employment_type: row.employment_type,
      monthly_salary: row.salary != null ? Number(row.salary) : 0,
      bank_account: row.bank_details?.account_number
        ? `****${String(row.bank_details.account_number).slice(-4)}` : 'Not provided',
    }));
};

/**
 * Convert data to CSV format
 * @private
 */
const convertToCSV = (data) => {
  if (!data || data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const csvHeaders = headers.join(',');

  const csvRows = data.map((row) => headers.map((header) => {
    const value = row[header];
    if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }).join(','));

  return [csvHeaders, ...csvRows].join('\n');
};
