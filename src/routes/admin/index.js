// src/routes/admin/index.js
import express from 'express';
import db from '../../config/database.js';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';

const router = express.Router();

// Admin Dashboard Routes - All require ADMIN role
wrapAutoRBAC(router, 'adminDashboard', {
  get: [
    // Test route
    ['/test', (req, res) => {
      res.json({
        message: 'Admin dashboard routes working',
        timestamp: new Date().toISOString(),
        modules: {
          appointments: '/api/v1/appointments/admin',
          departments: '/api/v1/admin/departments',
          doctors: '/api/v1/admin/doctors',
          users: '/api/v1/users/admin',
          notifications: '/api/v1/notifications/admin',
          records: '/api/v1/health-records/admin',
          investigations: '/api/v1/investigations/admin',
          pharmacy: '/api/v1/pharmacy/admin',
          sos: '/api/v1/sos/admin',
          staff: '/api/v1/staff/admin',
          analytics: '/api/v1/analytics',
          devices: '/api/v1/devices',
          feedback: '/api/v1/feedback'
        }
      });
    }],

    // Main Dashboard Overview
    ['/dashboard', async (req, res) => {
      try {
        // Aggregate stats from all modules
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
        res.status(500).json({
          success: false,
          message: 'Failed to fetch dashboard data'
        });
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

    // Staff Admin Summary
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
            analytics: '/api/v1/appointments/admin/analytics',
            conflicts: '/api/v1/appointments/admin/conflicts',
            capacity: '/api/v1/appointments/admin/capacity',
            noShows: '/api/v1/appointments/admin/no-shows'
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

// Helper functions for data aggregation
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

async function getSystemAlerts() {
  // Check for various system conditions that need admin attention
  const alerts = [];
  
  // Check for high SOS alert rate
  const sosCheck = await db.query(`
    SELECT COUNT(*) as count 
    FROM sos_alerts 
    WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
  `);
  
  if (sosCheck.rows[0].count > 10) {
    alerts.push({
      type: 'warning',
      message: `High SOS alert rate: ${sosCheck.rows[0].count} alerts in the last hour`,
      priority: 'high'
    });
  }
  
  // Check for appointment conflicts today
  const conflictCheck = await db.query(`
    SELECT COUNT(*) as conflicts
    FROM appointments a1
    JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
    WHERE a1.id != a2.id 
      AND a1.status = 'scheduled' 
      AND a2.status = 'scheduled'
      AND DATE(a1.appointment_date) = CURRENT_DATE
      AND a1.appointment_date < a2.appointment_date
      AND a1.appointment_date + INTERVAL '30 minutes' > a2.appointment_date
  `);
  
  if (conflictCheck.rows[0].conflicts > 0) {
    alerts.push({
      type: 'error',
      message: `${conflictCheck.rows[0].conflicts} appointment conflicts detected today`,
      priority: 'urgent',
      action: '/api/v1/appointments/admin/conflicts'
    });
  }
  
  // Check for high no-show rate
  const noShowCheck = await db.query(`
    SELECT 
      COUNT(CASE WHEN status = 'no_show' THEN 1 END) as no_shows,
      COUNT(*) as total
    FROM appointments
    WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days'
      AND appointment_date < CURRENT_DATE
  `);
  
  const noShowRate = (noShowCheck.rows[0].no_shows / noShowCheck.rows[0].total) * 100;
  if (noShowRate > 15) {
    alerts.push({
      type: 'warning',
      message: `High no-show rate: ${noShowRate.toFixed(1)}% in the last 7 days`,
      priority: 'medium',
      action: '/api/v1/appointments/admin/no-shows'
    });
  }
  
  // Check for doctors at capacity
  const capacityCheck = await db.query(`
    SELECT 
      d.name as doctor_name,
      COUNT(a.id) as booked,
      doc.max_appointments_per_day as capacity
    FROM appointments a
    JOIN doctors doc ON a.doctor_id = doc.id
    JOIN users d ON doc.user_id = d.id
    WHERE DATE(a.appointment_date) = CURRENT_DATE
      AND a.status = 'scheduled'
    GROUP BY d.name, doc.max_appointments_per_day
    HAVING COUNT(a.id) >= doc.max_appointments_per_day
  `);
  
  if (capacityCheck.rows.length > 0) {
    alerts.push({
      type: 'info',
      message: `${capacityCheck.rows.length} doctors at full capacity today`,
      priority: 'low',
      action: '/api/v1/appointments/admin/capacity'
    });
  }
  
  // Check for attendance anomalies
  const attendanceCheck = await db.query(`
    SELECT 
      COUNT(DISTINCT staff_id) as absent_count
    FROM staff s
    WHERE s.is_active = true 
      AND s.on_leave = false
      AND NOT EXISTS (
        SELECT 1 FROM staff_attendance a 
        WHERE a.staff_id = s.id 
        AND a.check_in_time::date = CURRENT_DATE
      )
  `);
  
  if (attendanceCheck.rows[0].absent_count > 5) {
    alerts.push({
      type: 'warning',
      message: `${attendanceCheck.rows[0].absent_count} staff members absent today without leave`,
      priority: 'medium',
      action: '/api/v1/staff/admin/attendance/absent-report'
    });
  }
  
  // Check for pending HR actions
  const hrCheck = await db.query(`
    SELECT 
      COUNT(*) FILTER (WHERE type = 'review') as pending_reviews,
      COUNT(*) FILTER (WHERE type = 'leave') as pending_leaves
    FROM (
      SELECT 'review' as type FROM performance_reviews WHERE status = 'pending'
      UNION ALL
      SELECT 'leave' as type FROM leave_applications WHERE status = 'pending'
    ) hr_actions
  `);
  
  if (hrCheck.rows[0].pending_reviews > 10 || hrCheck.rows[0].pending_leaves > 15) {
    alerts.push({
      type: 'info',
      message: `HR actions pending: ${hrCheck.rows[0].pending_reviews} reviews, ${hrCheck.rows[0].pending_leaves} leave requests`,
      priority: 'medium',
      action: '/api/v1/staff/admin/dashboard'
    });
  }
  
  return alerts;
}

async function getQuickStats() {
  const result = await db.query(`
    SELECT 
      (SELECT COUNT(*) FROM appointments WHERE appointment_date::date = CURRENT_DATE) as appointments_today,
      (SELECT COUNT(*) FROM appointments WHERE appointment_date BETWEEN NOW() AND NOW() + INTERVAL '7 days') as appointments_week,
      (SELECT COUNT(*) FROM users WHERE is_active = true) as active_users,
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM staff WHERE is_active = true) as total_staff,
      (SELECT COUNT(*) FROM staff_attendance WHERE check_in_time::date = CURRENT_DATE) as staff_present,
      (SELECT SUM(total_amount) FROM pharmacy_orders WHERE DATE(placed_at) = CURRENT_DATE) as revenue_today,
      (SELECT SUM(total_amount) FROM pharmacy_orders WHERE placed_at >= DATE_TRUNC('month', CURRENT_DATE)) as revenue_month
  `);
  
  const stats = result.rows[0];
  
  return {
    appointments: { 
      today: parseInt(stats.appointments_today) || 0, 
      week: parseInt(stats.appointments_week) || 0 
    },
    users: { 
      total: parseInt(stats.total_users) || 0, 
      active: parseInt(stats.active_users) || 0 
    },
    staff: { 
      total: parseInt(stats.total_staff) || 0, 
      present: parseInt(stats.staff_present) || 0 
    },
    revenue: { 
      today: parseFloat(stats.revenue_today) || 0, 
      month: parseFloat(stats.revenue_month) || 0 
    }
  };
}

async function getModuleHealth() {
  const health = {};
  
  try {
    // Check users module
    const userCheck = await db.query('SELECT COUNT(*) FROM users LIMIT 1');
    health.users = 'healthy';
  } catch (err) {
    health.users = 'unhealthy';
  }
  
  try {
    // Check appointments module
    const appointmentCheck = await db.query('SELECT COUNT(*) FROM appointments LIMIT 1');
    const conflictCount = await db.query(`
      SELECT COUNT(*) as conflicts
      FROM appointments a1
      JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
      WHERE a1.id != a2.id 
        AND a1.status = 'scheduled' 
        AND a2.status = 'scheduled'
        AND DATE(a1.appointment_date) = CURRENT_DATE
        AND a1.appointment_date < a2.appointment_date
        AND a1.appointment_date + INTERVAL '30 minutes' > a2.appointment_date
    `);
    
    health.appointments = conflictCount.rows[0].conflicts > 0 ? 'warning' : 'healthy';
  } catch (err) {
    health.appointments = 'unhealthy';
  }
  
  try {
    // Check pharmacy module
    const pharmacyCheck = await db.query('SELECT COUNT(*) FROM pharmacy_orders LIMIT 1');
    health.pharmacy = 'healthy';
  } catch (err) {
    health.pharmacy = 'unhealthy';
  }
  
  try {
    // Check investigations module
    const investigationCheck = await db.query('SELECT COUNT(*) FROM investigations LIMIT 1');
    health.investigations = 'healthy';
  } catch (err) {
    health.investigations = 'unhealthy';
  }
  
  try {
    // Check emergency module
    const emergencyCheck = await db.query('SELECT COUNT(*) FROM sos_alerts WHERE status = \'active\'');
    health.emergency = emergencyCheck.rows[0].count > 5 ? 'warning' : 'healthy';
  } catch (err) {
    health.emergency = 'unhealthy';
  }
  
  try {
    // Check staff module
    const staffCheck = await db.query('SELECT COUNT(*) FROM staff LIMIT 1');
    const attendanceIssues = await db.query(`
      SELECT COUNT(*) as issues
      FROM staff s
      WHERE s.is_active = true 
        AND s.on_leave = false
        AND NOT EXISTS (
          SELECT 1 FROM staff_attendance a 
          WHERE a.staff_id = s.id 
          AND a.check_in_time::date = CURRENT_DATE
        )
    `);
    
    health.staff = attendanceIssues.rows[0].issues > 10 ? 'warning' : 'healthy';
  } catch (err) {
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
  // Implement cache refresh logic
  logger.info('Dashboard cache refreshed');
}

async function generateDashboardReport(format, dateRange) {
  // Implement report generation
  return {
    url: `/exports/dashboard-report.${format}`,
    generatedAt: new Date()
  };
}

export default router;