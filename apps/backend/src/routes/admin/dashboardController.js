// src/routes/admin/dashboardController.js
//
// M20 (audit 2026-06-22): the admin dashboard handlers were 36 inline closures
// inside routes/admin/index.js's wrapAutoRBAC config (a 697-line god-router with
// ~70 raw res.json / res.status calls bypassing the standard response envelope).
// They are extracted here as named handlers so index.js is a thin router and the
// success/error paths go through the success()/error() helpers (consistent
// envelope + requestId, leak-scrubbing on the error path) like every other admin
// sub-router (see databaseRoutes.js).
//
// Behaviour-preserving: success payloads are unchanged ({ success, data } plus
// the helper's additive message/requestId); error paths keep their specific 500
// message via { safe: true } (these are static, developer-authored strings).
// Three handlers keep a bespoke response shape verbatim — the dev /test info
// page and the two *summary endpoints that carry a top-level `links` block — so
// no consumer contract changes.

import logger from '../../logging/logger.js';
import { error, success } from '../../utils/responseHelper.js';
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
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
  getSosAnalytics,
  getAllAlerts,
  getEmergencyServices,
  getPerformanceReport,
  updateSystemConfig,
  broadcastEmergencyAlert,
  escalateAlert,
  getUploadSummary,
  listQuarantinedFiles,
  getHipaaAuditReport,
  rescanFile,
  cleanupExpiredFiles,
  bulkUpdateHipaaProtection,
  purgeQuarantinedFiles,
} from './services/index.js';

const todayIso = () => new Date().toISOString().split('T')[0];

/* ----------------------------- dev /test info ----------------------------- */

// Bespoke top-level shape (not the success() envelope) — kept verbatim.
export function testInfo(_req, res) {
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
}

/* ------------------------------- dashboard -------------------------------- */

export async function dashboard(_req, res) {
  try {
    const [
      userStats,
      doctorStats,
      departmentStats,
      appointmentStats,
      recordStats,
      emergencyStats,
      staffStats,
      recentActivityData,
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

    success(res, {
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
      recentActivity: recentActivityData,
      systemHealth: moduleHealth,
    }, 'Dashboard overview');
  } catch (err) {
    logger.error('Dashboard data fetch error:', err);
    error(res, 'Failed to fetch dashboard data', 500, { safe: true });
  }
}

/* ----------------------------- stat endpoints ----------------------------- */

export async function statsQuick(_req, res) {
  try {
    success(res, await getQuickStats(), 'Quick stats');
  } catch (e) {
    logger.error('Quick stats error:', e);
    error(res, 'Failed to get quick stats', 500, { safe: true });
  }
}

export async function statsUsers(_req, res) {
  try {
    success(res, await getUserStats(), 'User stats');
  } catch (e) {
    logger.error('User stats error:', e);
    error(res, 'Failed to get user stats', 500, { safe: true });
  }
}

export async function statsDoctors(_req, res) {
  try {
    success(res, await getDoctorStats(), 'Doctor stats');
  } catch (e) {
    logger.error('Doctor stats error:', e);
    error(res, 'Failed to get doctor stats', 500, { safe: true });
  }
}

export async function statsAppointments(_req, res) {
  try {
    success(res, await getAppointmentStats(), 'Appointment stats');
  } catch (e) {
    logger.error('Appointment stats error:', e);
    error(res, 'Failed to get appointment stats', 500, { safe: true });
  }
}

export async function statsRecords(_req, res) {
  try {
    success(res, await getRecordStats(), 'Record stats');
  } catch (e) {
    logger.error('Record stats error:', e);
    error(res, 'Failed to get record stats', 500, { safe: true });
  }
}

export async function statsEmergency(_req, res) {
  try {
    success(res, await getEmergencyStats(), 'Emergency stats');
  } catch (e) {
    logger.error('Emergency stats error:', e);
    error(res, 'Failed to get emergency stats', 500, { safe: true });
  }
}

export async function statsStaff(_req, res) {
  try {
    success(res, await getStaffStats(), 'Staff stats');
  } catch (e) {
    logger.error('Staff stats error:', e);
    error(res, 'Failed to get staff stats', 500, { safe: true });
  }
}

export async function statsDepartments(_req, res) {
  try {
    success(res, await getDepartmentStats(), 'Department stats');
  } catch (e) {
    logger.error('Department stats error:', e);
    error(res, 'Failed to get department stats', 500, { safe: true });
  }
}

/* --------------------------- activity / alerts ---------------------------- */

export async function recentActivity(req, res) {
  try {
    const { limit = 50, offset = 0 } = req.query;
    success(res, await getRecentActivity(Number(limit), Number(offset)), 'Recent activity');
  } catch (e) {
    logger.error('Recent activity error:', e);
    error(res, 'Failed to get recent activity', 500, { safe: true });
  }
}

export async function systemAlerts(_req, res) {
  try {
    success(res, await getSystemAlerts(), 'System alerts');
  } catch (e) {
    logger.error('Alerts error:', e);
    error(res, 'Failed to get system alerts', 500, { safe: true });
  }
}

/* ------------------------------- health ----------------------------------- */

// No try/catch in the original — errors propagate to the wrapAsync/global
// handler (Sentry). Preserved.
export async function moduleHealth(_req, res) {
  success(res, await getModuleHealth(), 'Module health');
}

export async function systemHealth(_req, res) {
  try {
    success(res, await getSystemHealth(), 'System health');
  } catch (e) {
    logger.error('System health error:', e);
    error(res, 'Failed to get system health', 500, { safe: true });
  }
}

/* ------------------------------- summaries -------------------------------- */

// Bespoke shape: { success, data, links } — kept verbatim (success() would drop
// the top-level links block).
export async function staffSummary(_req, res) {
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
  } catch (err) {
    logger.error('Staff summary error:', err);
    error(res, 'Failed to get staff summary', 500, { safe: true });
  }
}

