// src/controllers/staff/staffAdminController.js
// Barrel file — re-exports from domain-specific controllers so existing
// imports (including the route file) continue to work unchanged.

export { getStaffAdminDashboard } from './staffAdminDashboardController.js';

export {
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
  bulkAttendanceCorrection,
  overrideAttendance,
  syncBiometricData,
} from './staffAdminAttendanceController.js';

export {
  getLeavePatterns,
  getAllLeaveRequests,
  bulkLeaveApproval,
  approveLeaveRequest,
  overrideLeaveBalance,
} from './staffAdminLeaveController.js';

export {
  getPerformanceAnalytics,
  getDepartmentAnalytics,
  getEfficiencyReport,
  getOvertimeReport,
  getTurnoverReport,
} from './staffAdminAnalyticsController.js';

export {
  getPendingReviews,
  getOnboardingStatus,
  approvePerformanceReview,
} from './staffAdminHRController.js';

export {
  advancedStaffSearch,
  exportStaffData,
  bulkShiftAssignment,
  generatePayrollData,
  updateStaffStatus,
  archiveStaffMember,
  purgeOldRecords,
} from './staffAdminOperationsController.js';

// Default export for legacy consumers
import { getPerformanceAnalytics, getDepartmentAnalytics, getEfficiencyReport, getOvertimeReport, getTurnoverReport } from './staffAdminAnalyticsController.js';
import { getAttendanceAnalytics, getAttendanceAnomalies, getLateArrivals, getEarlyDepartures, getAbsentReport, bulkAttendanceCorrection, overrideAttendance, syncBiometricData } from './staffAdminAttendanceController.js';
import { getStaffAdminDashboard } from './staffAdminDashboardController.js';
import { getPendingReviews, getOnboardingStatus, approvePerformanceReview } from './staffAdminHRController.js';
import { getLeavePatterns, getAllLeaveRequests, bulkLeaveApproval, approveLeaveRequest, overrideLeaveBalance } from './staffAdminLeaveController.js';
import { advancedStaffSearch, exportStaffData, bulkShiftAssignment, generatePayrollData, updateStaffStatus, archiveStaffMember, purgeOldRecords } from './staffAdminOperationsController.js';

export default {
  getStaffAdminDashboard,
  getAttendanceAnalytics,
  getPerformanceAnalytics,
  getDepartmentAnalytics,
  getLeavePatterns,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
  getPendingReviews,
  getAllLeaveRequests,
  getOnboardingStatus,
  getEfficiencyReport,
  getOvertimeReport,
  getTurnoverReport,
  advancedStaffSearch,
  exportStaffData,
  bulkAttendanceCorrection,
  bulkShiftAssignment,
  bulkLeaveApproval,
  overrideAttendance,
  overrideLeaveBalance,
  generatePayrollData,
  syncBiometricData,
  updateStaffStatus,
  approvePerformanceReview,
  approveLeaveRequest,
  archiveStaffMember,
  purgeOldRecords
};
