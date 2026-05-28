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

const router = express.Router();

wrapAutoRBAC(router, 'staffAdminRoutes', {
  get: [
    // Staff Admin Dashboard
    ['/dashboard', staffAdminController.getStaffAdminDashboard],
    
    // Analytics & Reports
    ['/analytics/attendance', staffAdminController.getAttendanceAnalytics],
    ['/analytics/performance', staffAdminController.getPerformanceAnalytics],
    ['/analytics/department-wise', staffAdminController.getDepartmentAnalytics],
    ['/analytics/leave-patterns', staffAdminController.getLeavePatterns],
    
    // Attendance Management
    ['/attendance/anomalies', staffAdminController.getAttendanceAnomalies],
    ['/attendance/late-arrivals', staffAdminController.getLateArrivals],
    ['/attendance/early-departures', staffAdminController.getEarlyDepartures],
    ['/attendance/absent-report', staffAdminController.getAbsentReport],
    ['/attendance/disputes/pending', attendanceController.getPendingDisputes],
    ['/attendance/geofence-breaches', attendanceController.getGeofenceBreaches],
    ['/attendance/bulk-template', bulkController.getBulkTemplate],
    
    // HR Oversight
    ['/hr/pending-reviews', staffAdminController.getPendingReviews],
    ['/hr/leave-requests', staffAdminController.getAllLeaveRequests],
    ['/hr/onboarding-status', staffAdminController.getOnboardingStatus],
    ['/hierarchy', organizationHierarchyController.getOrganizationHierarchy],

    // Leave Approvals (portal-facing)
    ['/leave/pending', staffAdminController.getAllLeaveRequests],
    ['/replacement/pending-hr', replacementController.getPendingReplacements],
    
    // Shifts
    ['/shifts', shiftController.getAllShifts],
    ['/shifts/presets', shiftController.getAllShifts],  // same — presets returned first

    // Overtime
    ['/overtime/pending', overtimeController.getPendingOvertimeRequests],
    
    // Staff Reports
    ['/reports/efficiency', staffAdminController.getEfficiencyReport],
    ['/reports/overtime', staffAdminController.getOvertimeReport],
    ['/reports/turnover', staffAdminController.getTurnoverReport],
    
    // Search & Filter
    ['/search', staffAdminController.advancedStaffSearch],
    
    // Export
    ['/export/:type', staffAdminController.exportStaffData],

    // Incident Reports (admin)
    ['/incidents', incidentController.getAllIncidents],
    ['/incidents/stats', incidentController.getIncidentStats],

    // Audit routes — incidents/grievances
    ['/audit/dashboard', reportAuditController.getAuditDashboard],
    ['/audit/activity', reportAuditController.getAdminActivityReport],
    ['/audit/sla', reportAuditController.getSLAReport],
    ['/audit/trail/:type/:id', reportAuditController.getReportAuditTrail],

    // Audit routes — attendance
    ['/audit/attendance/dashboard', attendanceAuditController.getAttendanceAuditDashboard],
    ['/audit/attendance/hr-activity', attendanceAuditController.getAttendanceHRActivity],
    ['/audit/attendance/sla', attendanceAuditController.getAttendanceSLAReport],
    ['/audit/attendance/geofence', attendanceAuditController.getGeofenceBreachLog],
    ['/audit/attendance/leave/:id', attendanceAuditController.getLeaveAuditTrail],
    ['/incidents/:id', incidentController.getAdminIncidentDetail],

    // Grievances (admin/HR)
    ['/grievances', grievanceController.getAllGrievances],
    ['/grievances/stats', grievanceController.getGrievanceStats],
    ['/grievances/:id', grievanceController.getGrievanceAdminDetail],

    // Housekeeping (admin)
    ['/housekeeping/logs', housekeepingController.getAllCleaningLogs],
    ['/housekeeping/requests', housekeepingController.getAllRequests],
    ['/housekeeping/stats', housekeepingController.getHousekeepingStats],
    ['/housekeeping/zones', housekeepingController.getAdminZones],

    // Payroll (admin)
    ['/payroll/runs', payrollController.getPayrollRuns],
    ['/payroll/runs/:runId', payrollController.getPayrollRunDetail],
    ['/payroll/staff', payrollController.getStaffForPayroll],
    ['/payroll/salary/:staffUid', payrollController.getStaffSalaryConfig],
    ['/payroll/revisions', salaryRevisionController.getRevisions],
    ['/payroll/revisions/:id', salaryRevisionController.getRevisionDetail],
    ['/payroll/annual-review', salaryRevisionController.getAnnualReviewStatus],
    // New payroll features
    ['/payroll/export/summary', payrollController.exportPayrollSummary],
    ['/payroll/export/pf', payrollController.exportPFRegister],
    ['/payroll/export/esi', payrollController.exportESIRegister],
    ['/payroll/comparison', payrollController.getPayrollComparison],
    ['/payroll/advances', payrollController.getAllAdvances],
    // Compliance features — GET
    ['/payroll/fnf', payrollController.getFnFList],
    ['/payroll/gratuity', payrollController.getAllGratuityStatus],
    ['/payroll/declarations', payrollController.getAllDeclarations],
    ['/payroll/leave-encashment', payrollController.getLeaveEncashments],
    ['/payroll/queries', payrollController.getAllPayslipQueries],
    ['/payroll/compliance-calendar', payrollController.getComplianceCalendar],
    ['/payroll/bulk-revisions', payrollController.getBulkRevisions],
  ],
  
  post: [
    // Bulk Operations
    ['/bulk/attendance-correction', bulkController.bulkCorrectAttendance],
    ['/bulk/shift-assignment', staffAdminController.bulkShiftAssignment],
    ['/bulk/leave-approval', staffAdminController.bulkLeaveApproval],

    // Attendance disputes
    ['/attendance/disputes/:id/resolve', attendanceController.resolveDispute],

    // Leave approval actions (portal-facing)
    ['/leave/:leaveId/approve', staffAdminController.approveLeaveRequest],
    ['/leave/:leaveId/reject', staffAdminController.approveLeaveRequest],
    ['/replacement/:id/hr-approve', replacementController.hrApproveReplacement],
    
    // Shift operations
    ['/shifts/assign', shiftController.assignShift],
    ['/shifts/custom', shiftController.createCustomShift],

    // Overtime operations
    ['/overtime/:id/approve', overtimeController.approveOvertime],
    
    // Override Operations
    ['/override/attendance', staffAdminController.overrideAttendance],
    ['/override/leave-balance', staffAdminController.overrideLeaveBalance],
    
    // System Operations
    ['/generate-payroll-data', staffAdminController.generatePayrollData],
    ['/sync-biometric', staffAdminController.syncBiometricData],

    // Incident update (admin)
    ['/incidents/:id/update', incidentController.updateIncident],

    // Grievance update (admin/HR)
    ['/grievances/:id/update', grievanceController.updateGrievance],

    // Housekeeping (admin actions)
    ['/housekeeping/requests/:id/assign', housekeepingController.assignRequest],
    ['/housekeeping/logs/:id/verify', housekeepingController.verifyLog],
    ['/housekeeping/requests/:id/verify', housekeepingController.verifyRequest],
    ['/housekeeping/zones', housekeepingController.createZone],
    ['/housekeeping/requests/create', housekeepingController.adminCreateRequest],

    // Payroll (admin actions)
    ['/payroll/run', payrollController.runPayroll],
    ['/payroll/issue', payrollController.issuePayslips],
    ['/payroll/salary/:staffUid', payrollController.upsertStaffSalaryConfig],
    // New payroll features — POST
    ['/payroll/tax-summary/all', payrollController.generateAllTaxSummaries],
    ['/payroll/advances/create', payrollController.createAdvance],
    ['/payroll/revisions/:revisionId/arrears', payrollController.calculateRevisionArrears],
    // Manual edit + dual sign
    ['/payroll/payslips/:id/edit', payrollController.manualEditPayslip],
    ['/payroll/runs/:runId/hr-sign', payrollController.hrSignPayrollRun],
    ['/payroll/runs/:runId/admin-sign', payrollController.adminSignPayrollRun],
    ['/payroll/revisions/propose', salaryRevisionController.proposeRevision],
    ['/payroll/revisions/:id/hr-sign', salaryRevisionController.hrSignRevision],
    ['/payroll/revisions/:id/admin-sign', salaryRevisionController.adminSignRevision],
    ['/payroll/revisions/:id/apply', salaryRevisionController.applyRevision],
    ['/payroll/revisions/:id/reject', salaryRevisionController.rejectRevision],
    // Compliance features — POST
    ['/payroll/fnf/create', payrollController.createFnF],
    ['/payroll/fnf/:id/approve', payrollController.approveFnF],
    ['/payroll/fnf/:id/mark-paid', payrollController.markFnFPaid],
    ['/payroll/declarations/:id/approve', payrollController.approveDeclaration],
    ['/payroll/leave-encashment/create', payrollController.calculateLeaveEncashment],
    ['/payroll/queries/:id/reply', payrollController.replyToPayslipQuery],
    ['/payroll/bulk-revisions/create', payrollController.createBulkRevision],
    ['/payroll/bulk-revisions/:id/approve', payrollController.approveBulkRevision],
  ],
  
  put: [
    // Update Staff Status
    ['/status/:staffId', staffAdminController.updateStaffStatus],
    
    // Approve/Reject Operations
    ['/approve/performance-review/:reviewId', staffAdminController.approvePerformanceReview],
    ['/approve/leave/:leaveId', staffAdminController.approveLeaveRequest],

    // Custom shift update
    ['/shifts/custom/:id', shiftController.updateCustomShift],

    // Housekeeping zone update
    ['/housekeeping/zones/:id', housekeepingController.updateZone],
  ],
  
  delete: [
    // Archive/Delete Operations
    ['/archive/:staffId', staffAdminController.archiveStaffMember],
    ['/purge/old-records', staffAdminController.purgeOldRecords],

    // Deactivate custom shift
    ['/shifts/custom/:id', shiftController.deactivateShift],

    // Housekeeping zone remove is a soft-deactivate so historical requests stay intact.
    ['/housekeeping/zones/:id', housekeepingController.deleteZone]
  ]
});

export default router;
