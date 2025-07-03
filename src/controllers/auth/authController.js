// src/controllers/auth/authController.js - Core Authentication Controller

import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as authService from '../../services/auth/authService.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';

// Request OTP for login/registration
// NOTE: This is NOT for patient login (patients use Firebase)
// This is for: admin override, testing, non-patient users
export const requestOtp = async (req, res) => {
  try {
    const { phone, purpose = 'general' } = req.body;

    const result = await authService.requestOtp(phone, purpose, req);

    success(res, result, 'OTP sent successfully');
  } catch (err) {
    logger.error('Request OTP Error:', err);
    error(res, err.message || 'Failed to send OTP', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Verify OTP and authenticate
// NOTE: This is NOT for patient login (patients use Firebase)
// This is for: admin override, testing, non-patient users
export const verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    const result = await authService.verifyOtpAndAuthenticate(phone, otp, req);

    success(res, result, result.isNewUser ? 'User registered and logged in' : 'Login successful');
  } catch (err) {
    logger.error('Verify OTP Error:', err);
    error(res, err.message || 'Authentication failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Refresh JWT token
export const refreshToken = async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Authorization token required', HTTP_STATUS.UNAUTHORIZED);
    }

    const token = authHeader.split(' ')[1];
    const result = await authService.refreshToken(token);

    success(res, result, 'Token refreshed successfully');
  } catch (err) {
    logger.error('Token Refresh Error:', err);
    error(res, err.message || 'Failed to refresh token', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Logout
export const logout = async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    let userPhone = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const result = await authService.logout(token, req);
      userPhone = result.phone;
    }

    success(res, {
      message: 'Logged out successfully. Please discard your token.',
      phone: userPhone
    }, 'Logout successful');
  } catch (err) {
    logger.error('Logout Error:', err);
    // Don't fail logout even if there's an error
    success(res, {
      message: 'Logged out successfully. Please discard your token.'
    }, 'Logout successful');
  }
};

// Get authentication health status
export const getHealthStatus = async (req, res) => {
  try {
    const healthData = await authService.getHealthStatus();
    success(res, healthData, 'Authentication service is healthy');
  } catch (err) {
    logger.error('Auth Health Check Error:', err);
    error(res, 'Authentication service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get public authentication statistics (with DD-MM-YYYY date formatting)
export const getPublicStats = async (req, res) => {
  try {
    const stats = await authService.getPublicStats();

    // Format dates to DD-MM-YYYY
    if (stats.lastUpdated) {
      stats.lastUpdated = formatDateDDMMYYYY(stats.lastUpdated);
    }

    success(res, stats, 'Authentication statistics');
  } catch (err) {
    logger.error('Auth Stats Error:', err);
    error(res, 'Failed to fetch statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Legacy login handler (maintained for backward compatibility)
export const login = async (req, res) => {
  try {
    const { phone } = req.body;
    const result = await authService.legacyLogin(phone, req);
    success(res, result, 'Login successful');
  } catch (err) {
    logger.error('Legacy Login Error:', err);
    error(res, err.message || 'Login failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Legacy register handler (maintained for backward compatibility)
export const register = async (req, res) => {
  try {
    const { phone } = req.body;
    const result = await authService.legacyRegister(phone, req);
    success(res, result, 'Registration successful');
  } catch (err) {
    logger.error('Legacy Register Error:', err);
    error(res, err.message || 'Registration failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