export async function appointmentsSummary(_req, res) {
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
  } catch (err) {
    logger.error('Appointment summary error:', err);
    error(res, 'Failed to get appointment summary', 500, { safe: true });
  }
}

/* -------------------------- staff attendance ------------------------------ */

export async function attendanceAnalytics(req, res) {
  try {
    const {
      department = null,
      start_date: startDate = null,
      end_date: endDate = null,
      group_by: groupBy = 'day',
    } = req.query;
    success(res, await getAttendanceAnalytics({ department, startDate, endDate, groupBy }), 'Attendance analytics');
  } catch (err) {
    logger.error('Attendance analytics error:', err);
    error(res, 'Failed to get attendance analytics', 500, { safe: true });
  }
}

export async function attendanceAnomalies(_req, res) {
  try {
    success(res, await getAttendanceAnomalies(), 'Attendance anomalies');
  } catch (err) {
    logger.error('Attendance anomalies error:', err);
    error(res, 'Failed to get attendance anomalies', 500, { safe: true });
  }
}

export async function lateArrivals(req, res) {
  try {
    const { date = todayIso(), department = null } = req.query;
    success(res, await getLateArrivals(date, department), 'Late arrivals');
  } catch (err) {
    logger.error('Late arrivals error:', err);
    error(res, 'Failed to get late arrivals', 500, { safe: true });
  }
}

export async function earlyDepartures(req, res) {
  try {
    const { date = todayIso(), department = null } = req.query;
    success(res, await getEarlyDepartures(date, department), 'Early departures');
  } catch (err) {
    logger.error('Early departures error:', err);
    error(res, 'Failed to get early departures', 500, { safe: true });
  }
}

export async function absentReport(req, res) {
  try {
    const { date = todayIso(), department = null } = req.query;
    success(res, await getAbsentReport(date, department), 'Absent report');
  } catch (err) {
    logger.error('Absent report error:', err);
    error(res, 'Failed to get absent report', 500, { safe: true });
  }
}

/* ------------------------------ SOS (reads) ------------------------------- */

export async function sosAnalytics(_req, res) {
  try {
    success(res, await getSosAnalytics(), 'SOS analytics');
  } catch (err) {
    logger.error('SOS analytics error:', err);
    error(res, 'Failed to get SOS analytics', 500, { safe: true });
  }
}

export async function sosAlerts(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    success(res, await getAllAlerts(limit, offset), 'SOS alerts');
  } catch (err) {
    logger.error('SOS alerts list error:', err);
    error(res, 'Failed to get SOS alerts', 500, { safe: true });
  }
}

