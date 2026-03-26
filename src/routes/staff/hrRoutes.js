import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as hrController from '../../controllers/staff/hrController.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import * as overtimeController from '../../controllers/staff/overtimeController.js';
import * as shiftController from '../../controllers/staff/shiftController.js';
import * as incidentController from '../../controllers/staff/incidentController.js';
import * as grievanceController from '../../controllers/staff/grievanceController.js';
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
    ['/export-report', exportReportValidation, hrController.exportStaffReport],

    // Replacement requests
    ['/replacement/pending', replacementController.getPendingReplacements],
    ['/replacement/history', replacementController.getReplacementHistory],

    // Shifts
    ['/shifts', shiftController.getAllShifts],
    ['/shift/my-shift', shiftController.getMyShift],

    // Overtime
    ['/overtime', overtimeController.getMyOvertimeRequests],

    // Incident Reports (staff)
    ['/incidents', incidentController.getMyIncidents],
    ['/incidents/:id', incidentController.getIncidentDetail],

    // Grievances (staff)
    ['/grievances', grievanceController.getMyGrievances],
    ['/grievances/:id', grievanceController.getGrievanceDetail],
  ],
  
  post: [
    // Create Performance Review
    ['/performance-review', performanceReviewValidation, hrController.createPerformanceReview],
    
    // Apply for Leave
    ['/leave/apply', leaveApplicationValidation, hrController.applyForLeave],

    // Replacement requests
    ['/replacement/request', replacementController.requestReplacement],
    ['/replacement/:id/respond', replacementController.respondToReplacement],
    ['/replacement/:id/hr-approve', replacementController.hrApproveReplacement],

    // Overtime
    ['/overtime/request', overtimeController.requestOvertime],
    ['/overtime/:id/approve', overtimeController.approveOvertime],

    // Incident Reports (staff submit)
    ['/incidents/submit', incidentController.submitIncident],

    // Grievances (staff submit)
    ['/grievances/submit', grievanceController.submitGrievance],
  ],
  
  put: [
    // Update Onboarding Task
    ['/onboarding/:staff_id/task', updateOnboardingTaskValidation, hrController.updateOnboardingTask]
  ]
});

export default router;