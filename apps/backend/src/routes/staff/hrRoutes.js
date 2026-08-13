import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as grievanceController from '../../controllers/staff/grievanceController.js';
import * as housekeepingController from '../../controllers/staff/housekeepingController.js';
import * as hrController from '../../controllers/staff/hrController.js';
import * as incidentController from '../../controllers/staff/incidentController.js';
import * as overtimeController from '../../controllers/staff/overtimeController.js';
import * as payrollController from '../../controllers/staff/payrollController.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import * as shiftController from '../../controllers/staff/shiftController.js';
import { staffAccessGuard } from '../../middleware/staffAccessMiddleware.js';
import { STAFF_ACCESS_POLICY_CODES } from '../../services/security/staffAccessDecisionService.js';
import {
  performanceReviewValidation,
  leaveApplicationValidation,
  updateOnboardingTaskValidation,
  exportReportValidation
} from '../../validators/staff/hrValidators.js';

const router = express.Router();
const guardHrReportView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_REPORT_VIEW, {
  allowNoTarget: true,
});
const guardProfileViewByStaffId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW, {
  targetParam: 'staff_id',
  requireTarget: true,
});
const guardProfileWriteByStaffId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE, {
  targetParam: 'staff_id',
  requireTarget: true,
});
const guardPerformanceReviewWrite = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE, {
  targetSelector: (req) => req.body?.staff_id,
  requireTarget: true,
});
const guardLeaveSelfView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_VIEW, {
  selfIfNoTarget: true,
  requireTarget: true,
});
const guardLeaveViewByStaffId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_VIEW, {
  targetParam: 'staff_id',
  requireTarget: true,
});
const guardLeaveApply = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_WRITE, {
  targetSelector: (req) => req.body?.staff_id || req.user?.uid,
  requireTarget: true,
});
const guardPayrollSelfView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_VIEW, {
  selfIfNoTarget: true,
  requireTarget: true,
});
const guardPayrollSelfWrite = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_SELF_WRITE, {
  selfIfNoTarget: true,
  requireTarget: true,
});
const guardPayslipView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_VIEW, {
  resourceType: 'payslip',
  resourceIdParam: 'id',
  requireTarget: true,
});
// Sol Ultra #30/#36: overtime + replacement APPROVAL are manager/HR actions, but
// this chart-side HR mount registered them with no authority guard (any staff in
// the block could approve). The people-ops mount (staffAdminRoutes) already gates
// these exact handlers with STAFF_LEAVE_WRITE — apply the same capability here.
const guardHrApprovalCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_WRITE, {
  allowNoTarget: true,
});

wrapAutoRBAC(router, 'staffHRRoutes', {
  get: [
    // HR Dashboard
    ['/dashboard', guardHrReportView, hrController.getHRDashboard],
    
    // Performance Management
    ['/performance-report', guardHrReportView, hrController.getPerformanceReport],
    
    // Onboarding
    ['/onboarding/:staff_id', guardProfileViewByStaffId, hrController.getOnboardingChecklist],
    
    // Leave Management
    ['/leave/my', guardLeaveSelfView, hrController.getMyLeaveApplications],
    ['/leave/balance', guardLeaveSelfView, hrController.getMyLeaveBalance],
    ['/leave-balance/:staff_id', guardLeaveViewByStaffId, hrController.getStaffLeaveBalance],
    
    // Department Analytics
    ['/department/:department/summary', guardHrReportView, hrController.getDepartmentStaffSummary],
    
    // Attendance Analytics
    ['/attendance-analytics', guardHrReportView, hrController.getAttendanceAnalytics],
    
    // Export Reports
    ['/export-report', guardHrReportView, exportReportValidation, hrController.exportStaffReport],

    // Replacement requests
    ['/replacement/pending', replacementController.getPendingReplacements],
    ['/replacement/history', replacementController.getReplacementHistory],

    // Shifts
    ['/shifts', shiftController.getAllShifts],
    // Backward-compatible staff desktop/mobile alias. The canonical route is
    // /shift/my-shift, but older clients called /shift directly.
    ['/shift', shiftController.getMyShift],
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
    ['/payslips', guardPayrollSelfView, payrollController.getMyPayslips],
    ['/payslips/:id', guardPayslipView, payrollController.getPayslipDetail],
    // Aliases matching the admin /dashboard/my-payslips page's API config
    // (apps/admin/src/lib/api-config.ts → myWork.payslips.*). Controllers are
    // the same; only the URL shape differs.
    ['/payroll/my-payslips', guardPayrollSelfView, payrollController.getMyPayslips],
    ['/payroll/my-payslips/:id', guardPayslipView, payrollController.getPayslipDetail],
    ['/payroll/my-payslips/:id/download', guardPayslipView, payrollController.downloadPayslip],
    ['/payroll/tax-summary', guardPayrollSelfView, payrollController.getMyTaxSummary],
    ['/payroll/advances', guardPayrollSelfView, payrollController.getMyAdvances],
    // Compliance: staff self-service
    ['/payroll/declarations', guardPayrollSelfView, payrollController.getMyDeclarations],
    ['/payroll/queries', guardPayrollSelfView, payrollController.getMyPayslipQueries],
  ],
  
  post: [
    ['/payslips/:id/password', guardPayslipView, payrollController.revealPayslipPassword],
    ['/payroll/my-payslips/:id/password', guardPayslipView, payrollController.revealPayslipPassword],
    // Create Performance Review
    ['/performance-review', performanceReviewValidation, guardPerformanceReviewWrite, hrController.createPerformanceReview],
    
    // Apply for Leave
    ['/leave/apply', hrController.normalizeLeaveApplicationRequest, guardLeaveApply, leaveApplicationValidation, hrController.applyForLeave],

    // Replacement requests
    ['/replacement/request', replacementController.requestReplacement],
    ['/replacement/:id/respond', replacementController.respondToReplacement],
    ['/replacement/:id/hr-approve', guardHrApprovalCollection, replacementController.hrApproveReplacement],

    // Overtime
    ['/overtime/request', overtimeController.requestOvertime],
    ['/overtime/:id/approve', guardHrApprovalCollection, overtimeController.approveOvertime],

    // Incident Reports (staff submit)
    ['/incidents/submit', incidentController.submitIncident],

    // Grievances (staff submit)
    ['/grievances/submit', grievanceController.submitGrievance],

    // Housekeeping (staff submit)
    ['/housekeeping/log', housekeepingController.submitCleaningLog],
    ['/housekeeping/request', housekeepingController.raiseRequest],
    ['/housekeeping/requests/:id/start', housekeepingController.startRequest],
    ['/housekeeping/requests/:id/complete', housekeepingController.completeRequest],
    // Compliance: staff self-service POST
    ['/payroll/declarations/submit', guardPayrollSelfWrite, payrollController.upsertDeclaration],
    ['/payroll/queries/raise', guardPayrollSelfWrite, payrollController.raisePayslipQuery],
  ],
  
  put: [
    // Update Onboarding Task
    ['/onboarding/:staff_id/task', updateOnboardingTaskValidation, guardProfileWriteByStaffId, hrController.updateOnboardingTask]
  ]
});

export default router;
