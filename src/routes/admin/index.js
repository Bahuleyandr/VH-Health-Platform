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
    const { rows } = await db.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
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

async function safeQuery(sql, params = [], label = 'query') {
  try {
    const r = await db.query(sql, params);
    return r.rows;
  } catch (err) {
    logger.warn(`[admin:${label}] skipped: ${err.message}`);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                             stats / analytics                               */
/* -------------------------------------------------------------------------- */

async function getUserStats() {
  if (!(await tableExists('users'))) {
    return { total: 0, active: 0, newToday: 0, growth: [] };
  }

  const total = await safeScalar(`SELECT COUNT(*) FROM users`);
  const active = (await columnExists('users', 'is_active'))
    ? await safeScalar(`SELECT COUNT(*) FROM users WHERE is_active = true`)
    : 0;
  const newToday = (await columnExists('users', 'created_at'))
    ? await safeScalar(`SELECT COUNT(*) FROM users WHERE (created_at)::date = CURRENT_DATE`)
    : 0;

  const growth = (await columnExists('users', 'created_at'))
    ? await safeQuery(
        `
        SELECT date_trunc('day', created_at) AS date, COUNT(*)::int AS count
        FROM users
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1
        `,
        [],
        'users.growth'
      )
    : [];

  return { total, active, newToday, growth };
}

async function getDoctorStats() {
  if (!(await tableExists('doctors'))) return { total: 0, available: 0, onDuty: 0 };

  // Fallback-friendly: treat missing columns as 0
  const total = await safeScalar(`SELECT COUNT(*) FROM doctors`);
  const available = (await columnExists('doctors', 'is_available'))
    ? await safeScalar(`SELECT COUNT(*) FROM doctors WHERE is_available = true`)
    : 0;
  const onDuty = (await columnExists('doctors', 'is_on_leave'))
    ? await safeScalar(`SELECT COUNT(*) FROM doctors WHERE COALESCE(is_on_leave,false) = false`)
    : 0;

  return { total, available, onDuty };
}

async function getDepartmentStats() {
  if (!(await tableExists('departments'))) return { total: 0, utilization: [] };

  const totalRows = await safeQuery(`SELECT COUNT(*)::int AS total FROM departments`, [], 'depts.count');
  const names = await safeQuery(`SELECT name FROM departments ORDER BY name LIMIT 20`, [], 'depts.names');

  return {
    total: totalRows[0]?.total ?? 0,
    // Don’t assume capacity/patient_count exist yet
    utilization: names.map((r) => ({ name: r.name, patientCount: null, utilization: null })),
  };
}

async function getAppointmentStats() {
  if (!(await tableExists('appointments'))) {
    return { today: 0, upcoming: 0, completed: 0, no_shows: 0, completionRate: 0, trends: [], avg_wait_time_minutes: null };
  }

  const core = await safeQuery(
    `
    SELECT
      COUNT(*) FILTER (WHERE (appointment_date)::date = CURRENT_DATE)::int AS today,
      COUNT(*) FILTER (WHERE status = 'scheduled' AND appointment_date > NOW())::int AS upcoming,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
      COUNT(*)::int AS total
    FROM appointments
    `,
    [],
    'appts.core'
  );
  const r = core[0] || { today: 0, upcoming: 0, completed: 0, no_shows: 0, total: 0 };

  const trends = await safeQuery(
    `
    SELECT (appointment_date)::date AS date,
           COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
    FROM appointments
    WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY 1
    ORDER BY 1
    `,
    [],
    'appts.trends'
  );

  const wait = await safeQuery(
    `
    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(updated_at, appointment_date) - appointment_date)) / 60))::int AS minutes
    FROM appointments
    WHERE status = 'completed'
      AND (appointment_date)::date = CURRENT_DATE
    `,
    [],
    'appts.wait'
  );

  const completionRate = r.total > 0 ? Math.round((r.completed * 10000) / r.total) / 100 : 0;

  return {
    today: r.today ?? 0,
    upcoming: r.upcoming ?? 0,
    completed: r.completed ?? 0,
    no_shows: r.no_shows ?? 0,
    completionRate,
    trends,
    avg_wait_time_minutes: wait[0]?.minutes ?? null,
  };
}

async function getRecordStats() {
  if (!(await tableExists('medical_records'))) return { total: 0, createdToday: 0 };

  const rows = await safeQuery(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE (created_at)::date = CURRENT_DATE)::int AS createdtoday
    FROM medical_records
    `,
    [],
    'records.core'
  );
  return { total: rows[0]?.total ?? 0, createdToday: rows[0]?.createdtoday ?? 0 };
}

async function getEmergencyStats() {
  if (!(await tableExists('sos_alerts'))) return { active: 0, last24Hours: 0 };

  const rows = await safeQuery(
    `
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int AS active,
      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '24 hours')::int AS last24hours
    FROM sos_alerts
    `,
    [],
    'sos.core'
  );
  return { active: rows[0]?.active ?? 0, last24Hours: rows[0]?.last24hours ?? 0 };
}

async function getStaffStats() {
  if (!(await tableExists('staff'))) {
    return { total_staff: 0, active_staff: 0, on_leave: 0, present_today: 0, pending_reviews: 0, pending_leaves: 0 };
  }

  const core = await safeQuery(
    `
    SELECT
      COUNT(*)::int AS total_staff,
      COUNT(*) FILTER (WHERE COALESCE(is_active, true) = true)::int AS active_staff,
      COUNT(*) FILTER (WHERE COALESCE(on_leave, false) = true)::int AS on_leave
    FROM staff
    `,
    [],
    'staff.core'
  );

  const present = (await tableExists('staff_attendance'))
    ? await safeQuery(
        `
        SELECT COUNT(DISTINCT staff_id)::int AS present_today
        FROM staff_attendance
        WHERE (check_in_time)::date = CURRENT_DATE
        `,
        [],
        'staff.present'
      )
    : [{ present_today: 0 }];

  const pendingReviews = (await tableExists('performance_reviews'))
    ? await safeQuery(`SELECT COUNT(*)::int AS c FROM performance_reviews WHERE status = 'pending'`, [], 'staff.reviews')
    : [{ c: 0 }];

  const pendingLeaves = (await tableExists('leave_applications'))
    ? await safeQuery(`SELECT COUNT(*)::int AS c FROM leave_applications WHERE status = 'pending'`, [], 'staff.leaves')
    : [{ c: 0 }];

  return {
    total_staff: core[0]?.total_staff ?? 0,
    active_staff: core[0]?.active_staff ?? 0,
    on_leave: core[0]?.on_leave ?? 0,
    present_today: present[0]?.present_today ?? 0,
    pending_reviews: pendingReviews[0]?.c ?? 0,
    pending_leaves: pendingLeaves[0]?.c ?? 0,
  };
}

async function getRecentActivity(limit = 50, offset = 0) {
  // Build from several sources, no fragile joins/columns.
  const apptCreated = await safeQuery(
    `
    SELECT 'appointment' AS type,
           'Appointment created' AS description,
           created_at AS timestamp,
           NULL::text AS user_id
    FROM appointments
    WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset],
    'activity.appt_created'
  );

  const apptCompleted = await safeQuery(
    `
    SELECT 'appointment_completed' AS type,
           'Appointment completed' AS description,
           COALESCE(updated_at, created_at) AS timestamp,
           NULL::text AS user_id
    FROM appointments
    WHERE status = 'completed'
      AND COALESCE(updated_at, created_at) >= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset],
    'activity.appt_completed'
  );

  const userRegistered = await safeQuery(
    `
    SELECT 'user' AS type,
           'New user registered' AS description,
           created_at AS timestamp,
           (uid)::text AS user_id
    FROM users
    WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset],
    'activity.users'
  );

  const sos = await safeQuery(
    `
    SELECT 'emergency' AS type,
           CONCAT('SOS alert (', COALESCE(status, 'new'), ')') AS description,
           created_at AS timestamp,
           NULL::text AS user_id
    FROM sos_alerts
    WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset],
    'activity.sos'
  );

  const all = [...apptCreated, ...apptCompleted, ...userRegistered, ...sos];
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return all.slice(0, limit);
}

/**
 * Lightweight module health checks (no COUNT(*) full scans)
 */
async function getModuleHealth() {
  const health = {};

  // Users
  health.users = (await safeQuery('SELECT 1 FROM users LIMIT 1', [], 'health.users')).length ? 'healthy' : 'unhealthy';

  // Appointments + simple conflict heuristic
  const apptAny = await safeQuery('SELECT 1 FROM appointments LIMIT 1', [], 'health.appts');
  if (apptAny.length) {
    const conflict = await safeQuery(
      `
      SELECT 1
      FROM appointments a1
      JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
      WHERE a1.id <> a2.id
        AND a1.status = 'scheduled' AND a2.status = 'scheduled'
        AND (a1.appointment_date)::date = CURRENT_DATE
        AND a1.appointment_date < a2.appointment_date
        AND a1.appointment_date + INTERVAL '30 minutes' > a2.appointment_date
      LIMIT 1
      `,
      [],
      'health.appt_conflict'
    );
    health.appointments = conflict.length ? 'warning' : 'healthy';
  } else {
    health.appointments = 'unhealthy';
  }

  // Pharmacy
  health.pharmacy =
    (await safeQuery('SELECT 1 FROM pharmacy_orders LIMIT 1', [], 'health.pharm')).length ? 'healthy' : 'unhealthy';

  // Investigations
  health.investigations =
    (await safeQuery('SELECT 1 FROM investigations LIMIT 1', [], 'health.invest')).length ? 'healthy' : 'unhealthy';

  // SOS (warning if >= 6 active)
  const sosWarn = await safeQuery(
    `SELECT 1 FROM sos_alerts WHERE status = 'active' OFFSET 5 LIMIT 1`,
    [],
    'health.sos_warn'
  );
  health.emergency = sosWarn.length ? 'warning' : 'healthy';

  // Staff (warning if many with no check-in today) — use staff.id consistently
  const staffWarn = await safeQuery(
    `
    SELECT 1
    FROM staff s
    WHERE COALESCE(s.is_active, true) = true
      AND COALESCE(s.on_leave, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM staff_attendance a
        WHERE a.staff_id = s.id
          AND (a.check_in_time)::date = CURRENT_DATE
      )
    OFFSET 10 LIMIT 1
    `,
    [],
    'health.staff_warn'
  );
  health.staff = staffWarn.length ? 'warning' : 'healthy';

  return health;
}

async function getSystemAlerts() {
  const alerts = [];

  // SOS spike
  if (await tableExists('sos_alerts')) {
    const sosLastHour = await safeScalar(
      `SELECT COUNT(*) FROM sos_alerts WHERE created_at >= NOW() - INTERVAL '1 hour'`
    );
    if (sosLastHour > 10) {
      alerts.push({
        type: 'warning',
        message: `High SOS alert rate: ${sosLastHour} in the last hour`,
        priority: 'high',
      });
    }
  }

  // Appointment conflicts (lightweight)
  if (await tableExists('appointments')) {
    const conflicts = await safeQuery(
      `
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
      `,
      [],
      'alerts.conflicts'
    );
    if (conflicts.length) {
      alerts.push({
        type: 'error',
        message: 'Appointment conflicts detected today',
        priority: 'urgent',
        action: '/api/v1/admin/appointments/conflicts',
      });
    }

    // No-show rate last 7 days
    const total7 = await safeScalar(
      `SELECT COUNT(*) FROM appointments WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days' AND appointment_date < CURRENT_DATE`
    );
    const noshows7 = await safeScalar(
      `SELECT COUNT(*) FROM appointments WHERE status = 'no_show' AND appointment_date >= CURRENT_DATE - INTERVAL '7 days' AND appointment_date < CURRENT_DATE`
    );
    if (total7 > 0) {
      const rate = (noshows7 / total7) * 100;
      if (rate > 15) {
        alerts.push({
          type: 'warning',
          message: `High no-show rate: ${rate.toFixed(1)}% in the last 7 days`,
          priority: 'medium',
          action: '/api/v1/admin/appointments/no-shows',
        });
      }
    }
  }

  // Attendance issues
  if ((await tableExists('staff')) && (await tableExists('staff_attendance'))) {
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
      `
    );
    if (absent > 5) {
      alerts.push({
        type: 'warning',
        message: `${absent} staff absent today without leave`,
        priority: 'medium',
        action: '/api/v1/staff/admin/attendance/absent-report',
      });
    }
  }

  return alerts;
}

async function getSystemHealth() {
  return { database: 'connected', cache: 'active', storage: 'available', notifications: 'operational' };
}

async function refreshDashboardCache() {
  logger.info('Dashboard cache refreshed');
}

async function generateDashboardReport(format, _dateRange) {
  return { url: `/exports/dashboard-report.${format}`, generatedAt: new Date() };
}

/* -------------------------------------------------------------------------- */
/*                                route wrapper                               */
/* -------------------------------------------------------------------------- */

wrapAutoRBAC(router, 'adminDashboard', {
  get: [
    ['/test', (_req, res) => {
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
    }],

    ['/dashboard', async (_req, res) => {
      try {
        const [userStats, doctorStats, departmentStats, appointmentStats, recordStats, emergencyStats, staffStats] =
          await Promise.all([
            getUserStats(),
            getDoctorStats(),
            getDepartmentStats(),
            getAppointmentStats(),
            getRecordStats(),
            getEmergencyStats(),
            getStaffStats(),
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
              pendingHRActions: (staffStats.pending_reviews || 0) + (staffStats.pending_leaves || 0),
              recordsCreatedToday: recordStats.createdToday || 0,
            },
            charts: {
              userGrowth: userStats.growth,
              appointmentTrends: appointmentStats.trends,
              departmentUtilization: departmentStats.utilization,
            },
            recentActivity: await getRecentActivity(),
            systemHealth: await getModuleHealth(),
          },
        });
      } catch (error) {
        logger.error('Dashboard data fetch error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard data' });
      }
    }],

    ['/stats/quick', async (_req, res) => {
      try {
        // Reuse pieces from the specific helpers for a tiny snapshot
        const [appts, users, staff, pharm] = await Promise.all([
          (async () => {
            if (!(await tableExists('appointments'))) return { today: 0, week: 0 };
            const today = await safeScalar(
              `SELECT COUNT(*) FROM appointments WHERE appointment_date::date = CURRENT_DATE`
            );
            const week = await safeScalar(
              `SELECT COUNT(*) FROM appointments WHERE appointment_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'`
            );
            return { today, week };
          })(),
          (async () => {
            const have = await tableExists('users');
            if (!have) return { total: 0, active: 0 };
            const total = await safeScalar(`SELECT COUNT(*) FROM users`);
            const active = (await columnExists('users', 'is_active'))
              ? await safeScalar(`SELECT COUNT(*) FROM users WHERE is_active = true`)
              : 0;
            return { total, active };
          })(),
          (async () => {
            const have = await tableExists('staff');
            if (!have) return { total: 0, present: 0 };
            const total = await safeScalar(`SELECT COUNT(*) FROM staff`);
            const present = (await tableExists('staff_attendance'))
              ? await safeScalar(
                  `SELECT COUNT(*) FROM staff_attendance WHERE check_in_time::date = CURRENT_DATE`
                )
              : 0;
            return { total, present };
          })(),
          (async () => {
            const have = await tableExists('pharmacy_orders');
            if (!have) return { today: 0, month: 0 };
            const today = await safeScalar(
              `SELECT COALESCE(SUM(total_amount),0) FROM pharmacy_orders WHERE DATE(placed_at) = CURRENT_DATE`
            );
            const month = await safeScalar(
              `SELECT COALESCE(SUM(total_amount),0) FROM pharmacy_orders WHERE placed_at >= DATE_TRUNC('month', CURRENT_DATE)`
            );
            return { today: Number(today), month: Number(month) };
          })(),
        ]);

        res.json({ success: true, data: { appointments: appts, users, staff, revenue: pharm } });
      } catch (e) {
        logger.error('Quick stats error:', e);
        res.status(500).json({ success: false, message: 'Failed to get quick stats' });
      }
    }],

    ['/activity/recent', async (req, res) => {
      try {
        const { limit = 50, offset = 0 } = req.query;
        const activity = await getRecentActivity(Number(limit), Number(offset));
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
            attendance: '/api/v1/staff/admin/attendance/anomalies',
          },
        });
      } catch (error) {
        logger.error('Staff summary error:', error);
        res.status(500).json({ success: false, message: 'Failed to get staff summary' });
      }
    }],

    ['/appointments/summary', async (_req, res) => {
      try {
        const { rows } = await db.query(
          `
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
          `
        );
        res.json({
          success: true,
          data: rows[0],
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
    }],
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
    }],
  ],
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
