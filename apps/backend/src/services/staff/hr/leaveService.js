// src/services/staff/hr/leaveService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';
import { requireTenantId } from '../../tenant/tenantService.js';

const APPROVED_LEAVE_STATUSES = ['approved', 'APPROVED'];
const DEFAULT_LEAVE_ENTITLEMENTS = {
  ANNUAL: 12,
  SICK: 12,
  CASUAL: 12,
  EARNED: 12,
  MATERNITY: 180,
  PATERNITY: 15,
  BEREAVEMENT: 5,
  UNPAID: 365,
  COMPENSATORY: 12,
};

function normalizeLeaveStatus(status, fallback = 'pending') {
  return String(status || fallback).trim().toLowerCase();
}

function normalizeLeaveType(leaveType) {
  return String(leaveType || '').trim().toUpperCase();
}

function entitlementFor(leaveType, value) {
  const type = normalizeLeaveType(leaveType);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return DEFAULT_LEAVE_ENTITLEMENTS[type] ?? 0;
}

// Fetch users row + associated staff row via the users↔staff relation
// (FK declared in migration 090). Used by the balance + apply flows.
//
// Tolerates THREE identifier shapes the staff app might send for "my
// own balance":
//   - integer  users.id          (admin tooling)
//   - UUID     users.uid         (req.user.uid in the staff JWT)
//   - EMP-NNNN staff.employee_id (legacy URL pattern)
// The old implementation only handled int — `Number(uuid) → NaN` and
// Prisma rejected with PrismaClientValidationError → controller 500.
async function fetchStaffInfo(staffId) {
  const idStr = String(staffId);
  let where;
  if (/^\d+$/.test(idStr)) {
    where = { id: Number(idStr) };
  } else if (/^EMP-/i.test(idStr)) {
    // employee_id lives on staff, not users. Resolve via the staff side.
    const staffRow = await prisma.staff.findFirst({
      where: { employee_id: idStr.toUpperCase() },
      select: { user_id: true },
    });
    if (!staffRow?.user_id) return null;
    where = { uid: staffRow.user_id };
  } else {
    where = { uid: idStr };
  }
  const user = await prisma.users.findUnique({
    where,
    select: {
      id: true,
      uid: true,
      name: true,
      tenant_id: true,
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
    tenant_id: user.tenant_id,
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
//
// `staffIntId` MUST be the resolved users.id integer — callers should
// run input through `fetchStaffInfo()` first if they only have a UUID
// or employee_id. (`leave_applications.staff_id` is an INT FK and
// `Number(uuid) → NaN` triggers a Prisma validation error.)
async function getLeaveBalanceByType(staffIntId, year, { leaveType = null } = {}) {
  const requestedLeaveType = leaveType ? normalizeLeaveType(leaveType) : null;
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);

  const [configuredLeaveTypes, approvedApplications] = await Promise.all([
    prisma.leave_types.findMany({
      where: requestedLeaveType
        ? { leave_type: { in: [requestedLeaveType, requestedLeaveType.toLowerCase()] } }
        : undefined,
      select: { leave_type: true, annual_entitlement: true },
      orderBy: { leave_type: 'asc' },
    }),
    prisma.leave_applications.findMany({
      where: {
        staff_id: Number(staffIntId),
        status: { in: APPROVED_LEAVE_STATUSES },
        start_date: { gte: yearStart, lt: yearEnd },
        ...(requestedLeaveType
          ? { leave_type: { in: [requestedLeaveType, requestedLeaveType.toLowerCase()] } }
          : {}),
      },
      select: { leave_type: true, days_taken: true },
    }),
  ]);

  const leaveTypeByCode = new Map();
  for (const [type, defaultEntitlement] of Object.entries(DEFAULT_LEAVE_ENTITLEMENTS)) {
    leaveTypeByCode.set(type, {
      leave_type: type,
      annual_entitlement: defaultEntitlement,
    });
  }
  for (const lt of configuredLeaveTypes) {
    const type = normalizeLeaveType(lt.leave_type);
    if (!type) continue;
    leaveTypeByCode.set(type, {
      leave_type: type,
      annual_entitlement: entitlementFor(type, lt.annual_entitlement),
    });
  }
  const leaveTypes = requestedLeaveType
    ? [leaveTypeByCode.get(requestedLeaveType) ?? {
      leave_type: requestedLeaveType,
      annual_entitlement: entitlementFor(requestedLeaveType),
    }]
    : [...leaveTypeByCode.values()];

  const usedByType = new Map();
  for (const app of approvedApplications) {
    const type = normalizeLeaveType(app.leave_type);
    const days = Number(app.days_taken) || 0;
    usedByType.set(type, (usedByType.get(type) ?? 0) + days);
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

  // After fetchStaffInfo resolves identifier shapes, downstream queries
  // ALWAYS use the resolved int (`staff.id`) — not the raw `staffId`,
  // which may still be a UUID or "EMP-NNNN" string.
  const staffIntId = staff.id;
  const yearInt = Number(year);
  const yearStart = new Date(yearInt, 0, 1);
  const yearEnd = new Date(yearInt + 1, 0, 1);

  const [leaveBalance, historyRows] = await Promise.all([
    getLeaveBalanceByType(staffIntId, yearInt),
    prisma.leave_applications.findMany({
      where: {
        staff_id: staffIntId,
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
      status_normalized: normalizeLeaveStatus(leave.status),
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
    replacement_staff_id,
    replacementStaffId,
    appliedBy,
  } = leaveData;

  // Calculate days requested.
  const startDate = new Date(start_date);
  const endDate = new Date(end_date);
  const daysDifference = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;

  if (daysDifference <= 0 || startDate > endDate) {
    throw new Error('INVALID_DATE_RANGE');
  }

  // Resolve identifier first so balance + insert both use the int FK.
  const staff = await fetchStaffInfo(staff_id);
  if (!staff) {
    throw new Error('STAFF_NOT_FOUND');
  }

  // Check leave balance for the requested year + leave type.
  const balance = await getLeaveBalanceByType(
    staff.id,
    startDate.getFullYear(),
    { leaveType: leave_type },
  );
  if (balance.length === 0 || balance[0].days_remaining < daysDifference) {
    throw new Error('INSUFFICIENT_LEAVE_BALANCE');
  }

  const requestedReplacementId = replacement_staff_id ?? replacementStaffId;

  // Stamp tenant_id explicitly from the resolved staff row. Both tables carry a
  // GUC-reading DEFAULT, but a bare prisma.$transaction never sets
  // app.current_tenant_id, so the default would misfile every row on the
  // default tenant (862b78de pattern).
  const tenantId = requireTenantId(staff.tenant_id);

  // Create leave application and optional replacement request atomically,
  // so roster coverage can see both sides of the same leave event.
  const { application, replacementRequest } = await prisma.$transaction(async tx => {
    const createdApplication = await tx.leave_applications.create({
      data: {
        tenant_id: tenantId,
        staff_id: staff.id,
        leave_type,
        start_date: startDate,
        end_date: endDate,
        days_taken: daysDifference,
        reason: reason ?? null,
        emergency_contact: emergency_contact ?? null,
        status: 'pending',
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

    let createdReplacement = null;
    if (requestedReplacementId != null && String(requestedReplacementId).trim() !== '') {
      const replacementUserId = Number.parseInt(String(requestedReplacementId), 10);
      if (!Number.isInteger(replacementUserId) || replacementUserId <= 0) {
        throw new Error('REPLACEMENT_STAFF_NOT_FOUND');
      }
      if (replacementUserId === staff.id) {
        throw new Error('REPLACEMENT_STAFF_SAME_AS_REQUESTER');
      }

      const replacementUser = await tx.users.findFirst({
        where: { id: replacementUserId, is_active: true, tenant_id: tenantId },
        select: { id: true },
      });
      if (!replacementUser) {
        throw new Error('REPLACEMENT_STAFF_NOT_FOUND');
      }

      createdReplacement = await tx.replacement_requests.create({
        data: {
          tenant_id: tenantId,
          leave_request_id: createdApplication.id,
          requester_id: staff.id,
          replacement_staff_id: replacementUser.id,
          dates: JSON.stringify({
            start_date,
            end_date,
            days: daysDifference,
          }),
          status: 'pending',
          requester_message: reason ?? null,
        },
        select: {
          id: true,
          leave_request_id: true,
          requester_id: true,
          replacement_staff_id: true,
          dates: true,
          status: true,
          requested_at: true,
        },
      });
    }

    return { application: createdApplication, replacementRequest: createdReplacement };
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
      // tenant_id stamped from the same resolved tenant the leave rows carry;
      // the column DEFAULT reads app.current_tenant_id and falls back to the
      // literal default tenant when that GUC is unset, which would hide the
      // approval request from the supervisor's tenant-filtered list.
      // `updated_at` is NOT NULL with no DEFAULT — omitting it made this create
      // throw, so the supervisor was never notified at all.
      await prisma.notifications.create({
        data: {
          tenant_id: tenantId,
          user_id: supervisor.users.id,
          phone: supervisor.users.phone,
          title: 'Leave Application Pending Approval',
          body: `${staff.name} has applied for ${leave_type} from ${fmt(startDate)} to ${fmt(endDate)}`,
          type: 'leave_application',
          related_id: application.id,
          updated_at: new Date(),
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
      status: normalizeLeaveStatus(application.status),
    },
    replacementRequest,
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
 * Check if user is viewing their own data.
 * Tolerates int / UUID / EMP- identifiers (same shapes fetchStaffInfo
 * accepts). Trivially returns true when the URL identifier is already
 * the JWT uid — saves a DB round-trip on the most common call path.
 */
export const isUserViewingOwnData = async (staffId, userUid) => {
  if (!userUid) return false;
  if (String(staffId) === String(userUid)) return true;
  const staff = await fetchStaffInfo(staffId);
  return staff?.uid === userUid;
};

/** Same as above; preserved as a separate name for the apply-leave path. */
export const isUserApplyingOwnLeave = async (staffId, userUid) => {
  if (!userUid) return false;
  if (String(staffId) === String(userUid)) return true;
  const staff = await fetchStaffInfo(staffId);
  return staff?.uid === userUid;
};
