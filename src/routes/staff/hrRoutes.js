import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as hrController from '../../controllers/staff/hrController.js';
import {
  performanceReviewValidation,
  onboardingValidation,
  leaveApplicationValidation,
  updateOnboardingTaskValidation,
  exportReportValidation
} from '../../validators/staff/hrValidators.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffHRRoutes', {
  get: [
    // HR Dashboard
    ['/dashboard', hrController.getHRDashboard],
    
    // Performance Management
    ['/performance-report', hrController.getPerformanceReport],
    
    // Onboarding
    ['/onboarding/:staff_id', hrController.getOnboardingChecklist],
    
    // Leave Management
    ['/leave-balance/:staff_id', hrController.getStaffLeaveBalance],
    
    // Department Analytics
    ['/department/:department/summary', hrController.getDepartmentStaffSummary],
    
    // Attendance Analytics
    ['/attendance-analytics', hrController.getAttendanceAnalytics],
    
    // Export Reports
    ['/export-report', exportReportValidation, hrController.exportStaffReport]
  ],
  
  post: [
    // Create Performance Review
    ['/performance-review', performanceReviewValidation, hrController.createPerformanceReview],
    
    // Apply for Leave
    ['/leave/apply', leaveApplicationValidation, hrController.applyForLeave]
  ],
  
  put: [
    // Update Onboarding Task
    ['/onboarding/:staff_id/task', updateOnboardingTaskValidation, hrController.updateOnboardingTask]
  ]
});

export default router;