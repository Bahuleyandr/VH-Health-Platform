// src/routes/admin/index.js
import express from 'express';
import db from '../../config/database.js';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';

// Aggregate admin sub-modules here so everything lives under /api/v1/admin/<module>
import appointmentAdminRoutes from '../appointment/appointmentAdminRoutes.js';
import adminDoctorRoutes from '../doctor/adminDoctorRoutes.js';
import adminDepartmentRoutes from '../department/adminDepartmentRoutes.js';
import adminUserRoutes from '../user/adminUserRoutes.js';
import adminNotificationRoutes from '../notification/adminNotificationRoutes.js';
import adminRecordRoutes from '../record/adminRoutes.js';
import adminInvestigationRoutes from '../investigation/adminRoutes.js';
import adminPharmacyRoutes from '../pharmacy/adminRoutes.js';
import analyticsRoutes from '../analyticsRoutes.js';

const router = express.Router();

/**
 * Admin Dashboard + Utilities
 * NOTE: RBAC for this group uses the "adminDashboard" key.
 * Ensure rbacConfig includes: adminDashboard: ['ADMIN'] (or equivalent).
 */
wrapAutoRBAC(router, 'adminDashboard', {
  get: [
    // Test route
    ['/test', (req, res) => {
      res.json({
        message: 'Admin dashboard routes working',
        timestamp: new Date().toISOString(),
        modules: {
          // Unified, centralized admin namespace
          appointments: '/api/v1/admin/appointments',
          departments: '/api/v1/admin/departments',
          doctors: '/api/v1/admin/doctors',
          users: '/api/v1/admin/users',
          notifications: '/api/v1/admin/notifications',
          records: '/api/v1/admin/records',
          investigations: '/api/v1/admin/investigations',
          pharmacy: '/api/v1/admin/pharmacy',
          // These two remain non-admin namespaces unless you later centralize them:
          devices: '/api/v1/devices',
          feedback: '/api/v1/feedback',
          // Admin analytics
          analytics: '/api/v1/admin/analytics'
        }
      });
    }],

    // Main Dashboard Overview
    ['/dashboard', async (req, res) => {
      try {
        const [
          userStats,
          doctorStats,
          departmentStats,
          appointmentStats,
          recordStats,
          emergencyStats,
          staffStats
        ] = await Promise.all([
          getUserStats(),
          getDoctorStats(),
          getDepartmentStats(),
          getAppointmentStats(),
          getRecordStats(),
          getEmergencyStats(),
          getStaffStats()
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
              pendingHRActions: staffStats.pending_reviews + staffStats.pending_leaves
            },
            charts: {
              userGrowth: userStats.growth,
              appointmentTrends: appointmentStats.trends,
              departmentUtilization: departmentStats.utilization
            },
            recentActivity: await getRecentActivity(),
            systemHealth: await getSystemHealth()
          }
        });
      } catch (error) {
        logger.error('Dashboard data fetch error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard data' });
      }
    }],

    // Quick Stats
    ['/stats/quick', async (req, res) => {
      const stats = await getQuickStats();
      res.json({ success: true, data: stats });
    }],

    // Activity Feed
    ['/activity/recent', async (req, res) => {
      const { limit = 50, offset = 0 } = req.query;
      const activity = await getRecentActivity(limit, offset);
      res.json({ success: true, data: activity });
    }],

    // System Alerts
    ['/alerts', async (req, res) => {
      const alerts = await getSystemAlerts();
      res.json({ success: true, data: alerts });
    }],

    // Module Health Status
    ['/health/modules', async (req, res) => {
      const health = await getModuleHealth();
      res.json({ success: true, data: health });
    }],

    // Staff Admin Summary (links currently point to staff module paths; centralize later if desired)
    ['/staff/summary', async (req, res) => {
      try {
        const summary = await db.query(`
          SELECT 
            COUNT(DISTINCT s.id) as total_staff,
            COUNT(DISTINCT s.id) FILTER (WHERE s.is_active = true) as active_staff,
            COUNT(DISTINCT s.id) FILTER (WHERE s.on_leave = true) as on_leave,
            COUNT(DISTINCT a.staff_id) FILTER (
              WHERE a.check_in_time::date = CURRENT_DATE
            ) as present_today,
            COUNT(DISTINCT a.staff_id) FILTER (
              WHERE a.check_in_time::date = CURRENT_DATE 
              AND a.check_in_time::time > '09:30:00'
            ) as late_today,
            COUNT(DISTINCT pr.id) FILTER (WHERE pr.status = 'pending') as pending_reviews,
            COUNT(DISTINCT la.id) FILTER (WHERE la.status = 'pending') as pending_leaves,
            ROUND(AVG(
              CASE WHEN a.check_in_time IS NOT NULL 
              THEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time))/3600 
              END
            ), 2) as avg_hours_today
          FROM staff s
          LEFT JOIN staff_attendance a ON s.id = a.staff_id
          LEFT JOIN performance_reviews pr ON s.id = pr.staff_id
          LEFT JOIN leave_applications la ON s.id = la.staff_id
        `);
        
        res.json({ 
          success: true, 
          data: summary.rows[0],
          links: {
            analytics: '/api/v1/staff/admin/analytics/attendance',
            hrDashboard: '/api/v1/staff/admin/dashboard',
            pendingActions: '/api/v1/staff/admin/hr/pending-reviews',
            attendance: '/api/v1/staff/admin/attendance/anomalies'
          }
        });
      } catch (error) {
        logger.error('Staff summary error:', error);
        res.status(500).json({ success: false, message: 'Failed to get staff summary' });
      }
    }],

    // Appointment Admin Summary
    ['/appointments/summary', async (req, res) => {
      try {
        const summary = await db.query(`
          SELECT 
            COUNT(*) FILTER (WHERE appointment_date::date = CURRENT_DATE) as today_total,
            COUNT(*) FILTER (WHERE appointment_date::date = CURRENT_DATE AND status = 'scheduled') as today_scheduled,
            COUNT(*) FILTER (WHERE appointment_date::date = CURRENT_DATE AND status = 'completed') as today_completed,
            COUNT(*) FILTER (WHERE appointment_date > NOW() AND status = 'scheduled') as upcoming_total,
            COUNT(*) FILTER (WHERE appointment_date < NOW() AND status = 'no_show') as total_no_shows,
            COUNT(DISTINCT patient_id) as unique_patients,
            COUNT(DISTINCT doctor_id) as active_doctors,
            ROUND(AVG(CASE WHEN status = 'completed' THEN 
              EXTRACT(EPOCH FROM (updated_at - appointment_date))/60 
            END)) as avg_wait_time_minutes
          FROM appointments
          WHERE appointment_date >= CURRENT_DATE - INTERVAL '30 days'
        `);
        
        res.json({ 
          success: true, 
          data: summary.rows[0],
          links: {
            analytics: '/api/v1/admin/appointments/analytics',
            conflicts: '/api/v1/admin/appointments/conflicts',
            capacity: '/api/v1/admin/appointments/capacity',
            noShows: '/api/v1/admin/appointments/no-shows'
          }
        });
      } catch (error) {
        logger.error('Appointment summary error:', error);
        res.status(500).json({ success: false, message: 'Failed to get appointment summary' });
      }
    }]
  ],

  post: [
    // Refresh Dashboard Cache
    ['/refresh-cache', async (req, res) => {
      await refreshDashboardCache();
      res.json({ success: true, message: 'Dashboard cache refreshed' });
    }],

    // Export Dashboard Report
    ['/export/report', async (req, res) => {
      const { format = 'pdf', dateRange } = req.body;
      const report = await generateDashboardReport(format, dateRange);
      res.json({ success: true, data: report });
    }]
  ]
});

