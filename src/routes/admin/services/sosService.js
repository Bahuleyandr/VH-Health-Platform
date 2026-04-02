// src/routes/admin/services/sosService.js
import {
  tableExists,
  columnExists,
  safeQuery,
  safeScalar,
} from './common.js';
import logger from '../../../logging/logger.js';

/**
 * Returns aggregated SOS alert metrics:
 * - totalAlerts, activeAlerts, resolvedAlerts, testAlerts
 * - severityCounts {high, medium, low}
 * - last24Hours: alerts created in last 24h
 * - last7Days: array of { date, count } for past 7 days
 */
export async function getSosAnalytics() {
  // If the table doesn't exist, return zeros
  if (!(await tableExists('sos_alerts'))) {
    return {
      totalAlerts: 0,
      activeAlerts: 0,
      resolvedAlerts: 0,
      testAlerts: 0,
      severityCounts: { high: 0, medium: 0, low: 0 },
      last24Hours: 0,
      last7Days: [],
    };
  }

  // Core aggregated counts
  const core = await safeQuery(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active,
      COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
      COUNT(*) FILTER (WHERE COALESCE(is_test_alert, false) = true)::int AS test,
      COUNT(*) FILTER (WHERE UPPER(severity) = 'HIGH')::int AS high,
      COUNT(*) FILTER (WHERE UPPER(severity) = 'MEDIUM')::int AS medium,
      COUNT(*) FILTER (WHERE UPPER(severity) = 'LOW')::int AS low,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last24h
    FROM sos_alerts
    `,
    [],
    'sos.analytics_core'
  );

  const row = core[0] || {};
  // Trend over last 7 days
  const trend = await safeQuery(
    `
    SELECT date_trunc('day', created_at) AS date,
           COUNT(*)::int AS count
    FROM sos_alerts
    WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY 1
    ORDER BY 1
    `,
    [],
    'sos.analytics_trend'
  );

  return {
    totalAlerts: row.total ?? 0,
    activeAlerts: row.active ?? 0,
    resolvedAlerts: row.resolved ?? 0,
    testAlerts: row.test ?? 0,
    severityCounts: {
      high: row.high ?? 0,
      medium: row.medium ?? 0,
      low: row.low ?? 0,
    },
    last24Hours: row.last24h ?? 0,
    last7Days: trend,
  };
}

/**
 * Fetch a paginated list of SOS alerts, newest first.
 * @param {number} limit - Max number of alerts to return.
 * @param {number} offset - Number of alerts to skip.
 * @returns {Promise<Array>} Array of alert records.
 */
export async function getAllAlerts(limit = 50, offset = 0) {
  if (!(await tableExists('sos_alerts'))) {
    return [];
  }
  const list = await safeQuery(
    `SELECT id, user_uid, phone, latitude, longitude, status, notes, description, address, created_at, resolved_at FROM sos_alerts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
    'sos.all_alerts'
  );
  return list;
}

/**
 * Retrieve configured emergency services (e.g. hospitals, police, fire).
 * Tries multiple possible table names and returns the first match.
 * @returns {Promise<Array>} Array of service records or empty.
 */
export async function getEmergencyServices() {
  const tables = ['emergency_services', 'sos_services'];
  for (const table of tables) {
    if (await tableExists(table)) {
      const services = await safeQuery(
        `SELECT * FROM ${table} ORDER BY name`,
        [],
        `sos.services.${table}`
      );
      return services;
    }
  }
  return [];
}

/**
 * Generate a performance report for the SOS system.
 * Includes aggregated metrics and an average response time if a suitable timestamp column exists.
 * @returns {Promise<Object>} Report data.
 */
export async function getPerformanceReport() {
  // Start with core analytics
  const metrics = await getSosAnalytics();
  if (!(await tableExists('sos_alerts'))) {
    return { metrics, avgResponseTimeMinutes: null };
  }

  // Try to compute average response time using common resolution columns
  let avgResponse = null;
  const possibleCols = ['resolved_at', 'updated_at', 'responded_at'];
  for (const col of possibleCols) {
    if (await columnExists('sos_alerts', col)) {
      avgResponse = await safeScalar(
        `
        SELECT ROUND(
          AVG(EXTRACT(EPOCH FROM (COALESCE(${col}, NOW()) - created_at)) / 60)
        )::int AS minutes
        FROM sos_alerts
        WHERE COALESCE(${col}, NOW()) > created_at
        `,
        [],
        null
      );
      break;
    }
  }
  return {
    metrics,
    avgResponseTimeMinutes: avgResponse,
  };
}

/**
 * Update SOS system configuration settings.
 * Currently acts as a stub that logs the update request.
 * @param {Object} configUpdates - Arbitrary config object.
 * @returns {Promise<Object>} Confirmation.
 */
export async function updateSystemConfig(configUpdates) {
  logger.info('SOS system configuration updated', configUpdates);
  return { success: true, updated: configUpdates };
}

/**
 * Broadcast a general emergency alert to all registered responders.
 * This stub logs the broadcast details.
 * @param {Object} params - Contains the broadcast message and optional severity.
 * @returns {Promise<Object>} Confirmation.
 */
export async function broadcastEmergencyAlert({ message, severity = 'HIGH' }) {
  logger.info('SOS broadcast alert', { message, severity });
  return { success: true, message: 'Broadcast sent' };
}

/**
 * Escalate an existing alert by ID.
 * This stub logs the escalation request.
 * @param {number|string} alertId - The ID of the alert to be escalated.
 * @param {string|null} escalationReason - Optional reason for escalation.
 * @returns {Promise<Object>} Confirmation.
 */
export async function escalateAlert(alertId, escalationReason = null) {
  logger.info(`SOS alert ${alertId} escalation requested`, { reason: escalationReason });
  return { success: true, alertId, reason: escalationReason };
}

export default {
  getSosAnalytics,
  getAllAlerts,
  getEmergencyServices,
  getPerformanceReport,
  updateSystemConfig,
  broadcastEmergencyAlert,
  escalateAlert,
};
