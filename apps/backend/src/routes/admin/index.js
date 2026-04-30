// src/routes/admin/index.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';

// Sub-routers (must remain mounted)
import analyticsRoutes from '../analyticsRoutes.js';
import appointmentAdminRoutes from '../appointment/appointmentAdminRoutes.js';
import adminDepartmentRoutes from '../department/adminDepartmentRoutes.js';
import adminDoctorRoutes from '../doctor/adminDoctorRoutes.js';
import adminInvestigationRoutes from '../investigation/adminRoutes.js';
import adminNotificationRoutes from '../notification/adminNotificationRoutes.js';
import adminPharmacyRoutes from '../pharmacy/adminRoutes.js';
import adminRecordRoutes from '../record/adminRoutes.js';
import adminUserRoutes from '../user/adminUserRoutes.js';
import auditRoutes from './auditRoutes.js';
import eventOutboxRoutes from './eventOutboxRoutes.js';
import executiveKpiRoutes from './executiveKpiRoutes.js';
import featureFlagRoutes from './featureFlagRoutes.js';
import { deliveryRouter, integrationRouter, subscriptionRouter } from './integrationRoutes.js';
import patientIdentifierRoutes from './patientIdentifierRoutes.js';
import patientMergeRoutes from './patientMergeRoutes.js';
import surgicalDocumentationRoutes from './surgicalDocumentationRoutes.js';
import telemedicineRoutes from './telemedicineRoutes.js';

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
  getSystemHealth,
  refreshDashboardCache,
  generateDashboardReport,

  // Admin Staff Attendance
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,

  // Admin SOS
  getSosAnalytics,
  getAllAlerts,
  getEmergencyServices,
  getPerformanceReport,
  updateSystemConfig,
  broadcastEmergencyAlert,
  escalateAlert,

  // NEW: Admin Uploads (file management)
  getUploadSummary,
  listQuarantinedFiles,
  getHipaaAuditReport,
  rescanFile,
  cleanupExpiredFiles,
  bulkUpdateHipaaProtection,
  purgeQuarantinedFiles,
} from './services/index.js';

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               RBAC-wrapped API                              */
/* -------------------------------------------------------------------------- */

