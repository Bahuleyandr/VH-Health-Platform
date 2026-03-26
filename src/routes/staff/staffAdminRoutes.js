// src/routes/staff/staffAdminRoutes.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as staffAdminController from '../../controllers/staff/staffAdminController.js';
import * as housekeepingController from '../../controllers/staff/housekeepingController.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import * as attendanceController from '../../controllers/staff/attendanceController.js';
import * as overtimeController from '../../controllers/staff/overtimeController.js';
import * as shiftController from '../../controllers/staff/shiftController.js';
import * as bulkController from '../../controllers/staff/bulkAttendanceController.js';
import * as incidentController from '../../controllers/staff/incidentController.js';
import * as grievanceController from '../../controllers/staff/grievanceController.js';
import * as reportAuditController from '../../controllers/staff/reportAuditController.js';
import * as attendanceAuditController from '../../controllers/staff/attendanceAuditController.js';

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
    ['/housekeeping/zones', housekeepingController.getZones],
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
  ],
  
  put: [
    // Update Staff Status
    ['/status/:staffId', staffAdminController.updateStaffStatus],
    
    // Approve/Reject Operations
    ['/approve/performance-review/:reviewId', staffAdminController.approvePerformanceReview],
    ['/approve/leave/:leaveId', staffAdminController.approveLeaveRequest],

    // Custom shift update
    ['/shifts/custom/:id', shiftController.updateCustomShift]
  ],
  
  delete: [
    // Archive/Delete Operations
    ['/archive/:staffId', staffAdminController.archiveStaffMember],
    ['/purge/old-records', staffAdminController.purgeOldRecords],

    // Deactivate custom shift
    ['/shifts/custom/:id', shiftController.deactivateShift]
  ]
});

export default router;