// src/routes/admin/index.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';

// Sub-routers (must remain mounted)
import appointmentAdminRoutes from '../appointment/appointmentAdminRoutes.js';
import adminDoctorRoutes from '../doctor/adminDoctorRoutes.js';
import adminDepartmentRoutes from '../department/adminDepartmentRoutes.js';
import adminUserRoutes from '../user/adminUserRoutes.js';
import adminNotificationRoutes from '../notification/adminNotificationRoutes.js';
import adminRecordRoutes from '../record/adminRoutes.js';
import adminInvestigationRoutes from '../investigation/adminRoutes.js';
import adminPharmacyRoutes from '../pharmacy/adminRoutes.js';
import analyticsRoutes from '../analyticsRoutes.js';

// Services (barrel import)
import {
  getUserStats,
  getDoctorStats,
  getDepartmentStats,
  getAppointmentStats,
  getRecordStats,
  getEmergencyStats,
  getStaffStats,
  getQuickStats,
  getAppointmentSummary,
  getRecentActivity,
  getSystemAlerts,
  getModuleHealth,
  refreshDashboardCache,
  generateDashboardReport,

  // NEW: Admin attendance services
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
} from './services/index.js';

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               RBAC-wrapped API                              */
/* -------------------------------------------------------------------------- */

wrapAutoRBAC(router, 'adminDashboard', {
  get: [
    [
      '/test',
      (_req, res) => {
        res.json({
          message: 'Admin dashboard routes working',
          timestamp: new Date().toISOString(),
          modules: {
            appointments: '/api/v1/admin/appointments',
            departments: '/api/v1/admin/departments',
            doctors: '/api/v1/admin/doctors',
            users: '/api/v1/admin/users',
            notifications: '/api/v1/admin/notifications',
            records: '/api/v1/admin/records',
            investigations: '/api/v1/admin/investigations',
            pharmacy: '/api/v1/admin/pharmacy',
            devices: '/api/v1/devices',
            feedback: '/api/v1/feedback',
            analytics: '/api/v1/admin/analytics',
          },
        });
      },
    ],

    [
      '/dashboard',
      async (_req, res) => {
        try {
          const [
            userStats,
            doctorStats,
            departmentStats,
            appointmentStats,
            recordStats,
            emergencyStats,
            staffStats,
            recentActivity,
            moduleHealth,
          ] = await Promise.all([
            getUserStats(),
            getDoctorStats(),
            getDepartmentStats(),
            getAppointmentStats(),
            getRecordStats(),
            getEmergencyStats(),
            getStaffStats(),
            getRecentActivity(),
            getModuleHealth(),
          ]);

          res.json({
            success: true,
            data: {
              overview: {
                totalUsers: userStats.total,
                activeUsers: userStats.active,
                newUsersToday: userStats.newToday,
                totalDoctors: doctorStats.total,
                availableDoctors: doctorStats.available,
                totalDepartments: departmentStats.total,
                appointmentsToday: appointmentStats.today,
                appointmentsUpcoming: appointmentStats.upcoming,
                appointmentCompletionRate: appointmentStats.completionRate,
                emergencyAlerts: emergencyStats.active,
                totalStaff: staffStats.total_staff,
                presentStaff: staffStats.present_today,
                onLeaveStaff: staffStats.on_leave,
                pendingHRActions:
                  (staffStats.pending_reviews || 0) + (staffStats.pending_leaves || 0),
                recordsCreatedToday: recordStats.createdToday || 0,
              },
              charts: {
                userGrowth: userStats.growth,
                appointmentTrends: appointmentStats.trends,
                departmentUtilization: departmentStats.utilization,
              },
              recentActivity,
              systemHealth: moduleHealth,
            },
          });
        } catch (error) {
          logger.error('Dashboard data fetch error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to fetch dashboard data' });
        }
      },
    ],

    [
      '/stats/quick',
      async (_req, res) => {
        try {
          const data = await getQuickStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('Quick stats error:', e);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get quick stats' });
        }
      },
    ],

    [
      '/activity/recent',
      async (req, res) => {
        try {
          const { limit = 50, offset = 0 } = req.query;
          const activity = await getRecentActivity(Number(limit), Number(offset));
          res.json({ success: true, data: activity });
        } catch (e) {
          logger.error('Recent activity error:', e);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get recent activity' });
        }
      },
    ],

    [
      '/alerts',
      async (_req, res) => {
        try {
          const alerts = await getSystemAlerts();
          res.json({ success: true, data: alerts });
        } catch (e) {
          logger.error('Alerts error:', e);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get system alerts' });
        }
      },
    ],

    [
      '/health/modules',
      async (_req, res) => {
        const health = await getModuleHealth();
        res.json({ success: true, data: health });
      },
    ],

    [
      '/staff/summary',
      async (_req, res) => {
        try {
          const summary = await getStaffStats();
          res.json({
            success: true,
            data: summary,
            links: {
              analytics: '/api/v1/staff/admin/analytics/attendance',
              hrDashboard: '/api/v1/staff/admin/dashboard',
              pendingActions: '/api/v1/staff/admin/hr/pending-reviews',
              attendance: '/api/v1/staff/admin/attendance/anomalies',
            },
          });
        } catch (error) {
          logger.error('Staff summary error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get staff summary' });
        }
      },
    ],

    [
      '/appointments/summary',
      async (_req, res) => {
        try {
          const summary = await getAppointmentSummary();
          res.json({
            success: true,
            data: summary,
            links: {
              analytics: '/api/v1/admin/appointments/analytics',
              conflicts: '/api/v1/admin/appointments/conflicts',
              capacity: '/api/v1/admin/appointments/capacity',
              noShows: '/api/v1/admin/appointments/no-shows',
            },
          });
        } catch (error) {
          logger.error('Appointment summary error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get appointment summary' });
        }
      },
    ],

    // ---------------------- NEW: Admin Staff Attendance ----------------------
    [
      '/staff/attendance/analytics',
      async (req, res) => {
        try {
          const {
            department = null,
            start_date: startDate = null,
            end_date: endDate = null,
            group_by: groupBy = 'day',
          } = req.query;
          const data = await getAttendanceAnalytics({ department, startDate, endDate, groupBy });
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Attendance analytics error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get attendance analytics' });
        }
      },
    ],
    [
      '/staff/attendance/anomalies',
      async (_req, res) => {
        try {
          const data = await getAttendanceAnomalies();
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Attendance anomalies error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get attendance anomalies' });
        }
      },
    ],
    [
      '/staff/attendance/late-arrivals',
      async (req, res) => {
        try {
          const { date = new Date().toISOString().split('T')[0], department = null } = req.query;
          const data = await getLateArrivals(date, department);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Late arrivals error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get late arrivals' });
        }
      },
    ],
    [
      '/staff/attendance/early-departures',
      async (req, res) => {
        try {
          const { date = new Date().toISOString().split('T')[0], department = null } = req.query;
          const data = await getEarlyDepartures(date, department);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Early departures error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get early departures' });
        }
      },
    ],
    [
      '/staff/attendance/absent-report',
      async (req, res) => {
        try {
          const { date = new Date().toISOString().split('T')[0], department = null } = req.query;
          const data = await getAbsentReport(date, department);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Absent report error:', error);
          res
            .status(500)
            .json({ success: false, message: 'Failed to get absent report' });
        }
      },
    ],
    // ------------------------------------------------------------------------
  ],

  post: [
    [
      '/refresh-cache',
      async (_req, res) => {
        await refreshDashboardCache();
        res.json({ success: true, message: 'Dashboard cache refreshed' });
      },
    ],

    [
      '/export/report',
      async (req, res) => {
        const { format = 'pdf', dateRange } = req.body || {};
        const report = await generateDashboardReport(format, dateRange);
        res.json({ success: true, data: report });
      },
    ],
  ],
});

/* -------------------------------------------------------------------------- */
/*                           Mount admin sub-routers                           */
/* -------------------------------------------------------------------------- */

router.use('/appointments', appointmentAdminRoutes);
router.use('/doctors', adminDoctorRoutes);
router.use('/departments', adminDepartmentRoutes);
router.use('/users', adminUserRoutes);
router.use('/notifications', adminNotificationRoutes);
router.use('/records', adminRecordRoutes);
router.use('/investigations', adminInvestigationRoutes);
router.use('/pharmacy', adminPharmacyRoutes);
router.use('/analytics', analyticsRoutes);

export default router;