wrapAutoRBAC(router, 'adminDashboard', {
  get: [
    // /test endpoint — disabled in production to reduce attack surface
    ...((process.env.NODE_ENV || '').toLowerCase() !== 'production' ? [[
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
    ]] : []),

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
          res.status(500).json({ success: false, message: 'Failed to fetch dashboard data' });
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
          res.status(500).json({ success: false, message: 'Failed to get quick stats' });
        }
      },
    ],

    // -------------- Individual stat endpoints (used by portal useAdminStats) ----
    [
      '/stats/users',
      async (_req, res) => {
        try {
          const data = await getUserStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('User stats error:', e);
          res.status(500).json({ success: false, message: 'Failed to get user stats' });
        }
      },
    ],

    [
      '/stats/doctors',
      async (_req, res) => {
        try {
          const data = await getDoctorStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('Doctor stats error:', e);
          res.status(500).json({ success: false, message: 'Failed to get doctor stats' });
        }
      },
    ],

    [
      '/stats/appointments',
      async (_req, res) => {
        try {
          const data = await getAppointmentStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('Appointment stats error:', e);
          res.status(500).json({ success: false, message: 'Failed to get appointment stats' });
        }
      },
    ],

    [
      '/stats/records',
      async (_req, res) => {
        try {
          const data = await getRecordStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('Record stats error:', e);
          res.status(500).json({ success: false, message: 'Failed to get record stats' });
        }
      },
    ],

    [
      '/stats/emergency',
      async (_req, res) => {
        try {
          const data = await getEmergencyStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('Emergency stats error:', e);
          res.status(500).json({ success: false, message: 'Failed to get emergency stats' });
        }
      },
    ],

    [
      '/stats/staff',
      async (_req, res) => {
        try {
          const data = await getStaffStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('Staff stats error:', e);
          res.status(500).json({ success: false, message: 'Failed to get staff stats' });
        }
      },
    ],

    [
      '/stats/departments',
      async (_req, res) => {
        try {
          const data = await getDepartmentStats();
          res.json({ success: true, data });
        } catch (e) {
          logger.error('Department stats error:', e);
          res.status(500).json({ success: false, message: 'Failed to get department stats' });
        }
      },
    ],
    // -------------- End individual stat endpoints --------------------------------

    [
      '/activity/recent',
      async (req, res) => {
        try {
          const { limit = 50, offset = 0 } = req.query;
          const activity = await getRecentActivity(Number(limit), Number(offset));
          res.json({ success: true, data: activity });
        } catch (e) {
          logger.error('Recent activity error:', e);
          res.status(500).json({ success: false, message: 'Failed to get recent activity' });
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
          res.status(500).json({ success: false, message: 'Failed to get system alerts' });
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
      '/health/system',
      async (_req, res) => {
        try {
          const health = await getSystemHealth();
          res.json({ success: true, data: health });
        } catch (e) {
          logger.error('System health error:', e);
          res.status(500).json({ success: false, message: 'Failed to get system health' });
        }
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
          res.status(500).json({ success: false, message: 'Failed to get staff summary' });
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
          res.status(500).json({ success: false, message: 'Failed to get appointment summary' });
        }
      },
    ],

    // ---------------------- Admin Staff Attendance ---------------------------
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
          res.status(500).json({ success: false, message: 'Failed to get attendance analytics' });
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
          res.status(500).json({ success: false, message: 'Failed to get attendance anomalies' });
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
          res.status(500).json({ success: false, message: 'Failed to get late arrivals' });
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
          res.status(500).json({ success: false, message: 'Failed to get early departures' });
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
          res.status(500).json({ success: false, message: 'Failed to get absent report' });
        }
      },
    ],

    // ---------------------- Admin SOS management -----------------------------
    [
      '/sos/analytics',
      async (_req, res) => {
        try {
          const data = await getSosAnalytics();
          res.json({ success: true, data });
        } catch (error) {
          logger.error('SOS analytics error:', error);
          res.status(500).json({ success: false, message: 'Failed to get SOS analytics' });
        }
      },
    ],
    [
      '/sos/alerts',
      async (req, res) => {
        try {
          const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
          const offset = Math.max(Number(req.query.offset ?? 0), 0);
          const data = await getAllAlerts(limit, offset);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('SOS alerts list error:', error);
          res.status(500).json({ success: false, message: 'Failed to get SOS alerts' });
        }
      },
    ],
    [
      '/sos/emergency-services',
      async (_req, res) => {
        try {
          const data = await getEmergencyServices();
          res.json({ success: true, data });
        } catch (error) {
          logger.error('SOS services error:', error);
          res.status(500).json({ success: false, message: 'Failed to get emergency services' });
        }
      },
    ],
    [
      '/sos/performance-report',
      async (_req, res) => {
        try {
          const data = await getPerformanceReport();
          res.json({ success: true, data });
        } catch (error) {
          logger.error('SOS performance report error:', error);
          res.status(500).json({ success: false, message: 'Failed to get performance report' });
        }
      },
    ],

    // ---------------------- NEW: Admin Uploads (file mgmt) -------------------
    [
      '/upload/summary',
      async (_req, res) => {
        try {
          const data = await getUploadSummary();
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Upload summary error:', error);
          res.status(500).json({ success: false, message: 'Failed to get upload summary' });
        }
      },
    ],
    [
      '/upload/quarantine',
      async (req, res) => {
        try {
          const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
          const offset = Math.max(Number(req.query.offset ?? 0), 0);
          const data = await listQuarantinedFiles(limit, offset);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('List quarantined files error:', error);
          res.status(500).json({ success: false, message: 'Failed to list quarantined files' });
        }
      },
    ],
    [
      '/upload/hipaa/audit',
      async (req, res) => {
        try {
          const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
          const offset = Math.max(Number(req.query.offset ?? 0), 0);
          const { start_date: startDate = null, end_date: endDate = null } = req.query;
          const data = await getHipaaAuditReport({ limit, offset, startDate, endDate });
          res.json({ success: true, data });
        } catch (error) {
          logger.error('HIPAA audit error:', error);
          res.status(500).json({ success: false, message: 'Failed to get HIPAA audit report' });
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

    // SOS actions
    [
      '/sos/update-config',
      async (req, res) => {
        try {
          const data = await updateSystemConfig(req.body || {});
          res.json({ success: true, data });
        } catch (error) {
          logger.error('SOS update-config error:', error);
          res.status(500).json({ success: false, message: 'Failed to update SOS config' });
        }
      },
    ],
    [
      '/sos/broadcast',
      async (req, res) => {
        try {
          const { message, severity } = req.body || {};
          const data = await broadcastEmergencyAlert({ message, severity });
          res.json({ success: true, data });
        } catch (error) {
          logger.error('SOS broadcast error:', error);
          res.status(500).json({ success: false, message: 'Failed to broadcast SOS alert' });
        }
      },
    ],
    [
      '/sos/escalate/:alertId',
      async (req, res) => {
        try {
          const { alertId } = req.params;
          const { reason = null } = req.body || {};
          const data = await escalateAlert(alertId, reason);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('SOS escalate error:', error);
          res.status(500).json({ success: false, message: 'Failed to escalate SOS alert' });
        }
      },
    ],

    // Upload actions
    [
      '/upload/rescan/:fileId',
      async (req, res) => {
        try {
          const { fileId } = req.params;
          const data = await rescanFile(fileId);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Upload rescan error:', error);
          res.status(500).json({ success: false, message: 'Failed to rescan file' });
        }
      },
    ],
    [
      '/upload/cleanup',
      async (req, res) => {
        try {
          const { dryRun = true } = req.body || {};
          const data = await cleanupExpiredFiles(Boolean(dryRun));
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Upload cleanup error:', error);
          res.status(500).json({ success: false, message: 'Failed to cleanup expired files' });
        }
      },
    ],
    [
      '/upload/hipaa/bulk-protect',
      async (req, res) => {
        try {
          const payload = req.body || {};
          const data = await bulkUpdateHipaaProtection(payload);
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Upload bulk HIPAA protect error:', error);
          res.status(500).json({ success: false, message: 'Failed to update HIPAA protection' });
        }
      },
    ],
    [
      '/upload/quarantine/purge',
      async (req, res) => {
        try {
          const { dryRun = true } = req.body || {};
          const data = await purgeQuarantinedFiles(Boolean(dryRun));
          res.json({ success: true, data });
        } catch (error) {
          logger.error('Upload purge quarantine error:', error);
          res.status(500).json({ success: false, message: 'Failed to purge quarantined files' });
        }
      },
    ],
  ],
});

/* -------------------------------------------------------------------------- */
/*                           Mount admin sub-routers                           */
/* -------------------------------------------------------------------------- */

router.use('/audit', auditRoutes);
router.use('/events', eventOutboxRoutes);
router.use('/appointments', appointmentAdminRoutes);
router.use('/doctors', adminDoctorRoutes);
router.use('/departments', adminDepartmentRoutes);
router.use('/users', adminUserRoutes);
router.use('/notifications', adminNotificationRoutes);
router.use('/records', adminRecordRoutes);
router.use('/investigations', adminInvestigationRoutes);
router.use('/pharmacy', adminPharmacyRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/feature-flags', featureFlagRoutes);
router.use('/executive-kpi', executiveKpiRoutes);
router.use('/patient-identifiers', patientIdentifierRoutes);
router.use('/patient-merges', patientMergeRoutes);
router.use('/integrations', integrationRouter);
router.use('/webhook-subscriptions', subscriptionRouter);
router.use('/webhook-deliveries', deliveryRouter);
router.use('/surgical', surgicalDocumentationRoutes);
router.use('/telemedicine', telemedicineRoutes);

export default router;