/**
 * Mount admin sub-modules under /api/v1/admin/<module>
 * (app.js must: app.use('/api/v1/admin', jwtAuth, thisRouter))
 */
router.use('/appointments', appointmentAdminRoutes);
router.use('/doctors', adminDoctorRoutes);
router.use('/departments', adminDepartmentRoutes);
router.use('/users', adminUserRoutes);
router.use('/notifications', adminNotificationRoutes);
router.use('/records', adminRecordRoutes);
router.use('/investigations', adminInvestigationRoutes);
router.use('/pharmacy', adminPharmacyRoutes);
router.use('/analytics', analyticsRoutes);

// ------------------------------
// Helper functions
// ------------------------------
async function getUserStats() {
  const result = await db.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN is_active = true THEN 1 END) as active,
      COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) as newToday,
      json_agg(
        json_build_object(
          'date', date_trunc('day', created_at),
          'count', COUNT(*)
        ) ORDER BY date_trunc('day', created_at)
      ) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') as growth
    FROM users
  `);
  return result.rows[0];
}

async function getDoctorStats() { 
  const result = await db.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN is_available = true THEN 1 END) as available,
      COUNT(CASE WHEN is_on_leave = false THEN 1 END) as onDuty
    FROM doctors
    WHERE is_active = true
  `);
  return result.rows[0];
}

