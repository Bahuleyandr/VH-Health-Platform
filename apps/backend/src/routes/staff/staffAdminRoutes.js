// src/routes/staff/staffAdminRoutes.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as attendanceAuditController from '../../controllers/staff/attendanceAuditController.js';
import * as attendanceController from '../../controllers/staff/attendanceController.js';
import * as bulkController from '../../controllers/staff/bulkAttendanceController.js';
import * as grievanceController from '../../controllers/staff/grievanceController.js';
import * as housekeepingController from '../../controllers/staff/housekeepingController.js';
import * as incidentController from '../../controllers/staff/incidentController.js';
import * as organizationHierarchyController from '../../controllers/staff/organizationHierarchyController.js';
import * as overtimeController from '../../controllers/staff/overtimeController.js';
import * as payrollController from '../../controllers/staff/payrollController.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import * as reportAuditController from '../../controllers/staff/reportAuditController.js';
import * as salaryRevisionController from '../../controllers/staff/salaryRevisionController.js';
import * as shiftController from '../../controllers/staff/shiftController.js';
import * as staffAdminController from '../../controllers/staff/staffAdminController.js';
import { PEOPLE_OPERATIONS_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { staffAccessGuard } from '../../middleware/staffAccessMiddleware.js';
import { STAFF_ACCESS_POLICY_CODES } from '../../services/security/staffAccessDecisionService.js';

const router = express.Router();
const reportReviewRoles = requireRole(...PEOPLE_OPERATIONS_ROUTE_ROLES);
const payrollHrSignerRoles = requireRole('HR_STAFF');
const payrollAdminSignerRoles = requireRole('ADMIN', 'SUPER_ADMIN');
const guardStaffReportView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_REPORT_VIEW, {
  allowNoTarget: true,
});
const guardDirectoryView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_DIRECTORY_VIEW, {
  allowNoTarget: true,
});
const guardProfileWriteCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE, {
  allowNoTarget: true,
});
const guardProfileWriteByStaffId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE, {
  resourceType: 'staff_row',
  resourceIdParam: 'staffId',
  requireTarget: true,
});
const guardAttendanceViewCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_VIEW, {
  allowNoTarget: true,
});
const guardAttendanceWriteCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_WRITE, {
  allowNoTarget: true,
});
const guardAttendanceWriteByBodyStaffId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_WRITE, {
  targetSelector: (req) => req.body?.staff_id || req.body?.staffId,
  requireTarget: true,
});
const guardAttendanceDisputeWrite = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_WRITE, {
  resourceType: 'attendance_dispute',
  resourceIdParam: 'id',
  requireTarget: true,
});
const guardLeaveViewCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_VIEW, {
  allowNoTarget: true,
});
const guardLeaveWriteCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_WRITE, {
  allowNoTarget: true,
});
const guardLeaveWriteByBodyStaffId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_WRITE, {
  targetSelector: (req) => req.body?.staff_id || req.body?.staffId,
  requireTarget: true,
});
const guardLeaveWriteByLeaveId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_WRITE, {
  resourceType: 'leave_application',
  resourceIdParam: 'leaveId',
  requireTarget: true,
});
const guardPayrollViewCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_VIEW, {
  allowNoTarget: true,
});
const guardPayrollWriteCollection = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_WRITE, {
  allowNoTarget: true,
});
const guardPayrollViewByStaffUid = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_VIEW, {
  targetParam: 'staffUid',
  requireTarget: true,
});
const guardPayrollWriteByStaffUid = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_WRITE, {
  targetParam: 'staffUid',
  requireTarget: true,
});
const guardPayrollWriteByPayslipId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_WRITE, {
  resourceType: 'payslip',
  resourceIdParam: 'id',
  requireTarget: true,
});
const guardPayrollWriteBySalaryRevisionId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_WRITE, {
  resourceType: 'salary_revision',
  resourceIdSelector: (req) => req.params?.revisionId || req.params?.id,
  requireTarget: true,
});
const guardPayrollViewBySalaryRevisionId = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_VIEW, {
  resourceType: 'salary_revision',
  resourceIdSelector: (req) => req.params?.revisionId || req.params?.id,
  requireTarget: true,
});
const guardPayrollWriteByBodyStaffUid = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_WRITE, {
  targetSelector: (req) => req.body?.staff_uid,
  requireTarget: true,
});

