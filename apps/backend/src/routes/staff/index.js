// src/routes/staff/

import express from 'express';
import attendanceRoutes from './attendanceRoutes.js';
import hrRoutes from './hrRoutes.js';
import pharmacyRoutes from './pharmacyRoutes.js';
import staffAdminRoutes from './staffAdminRoutes.js';
import staffRoutes from './staffRoutes.js';
import * as replacementController from '../../controllers/staff/replacementController.js';

const router = express.Router();

// Mount sub-routers
router.use('/', staffRoutes);           // Staff management
router.use('/attendance', attendanceRoutes);  // Attendance operations
router.use('/hr', hrRoutes);            // HR management
router.use('/pharmacy', pharmacyRoutes); // Pharmacy order updates
router.use('/admin', staffAdminRoutes);  // Staff admin operations

// ─── /staff/replacements/* aliases ────────────────────────────────────────
// The admin /dashboard/my-replacements page calls /api/v1/staff/replacements/my
// (GET) and /api/v1/staff/replacements (POST). The canonical controllers live
// under /staff/hr/replacement/* (see hrRoutes.js); these aliases keep that
// canonical mount untouched while supporting the admin page's API config
// (apps/admin/src/lib/api-config.ts → myWork.replacements.*).
router.get('/replacements/my', replacementController.getPendingReplacements);
router.post('/replacements', replacementController.requestReplacement);

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