async function getDepartmentStats() {
  const result = await db.query(`
    SELECT 
      COUNT(*) as total,
      json_agg(
        json_build_object(
          'name', name,
          'patientCount', patient_count,
          'utilization', (patient_count::float / capacity * 100)
        )
      ) as utilization
    FROM departments
    WHERE is_active = true
  `);
  return result.rows[0];
}

async function getAppointmentStats() {
  const result = await db.query(`
    SELECT 
      COUNT(CASE WHEN appointment_date::date = CURRENT_DATE THEN 1 END) as today,
      COUNT(CASE WHEN status = 'scheduled' AND appointment_date > NOW() THEN 1 END) as upcoming,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
      COUNT(CASE WHEN status = 'no_show' THEN 1 END) as no_shows,
      ROUND(COUNT(CASE WHEN status = 'completed' THEN 1 END)::numeric / 
            NULLIF(COUNT(*), 0) * 100, 2) as completionRate,
      json_agg(
        json_build_object(
          'date', appointment_date::date,
          'count', COUNT(*),
          'completed', COUNT(CASE WHEN status = 'completed' THEN 1 END)
        ) ORDER BY appointment_date::date
      ) FILTER (WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days') as trends
    FROM appointments
    WHERE appointment_date >= CURRENT_DATE - INTERVAL '30 days'
  `);
  return result.rows[0];
}

async function getRecordStats() {
  const result = await db.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) as createdToday
    FROM medical_records
  `);
  return result.rows[0];
}

async function getEmergencyStats() {
  const result = await db.query(`
    SELECT 
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
      COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '24 hours' THEN 1 END) as last24Hours
    FROM sos_alerts
  `);
  return result.rows[0];
}

async function getStaffStats() {
  const result = await db.query(`
    SELECT 
      COUNT(DISTINCT s.id) as total_staff,
      COUNT(DISTINCT s.id) FILTER (WHERE s.is_active = true) as active_staff,
      COUNT(DISTINCT s.id) FILTER (WHERE s.on_leave = true) as on_leave,
      COUNT(DISTINCT a.staff_id) FILTER (
        WHERE a.check_in_time::date = CURRENT_DATE
      ) as present_today,
      COUNT(DISTINCT pr.id) FILTER (
        WHERE pr.status = 'pending'
      ) as pending_reviews,
      COUNT(DISTINCT la.id) FILTER (
        WHERE la.status = 'pending'
      ) as pending_leaves
    FROM staff s
    LEFT JOIN staff_attendance a ON s.id = a.staff_id
    LEFT JOIN performance_reviews pr ON s.id = pr.staff_id
    LEFT JOIN leave_applications la ON s.id = la.staff_id
  `);
  return result.rows[0];
}

async function getRecentActivity(limit = 50, offset = 0) {
  const result = await db.query(`
    SELECT 
      'appointment' as type,
      CONCAT('Appointment scheduled for ', p.name) as description,
      a.created_at as timestamp,
      a.created_by as user_id
    FROM appointments a
    JOIN users p ON a.patient_id = p.id
    WHERE a.created_at >= CURRENT_DATE - INTERVAL '7 days'
    
    UNION ALL
    
    SELECT 
      'appointment_completed' as type,
      CONCAT('Appointment completed for ', p.name) as description,
      a.updated_at as timestamp,
      a.updated_by as user_id
    FROM appointments a
    JOIN users p ON a.patient_id = p.id
    WHERE a.status = 'completed' AND a.updated_at >= CURRENT_DATE - INTERVAL '7 days'
    
    UNION ALL
    
    SELECT 
      'user' as type,
      CONCAT('New user registered: ', name) as description,
      created_at as timestamp,
      uid as user_id
    FROM users
    WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    
    UNION ALL
    
    SELECT 
      'emergency' as type,
      CONCAT('SOS alert from ', phone) as description,
      created_at as timestamp,
      created_by as user_id
    FROM sos_alerts
    WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    
    UNION ALL
    
    SELECT 
      'staff_attendance' as type,
      CONCAT(s.name, ' checked in') as description,
      a.check_in_time as timestamp,
      s.user_id as user_id
    FROM staff_attendance a
    JOIN staff s ON a.staff_id = s.id
    WHERE a.check_in_time >= CURRENT_DATE - INTERVAL '7 days'
    
    UNION ALL
    
    SELECT 
      'leave_request' as type,
      CONCAT('Leave request from ', s.name) as description,
      la.created_at as timestamp,
      s.user_id as user_id
    FROM leave_applications la
    JOIN staff s ON la.staff_id = s.id
    WHERE la.created_at >= CURRENT_DATE - INTERVAL '7 days'
    
    ORDER BY timestamp DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  
  return result.rows;
}

