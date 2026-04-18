import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as attendanceController from '../../controllers/staff/attendanceController.js';
import { 
  markAttendanceValidation,
  getAttendanceValidation 
} from '../../validators/staff/attendanceValidators.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffAttendanceRoutes', {
  post: [
    ['/', markAttendanceValidation, attendanceController.markAttendance],
    ['/:id/regularize', attendanceController.requestRegularization],
    ['/:id/break/start', attendanceController.startBreak],
    ['/:id/break/end', attendanceController.endBreak],
    ['/:id/dispute', attendanceController.submitDispute],
  ],
  
  get: [
    ['/:id', getAttendanceValidation, attendanceController.getStaffAttendance],
    ['/:id/calendar', attendanceController.getAttendanceCalendar],
    ['/:id/break/today', attendanceController.getTodayBreaks],
    ['/:id/disputes', attendanceController.getMyDisputes],
  ]
});

export default router;
