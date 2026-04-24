// src/services/staff/hr/leaveService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

/**
 * Get staff leave balance for a specific year
 * @param {number} staffId - Staff ID
 * @param {number} year - Year to check balance for
 * @returns {Object} Leave balance and history
 */
export const getStaffLeaveBalance = async (staffId, year) => {
  const staffCheck = await prisma.$queryRawUnsafe(
    'SELECT u.name, s.employee_id, s.hire_date FROM users u JOIN staff s ON u.uid = s.user_id WHERE u.id = $1',
    staffId
  );

  if (staffCheck.length === 0) {
    return null;
  }

  const staff = staffCheck[0];

  // Get leave entitlement and usage
  const leaveData = await prisma.$queryRawUnsafe(`
    SELECT 
      lt.leave_type,
      lt.annual_entitlement,
      COALESCE(SUM(la.days_taken), 0) as days_used,
      lt.annual_entitlement - COALESCE(SUM(la.days_taken), 0) as days_remaining
    FROM leave_types lt
    LEFT JOIN leave_applications la ON lt.leave_type = la.leave_type 
      AND la.staff_id = $1 
      AND EXTRACT(YEAR FROM la.start_date) = $2
      AND la.status = 'APPROVED'
    GROUP BY lt.leave_type, lt.annual_entitlement
    ORDER BY lt.leave_type
  `, staffId, year);

  // Get leave history
  const leaveHistory = await prisma.$queryRawUnsafe(`
    SELECT 
      leave_type,
      start_date,
      end_date,
      days_taken,
      status,
      reason,
      approved_by,
      approved_date
    FROM leave_applications
    WHERE staff_id = $1 AND EXTRACT(YEAR FROM start_date) = $2
    ORDER BY start_date DESC
  `, staffId, year);

  return {
    staff: {
      name: staff.name,
      employee_id: staff.employee_id,
      hire_date: new Date(staff.hire_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      })
    },
    year,
    leaveBalance: leaveData,
    leaveHistory: leaveHistory.map(leave => ({
      ...leave,
      start_date: new Date(leave.start_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      end_date: new Date(leave.end_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      approved_date: leave.approved_date ? new Date(leave.approved_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }) : null
    })),
    summary: {
      total_entitled: leaveData.reduce((sum, leave) => sum + leave.annual_entitlement, 0),
      total_used: leaveData.reduce((sum, leave) => sum + parseFloat(leave.days_used), 0),
      total_remaining: leaveData.reduce((sum, leave) => sum + leave.days_remaining, 0)
    }
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
    appliedBy
  } = leaveData;

  // Calculate days requested
  const startDate = new Date(start_date);
  const endDate = new Date(end_date);
  const daysDifference = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;

  // Validate date range
  if (daysDifference <= 0 || startDate > endDate) {
    throw new Error('INVALID_DATE_RANGE');
  }

  // Check leave balance
  const balanceCheck = await prisma.$queryRawUnsafe(`
    SELECT 
      lt.annual_entitlement,
      COALESCE(SUM(la.days_taken), 0) as days_used,
      lt.annual_entitlement - COALESCE(SUM(la.days_taken), 0) as days_remaining
    FROM leave_types lt
    LEFT JOIN leave_applications la ON lt.leave_type = la.leave_type 
      AND la.staff_id = $1 
      AND EXTRACT(YEAR FROM la.start_date) = EXTRACT(YEAR FROM $2::date)
      AND la.status = 'APPROVED'
    WHERE lt.leave_type = $3
    GROUP BY lt.leave_type, lt.annual_entitlement
  `, staff_id, start_date, leave_type);

  if (balanceCheck.length === 0 || balanceCheck[0].days_remaining < daysDifference) {
    throw new Error('INSUFFICIENT_LEAVE_BALANCE');
  }

  // Get staff details
  const staffInfo = await prisma.$queryRawUnsafe(
    'SELECT u.name, s.employee_id, s.department, s.supervisor_id FROM users u JOIN staff s ON u.uid = s.user_id WHERE u.id = $1',
    staff_id
  );

  if (staffInfo.length === 0) {
    throw new Error('STAFF_NOT_FOUND');
  }

  const staff = staffInfo[0];

  // Create leave application
  const applicationResult = await prisma.$queryRawUnsafe(`
    INSERT INTO leave_applications (
      staff_id, leave_type, start_date, end_date, days_taken,
      reason, emergency_contact, status, applied_by, applied_date,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    RETURNING id, staff_id, leave_type, start_date, end_date, days_taken, reason, emergency_contact, status, applied_by, applied_date, created_at
  `, 
    staff_id, leave_type, start_date, end_date, daysDifference,
    reason, emergency_contact, 'PENDING', appliedBy
  );

  // Create notification for supervisor
  if (staff.supervisor_id) {
    await prisma.$queryRawUnsafe(
      `INSERT INTO notifications (
        user_id, title, body, type, related_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      
        staff.supervisor_id,
        'Leave Application Pending Approval',
        `${staff.name} has applied for ${leave_type} from ${startDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })} to ${endDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}`,
        'leave_application',
        applicationResult[0].id
      
    );
  }

  logger.info(`📅 Leave application created for ${staff.name} (${staff_id}) - ${leave_type} for ${daysDifference} days`);

  return {
    application: {
      ...applicationResult[0],
      start_date: startDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      end_date: endDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      applied_date: new Date(applicationResult[0].applied_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    },
    staffInfo: {
      name: staff.name,
      employee_id: staff.employee_id,
      department: staff.department
    },
    leaveBalance: {
      days_requested: daysDifference,
      days_remaining_before: balanceCheck[0].days_remaining,
      days_remaining_after: balanceCheck[0].days_remaining - daysDifference
    }
  };
};

/**
 * Check if user is viewing their own data
 * @param {number} staffId - Staff ID
 * @param {string} userUid - User UID
 * @returns {boolean} True if viewing own data
 */
export const isUserViewingOwnData = async (staffId, userUid) => {
  const result = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM users WHERE id = $1 AND uid = $2',
    staffId, userUid
  );
  return result.length > 0;
};

/**
 * Check if user is applying for their own leave
 * @param {number} staffId - Staff ID
 * @param {string} userUid - User UID
 * @returns {boolean} True if applying for own leave
 */
export const isUserApplyingOwnLeave = async (staffId, userUid) => {
  const result = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM users WHERE id = $1 AND uid = $2',
    staffId, userUid
  );
  return result.length > 0;
};