// controllers/staff/hrController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as hrService from '../../services/staff/hr/index.js';
import { success, error } from '../../utils/responseHelper.js';

// Import all HR services from the index

async function resolveCurrentStaffRef(req) {
  if (!req.user?.uid) return null;
  const user = await prisma.users.findUnique({
    where: { uid: req.user.uid },
    select: {
      id: true,
      uid: true,
      staff: {
        select: { employee_id: true },
        take: 1,
      },
    },
  });
  if (!user?.staff?.length) return null;
  return { id: user.id, uid: user.uid };
}

function formatISODate(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function inclusiveDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.max(1, Math.ceil((end - start) / 86_400_000) + 1);
}

export function normalizeLeaveApplicationRequest(req, _res, next) {
  const rawLeaveType = req.body?.leave_type || req.body?.type;
  req.body = {
    ...(req.body || {}),
    staff_id: req.body?.staff_id || req.user?.uid,
    leave_type: rawLeaveType == null ? rawLeaveType : String(rawLeaveType).trim().toUpperCase(),
  };
  next();
}

// Get HR Dashboard
export const getHRDashboard = async (req, res) => {
  try {
    const { timeframe = 'current_month' } = req.query;
    const userRole = req.user?.role;
    
    // Only HR_STAFF and ADMIN can access HR dashboard
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      return error(res, 'Access denied: HR privileges required', HTTP_STATUS.FORBIDDEN);
    }

    const dashboardData = await hrService.getHRDashboardData(timeframe);

    success(res, dashboardData, 'HR dashboard data retrieved successfully');

  } catch (err) {
    logger.error('HR Dashboard Error:', err);
    error(res, 'Failed to load HR dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get Performance Report
export const getPerformanceReport = async (req, res) => {
  try {
    const { 
      department, 
      timeframe = 'quarterly', 
      start_date, 
      end_date 
    } = req.query;
    
    const userRole = req.user?.role;
    const generatedBy = req.user?.name;
    
    // Only HR_STAFF, ADMIN, and DOCTOR can generate performance reports
    if (!['ADMIN', 'HR_STAFF', 'DOCTOR'].includes(userRole)) {
      return error(res, 'Access denied: Insufficient privileges for performance reports', HTTP_STATUS.FORBIDDEN);
    }

    const report = await hrService.generatePerformanceReport({
      department,
      timeframe,
      start_date,
      end_date,
      userRole
    });

    success(res, {
      ...report,
      generatedBy
    }, 'Staff performance report generated successfully');

  } catch (err) {
    logger.error('Performance Report Error:', err);
    error(res, 'Failed to generate performance report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Create Performance Review
export const createPerformanceReview = async (req, res) => {
  try {
    const {
      staff_id, 
      rating, 
      review_period, 
      reviewer_comments,
      goals_achieved, 
      areas_for_improvement, 
      future_goals,
      training_recommendations
    } = req.body;

    const reviewerId = req.user?.uid;
    const reviewerName = req.user?.name;
    const reviewerRole = req.user?.role;

    // Only HR_STAFF, ADMIN, and DOCTOR can create performance reviews
    if (!['ADMIN', 'HR_STAFF', 'DOCTOR'].includes(reviewerRole)) {
      return error(res, 'Access denied: Insufficient permissions to create performance reviews', HTTP_STATUS.FORBIDDEN);
    }

    const review = await hrService.createPerformanceReview({
      staff_id,
      rating,
      review_period,
      reviewer_comments,
      goals_achieved,
      areas_for_improvement,
      future_goals,
      training_recommendations,
      reviewerId,
      reviewerName
    });

    if (!review) {
      return error(res, 'Failed to create performance review', HTTP_STATUS.BAD_REQUEST);
    }

    success(res, {
      review: review.review,
      staffInfo: review.staffInfo,
      reviewer: reviewerName
    }, 'Performance review created successfully');

  } catch (err) {
    logger.error('Create Performance Review Error:', err);
    
    if (err.message === 'STAFF_NOT_FOUND') {
      error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    } else {
      error(res, 'Failed to create performance review', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

// Get Onboarding Checklist
export const getOnboardingChecklist = async (req, res) => {
  try {
    const { staff_id } = req.params;
    const userRole = req.user?.role;
    
    // Only HR_STAFF, ADMIN, and the staff member themselves can view onboarding
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      // Check if user is viewing their own onboarding
      const userCheck = await hrService.isUserViewingOwnOnboarding(staff_id, req.user?.uid);
      if (!userCheck) {
        return error(res, 'Access denied: Cannot view other staff onboarding', HTTP_STATUS.FORBIDDEN);
      }
    }

    const onboardingData = await hrService.getOnboardingChecklist(staff_id);

    if (!onboardingData) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, onboardingData, 'Staff onboarding information retrieved successfully');

  } catch (err) {
    logger.error('Onboarding Checklist Error:', err);
    error(res, 'Failed to retrieve onboarding information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update Onboarding Task
export const updateOnboardingTask = async (req, res) => {
  try {
    const { staff_id } = req.params;
    const { task_id, completed, completed_by } = req.body;
    const userRole = req.user?.role;
    const updatedBy = req.user?.uid;
    
    // Only HR_STAFF and ADMIN can update onboarding tasks
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      return error(res, 'Access denied: HR privileges required', HTTP_STATUS.FORBIDDEN);
    }

    const result = await hrService.updateOnboardingTask(
      staff_id,
      task_id,
      completed,
      completed_by || updatedBy
    );

    if (!result) {
      return error(res, 'Failed to update onboarding task', HTTP_STATUS.BAD_REQUEST);
    }

    success(res, result, 'Onboarding task updated successfully');

  } catch (err) {
    logger.error('Update Onboarding Task Error:', err);
    error(res, 'Failed to update onboarding task', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get Staff Leave Balance
export const getStaffLeaveBalance = async (req, res) => {
  try {
    const { staff_id } = req.params;
    const { year = new Date().getFullYear() } = req.query;
    const userRole = req.user?.role;
    
    // Check permissions
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      // Check if user is viewing their own leave balance
      const userCheck = await hrService.isUserViewingOwnData(staff_id, req.user?.uid);
      if (!userCheck) {
        return error(res, 'Access denied: Cannot view other staff leave balance', HTTP_STATUS.FORBIDDEN);
      }
    }

    const leaveData = await hrService.getStaffLeaveBalance(staff_id, year);

    if (!leaveData) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, leaveData, 'Staff leave balance retrieved successfully');

  } catch (err) {
    logger.error('Get Leave Balance Error:', err);
    error(res, 'Failed to retrieve leave balance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getMyLeaveApplications = async (req, res) => {
  try {
    const staff = await resolveCurrentStaffRef(req);
    if (!staff) {
      return success(res, [], 'Leave applications retrieved successfully');
    }

    const rows = await prisma.leave_applications.findMany({
      where: { staff_id: staff.id },
      select: {
        id: true,
        leave_type: true,
        start_date: true,
        end_date: true,
        days_taken: true,
        reason: true,
        status: true,
        applied_date: true,
        reviewed_by: true,
        review_notes: true,
      },
      orderBy: { applied_date: 'desc' },
      take: 50,
    });

    const applications = rows.map((leave) => ({
      id: leave.id,
      leave_type: leave.leave_type,
      type: leave.leave_type,
      start_date: formatISODate(leave.start_date),
      end_date: formatISODate(leave.end_date),
      days: Number(leave.days_taken) || inclusiveDays(leave.start_date, leave.end_date),
      reason: leave.reason,
      status: String(leave.status || 'pending').toLowerCase(),
      created_at: leave.applied_date,
      reviewed_by: leave.reviewed_by,
      review_notes: leave.review_notes,
    }));

    return success(res, applications, 'Leave applications retrieved successfully');
  } catch (err) {
    logger.error('Get My Leave Applications Error:', err);
    return error(res, 'Failed to retrieve leave applications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getMyLeaveBalance = async (req, res) => {
  try {
    const staff = await resolveCurrentStaffRef(req);
    const emptyBalance = { casual: 0, sick: 0, earned: 0, annual: 0 };
    if (!staff) {
      return success(res, emptyBalance, 'Leave balance retrieved successfully');
    }

    const leaveData = await hrService.getStaffLeaveBalance(
      String(staff.id),
      req.query.year || new Date().getFullYear()
    );
    const balance = { ...emptyBalance };
    for (const leave of leaveData?.leaveBalance || []) {
      const key = String(leave.leave_type || '').toLowerCase();
      if (key === 'casual') balance.casual = Number(leave.days_remaining) || 0;
      if (key === 'sick') balance.sick = Number(leave.days_remaining) || 0;
      if (key === 'earned') balance.earned = Number(leave.days_remaining) || 0;
      if (key === 'annual') balance.annual = Number(leave.days_remaining) || 0;
    }

    return success(res, balance, 'Leave balance retrieved successfully');
  } catch (err) {
    logger.error('Get My Leave Balance Error:', err);
    return error(res, 'Failed to retrieve leave balance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Apply for Leave
export const applyForLeave = async (req, res) => {
  try {
    const {
      staff_id,
      leave_type,
      type,
      start_date,
      end_date,
      reason,
      emergency_contact,
      replacement_staff_id
    } = req.body;
    
    const appliedBy = req.user?.uid;
    const userRole = req.user?.role;
    
    // Staff can apply for their own leave, HR can apply on behalf of others
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      const userCheck = await hrService.isUserApplyingOwnLeave(staff_id, appliedBy);
      if (!userCheck) {
        return error(res, 'Access denied: Cannot apply leave for other staff', HTTP_STATUS.FORBIDDEN);
      }
    }

    const leaveApplication = await hrService.applyForLeave({
      staff_id: staff_id || appliedBy,
      leave_type: leave_type || type,
      start_date,
      end_date,
      reason,
      emergency_contact,
      replacement_staff_id,
      appliedBy
    });

    if (!leaveApplication) {
      return error(res, 'Failed to apply for leave', HTTP_STATUS.BAD_REQUEST);
    }

    success(res, leaveApplication, 'Leave application submitted successfully');

  } catch (err) {
    logger.error('Apply Leave Error:', err);
    
    if (err.message === 'INSUFFICIENT_LEAVE_BALANCE') {
      error(res, 'Insufficient leave balance', HTTP_STATUS.BAD_REQUEST);
    } else if (err.message === 'INVALID_DATE_RANGE') {
      error(res, 'Invalid date range for leave application', HTTP_STATUS.BAD_REQUEST);
    } else if (err.message === 'STAFF_NOT_FOUND') {
      error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    } else if (err.message === 'REPLACEMENT_STAFF_NOT_FOUND') {
      error(res, 'Replacement staff member not found', HTTP_STATUS.NOT_FOUND);
    } else if (err.message === 'REPLACEMENT_STAFF_SAME_AS_REQUESTER') {
      error(res, 'Replacement staff must be different from requester', HTTP_STATUS.BAD_REQUEST);
    } else {
      error(res, 'Failed to apply for leave', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

// Get Department Staff Summary
export const getDepartmentStaffSummary = async (req, res) => {
  try {
    const { department } = req.params;
    const userRole = req.user?.role;
    
    // Only HR_STAFF, ADMIN, and Department Heads can view department summaries
    if (!['ADMIN', 'HR_STAFF', 'DOCTOR'].includes(userRole)) {
      return error(res, 'Access denied: Insufficient privileges', HTTP_STATUS.FORBIDDEN);
    }

    const summary = await hrService.getDepartmentStaffSummary(department);

    success(res, summary, `${department} department staff summary retrieved successfully`);

  } catch (err) {
    logger.error('Department Summary Error:', err);
    error(res, 'Failed to retrieve department staff summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get Attendance Analytics
export const getAttendanceAnalytics = async (req, res) => {
  try {
    const { 
      department, 
      start_date, 
      end_date,
      group_by = 'day' // day, week, month
    } = req.query;
    
    const userRole = req.user?.role;
    
    // Only HR_STAFF and ADMIN can view attendance analytics
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      return error(res, 'Access denied: HR privileges required', HTTP_STATUS.FORBIDDEN);
    }

    const analytics = await hrService.getAttendanceAnalytics({
      department,
      start_date,
      end_date,
      group_by
    });

    success(res, analytics, 'Attendance analytics retrieved successfully');

  } catch (err) {
    logger.error('Attendance Analytics Error:', err);
    error(res, 'Failed to retrieve attendance analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Export Staff Report
export const exportStaffReport = async (req, res) => {
  try {
    const { 
      report_type, // attendance, performance, leave, payroll
      type,
      department,
      start_date,
      end_date,
      format = 'csv' // csv, pdf
    } = req.query;
    const selectedReportType = report_type || type;
    
    const userRole = req.user?.role;
    const generatedBy = req.user?.name;
    
    // Only HR_STAFF and ADMIN can export reports
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      return error(res, 'Access denied: HR privileges required', HTTP_STATUS.FORBIDDEN);
    }

    const report = await hrService.generateStaffReport({
      report_type: selectedReportType,
      department,
      start_date,
      end_date,
      format,
      generatedBy
    });

    if (!report) {
      return error(res, 'Failed to generate report', HTTP_STATUS.BAD_REQUEST);
    }

    // For CSV format, set appropriate headers
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=staff_${selectedReportType}_report_${new Date().toISOString().split('T')[0]}.csv`);
      return res.send(report.data);
    }

    success(res, report, 'Staff report generated successfully');

  } catch (err) {
    logger.error('Export Staff Report Error:', err);
    // Honor typed errors: an invalid/absent report_type is a 400 from the
    // service, not a server fault (2026-08-22 audit).
    error(
      res,
      err.statusCode ? err.message : 'Failed to export staff report',
      err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};