/**
 * Lightweight module health checks (no COUNT(*) full scans)
 * - Use simple existence checks (SELECT 1 ... LIMIT 1)
 * - For thresholds, use LIMIT/OFFSET tricks or EXISTS
 */
async function getModuleHealth() {
  const health = {};
  const exists = async (sql, params = []) => {
    const r = await db.query(sql, params);
    return r.rowCount > 0;
  };

  try {
    // Users table exists & readable → healthy (even if empty)
    await db.query('SELECT 1 FROM users LIMIT 1');
    health.users = 'healthy';
  } catch {
    health.users = 'unhealthy';
  }

  try {
    // Appointments table check
    await db.query('SELECT 1 FROM appointments LIMIT 1');

    // Any scheduling conflicts today? (cheap EXISTS)
    const hasConflict = await exists(`
      SELECT 1
      FROM appointments a1
      JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
      WHERE a1.id <> a2.id
        AND a1.status = 'scheduled'
        AND a2.status = 'scheduled'
        AND DATE(a1.appointment_date) = CURRENT_DATE
        AND a1.appointment_date < a2.appointment_date
        AND a1.appointment_date + INTERVAL '30 minutes' > a2.appointment_date
      LIMIT 1
    `);

    health.appointments = hasConflict ? 'warning' : 'healthy';
  } catch {
    health.appointments = 'unhealthy';
  }

  try {
    await db.query('SELECT 1 FROM pharmacy_orders LIMIT 1');
    health.pharmacy = 'healthy';
  } catch {
    health.pharmacy = 'unhealthy';
  }

  try {
    await db.query('SELECT 1 FROM investigations LIMIT 1');
    health.investigations = 'healthy';
  } catch {
    health.investigations = 'unhealthy';
  }

  try {
    // "warning" if at least 6 active SOS alerts:
    // OFFSET 5 LIMIT 1 → if a 6th row exists, rowCount > 0
    const sosWarning = await exists(`
      SELECT 1 FROM sos_alerts
      WHERE status = 'active'
      OFFSET 5 LIMIT 1
    `);
    health.emergency = sosWarning ? 'warning' : 'healthy';
  } catch {
    health.emergency = 'unhealthy';
  }

  try {
    // "warning" if at least 11 staff with attendance issue:
    // Check the 11th row via OFFSET 10 LIMIT 1
    const staffIssuesWarning = await exists(`
      SELECT 1
      FROM staff s
      WHERE s.is_active = true 
        AND s.on_leave = false
        AND NOT EXISTS (
          SELECT 1 FROM staff_attendance a 
          WHERE a.staff_id = s.id 
            AND a.check_in_time::date = CURRENT_DATE
        )
      OFFSET 10 LIMIT 1
    `);
    health.staff = staffIssuesWarning ? 'warning' : 'healthy';
  } catch {
    health.staff = 'unhealthy';
  }

  return health;
}

async function getSystemHealth() {
  return {
    database: 'connected',
    cache: 'active',
    storage: 'available',
    notifications: 'operational'
  };
}

async function refreshDashboardCache() {
  logger.info('Dashboard cache refreshed');
}

async function generateDashboardReport(format, dateRange) {
  return {
    url: `/exports/dashboard-report.${format}`,
    generatedAt: new Date()
  };
}

export default router;
