// src/services/staff/hr/index.js

/**
 * HR Services Export Hub
 * 
 * This file serves as the central export point for all HR-related services.
 * Import from here to access any HR functionality.
 * 
 * @module hr
 */

// Dashboard Service - HR dashboard and overview metrics
export { 
  getHRDashboardData 
} from './dashboardService.js';

// Performance Service - Performance reviews and evaluations
export { 
  generatePerformanceReport, 
  createPerformanceReview 
} from './performanceService.js';

// Onboarding Service - New employee onboarding management
export { 
  getOnboardingChecklist, 
  updateOnboardingTask,
  isUserViewingOwnOnboarding 
} from './onboardingService.js';

// Leave Service - Leave applications and balance management
export { 
  getStaffLeaveBalance, 
  applyForLeave,
  isUserApplyingOwnLeave,
  isUserViewingOwnData
} from './leaveService.js';

// Department Service - Department analytics and attendance
export { 
  getDepartmentStaffSummary, 
  getAttendanceAnalytics
} from './departmentService.js';

// Reporting Service - Generate various HR reports
export { 
  generateStaffReport
} from './reportingService.js';

// Re-export constants for convenience
export * from './constants.js';

/**
 * Service Documentation:
 * 
 * Dashboard Functions:
 * - getHRDashboardData(timeframe) - Get comprehensive HR metrics
 * 
 * Performance Functions:
 * - generatePerformanceReport(queryParams) - Generate performance analytics
 * - createPerformanceReview(reviewData) - Create new performance review
 * 
 * Onboarding Functions:
 * - getOnboardingChecklist(staffId) - Get onboarding tasks and progress
 * - updateOnboardingTask(staffId, taskId, completed, completedBy) - Update task
 * - isUserViewingOwnOnboarding(staffId, userUid) - Permission check
 * 
 * Leave Management Functions:
 * - getStaffLeaveBalance(staffId, year) - Get leave balance for a year
 * - applyForLeave(leaveData) - Submit new leave application
 * - isUserApplyingOwnLeave(staffId, userUid) - Permission check
 * - isUserViewingOwnData(staffId, userUid) - Permission check
 * 
 * Department Analytics Functions:
 * - getDepartmentStaffSummary(department) - Get department statistics
 * - getAttendanceAnalytics(queryParams) - Get attendance analytics
 * 
 * Reporting Functions:
 * - generateStaffReport(reportParams) - Generate HR reports (CSV/JSON)
 */