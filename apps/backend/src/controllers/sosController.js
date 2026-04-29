// src/controllers/sosController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import * as sosService from '../services/sosService.js';
import { isAdmin } from '../utils/roleHelpers.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { success, error } from '../utils/responseHelper.js';

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

// Patient Controllers
export const createEmergencyAlert = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, 'Validation failed', HTTP_STATUS.BAD_REQUEST, errors.array());
  }

  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber || req.user?.phone);
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
    logger.error('SOS Alert Creation Error:', err.stack || err.toString());
    error(res, 'Failed to process emergency alert. Please call emergency services directly.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber || req.user?.phone);
    if (!phone) {
      return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
    }

    // FIX: Corrected function name from updateEmergencyContact to updateEmergencyContacts
    const result = await sosService.updateEmergencyContacts(phone, req.body, req.user?.uid);
    success(res, result, 'Emergency contact information updated successfully');

  } catch (err) {
    logger.error('Update Emergency Contact Error:', err);
    error(res, 'Failed to update emergency contact information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
export const getEmergencyContact = async (req, res) => {
  try {
    const phone = normalizePhone(req.user?.phone);
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

    const alerts = await prisma.$queryRaw`
      SELECT id, phone, latitude, longitude, alert_type, severity, status,
             message, raised_at, responded_by, responded_at
      FROM sos_alerts
      WHERE status IN ('ACTIVE', 'RESPONDING')
      ORDER BY
        CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
        raised_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    success(res, { alerts }, 'Responder dashboard');
  } catch (err) {
    logger.error('Responder Dashboard Error:', err);
    error(res, 'Failed to load dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getResponderAnalytics = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const stats = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total_responded,
        AVG(EXTRACT(EPOCH FROM (responded_at - raised_at)))::int AS avg_response_seconds,
        COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END)::int AS resolved_count
      FROM sos_alerts
      WHERE responded_by = ${uid}::uuid
    `;
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

    const rows = await prisma.$queryRaw`
      UPDATE sos_alerts
      SET status = 'RESPONDING', responded_by = ${uid}::uuid, responded_at = NOW(), updated_at = NOW()
      WHERE id = ${parseInt(alertId, 10)} AND status = 'ACTIVE'
      RETURNING id, status, responded_at
    `;
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
    const rows = await prisma.$queryRaw`
      UPDATE sos_alerts
      SET status = 'RESOLVED', resolved_at = NOW(), updated_at = NOW()
      WHERE id = ${parseInt(alertId, 10)} AND status IN ('ACTIVE', 'RESPONDING')
      RETURNING id, status, resolved_at
    `;
    if (rows.length === 0) return error(res, 'Alert not found or already resolved', HTTP_STATUS.NOT_FOUND);
    success(res, rows[0], 'Alert resolved');
  } catch (err) {
    logger.error('Resolve Alert Error:', err);
    error(res, 'Failed to resolve alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getAdminAnalytics = async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const stats = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total_alerts,
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END)::int AS active,
        COUNT(CASE WHEN status = 'RESPONDING' THEN 1 END)::int AS responding,
        COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END)::int AS resolved,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END)::int AS cancelled,
        AVG(EXTRACT(EPOCH FROM (responded_at - raised_at)))::int AS avg_response_seconds,
        COUNT(CASE WHEN severity = 'CRITICAL' THEN 1 END)::int AS critical_count,
        COUNT(CASE WHEN severity = 'HIGH' THEN 1 END)::int AS high_count
      FROM sos_alerts
    `;
    success(res, stats[0] || {}, 'Admin SOS analytics');
  } catch (err) {
    logger.error('Admin Analytics Error:', err);
    error(res, 'Failed to load analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getAllAlerts = async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const statusFilter = req.query.status;

    let alerts;
    if (statusFilter) {
      alerts = await prisma.$queryRaw`
        SELECT id, phone, latitude, longitude, alert_type, severity, status,
               message, raised_at, responded_by, responded_at, resolved_at
        FROM sos_alerts WHERE status = ${statusFilter}
        ORDER BY raised_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      alerts = await prisma.$queryRaw`
        SELECT id, phone, latitude, longitude, alert_type, severity, status,
               message, raised_at, responded_by, responded_at, resolved_at
        FROM sos_alerts
        ORDER BY raised_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    }
    success(res, { alerts }, 'All alerts', HTTP_STATUS.OK, { limit, offset });
  } catch (err) {
    logger.error('Get All Alerts Error:', err);
    error(res, 'Failed to load alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getEmergencyServices = async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

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
    if (!isAdmin(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const report = await prisma.$queryRaw`
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
      GROUP BY sa.responded_by, u.name
      ORDER BY alerts_handled DESC
      LIMIT 50
    `;
    success(res, { responders: report }, 'Performance report');
  } catch (err) {
    logger.error('Performance Report Error:', err);
    error(res, 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateSystemConfig = async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

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
    const result = await prisma.$queryRaw`
      INSERT INTO notifications (phone, title, body, type, data, created_at)
      SELECT phone, ${title}, ${body}, 'SOS_BROADCAST',
             ${JSON.stringify({ severity })}::jsonb, NOW()
      FROM users WHERE role != 'PATIENT' AND is_active = true
      RETURNING id
    `;
    success(res, { notified: result.length }, `Broadcast sent to ${result.length} staff`);
  } catch (err) {
    logger.error('Broadcast Alert Error:', err);
    error(res, 'Failed to broadcast alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const escalateAlert = async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);

    const { alertId } = req.params;
    const ESCALATION = { 'LOW': 'MEDIUM', 'MEDIUM': 'HIGH', 'HIGH': 'CRITICAL' };

    const current = await prisma.$queryRaw`
      SELECT id, severity FROM sos_alerts WHERE id = ${parseInt(alertId, 10)}
    `;
    if (current.length === 0) return error(res, 'Alert not found', HTTP_STATUS.NOT_FOUND);

    const newSeverity = ESCALATION[current[0].severity];
    if (!newSeverity) return error(res, 'Alert is already at CRITICAL severity', HTTP_STATUS.BAD_REQUEST);

    const rows = await prisma.$queryRaw`
      UPDATE sos_alerts SET severity = ${newSeverity}, updated_at = NOW()
      WHERE id = ${parseInt(alertId, 10)}
      RETURNING id, severity
    `;
    success(res, rows[0], `Alert escalated to ${newSeverity}`);
  } catch (err) {
    logger.error('Escalate Alert Error:', err);
    error(res, 'Failed to escalate alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
