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
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array(),
      message: 'Validation failed'
    });
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
export const cancelAlert = async (req, res) => {
  // TODO: Implement actual logic
  return res.json({ success: true, message: 'cancelAlert handler not implemented yet' });
};

export const getMyAlerts = async (req, res) => {
  return res.json({ success: true, message: 'getMyAlerts handler not implemented yet' });
};

export const getNearbyServices = async (req, res) => {
  return res.json({ success: true, message: 'getNearbyServices handler not implemented yet' });
};

export const getMedicalInfo = async (req, res) => {
  return res.json({ success: true, message: 'getMedicalInfo handler not implemented yet' });
};

export const getResponderDashboard = async (req, res) => {
  return res.json({ success: true, message: 'getResponderDashboard handler not implemented yet' });
};

export const getResponderAnalytics = async (req, res) => {
  return res.json({ success: true, message: 'getResponderAnalytics handler not implemented yet' });
};

export const respondToAlert = async (req, res) => {
  return res.json({ success: true, message: 'respondToAlert handler not implemented yet' });
};

export const resolveAlert = async (req, res) => {
  return res.json({ success: true, message: 'resolveAlert handler not implemented yet' });
};

export const getAdminAnalytics = async (req, res) => {
  return res.json({ success: true, message: 'getAdminAnalytics handler not implemented yet' });
};

export const getAllAlerts = async (req, res) => {
  return res.json({ success: true, message: 'getAllAlerts handler not implemented yet' });
};

export const getEmergencyServices = async (req, res) => {
  return res.json({ success: true, message: 'getEmergencyServices handler not implemented yet' });
};

export const getPerformanceReport = async (req, res) => {
  return res.json({ success: true, message: 'getPerformanceReport handler not implemented yet' });
};

export const updateSystemConfig = async (req, res) => {
  return res.json({ success: true, message: 'updateSystemConfig handler not implemented yet' });
};

export const broadcastEmergencyAlert = async (req, res) => {
  return res.json({ success: true, message: 'broadcastEmergencyAlert handler not implemented yet' });
};

export const escalateAlert = async (req, res) => {
  return res.json({ success: true, message: 'escalateAlert handler not implemented yet' });
};