import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as attendanceController from '../../controllers/staff/attendanceController.js';
import { requireDeviceType } from '../../middleware/requireDeviceTypeMiddleware.js';
import { staffAccessGuard } from '../../middleware/staffAccessMiddleware.js';
import { STAFF_ACCESS_POLICY_CODES } from '../../services/security/staffAccessDecisionService.js';
import {
  markAttendanceValidation,
  getAttendanceValidation
} from '../../validators/staff/attendanceValidators.js';

const router = express.Router();

// Attendance check-in / check-out + break start/end are staff-initiated
// actions that must only happen from the phone — the desktop staff app
// (clinical notes / charting) is not the source of truth for who's
// physically on premise. `requireDeviceType('mobile')` reads the JWT
// claim set at login by every login flow (see services/auth/*).
const mobileOnly = requireDeviceType('mobile');
const guardAttendanceSelfView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_VIEW, {
  selfIfNoTarget: true,
  requireTarget: true,
});
const guardAttendanceSelfWrite = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_WRITE, {
  targetSelector: (req) => req.body?.staff_id || req.body?.staffId || req.user?.uid,
  requireTarget: true,
});
const guardAttendanceViewById = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_VIEW, {
  targetParam: 'id',
  requireTarget: true,
});
const guardAttendanceWriteById = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_WRITE, {
  targetParam: 'id',
  requireTarget: true,
});

wrapAutoRBAC(router, 'staffAttendanceRoutes', {
  post: [
    ['/', mobileOnly, markAttendanceValidation, guardAttendanceSelfWrite, attendanceController.markAttendance],
    ['/regularize', guardAttendanceSelfWrite, attendanceController.requestMyRegularization],
    ['/dispute', guardAttendanceSelfWrite, attendanceController.submitMyDispute],
    ['/:id/regularize', guardAttendanceWriteById, attendanceController.requestRegularization],
    ['/:id/break/start', mobileOnly, guardAttendanceWriteById, attendanceController.startBreak],
    ['/:id/break/end', mobileOnly, guardAttendanceWriteById, attendanceController.endBreak],
    ['/:id/dispute', guardAttendanceWriteById, attendanceController.submitDispute],
  ],
  
  get: [
    ['/my', guardAttendanceSelfView, attendanceController.getMyAttendance],
    ['/:id', getAttendanceValidation, guardAttendanceViewById, attendanceController.getStaffAttendance],
    ['/:id/calendar', guardAttendanceViewById, attendanceController.getAttendanceCalendar],
    ['/:id/break/today', guardAttendanceViewById, attendanceController.getTodayBreaks],
    ['/:id/disputes', guardAttendanceViewById, attendanceController.getMyDisputes],
  ]
});

export default router;
