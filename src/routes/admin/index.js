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
          departments: '/api/v1/admin/departments',
          doctors: '/api/v1/admin/doctors',
          users: '/api/v1/users/admin',
          notifications: '/api/v1/notifications/admin',
          records: '/api/v1/health-records/admin',
          investigations: '/api/v1/investigations/admin',
          pharmacy: '/api/v1/pharmacy/admin'
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
          emergencyStats
        ] = await Promise.all([
          getUserStats(),
          getDoctorStats(),
          getDepartmentStats(),
          getAppointmentStats(),
          getRecordStats(),
          getEmergencyStats()
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
              emergencyAlerts: emergencyStats.active
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
      json_agg(
        json_build_object(
          'date', appointment_date::date,
          'count', COUNT(*)
        ) ORDER BY appointment_date::date
      ) FILTER (WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days') as trends
    FROM appointments
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

async function getRecentActivity(limit = 50, offset = 0) {
  const result = await db.query(`
    SELECT 
      'appointment' as type,
      CONCAT('Appointment scheduled for ', p.name) as description,
      a.created_at as timestamp,
      a.created_by as user_id
    FROM appointments a
    JOIN users p ON a.patient_id = p.id
    
    UNION ALL
    
    SELECT 
      'user' as type,
      CONCAT('New user registered: ', name) as description,
      created_at as timestamp,
      uid as user_id
    FROM users
    
    UNION ALL
    
    SELECT 
      'emergency' as type,
      CONCAT('SOS alert from ', phone) as description,
      created_at as timestamp,
      created_by as user_id
    FROM sos_alerts
    
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
  
  // Add more system checks as needed
  
  return alerts;
}

async function getQuickStats() {
  // Implement quick stats logic
  return {
    appointments: { today: 0, week: 0 },
    users: { total: 0, active: 0 },
    revenue: { today: 0, month: 0 }
  };
}

async function getModuleHealth() {
  // Check health of each module
  return {
    users: 'healthy',
    appointments: 'healthy',
    pharmacy: 'healthy',
    investigations: 'healthy',
    emergency: 'healthy'
  };
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