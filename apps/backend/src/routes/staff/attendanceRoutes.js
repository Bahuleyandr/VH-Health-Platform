import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as attendanceController from '../../controllers/staff/attendanceController.js';
import { requireDeviceType } from '../../middleware/requireDeviceTypeMiddleware.js';
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

wrapAutoRBAC(router, 'staffAttendanceRoutes', {
  post: [
    ['/', mobileOnly, markAttendanceValidation, attendanceController.markAttendance],
    ['/regularize', attendanceController.requestMyRegularization],
    ['/dispute', attendanceController.submitMyDispute],
    ['/:id/regularize', attendanceController.requestRegularization],
    ['/:id/break/start', mobileOnly, attendanceController.startBreak],
    ['/:id/break/end', mobileOnly, attendanceController.endBreak],
    ['/:id/dispute', attendanceController.submitDispute],
  ],
  
  get: [
    ['/my', attendanceController.getMyAttendance],
    ['/:id', getAttendanceValidation, attendanceController.getStaffAttendance],
    ['/:id/calendar', attendanceController.getAttendanceCalendar],
    ['/:id/break/today', attendanceController.getTodayBreaks],
    ['/:id/disputes', attendanceController.getMyDisputes],
  ]
});

export default router;
