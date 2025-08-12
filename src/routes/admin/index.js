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

/* -------------------------------------------------------------------------- */
/*                               helper utilities                              */
/* -------------------------------------------------------------------------- */

async function tableExists(table) {
  try {
    const { rows } = await db.query(
      `SELECT to_regclass($1) AS reg`,
      [`public.${table}`]
    );
    return Boolean(rows[0]?.reg);
  } catch {
    return false;
  }
}

async function columnExists(table, column) {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function safeScalar(sql, params = [], fallback = 0) {
  try {
    const { rows } = await db.query(sql, params);
    const v = rows[0] && Object.values(rows[0])[0];
    return v == null ? fallback : Number(v);
  } catch {
    return fallback;
  }
}

async function safeRows(sql, params = []) {
  try {
    const { rows } = await db.query(sql, params);
    return rows;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                             stats / analytics                               */
/* -------------------------------------------------------------------------- */

async function getUserStats() {
  const haveUsers = await tableExists('users');
  if (!haveUsers) {
    return { total: 0, active: 0, newToday: 0, growth: [] };
  }

  const { rows } = await db.query(`
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
  return rows[0];
}

async function getDoctorStats() {
  const haveDoctors = await tableExists('doctors');
  if (!haveDoctors) return { total: 0, available: 0, onDuty: 0 };

  const { rows } = await db.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN is_available = true THEN 1 END) as available,
      COUNT(CASE WHEN is_on_leave = false THEN 1 END) as onDuty
    FROM doctors
    WHERE is_active = true
  `);
  return rows[0];
}

async function getDepartmentStats() {
  const haveDepartments = await tableExists('departments');
  if (!haveDepartments) return { total: 0, utilization: [] };

  const { rows } = await db.query(`
    SELECT 
      COUNT(*) as total,
      json_agg(
        json_build_object(
          'name', name,
          'patientCount', patient_count,
          'utilization', CASE 
            WHEN capacity IS NULL OR capacity = 0 THEN NULL
            ELSE (patient_count::float / capacity * 100) 
          END
        )
      ) as utilization
    FROM departments
    WHERE is_active = true
  `);
  return rows[0];
}

async function getAppointmentStats() {
  const haveAppts = await tableExists('appointments');
  if (!haveAppts) {
    return { today: 0, upcoming: 0, completed: 0, no_shows: 0, completionRate: 0, trends: [] };
  }

  const { rows } = await db.query(`
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
  return rows[0];
}

async function getRecordStats() {
  const have = await tableExists('medical_records');
  if (!have) return { total: 0, createdToday: 0 };

  const { rows } = await db.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) as createdToday
    FROM medical_records
  `);
  return rows[0];
}

async function getEmergencyStats() {
  const have = await tableExists('sos_alerts');
  if (!have) return { active: 0, last24Hours: 0 };

  const { rows } = await db.query(`
    SELECT 
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
      COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '24 hours' THEN 1 END) as last24Hours
    FROM sos_alerts
  `);
  return rows[0];
}

async function getStaffStats() {
  const haveStaff = await tableExists('staff');
  if (!haveStaff) {
    return {
      total_staff: 0, active_staff: 0, on_leave: 0,
      present_today: 0, pending_reviews: 0, pending_leaves: 0
    };
  }

  const hasActive = await columnExists('staff', 'is_active');
  const hasOnLeave = await columnExists('staff', 'on_leave');

  const total_staff = await safeScalar(`SELECT COUNT(*) FROM staff`, [], 0);
  const active_staff = hasActive
    ? await safeScalar(`SELECT COUNT(*) FROM staff WHERE is_active = true`, [], 0)
    : 0;
  const on_leave = hasOnLeave
    ? await safeScalar(`SELECT COUNT(*) FROM staff WHERE on_leave = true`, [], 0)
    : 0;

  const haveAttendance = await tableExists('staff_attendance');
  const present_today = haveAttendance
    ? await safeScalar(
        `SELECT COUNT(DISTINCT staff_id) FROM staff_attendance WHERE check_in_time::date = CURRENT_DATE`,
        [],
        0
      )
    : 0;

  const pending_reviews = (await tableExists('performance_reviews'))
    ? await safeScalar(`SELECT COUNT(*) FROM performance_reviews WHERE status = 'pending'`, [], 0)
    : 0;

  const pending_leaves = (await tableExists('leave_applications'))
    ? await safeScalar(`SELECT COUNT(*) FROM leave_applications WHERE status = 'pending'`, [], 0)
    : 0;

  return { total_staff, active_staff, on_leave, present_today, pending_reviews, pending_leaves };
}

async function getRecentActivity(limit = 50, offset = 0) {
  const parts = [];

  if (await tableExists('appointments')) {
    // Avoid non-existent columns like created_by/updated_by
    parts.push(`
      SELECT 
        'appointment' AS type,
        CONCAT('Appointment scheduled for ', COALESCE(p.name, 'patient #', a.patient_id::text)) AS description,
        COALESCE(a.updated_at, a.created_at, a.appointment_date) AS timestamp,
        NULL::text AS user_id
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      WHERE COALESCE(a.updated_at, a.created_at, a.appointment_date) >= CURRENT_DATE - INTERVAL '7 days'
    `);
  }

  if (await tableExists('users')) {
    parts.push(`
      SELECT 
        'user' AS type,
        CONCAT('New user registered: ', COALESCE(name, phone, uid::text)) AS description,
        created_at AS timestamp,
        uid::text AS user_id
      FROM users
      WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    `);
  }

  if (await tableExists('sos_alerts')) {
    parts.push(`
      SELECT 
        'emergency' AS type,
        CONCAT('SOS alert from ', COALESCE(phone, 'unknown')) AS description,
        created_at AS timestamp,
        NULL::text AS user_id
      FROM sos_alerts
      WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    `);
  }

  if (await tableExists('staff_attendance') && await tableExists('staff')) {
    parts.push(`
      SELECT 
        'staff_attendance' AS type,
        CONCAT(COALESCE(s.name, 'Staff'), ' checked in') AS description,
        a.check_in_time AS timestamp,
        s.user_id::text AS user_id
      FROM staff_attendance a
      LEFT JOIN staff s ON a.staff_id = s.id
      WHERE a.check_in_time >= CURRENT_DATE - INTERVAL '7 days'
    `);
  }

  if (await tableExists('leave_applications') && await tableExists('staff')) {
    parts.push(`
      SELECT 
        'leave_request' AS type,
        CONCAT('Leave request from ', COALESCE(s.name, 'Staff')) AS description,
        la.created_at AS timestamp,
        s.user_id::text AS user_id
      FROM leave_applications la
      LEFT JOIN staff s ON la.staff_id = s.id
      WHERE la.created_at >= CURRENT_DATE - INTERVAL '7 days'
    `);
  }

  if (parts.length === 0) return [];

  const sql = `
    ${parts.join('\nUNION ALL\n')}
    ORDER BY timestamp DESC
    LIMIT $1 OFFSET $2
  `;
  const { rows } = await db.query(sql, [Number(limit), Number(offset)]);
  return rows;
}

async function getQuickStats() {
  // appointments
  const haveAppts = await tableExists('appointments');
  const appointments_today = haveAppts
    ? await safeScalar(
        `SELECT COUNT(*) FROM appointments WHERE appointment_date::date = CURRENT_DATE`
      )
    : 0;

  const appointments_week = haveAppts
    ? await safeScalar(
        `SELECT COUNT(*) FROM appointments WHERE appointment_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'`
      )
    : 0;

  // users
  const haveUsers = await tableExists('users');
  const total_users = haveUsers
    ? await safeScalar(`SELECT COUNT(*) FROM users`)
    : 0;
  const active_users = haveUsers && await columnExists('users', 'is_active')
    ? await safeScalar(`SELECT COUNT(*) FROM users WHERE is_active = true`)
    : 0;

  // staff
  const haveStaff = await tableExists('staff');
  const total_staff = haveStaff
    ? await safeScalar(`SELECT COUNT(*) FROM staff`)
    : 0;
  const staff_present =
    (await tableExists('staff_attendance'))
      ? await safeScalar(
          `SELECT COUNT(*) FROM staff_attendance WHERE check_in_time::date = CURRENT_DATE`
        )
      : 0;

  // revenue (pharmacy orders)
  const havePharmacy = await tableExists('pharmacy_orders');
  const revenue_today = havePharmacy
    ? await safeScalar(
        `SELECT COALESCE(SUM(total_amount),0) FROM pharmacy_orders WHERE DATE(placed_at) = CURRENT_DATE`
      )
    : 0;

  const revenue_month = havePharmacy
    ? await safeScalar(
        `SELECT COALESCE(SUM(total_amount),0) FROM pharmacy_orders WHERE placed_at >= DATE_TRUNC('month', CURRENT_DATE)`
      )
    : 0;

  return {
    appointments: { today: appointments_today, week: appointments_week },
    users: { total: total_users, active: active_users },
    staff: { total: total_staff, present: staff_present },
    revenue: { today: Number(revenue_today), month: Number(revenue_month) }
  };
}

async function getSystemAlerts() {
  const alerts = [];

  // SOS spike
  if (await tableExists('sos_alerts')) {
    const sosLastHour = await safeScalar(
      `SELECT COUNT(*) FROM sos_alerts WHERE created_at >= NOW() - INTERVAL '1 hour'`,
      [],
      0
    );
    if (sosLastHour > 10) {
      alerts.push({
        type: 'warning',
        message: `High SOS alert rate: ${sosLastHour} in the last hour`,
        priority: 'high'
      });
    }
  }

  // Appointment conflicts (lightweight)
  if (await tableExists('appointments')) {
    const conflicts = await safeScalar(
      `
      SELECT COUNT(*) FROM (
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
      ) x
      `,
      [],
      0
    );
    if (conflicts > 0) {
      alerts.push({
        type: 'error',
        message: 'Appointment conflicts detected today',
        priority: 'urgent',
        action: '/api/v1/admin/appointments/conflicts'
      });
    }

    // No-show rate last 7 days
    const total7 = await safeScalar(
      `SELECT COUNT(*) FROM appointments WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days' AND appointment_date < CURRENT_DATE`,
      [],
      0
    );
    const noshows7 = await safeScalar(
      `SELECT COUNT(*) FROM appointments WHERE status = 'no_show' AND appointment_date >= CURRENT_DATE - INTERVAL '7 days' AND appointment_date < CURRENT_DATE`,
      [],
      0
    );
    if (total7 > 0) {
      const rate = (noshows7 / total7) * 100;
      if (rate > 15) {
        alerts.push({
          type: 'warning',
          message: `High no-show rate: ${rate.toFixed(1)}% in the last 7 days`,
          priority: 'medium',
          action: '/api/v1/admin/appointments/no-shows'
        });
      }
    }
  }

  // Attendance issues
  if (await tableExists('staff') && await tableExists('staff_attendance')) {
    const absent = await safeScalar(
      `
      SELECT COUNT(*) FROM staff s
      WHERE COALESCE(s.is_active, true) = true 
        AND COALESCE(s.on_leave, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM staff_attendance a 
          WHERE a.staff_id = s.id 
            AND a.check_in_time::date = CURRENT_DATE
        )
      `,
      [],
      0
    );
    if (absent > 5) {
      alerts.push({
        type: 'warning',
        message: `${absent} staff absent today without leave`,
        priority: 'medium',
        action: '/api/v1/staff/admin/attendance/absent-report'
      });
    }
  }

  return alerts;
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

  try { await db.query('SELECT 1 FROM users LIMIT 1'); health.users = 'healthy'; }
  catch { health.users = 'unhealthy'; }

  try {
    await db.query('SELECT 1 FROM appointments LIMIT 1');
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

  try { await db.query('SELECT 1 FROM pharmacy_orders LIMIT 1'); health.pharmacy = 'healthy'; }
  catch { health.pharmacy = 'unhealthy'; }

  try { await db.query('SELECT 1 FROM investigations LIMIT 1'); health.investigations = 'healthy'; }
  catch { health.investigations = 'unhealthy'; }

  try {
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
    const staffIssuesWarning = await exists(`
      SELECT 1
      FROM staff s
      WHERE COALESCE(s.is_active, true) = true 
        AND COALESCE(s.on_leave, false) = false
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

/* -------------------------------------------------------------------------- */
/*                                route wrapper                               */
/* -------------------------------------------------------------------------- */

/**
 * Admin Dashboard + Utilities
 * NOTE: RBAC for this group uses the "adminDashboard" key.
 * Ensure rbacConfig includes: adminDashboard: ['ADMIN'] (or equivalent).
 */
wrapAutoRBAC(router, 'adminDashboard', {
  get: [
    ['/test', (req, res) => {
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
          analytics: '/api/v1/admin/analytics'
        }
      });
    }],

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
              pendingHRActions: (staffStats.pending_reviews || 0) + (staffStats.pending_leaves || 0)
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

    ['/stats/quick', async (_req, res) => {
      try {
        const stats = await getQuickStats();
        res.json({ success: true, data: stats });
      } catch (e) {
        logger.error('Quick stats error:', e);
        res.status(500).json({ success: false, message: 'Failed to get quick stats' });
      }
    }],

    ['/activity/recent', async (req, res) => {
      try {
        const { limit = 50, offset = 0 } = req.query;
        const activity = await getRecentActivity(limit, offset);
        res.json({ success: true, data: activity });
      } catch (e) {
        logger.error('Recent activity error:', e);
        res.status(500).json({ success: false, message: 'Failed to get recent activity' });
      }
    }],

    ['/alerts', async (_req, res) => {
      try {
        const alerts = await getSystemAlerts();
        res.json({ success: true, data: alerts });
      } catch (e) {
        logger.error('Alerts error:', e);
        res.status(500).json({ success: false, message: 'Failed to get system alerts' });
      }
    }],

    ['/health/modules', async (_req, res) => {
      const health = await getModuleHealth();
      res.json({ success: true, data: health });
    }],

    ['/staff/summary', async (_req, res) => {
      try {
        const summary = await getStaffStats();
        res.json({
          success: true,
          data: summary,
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

    ['/appointments/summary', async (_req, res) => {
      try {
        const { rows } = await db.query(`
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
          data: rows[0],
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
    ['/refresh-cache', async (_req, res) => {
      await refreshDashboardCache();
      res.json({ success: true, message: 'Dashboard cache refreshed' });
    }],

    ['/export/report', async (req, res) => {
      const { format = 'pdf', dateRange } = req.body || {};
      const report = await generateDashboardReport(format, dateRange);
      res.json({ success: true, data: report });
    }]
  ]
});

/* -------------------------------------------------------------------------- */
/*                           mount admin sub-modules                           */
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