wrapAutoRBAC(router, 'staffAdminRoutes', {
  get: [
    // Staff Admin Dashboard
    ['/dashboard', guardStaffReportView, staffAdminController.getStaffAdminDashboard],
    
    // Analytics & Reports
    ['/analytics/attendance', guardAttendanceViewCollection, staffAdminController.getAttendanceAnalytics],
    ['/analytics/performance', guardStaffReportView, staffAdminController.getPerformanceAnalytics],
    ['/analytics/department-wise', guardStaffReportView, staffAdminController.getDepartmentAnalytics],
    ['/analytics/leave-patterns', guardLeaveViewCollection, staffAdminController.getLeavePatterns],
    
    // Attendance Management
    ['/attendance/anomalies', guardAttendanceViewCollection, staffAdminController.getAttendanceAnomalies],
    ['/attendance/late-arrivals', guardAttendanceViewCollection, staffAdminController.getLateArrivals],
    ['/attendance/early-departures', guardAttendanceViewCollection, staffAdminController.getEarlyDepartures],
    ['/attendance/absent-report', guardAttendanceViewCollection, staffAdminController.getAbsentReport],
    ['/attendance/disputes/pending', guardAttendanceViewCollection, attendanceController.getPendingDisputes],
    ['/attendance/geofence-breaches', guardAttendanceViewCollection, attendanceController.getGeofenceBreaches],
    ['/attendance/bulk-template', guardAttendanceWriteCollection, bulkController.getBulkTemplate],
    
    // HR Oversight
    ['/hr/pending-reviews', guardStaffReportView, staffAdminController.getPendingReviews],
    ['/hr/leave-requests', guardLeaveViewCollection, staffAdminController.getAllLeaveRequests],
    ['/hr/onboarding-status', guardStaffReportView, staffAdminController.getOnboardingStatus],
    ['/hierarchy', guardStaffReportView, organizationHierarchyController.getOrganizationHierarchy],

    // Leave Approvals (portal-facing)
    ['/leave/pending', guardLeaveViewCollection, staffAdminController.getAllLeaveRequests],
    ['/replacement/pending-hr', guardLeaveViewCollection, replacementController.getPendingReplacements],
    
    // Shifts
    ['/shifts', shiftController.getAllShifts],
    ['/shifts/presets', shiftController.getAllShifts],  // same — presets returned first

    // Overtime
    ['/overtime/pending', guardLeaveViewCollection, overtimeController.getPendingOvertimeRequests],
    
    // Staff Reports
    ['/reports/efficiency', guardStaffReportView, staffAdminController.getEfficiencyReport],
    ['/reports/overtime', guardStaffReportView, staffAdminController.getOvertimeReport],
    ['/reports/turnover', guardStaffReportView, staffAdminController.getTurnoverReport],
    
    // Search & Filter
    ['/search', guardDirectoryView, staffAdminController.advancedStaffSearch],
    
    // Export
    ['/export/:type', guardStaffReportView, staffAdminController.exportStaffData],

    // Incident Reports (admin)
    ['/incidents', reportReviewRoles, incidentController.getAllIncidents],
    ['/incidents/stats', reportReviewRoles, incidentController.getIncidentStats],

    // Audit routes — incidents/grievances
    ['/audit/dashboard', reportReviewRoles, reportAuditController.getAuditDashboard],
    ['/audit/activity', reportReviewRoles, reportAuditController.getAdminActivityReport],
    ['/audit/sla', reportReviewRoles, reportAuditController.getSLAReport],
    ['/audit/trail/:type/:id', reportReviewRoles, reportAuditController.getReportAuditTrail],

    // Audit routes — attendance
    ['/audit/attendance/dashboard', guardAttendanceViewCollection, attendanceAuditController.getAttendanceAuditDashboard],
    ['/audit/attendance/hr-activity', guardAttendanceViewCollection, attendanceAuditController.getAttendanceHRActivity],
    ['/audit/attendance/sla', guardAttendanceViewCollection, attendanceAuditController.getAttendanceSLAReport],
    ['/audit/attendance/geofence', guardAttendanceViewCollection, attendanceAuditController.getGeofenceBreachLog],
    ['/audit/attendance/leave/:id', guardLeaveViewCollection, attendanceAuditController.getLeaveAuditTrail],
    ['/incidents/:id', reportReviewRoles, incidentController.getAdminIncidentDetail],

    // Grievances (admin/HR)
    ['/grievances', reportReviewRoles, grievanceController.getAllGrievances],
    ['/grievances/stats', reportReviewRoles, grievanceController.getGrievanceStats],
    ['/grievances/:id', reportReviewRoles, grievanceController.getGrievanceAdminDetail],

    // Housekeeping (admin)
    ['/housekeeping/logs', housekeepingController.getAllCleaningLogs],
    ['/housekeeping/requests', housekeepingController.getAllRequests],
    ['/housekeeping/stats', housekeepingController.getHousekeepingStats],
    ['/housekeeping/zones', housekeepingController.getAdminZones],

    // Payroll (admin)
    ['/payroll/runs', guardPayrollViewCollection, payrollController.getPayrollRuns],
    ['/payroll/runs/:runId', guardPayrollViewCollection, payrollController.getPayrollRunDetail],
    ['/payroll/staff', guardPayrollViewCollection, payrollController.getStaffForPayroll],
    ['/payroll/salary/:staffUid', guardPayrollViewByStaffUid, payrollController.getStaffSalaryConfig],
    ['/payroll/revisions', guardPayrollViewCollection, salaryRevisionController.getRevisions],
    ['/payroll/revisions/:id', guardPayrollViewBySalaryRevisionId, salaryRevisionController.getRevisionDetail],
    ['/payroll/annual-review', guardPayrollViewCollection, salaryRevisionController.getAnnualReviewStatus],
    // New payroll features
    ['/payroll/export/summary', guardPayrollViewCollection, payrollController.exportPayrollSummary],
    ['/payroll/export/pf', guardPayrollViewCollection, payrollController.exportPFRegister],
    ['/payroll/export/esi', guardPayrollViewCollection, payrollController.exportESIRegister],
    ['/payroll/comparison', guardPayrollViewCollection, payrollController.getPayrollComparison],
    ['/payroll/advances', guardPayrollViewCollection, payrollController.getAllAdvances],
    // Compliance features — GET
    ['/payroll/fnf', guardPayrollViewCollection, payrollController.getFnFList],
    ['/payroll/gratuity', guardPayrollViewCollection, payrollController.getAllGratuityStatus],
    ['/payroll/declarations', guardPayrollViewCollection, payrollController.getAllDeclarations],
    ['/payroll/leave-encashment', guardPayrollViewCollection, payrollController.getLeaveEncashments],
    ['/payroll/queries', guardPayrollViewCollection, payrollController.getAllPayslipQueries],
    ['/payroll/compliance-calendar', guardPayrollViewCollection, payrollController.getComplianceCalendar],
    ['/payroll/bulk-revisions', guardPayrollViewCollection, payrollController.getBulkRevisions],
  ],
  
  post: [
    // Bulk Operations
    ['/bulk/attendance-correction', guardAttendanceWriteCollection, bulkController.bulkCorrectAttendance],
    ['/bulk/shift-assignment', guardProfileWriteCollection, staffAdminController.bulkShiftAssignment],
    ['/bulk/leave-approval', guardLeaveWriteCollection, staffAdminController.bulkLeaveApproval],

    // Attendance disputes
    ['/attendance/disputes/:id/resolve', guardAttendanceDisputeWrite, attendanceController.resolveDispute],

    // Leave approval actions (portal-facing)
    ['/leave/:leaveId/approve', guardLeaveWriteByLeaveId, staffAdminController.approveLeaveRequest],
    ['/leave/:leaveId/reject', guardLeaveWriteByLeaveId, staffAdminController.approveLeaveRequest],
    ['/replacement/:id/hr-approve', guardLeaveWriteCollection, replacementController.hrApproveReplacement],
    
    // Shift operations
    ['/shifts/assign', shiftController.assignShift],
    ['/shifts/custom', shiftController.createCustomShift],

    // Overtime operations
    ['/overtime/:id/approve', guardLeaveWriteCollection, overtimeController.approveOvertime],
    
    // Override Operations
    ['/override/attendance', guardAttendanceWriteByBodyStaffId, staffAdminController.overrideAttendance],
    ['/override/leave-balance', guardLeaveWriteByBodyStaffId, staffAdminController.overrideLeaveBalance],
    
    // System Operations
    ['/generate-payroll-data', guardPayrollWriteCollection, staffAdminController.generatePayrollData],
    ['/sync-biometric', guardAttendanceWriteCollection, staffAdminController.syncBiometricData],

    // Incident update (admin)
    ['/incidents/:id/update', reportReviewRoles, incidentController.updateIncident],

    // Grievance update (admin/HR)
    ['/grievances/:id/update', reportReviewRoles, grievanceController.updateGrievance],

    // Housekeeping (admin actions)
    ['/housekeeping/requests/:id/assign', housekeepingController.assignRequest],
    ['/housekeeping/logs/:id/verify', housekeepingController.verifyLog],
    ['/housekeeping/requests/:id/verify', housekeepingController.verifyRequest],
    ['/housekeeping/zones', housekeepingController.createZone],
    ['/housekeeping/requests/create', housekeepingController.adminCreateRequest],

    // Payroll (admin actions)
    [
      '/payroll/run',
      requireIdempotencyKey({ required: true, scope: 'payroll_run' }),
      guardPayrollWriteCollection,
      payrollController.runPayroll,
    ],
    ['/payroll/issue', guardPayrollWriteCollection, payrollController.issuePayslips],
    ['/payroll/salary/:staffUid', guardPayrollWriteByStaffUid, payrollController.upsertStaffSalaryConfig],
    // New payroll features — POST
    ['/payroll/tax-summary/all', guardPayrollWriteCollection, payrollController.generateAllTaxSummaries],
    ['/payroll/advances/create', guardPayrollWriteByBodyStaffUid, payrollController.createAdvance],
    ['/payroll/revisions/:revisionId/arrears', guardPayrollWriteBySalaryRevisionId, payrollController.calculateRevisionArrears],
    // Manual edit + dual sign
    ['/payroll/payslips/:id/edit', guardPayrollWriteByPayslipId, payrollController.manualEditPayslip],
    ['/payroll/runs/:runId/hr-sign', payrollHrSignerRoles, guardPayrollWriteCollection, payrollController.hrSignPayrollRun],
    ['/payroll/runs/:runId/admin-sign', payrollAdminSignerRoles, guardPayrollWriteCollection, payrollController.adminSignPayrollRun],
    ['/payroll/revisions/propose', guardPayrollWriteByBodyStaffUid, salaryRevisionController.proposeRevision],
    ['/payroll/revisions/:id/hr-sign', guardPayrollWriteBySalaryRevisionId, salaryRevisionController.hrSignRevision],
    ['/payroll/revisions/:id/admin-sign', guardPayrollWriteBySalaryRevisionId, salaryRevisionController.adminSignRevision],
    ['/payroll/revisions/:id/apply', guardPayrollWriteBySalaryRevisionId, salaryRevisionController.applyRevision],
    ['/payroll/revisions/:id/reject', guardPayrollWriteBySalaryRevisionId, salaryRevisionController.rejectRevision],
    // Compliance features — POST
    ['/payroll/fnf/create', guardPayrollWriteByBodyStaffUid, payrollController.createFnF],
    ['/payroll/fnf/:id/approve', guardPayrollWriteCollection, payrollController.approveFnF],
    ['/payroll/fnf/:id/mark-paid', guardPayrollWriteCollection, payrollController.markFnFPaid],
    ['/payroll/declarations/:id/approve', guardPayrollWriteCollection, payrollController.approveDeclaration],
    ['/payroll/leave-encashment/create', guardPayrollWriteByBodyStaffUid, payrollController.calculateLeaveEncashment],
    ['/payroll/queries/:id/reply', guardPayrollWriteCollection, payrollController.replyToPayslipQuery],
    ['/payroll/bulk-revisions/create', guardPayrollWriteCollection, payrollController.createBulkRevision],
    ['/payroll/bulk-revisions/:id/approve', guardPayrollWriteCollection, payrollController.approveBulkRevision],
  ],
  
  put: [
    // Update Staff Status
    ['/status/:staffId', guardProfileWriteByStaffId, staffAdminController.updateStaffStatus],
    
    // Approve/Reject Operations
    ['/approve/performance-review/:reviewId', guardProfileWriteCollection, staffAdminController.approvePerformanceReview],
    ['/approve/leave/:leaveId', guardLeaveWriteByLeaveId, staffAdminController.approveLeaveRequest],

    // Custom shift update
    ['/shifts/custom/:id', shiftController.updateCustomShift],

    // Housekeeping zone update
    ['/housekeeping/zones/:id', housekeepingController.updateZone],
  ],
  
  delete: [
    // Archive/Delete Operations
    ['/archive/:staffId', guardProfileWriteByStaffId, staffAdminController.archiveStaffMember],
    ['/purge/old-records', guardProfileWriteCollection, staffAdminController.purgeOldRecords],

    // Deactivate custom shift
    ['/shifts/custom/:id', shiftController.deactivateShift],

    // Housekeeping zone remove is a soft-deactivate so historical requests stay intact.
    ['/housekeeping/zones/:id', housekeepingController.deleteZone]
  ]
});

export default router;
