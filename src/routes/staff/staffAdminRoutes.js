// src/routes/staff/staffAdminRoutes.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as staffAdminController from '../../controllers/staff/staffAdminController.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import * as attendanceController from '../../controllers/staff/attendanceController.js';
import * as overtimeController from '../../controllers/staff/overtimeController.js';
import * as shiftController from '../../controllers/staff/shiftController.js';
import * as bulkController from '../../controllers/staff/bulkAttendanceController.js';

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

    // Overtime
    ['/overtime/pending', overtimeController.getPendingOvertimeRequests],
    
    // Staff Reports
    ['/reports/efficiency', staffAdminController.getEfficiencyReport],
    ['/reports/overtime', staffAdminController.getOvertimeReport],
    ['/reports/turnover', staffAdminController.getTurnoverReport],
    
    // Search & Filter
    ['/search', staffAdminController.advancedStaffSearch],
    
    // Export
    ['/export/:type', staffAdminController.exportStaffData]
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

    // Overtime operations
    ['/overtime/:id/approve', overtimeController.approveOvertime],
    
    // Override Operations
    ['/override/attendance', staffAdminController.overrideAttendance],
    ['/override/leave-balance', staffAdminController.overrideLeaveBalance],
    
    // System Operations
    ['/generate-payroll-data', staffAdminController.generatePayrollData],
    ['/sync-biometric', staffAdminController.syncBiometricData]
  ],
  
  put: [
    // Update Staff Status
    ['/status/:staffId', staffAdminController.updateStaffStatus],
    
    // Approve/Reject Operations
    ['/approve/performance-review/:reviewId', staffAdminController.approvePerformanceReview],
    ['/approve/leave/:leaveId', staffAdminController.approveLeaveRequest]
  ],
  
  delete: [
    // Archive/Delete Operations
    ['/archive/:staffId', staffAdminController.archiveStaffMember],
    ['/purge/old-records', staffAdminController.purgeOldRecords]
  ]
});

export default router;