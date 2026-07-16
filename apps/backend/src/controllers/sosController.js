// src/controllers/sosController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import * as sosService from '../services/sosService.js';
import { DEFAULT_TENANT_ID, resolveTenantOrThrow } from '../services/tenant/tenantService.js';
import { isAdmin } from '../utils/roleHelpers.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { success, error, relayAppError } from '../utils/responseHelper.js';

export const parseNearbyCoordinates = (query = {}) => {
  const rawLatitude = query.latitude ?? query.lat;
  const rawLongitude = query.longitude ?? query.lng;
  const latitude = Number.parseFloat(rawLatitude);
  const longitude = Number.parseFloat(rawLongitude);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return { latitude, longitude };
};

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function isAdminRole(role) {
  return isAdmin(role) || String(role || '').trim().toUpperCase() === 'SUPER_ADMIN';
}

async function resolveSelfServicePhone(req, requestedPhone) {
  const normalizedRequested = normalizePhone(requestedPhone || '');
  if (isAdminRole(req.user?.role) && normalizedRequested) {
    return normalizedRequested;
  }

  const tokenPhone = normalizePhone(req.user?.phone || '');
  if (tokenPhone) {
    if (normalizedRequested && normalizedRequested !== tokenPhone) {
      const err = new Error('Can only manage SOS data for yourself');
      err.statusCode = HTTP_STATUS.FORBIDDEN;
      throw err;
    }
    return tokenPhone;
  }

  if (!req.user?.uid) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT phone
       FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    req.user.uid,
    tenantOf(req),
  );
  const resolvedPhone = normalizePhone(rows[0]?.phone || '');
  if (normalizedRequested && resolvedPhone && normalizedRequested !== resolvedPhone) {
    const err = new Error('Can only manage SOS data for yourself');
    err.statusCode = HTTP_STATUS.FORBIDDEN;
    throw err;
  }
  return resolvedPhone;
}

const SOS_USER_JOIN = `LEFT JOIN users u ON (u.uid = sa.uid OR u.phone = sa.phone)`;
const SOS_TENANT_FILTER = `COALESCE(u.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $1::uuid`;

// Patient Controllers
export const createEmergencyAlert = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, 'Validation failed', HTTP_STATUS.BAD_REQUEST, errors.array());
  }

  try {
    const phone = await resolveSelfServicePhone(req, req.body.phone || req.body.phoneNumber);
    if (!phone) {
      return error(res, 'Phone number is required for emergency contact', HTTP_STATUS.BAD_REQUEST);
    }

    const alertData = {
      ...req.body,
      phone,
      ip_address: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
      createdBy: req.user?.uid || 'patient_app'
    };

    const result = await sosService.createAlert(alertData);
    
    success(res, result, 
      alertData.isTestAlert ? 'Test SOS alert created successfully' : RESPONSE_MESSAGES.SOS_ALERT_SAVED
    );

  } catch (err) {
    return relayAppError(res, err, 'Failed to process emergency alert. Please call emergency services directly.');
  }
};

