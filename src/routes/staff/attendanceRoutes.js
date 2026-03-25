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
  ],
  
  get: [
    ['/:id', getAttendanceValidation, attendanceController.getStaffAttendance],
    ['/:id/calendar', attendanceController.getAttendanceCalendar],
  ]
});

export default router;
