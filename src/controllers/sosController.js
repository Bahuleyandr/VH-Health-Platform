// src/controllers/sosController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import * as sosService from '../services/sosService.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { success, error } from '../utils/responseHelper.js';

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
      phone,
      ...req.body,
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
    const latitude = parseFloat(req.query.latitude);
    const longitude = parseFloat(req.query.longitude);

    if (isNaN(latitude) || isNaN(longitude)) {
      return error(res, 'Latitude and longitude are required', HTTP_STATUS.BAD_REQUEST);
    }

    const services = await sosService.getNearbyServices(latitude, longitude);
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
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const getResponderAnalytics = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const respondToAlert = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const resolveAlert = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const getAdminAnalytics = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const getAllAlerts = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const getEmergencyServices = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const getPerformanceReport = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const updateSystemConfig = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const broadcastEmergencyAlert = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};

export const escalateAlert = async (req, res) => {
  return res.status(501).json({ success: false, message: 'Not implemented' });
};