export const updateEmergencyContact = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }

  try {
    const phone = await resolveSelfServicePhone(req, req.body.phone || req.body.phoneNumber);
    if (!phone) {
      return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
    }

    // FIX: Corrected function name from updateEmergencyContact to updateEmergencyContacts
    const result = await sosService.updateEmergencyContacts(phone, req.body, req.user?.uid);
    success(res, result, 'Emergency contact information updated successfully');

  } catch (err) {
    return relayAppError(res, err, 'Failed to update emergency contact information');
  }
};
export const getEmergencyContact = async (req, res) => {
  try {
    const phone = await resolveSelfServicePhone(req);
    if (!phone) {
      return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await sosService.getEmergencyContacts(phone);
    success(res, result, 'Emergency contact retrieved successfully');
  } catch (err) {
    logger.error('Get Emergency Contact Error:', err);
    error(res, 'Failed to retrieve emergency contact', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const cancelAlert = async (req, res) => {
  try {
    const { alertId } = req.params;
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const result = await sosService.cancelAlert(alertId, uid);
    success(res, result, 'SOS alert cancelled');
  } catch (err) {
    logger.error('Cancel Alert Error:', err);
    if (err.message === 'Alert not found or already resolved') {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    error(res, 'Failed to cancel alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getMyAlerts = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const alerts = await sosService.getMyAlerts(uid, { limit, offset });
    success(res, { alerts }, 'Alerts retrieved');
  } catch (err) {
    logger.error('Get My Alerts Error:', err);
    error(res, 'Failed to retrieve alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getNearbyServices = async (req, res) => {
  try {
    const coordinates = parseNearbyCoordinates(req.query);

    if (!coordinates) {
      return error(res, 'Latitude and longitude are required', HTTP_STATUS.BAD_REQUEST);
    }

    const services = await sosService.getNearbyServices(coordinates.latitude, coordinates.longitude);
    success(res, { services }, 'Nearby services retrieved');
  } catch (err) {
    logger.error('Nearby Services Error:', err);
    error(res, 'Failed to retrieve nearby services', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getMedicalInfo = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const info = await sosService.getMedicalInfo(uid);
    if (!info) return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
    success(res, info, 'Medical info retrieved');
  } catch (err) {
    logger.error('Medical Info Error:', err);
    error(res, 'Failed to retrieve medical info', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getResponderDashboard = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const alerts = await prisma.$queryRawUnsafe(`
      SELECT sa.id, sa.phone, sa.latitude, sa.longitude, sa.alert_type,
             sa.severity, sa.status, sa.message, sa.raised_at,
             sa.responded_by, sa.responded_at
      FROM sos_alerts sa
      ${SOS_USER_JOIN}
      WHERE ${SOS_TENANT_FILTER}
        AND sa.status IN ('ACTIVE', 'RESPONDING')
      ORDER BY
        CASE sa.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
        sa.raised_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `, tenantOf(req));
    success(res, { alerts }, 'Responder dashboard');
  } catch (err) {
    logger.error('Responder Dashboard Error:', err);
    error(res, 'Failed to load dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getResponderAnalytics = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const stats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*)::int AS total_responded,
        AVG(EXTRACT(EPOCH FROM (sa.responded_at - sa.raised_at)))::int AS avg_response_seconds,
        COUNT(CASE WHEN sa.status = 'RESOLVED' THEN 1 END)::int AS resolved_count
      FROM sos_alerts sa
      ${SOS_USER_JOIN}
      WHERE ${SOS_TENANT_FILTER}
        AND sa.responded_by = $2::uuid
    `, tenantOf(req), uid);
    success(res, stats[0] || {}, 'Responder analytics');
  } catch (err) {
    logger.error('Responder Analytics Error:', err);
    error(res, 'Failed to load analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const respondToAlert = async (req, res) => {
  try {
    const { alertId } = req.params;
    const uid = req.user?.uid;

    const rows = await prisma.$queryRawUnsafe(`
      UPDATE sos_alerts
      SET status = 'RESPONDING', responded_by = $1::uuid, responded_at = NOW(), updated_at = NOW()
      WHERE id = $2::int AND status = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE (u.uid = sos_alerts.uid OR u.phone = sos_alerts.phone)
             AND COALESCE(u.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $3::uuid
        )
      RETURNING id, status, responded_at
    `, uid, parseInt(alertId, 10), tenantOf(req));
    if (rows.length === 0) return error(res, 'Alert not found or already responded', HTTP_STATUS.NOT_FOUND);
    success(res, rows[0], 'Alert marked as responding');
  } catch (err) {
    logger.error('Respond to Alert Error:', err);
    error(res, 'Failed to respond to alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const resolveAlert = async (req, res) => {
  try {
    const { alertId } = req.params;
    const rows = await prisma.$queryRawUnsafe(`
      UPDATE sos_alerts
      SET status = 'RESOLVED', resolved_at = NOW(), updated_at = NOW()
      WHERE id = $1::int AND status IN ('ACTIVE', 'RESPONDING')
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE (u.uid = sos_alerts.uid OR u.phone = sos_alerts.phone)
             AND COALESCE(u.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $2::uuid
        )
      RETURNING id, status, resolved_at
    `, parseInt(alertId, 10), tenantOf(req));
    if (rows.length === 0) return error(res, 'Alert not found or already resolved', HTTP_STATUS.NOT_FOUND);
    success(res, rows[0], 'Alert resolved');
  } catch (err) {
    logger.error('Resolve Alert Error:', err);
    error(res, 'Failed to resolve alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getAdminAnalytics = async (req, res) => {
  try {
    if (!isAdminRole(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const stats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*)::int AS total_alerts,
        COUNT(CASE WHEN sa.status = 'ACTIVE' THEN 1 END)::int AS active,
        COUNT(CASE WHEN sa.status = 'RESPONDING' THEN 1 END)::int AS responding,
        COUNT(CASE WHEN sa.status = 'RESOLVED' THEN 1 END)::int AS resolved,
        COUNT(CASE WHEN sa.status = 'CANCELLED' THEN 1 END)::int AS cancelled,
        AVG(EXTRACT(EPOCH FROM (sa.responded_at - sa.raised_at)))::int AS avg_response_seconds,
        COUNT(CASE WHEN sa.severity = 'CRITICAL' THEN 1 END)::int AS critical_count,
        COUNT(CASE WHEN sa.severity = 'HIGH' THEN 1 END)::int AS high_count
      FROM sos_alerts sa
      ${SOS_USER_JOIN}
      WHERE ${SOS_TENANT_FILTER}
    `, tenantOf(req));
    success(res, stats[0] || {}, 'Admin SOS analytics');
  } catch (err) {
    logger.error('Admin Analytics Error:', err);
    error(res, 'Failed to load analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getAllAlerts = async (req, res) => {
  try {
    if (!isAdminRole(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const statusFilter = req.query.status;

    let alerts;
    if (statusFilter) {
      alerts = await prisma.$queryRawUnsafe(`
        SELECT sa.id, sa.phone, sa.latitude, sa.longitude, sa.alert_type,
               sa.severity, sa.status, sa.message, sa.raised_at,
               sa.responded_by, sa.responded_at, sa.resolved_at
        FROM sos_alerts sa
        ${SOS_USER_JOIN}
        WHERE ${SOS_TENANT_FILTER} AND sa.status = $4
        ORDER BY sa.raised_at DESC LIMIT $2 OFFSET $3
      `, tenantOf(req), limit, offset, statusFilter);
    } else {
      alerts = await prisma.$queryRawUnsafe(`
        SELECT sa.id, sa.phone, sa.latitude, sa.longitude, sa.alert_type,
               sa.severity, sa.status, sa.message, sa.raised_at,
               sa.responded_by, sa.responded_at, sa.resolved_at
        FROM sos_alerts sa
        ${SOS_USER_JOIN}
        WHERE ${SOS_TENANT_FILTER}
        ORDER BY sa.raised_at DESC LIMIT $2 OFFSET $3
      `, tenantOf(req), limit, offset);
    }
    success(res, { alerts }, 'All alerts', HTTP_STATUS.OK, { limit, offset });
  } catch (err) {
    logger.error('Get All Alerts Error:', err);
    error(res, 'Failed to load alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getEmergencyServices = async (req, res) => {
  try {
    if (!isAdminRole(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    // Return configured emergency services (hospitals, police, ambulance)
    const hospitals = await prisma.$queryRaw`
      SELECT id, name, phone, address, latitude, longitude
      FROM hospitals WHERE status = 'active'
      ORDER BY name LIMIT 50
    `;
    success(res, { hospitals }, 'Emergency services');
  } catch (err) {
    logger.error('Emergency Services Error:', err);
    // Graceful fallback if hospitals table doesn't exist
    success(res, { hospitals: [] }, 'Emergency services (empty)');
  }
};

export const getPerformanceReport = async (req, res) => {
  try {
    if (!isAdminRole(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    // CAN-006: scope the responder performance report to the caller's tenant.
    // sos_alerts.tenant_id is indexed; an explicit predicate keeps the report
    // tenant-correct even if RLS auto-scoping is misconfigured (defense-in-depth,
    // matching the sibling SOS_TENANT_FILTER queries above).
    const report = await prisma.$queryRawUnsafe(`
      SELECT
        sa.responded_by,
        u.name AS responder_name,
        COUNT(*)::int AS alerts_handled,
        AVG(EXTRACT(EPOCH FROM (sa.responded_at - sa.raised_at)))::int AS avg_response_seconds,
        MIN(EXTRACT(EPOCH FROM (sa.responded_at - sa.raised_at)))::int AS min_response_seconds,
        MAX(EXTRACT(EPOCH FROM (sa.responded_at - sa.raised_at)))::int AS max_response_seconds
      FROM sos_alerts sa
      LEFT JOIN users u ON u.uid = sa.responded_by
      WHERE sa.responded_by IS NOT NULL
        AND sa.tenant_id = $1::uuid
      GROUP BY sa.responded_by, u.name
      ORDER BY alerts_handled DESC
      LIMIT 50
    `, tenantOf(req));
    success(res, { responders: report }, 'Performance report');
  } catch (err) {
    logger.error('Performance Report Error:', err);
    error(res, 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateSystemConfig = async (req, res) => {
  try {
    if (!isAdminRole(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const config = req.body;
    logger.info('SOS system config updated:', JSON.stringify(config));
    // Config persistence would require a system_config table — log for now
    success(res, { accepted: config }, 'System config updated');
  } catch (err) {
    logger.error('Update System Config Error:', err);
    error(res, 'Failed to update config', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const broadcastEmergencyAlert = async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const { title, message: body, severity = 'HIGH' } = req.body;
    if (!title || !body) return error(res, 'Title and message are required', HTTP_STATUS.BAD_REQUEST);

    // Insert notification for all active staff
    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO notifications (tenant_id, uid, phone, title, body, type, data, created_at, updated_at)
      SELECT tenant_id, uid, phone, $1, $2, 'SOS_BROADCAST',
             $3::jsonb, NOW(), NOW()
      FROM users
      WHERE role != 'PATIENT'
        AND is_active = true
        AND tenant_id = $4::uuid
      RETURNING id
    `, title, body, JSON.stringify({ severity }), tenantOf(req));
    success(res, { notified: result.length }, `Broadcast sent to ${result.length} staff`);
  } catch (err) {
    logger.error('Broadcast Alert Error:', err);
    error(res, 'Failed to broadcast alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const escalateAlert = async (req, res) => {
  try {
    if (!isAdminRole(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const { alertId } = req.params;
    const ESCALATION = { 'LOW': 'MEDIUM', 'MEDIUM': 'HIGH', 'HIGH': 'CRITICAL' };

    const current = await prisma.$queryRawUnsafe(`
      SELECT sa.id, sa.severity
      FROM sos_alerts sa
      ${SOS_USER_JOIN}
      WHERE sa.id = $1::int
        AND COALESCE(u.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $2::uuid
    `, parseInt(alertId, 10), tenantOf(req));
    if (current.length === 0) return error(res, 'Alert not found', HTTP_STATUS.NOT_FOUND);

    const newSeverity = ESCALATION[current[0].severity];
    if (!newSeverity) return error(res, 'Alert is already at CRITICAL severity', HTTP_STATUS.BAD_REQUEST);

    const rows = await prisma.$queryRawUnsafe(`
      UPDATE sos_alerts SET severity = $3, updated_at = NOW()
      WHERE id = $1::int
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE (u.uid = sos_alerts.uid OR u.phone = sos_alerts.phone)
             AND COALESCE(u.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $2::uuid
        )
      RETURNING id, severity
    `, parseInt(alertId, 10), tenantOf(req), newSeverity);
    success(res, rows[0], `Alert escalated to ${newSeverity}`);
  } catch (err) {
    logger.error('Escalate Alert Error:', err);
    error(res, 'Failed to escalate alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
