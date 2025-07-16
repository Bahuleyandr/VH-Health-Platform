// src/routes/staff/

import express from 'express';
import { wrapRoutes } from '../../config/routeWrapper.js';
import { success } from '../../utils/responseHelper.js';
import attendanceRoutes from './attendanceRoutes.js';
import hrRoutes from './hrRoutes.js';
import medicalRoutes from './medicalRoutes.js';
import pharmacyRoutes from './pharmacyRoutes.js';
import staffRoutes from './staffRoutes.js';

const router = express.Router();

// Mount sub-routers
router.use('/', staffRoutes);           // Staff management
router.use('/attendance', attendanceRoutes);  // Attendance operations
router.use('/hr', hrRoutes);            // HR management
router.use('/medical', medicalRoutes);  // Medical document uploads
router.use('/pharmacy', pharmacyRoutes); // Pharmacy order updates

// Legacy compatibility routes
router.get('/attendance', (req, res) => {
  res.json({
    success: true,
    message: 'Attendance system operational',
    features: ['check_in', 'check_out', 'location_tracking', 'hours_calculation'],
    endpoints: {
      mark_attendance: 'POST /staff/attendance',
      view_attendance: 'GET /staff/:id/attendance',
      attendance_summary: 'GET /staff/stats/summary'
    }
  });
});

router.get('/roll-call', (req, res) => {
  res.json({
    success: true,
    message: 'Roll-call system operational',
    features: ['shift_based_attendance', 'department_roll_call', 'real_time_status'],
    endpoints: {
      by_shift: 'GET /staff/shift/:shift',
      by_department: 'GET /staff/department/:department',
      dashboard: 'GET /staff/hr/dashboard'
    }
  });
});

export default router;