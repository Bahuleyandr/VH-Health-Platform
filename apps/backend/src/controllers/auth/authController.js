// src/controllers/auth/authController.js - Core Authentication Controller

import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
// ✅ FIX: Changed the import to get the class directly
import { AuthService } from '../../services/auth/authService.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { success, error } from '../../utils/responseHelper.js';

// Request OTP for login/registration
export const requestOtp = async (req, res) => {
  try {
    const { phone, purpose = 'general' } = req.body;
    // ✅ FIX: Called the static method on the AuthService class
    const result = await AuthService.requestOtp(phone, purpose, req);
    success(res, result, 'OTP sent successfully');
  } catch (err) {
    logger.error('Request OTP Error:', err);
    error(res, 'Failed to send OTP', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Verify OTP and authenticate
export const verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    // ✅ FIX: Called the static method on the AuthService class
    const result = await AuthService.verifyOtpAndAuthenticate(phone, otp, req);
    success(res, result, result.isNewUser ? 'User registered and logged in' : 'Login successful');
  } catch (err) {
    logger.error('Verify OTP Error:', err);
    error(res, 'Authentication failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Refresh JWT token
export const refreshToken = async (req, res) => {
  try {
    // Accept the refresh token from the request BODY or the Authorization
    // header. Once the Flutter client holds a stored refresh token it switches
    // to POSTing `{ refreshToken }` in the body with auth:false (vhhealth_core
    // VHHttpClient._performRefresh); the pre-stored-refresh / staff clients
    // still send it as a bearer header. C-9: AuthService.refreshToken enforces
    // that whatever is presented actually carries type:'refresh'.
    const authHeader = req.headers['authorization'];
    const bearer = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;
    const token = req.body?.refreshToken || bearer;
    if (!token) {
      return error(res, 'Authorization token required', HTTP_STATUS.UNAUTHORIZED);
    }
    const result = await AuthService.refreshToken(token, req);
    success(res, result, 'Token refreshed successfully');
  } catch (err) {
    logger.error('Token Refresh Error:', err);
    error(res, 'Failed to refresh token', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Logout
export const logout = async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    let userPhone = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      // ✅ FIX: Called the static method on the AuthService class
      const result = await AuthService.logout(token, req);
      userPhone = result.phone;
    }
    success(res, { message: 'Logged out successfully. Please discard your token.', phone: userPhone }, 'Logout successful');
  } catch (err) {
    logger.error('Logout Error:', err);
    success(res, { message: 'Logged out successfully. Please discard your token.' }, 'Logout successful');
  }
};

// Get authentication health status
export const getHealthStatus = async (req, res) => {
  try {
    // ✅ FIX: Called the static method on the AuthService class
    const healthData = await AuthService.getHealthStatus();
    success(res, healthData, 'Authentication service is healthy');
  } catch (err) {
    logger.error('Auth Health Check Error:', err);
    error(res, 'Authentication service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get public authentication statistics
export const getPublicStats = async (req, res) => {
  try {
    // ✅ FIX: Called the static method on the AuthService class
    const stats = await AuthService.getPublicStats();
    if (stats.lastUpdated) {
      stats.lastUpdated = formatDateDDMMYYYY(stats.lastUpdated);
    }
    success(res, stats, 'Authentication statistics');
  } catch (err) {
    logger.error('Auth Stats Error:', err);
    error(res, 'Failed to fetch statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Legacy login handler
export const login = async (req, res) => {
  try {
    const { phone } = req.body;
    // ✅ FIX: Called the static method on the AuthService class
    const result = await AuthService.legacyLogin(phone, req);
    success(res, result, 'Login successful');
  } catch (err) {
    logger.error('Legacy Login Error:', err);
    error(res, 'Login failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Legacy register handler
export const register = async (req, res) => {
  try {
    const { phone } = req.body;
    // ✅ FIX: Called the static method on the AuthService class
    const result = await AuthService.legacyRegister(phone, req);
    success(res, result, 'Registration successful');
  } catch (err) {
    logger.error('Legacy Register Error:', err);
    error(res, 'Registration failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
// ✅ FIX: Removed extra closing brace from the end of the file