// src/controllers/auth/adminAuthController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { AuthService } from '../../services/auth/authService.js';
import { success, error } from '../../utils/responseHelper.js';

// Admin login with username/password - FIXED: Changed from adminLogin to login
export const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { username, password } = req.body;
    const result = await AuthService.adminLogin(username, password);
    
    logger.info(`Admin login successful: ${username}`);
    success(res, result, 'Admin login successful');
  } catch (err) {
    logger.error('[AdminLogin]:', err);
    
    if (err.message === 'Invalid credentials') {
      return error(res, 'Invalid username or password', HTTP_STATUS.UNAUTHORIZED);
    }
    
    error(res, 'Admin login failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Forgot password - NEW FUNCTION
export const forgotPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { username } = req.body;
    const result = await AuthService.adminForgotPassword(username);
    
    success(res, result, 'Password reset OTP sent successfully');
  } catch (err) {
    logger.error('[ForgotPassword]:', err);
    error(res, err.message || 'Failed to send password reset OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Reset password - NEW FUNCTION
export const resetPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { username, otp, newPassword } = req.body;
    const result = await AuthService.adminResetPassword(username, otp, newPassword);
    
    success(res, result, 'Password reset successfully');
  } catch (err) {
    logger.error('[ResetPassword]:', err);
    error(res, err.message || 'Failed to reset password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Change password - NEW FUNCTION
export const changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.user?.uid;
    
    if (!adminId) {
      return error(res, 'Admin not authenticated', HTTP_STATUS.UNAUTHORIZED);
    }
    
    const result = await AuthService.changeAdminPassword(adminId, currentPassword, newPassword);
    
    logger.info(`Admin password changed: ${adminId}`);
    success(res, result, 'Password changed successfully');
  } catch (err) {
    logger.error('[ChangeAdminPassword]:', err);
    
    if (err.message === 'Current password is incorrect') {
      return error(res, err.message, HTTP_STATUS.UNAUTHORIZED);
    }
    
    error(res, 'Failed to change password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get admin profile - NEW FUNCTION
export const getProfile = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    const result = await AuthService.getAdminProfile(adminId);
    
    success(res, result, 'Profile retrieved successfully');
  } catch (err) {
    logger.error('[GetProfile]:', err);
    error(res, 'Failed to get profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get health status - NEW FUNCTION
export const getHealthStatus = async (req, res) => {
  try {
    const healthData = await AuthService.getAdminAuthHealth();
    success(res, healthData, 'Admin authentication service is healthy');
  } catch (err) {
    logger.error('[HealthCheck]:', err);
    error(res, 'Admin authentication service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get admin activity logs - NEW FUNCTION
export const getAdminActivityLogs = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    
    const result = await AuthService.getAdminActivityLogs(adminId, {
      page: parseInt(page),
      limit: parseInt(limit)
    });
    
    success(res, result, 'Activity logs retrieved successfully');
  } catch (err) {
    logger.error('[GetActivityLogs]:', err);
    error(res, 'Failed to get activity logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update admin permissions - NEW FUNCTION
export const updatePermissions = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { adminId, permissions } = req.body;
    const updatedBy = req.user?.uid;
    
    const result = await AuthService.updateAdminPermissions(adminId, permissions, updatedBy);
    
    success(res, result, 'Permissions updated successfully');
  } catch (err) {
    logger.error('[UpdatePermissions]:', err);
    error(res, 'Failed to update permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// KEEP EXISTING FUNCTIONS - Just remove the duplicate exports
export const createAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const adminData = req.body;
    const createdBy = req.user?.uid;
    
    const result = await AuthService.createAdmin({ ...adminData, createdBy });
    
    logger.info(`New admin created: ${adminData.username} by ${createdBy}`);
    success(res, result, 'Admin account created successfully');
  } catch (err) {
    logger.error('[CreateAdmin]:', err);
    
    if (err.message.includes('already exists')) {
      return error(res, err.message, HTTP_STATUS.CONFLICT);
    }
    
    error(res, 'Failed to create admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const listAdmins = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const result = await AuthService.listAdmins(parseInt(page), parseInt(limit));
    
    success(res, result, 'Admins retrieved successfully');
  } catch (err) {
    logger.error('[ListAdmins]:', err);
    error(res, 'Failed to retrieve admins', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deactivateAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { adminId, reason } = req.body;
    const deactivatedBy = req.user?.uid;
    
    if (adminId === deactivatedBy) {
      return error(res, 'Cannot deactivate your own account', HTTP_STATUS.BAD_REQUEST);
    }
    
    const result = await AuthService.deactivateAdmin(adminId, reason, deactivatedBy);
    
    logger.info(`Admin deactivated: ${adminId} by ${deactivatedBy}`);
    success(res, result, 'Admin account deactivated successfully');
  } catch (err) {
    logger.error('[DeactivateAdmin]:', err);
    
    if (err.message === 'Admin not found') {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to deactivate admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const reactivateAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { adminId } = req.body;
    const reactivatedBy = req.user?.uid;
    
    const result = await AuthService.reactivateAdmin(adminId, reactivatedBy);
    
    logger.info(`Admin reactivated: ${adminId} by ${reactivatedBy}`);
    success(res, result, 'Admin account reactivated successfully');
  } catch (err) {
    logger.error('[ReactivateAdmin]:', err);
    
    if (err.message === 'Admin not found') {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to reactivate admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
