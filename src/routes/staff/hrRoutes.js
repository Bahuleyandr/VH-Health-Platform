import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as hrController from '../../controllers/staff/hrController.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import * as overtimeController from '../../controllers/staff/overtimeController.js';
import * as shiftController from '../../controllers/staff/shiftController.js';
import * as incidentController from '../../controllers/staff/incidentController.js';
import * as grievanceController from '../../controllers/staff/grievanceController.js';
import * as housekeepingController from '../../controllers/staff/housekeepingController.js';
import * as payrollController from '../../controllers/staff/payrollController.js';
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

    // Housekeeping (staff)
    ['/housekeeping/zones', housekeepingController.getZones],
    ['/housekeeping/logs/my', housekeepingController.getMyCleaningLogs],
    ['/housekeeping/requests/my', housekeepingController.getMyRequests],
    ['/housekeeping/requests/:id', housekeepingController.getRequestDetail],

    // Payroll (staff: view own payslips)
    ['/payslips', payrollController.getMyPayslips],
    ['/payslips/:id', payrollController.getPayslipDetail],
    ['/payroll/tax-summary', payrollController.getMyTaxSummary],
    ['/payroll/advances', payrollController.getMyAdvances],
    // Compliance: staff self-service
    ['/payroll/declarations', payrollController.getMyDeclarations],
    ['/payroll/queries', payrollController.getMyPayslipQueries],
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

    // Housekeeping (staff submit)
    ['/housekeeping/log', housekeepingController.submitCleaningLog],
    ['/housekeeping/request', housekeepingController.raiseRequest],
    ['/housekeeping/requests/:id/complete', housekeepingController.completeRequest],
    // Compliance: staff self-service POST
    ['/payroll/declarations/submit', payrollController.upsertDeclaration],
    ['/payroll/queries/raise', payrollController.raisePayslipQuery],
  ],
  
  put: [
    // Update Onboarding Task
    ['/onboarding/:staff_id/task', updateOnboardingTaskValidation, hrController.updateOnboardingTask]
  ]
});

export default router;