export async function sosEmergencyServices(_req, res) {
  try {
    success(res, await getEmergencyServices(), 'Emergency services');
  } catch (err) {
    logger.error('SOS services error:', err);
    error(res, 'Failed to get emergency services', 500, { safe: true });
  }
}

export async function sosPerformanceReport(_req, res) {
  try {
    success(res, await getPerformanceReport(), 'SOS performance report');
  } catch (err) {
    logger.error('SOS performance report error:', err);
    error(res, 'Failed to get performance report', 500, { safe: true });
  }
}

/* ----------------------------- uploads (reads) ---------------------------- */

export async function uploadSummary(_req, res) {
  try {
    success(res, await getUploadSummary(), 'Upload summary');
  } catch (err) {
    logger.error('Upload summary error:', err);
    error(res, 'Failed to get upload summary', 500, { safe: true });
  }
}

export async function uploadQuarantine(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    success(res, await listQuarantinedFiles(limit, offset), 'Quarantined files');
  } catch (err) {
    logger.error('List quarantined files error:', err);
    error(res, 'Failed to list quarantined files', 500, { safe: true });
  }
}

export async function uploadHipaaAudit(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const { start_date: startDate = null, end_date: endDate = null } = req.query;
    success(res, await getHipaaAuditReport({ limit, offset, startDate, endDate }), 'HIPAA audit report');
  } catch (err) {
    logger.error('HIPAA audit error:', err);
    error(res, 'Failed to get HIPAA audit report', 500, { safe: true });
  }
}

/* ------------------------------ POST actions ------------------------------ */

// No try/catch in the original — errors propagate to wrapAsync/global handler.
export async function refreshCache(_req, res) {
  await refreshDashboardCache();
  success(res, null, 'Dashboard cache refreshed');
}

export async function exportReport(req, res) {
  const { format = 'pdf', dateRange } = req.body || {};
  success(res, await generateDashboardReport(format, dateRange), 'Dashboard report');
}

export async function sosUpdateConfig(req, res) {
  try {
    success(res, await updateSystemConfig(req.body || {}), 'SOS config updated');
  } catch (err) {
    logger.error('SOS update-config error:', err);
    error(res, 'Failed to update SOS config', 500, { safe: true });
  }
}

export async function sosBroadcast(req, res) {
  try {
    const { message, severity } = req.body || {};
    success(res, await broadcastEmergencyAlert({ message, severity }), 'SOS alert broadcast');
  } catch (err) {
    logger.error('SOS broadcast error:', err);
    error(res, 'Failed to broadcast SOS alert', 500, { safe: true });
  }
}

export async function sosEscalate(req, res) {
  try {
    const { alertId } = req.params;
    const { reason = null } = req.body || {};
    success(res, await escalateAlert(alertId, reason), 'SOS alert escalated');
  } catch (err) {
    logger.error('SOS escalate error:', err);
    error(res, 'Failed to escalate SOS alert', 500, { safe: true });
  }
}

export async function uploadRescan(req, res) {
  try {
    const { fileId } = req.params;
    success(res, await rescanFile(fileId), 'File rescanned');
  } catch (err) {
    logger.error('Upload rescan error:', err);
    error(res, 'Failed to rescan file', 500, { safe: true });
  }
}

export async function uploadCleanup(req, res) {
  try {
    const { dryRun = true } = req.body || {};
    success(res, await cleanupExpiredFiles(Boolean(dryRun)), 'Expired files cleaned up');
  } catch (err) {
    logger.error('Upload cleanup error:', err);
    error(res, 'Failed to cleanup expired files', 500, { safe: true });
  }
}

export async function uploadHipaaBulkProtect(req, res) {
  try {
    success(res, await bulkUpdateHipaaProtection(req.body || {}), 'HIPAA protection updated');
  } catch (err) {
    logger.error('Upload bulk HIPAA protect error:', err);
    error(res, 'Failed to update HIPAA protection', 500, { safe: true });
  }
}

export async function uploadQuarantinePurge(req, res) {
  try {
    const { dryRun = true } = req.body || {};
    success(res, await purgeQuarantinedFiles(Boolean(dryRun)), 'Quarantined files purged');
  } catch (err) {
    logger.error('Upload purge quarantine error:', err);
    error(res, 'Failed to purge quarantined files', 500, { safe: true });
  }
}
