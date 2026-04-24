// src/services/staff/hr/leaveService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

// Fetch users row + associated staff row via the users↔staff relation
// (FK declared in migration 090). Used by the balance + apply flows.
async function fetchStaffInfo(staffId) {
  const user = await prisma.users.findUnique({
    where: { id: Number(staffId) },
    select: {
      id: true,
      uid: true,
      name: true,
      staff: {
        select: {
          employee_id: true,
          department: true,
          hire_date: true,
          supervisor_id: true,
        },
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
    employee_id: staff.employee_id,
    department: staff.department,
    hire_date: staff.hire_date,
    supervisor_id: staff.supervisor_id,
  };
}

// Aggregate approved-days-used per leave_type for a given staff + year.
// Replaces the raw `GROUP BY leave_type ... SUM(days_taken)` query
// with typed findMany + JS reduce. All leave_types are returned (left
// outer join semantics) so unused types still show their entitlement.
async function getLeaveBalanceByType(staffId, year, { leaveType = null } = {}) {
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);

  const [leaveTypes, approvedApplications] = await Promise.all([
    prisma.leave_types.findMany({
      where: leaveType ? { leave_type: leaveType } : undefined,
      select: { leave_type: true, annual_entitlement: true },
      orderBy: { leave_type: 'asc' },
    }),
    prisma.leave_applications.findMany({
      where: {
        staff_id: Number(staffId),
        status: 'APPROVED',
        start_date: { gte: yearStart, lt: yearEnd },
        ...(leaveType ? { leave_type: leaveType } : {}),
      },
      select: { leave_type: true, days_taken: true },
    }),
  ]);

  const usedByType = new Map();
  for (const app of approvedApplications) {
    const days = Number(app.days_taken) || 0;
    usedByType.set(app.leave_type, (usedByType.get(app.leave_type) ?? 0) + days);
  }

  return leaveTypes.map((lt) => {
    const daysUsed = usedByType.get(lt.leave_type) ?? 0;
    return {
      leave_type: lt.leave_type,
      annual_entitlement: lt.annual_entitlement,
      days_used: daysUsed,
      days_remaining: lt.annual_entitlement - daysUsed,
    };
  });
}

/**
 * Get staff leave balance for a specific year
 * @param {number} staffId - Staff ID
 * @param {number} year - Year to check balance for
 * @returns {Object} Leave balance and history
 */
export const getStaffLeaveBalance = async (staffId, year) => {
  const staff = await fetchStaffInfo(staffId);
  if (!staff) return null;

  const yearInt = Number(year);
  const yearStart = new Date(yearInt, 0, 1);
  const yearEnd = new Date(yearInt + 1, 0, 1);

  const [leaveBalance, historyRows] = await Promise.all([
    getLeaveBalanceByType(staffId, yearInt),
    prisma.leave_applications.findMany({
      where: {
        staff_id: Number(staffId),
        start_date: { gte: yearStart, lt: yearEnd },
      },
      select: {
        leave_type: true,
        start_date: true,
        end_date: true,
        days_taken: true,
        status: true,
        reason: true,
        reviewed_by: true,
        reviewed_at: true,
      },
      orderBy: { start_date: 'desc' },
    }),
  ]);

  const fmtDate = (d) => d
    ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : null;

  return {
    staff: {
      name: staff.name,
      employee_id: staff.employee_id,
      hire_date: fmtDate(staff.hire_date),
    },
    year: yearInt,
    leaveBalance,
    leaveHistory: historyRows.map((leave) => ({
      leave_type: leave.leave_type,
      start_date: fmtDate(leave.start_date),
      end_date: fmtDate(leave.end_date),
      days_taken: leave.days_taken,
      status: leave.status,
      reason: leave.reason,
      approved_by: leave.reviewed_by,           // preserve public field name
      approved_date: fmtDate(leave.reviewed_at), // preserve public field name
    })),
    summary: {
      total_entitled: leaveBalance.reduce((sum, leave) => sum + leave.annual_entitlement, 0),
      total_used: leaveBalance.reduce((sum, leave) => sum + leave.days_used, 0),
      total_remaining: leaveBalance.reduce((sum, leave) => sum + leave.days_remaining, 0),
    },
  };
};

/**
 * Apply for leave
 * @param {Object} leaveData - Leave application data
 * @returns {Object} Created leave application details
 */
export const applyForLeave = async (leaveData) => {
  const {
    staff_id,
    leave_type,
    start_date,
    end_date,
    reason,
    emergency_contact,
    appliedBy,
  } = leaveData;

  // Calculate days requested.
  const startDate = new Date(start_date);
  const endDate = new Date(end_date);
  const daysDifference = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;

  if (daysDifference <= 0 || startDate > endDate) {
    throw new Error('INVALID_DATE_RANGE');
  }

  // Check leave balance for the requested year + leave type.
  const balance = await getLeaveBalanceByType(
    staff_id,
    startDate.getFullYear(),
    { leaveType: leave_type },
  );
  if (balance.length === 0 || balance[0].days_remaining < daysDifference) {
    throw new Error('INSUFFICIENT_LEAVE_BALANCE');
  }

  const staff = await fetchStaffInfo(staff_id);
  if (!staff) {
    throw new Error('STAFF_NOT_FOUND');
  }

  // Create leave application.
  const application = await prisma.leave_applications.create({
    data: {
      staff_id: Number(staff_id),
      leave_type,
      start_date: startDate,
      end_date: endDate,
      days_taken: daysDifference,
      reason: reason ?? null,
      emergency_contact: emergency_contact ?? null,
      status: 'PENDING',
      applied_by: appliedBy,
    },
    select: {
      id: true,
      staff_id: true,
      leave_type: true,
      start_date: true,
      end_date: true,
      days_taken: true,
      reason: true,
      emergency_contact: true,
      status: true,
      applied_by: true,
      applied_date: true,
      created_at: true,
    },
  });

  // Notify supervisor. `notifications.phone` is NOT NULL and the
  // pre-ORM raw INSERT omitted it — so this write silently failed
  // in prod (missing column ⇒ constraint violation). The typed
  // ORM requires phone, so look the supervisor up and use theirs.
  // supervisor_id is staff.supervisor_id → staff.id, not users.id.
  if (staff.supervisor_id) {
    const supervisor = await prisma.staff.findUnique({
      where: { id: staff.supervisor_id },
      select: { users: { select: { id: true, phone: true } } },
    });
    if (supervisor?.users?.phone) {
      const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      await prisma.notifications.create({
        data: {
          user_id: supervisor.users.id,
          phone: supervisor.users.phone,
          title: 'Leave Application Pending Approval',
          body: `${staff.name} has applied for ${leave_type} from ${fmt(startDate)} to ${fmt(endDate)}`,
          type: 'leave_application',
          related_id: application.id,
        },
      });
    }
  }

  logger.info(`📅 Leave application created for ${staff.name} (${staff_id}) - ${leave_type} for ${daysDifference} days`);

  const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return {
    application: {
      ...application,
      start_date: fmtDate(application.start_date),
      end_date: fmtDate(application.end_date),
      applied_date: fmtDate(application.applied_date),
    },
    staffInfo: {
      name: staff.name,
      employee_id: staff.employee_id,
      department: staff.department,
    },
    leaveBalance: {
      days_requested: daysDifference,
      days_remaining_before: balance[0].days_remaining,
      days_remaining_after: balance[0].days_remaining - daysDifference,
    },
  };
};

/**
 * Check if user is viewing their own data
 * @param {number} staffId - Staff ID
 * @param {string} userUid - User UID
 * @returns {boolean} True if viewing own data
 */
export const isUserViewingOwnData = async (staffId, userUid) => {
  const user = await prisma.users.findUnique({
    where: { id: Number(staffId) },
    select: { uid: true },
  });
  return user?.uid === userUid;
};

/**
 * Check if user is applying for their own leave
 * @param {number} staffId - Staff ID
 * @param {string} userUid - User UID
 * @returns {boolean} True if applying for own leave
 */
export const isUserApplyingOwnLeave = async (staffId, userUid) => {
  const user = await prisma.users.findUnique({
    where: { id: Number(staffId) },
    select: { uid: true },
  });
  return user?.uid === userUid;
};
