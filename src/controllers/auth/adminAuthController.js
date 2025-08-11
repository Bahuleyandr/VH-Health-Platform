// src/controllers/auth/adminAuthController.js

import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { AuthService } from '../../services/auth/authService.js';
import { success, error } from '../../utils/responseHelper.js';

/* util: pick username OR email from body */
const pickIdentity = (body) => (body?.username?.trim() || body?.email?.trim() || null);

/* ----------------------------- LOGIN ------------------------------ */
// Admin login (username OR email + password)
export const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const identity = pickIdentity(req.body);
    const { password } = req.body;

    const result = await AuthService.adminLogin(identity, password);
    logger.info(`Admin login successful: ${identity}`);
    return success(res, result, 'Admin login successful');
  } catch (err) {
    logger.error('[AdminLogin]:', err);
    if (err?.message === 'Invalid credentials') {
      return error(res, 'Invalid username or password', HTTP_STATUS.UNAUTHORIZED);
    }
    return error(res, 'Admin login failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ----------------------- PASSWORD: FORGOT/RESET ------------------- */
// Request password reset (send OTP)
export const forgotPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const identity = pickIdentity(req.body);
    const result = await AuthService.adminForgotPassword(identity);
    return success(res, result, 'Password reset OTP sent successfully');
  } catch (err) {
    logger.error('[ForgotPassword]:', err);
    return error(res, err.message || 'Failed to send password reset OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Reset password with OTP
export const resetPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const identity = pickIdentity(req.body);
    const { otp, newPassword } = req.body;

    const result = await AuthService.adminResetPassword(identity, otp, newPassword);
    return success(res, result, 'Password reset successfully');
  } catch (err) {
    logger.error('[ResetPassword]:', err);
    return error(res, err.message || 'Failed to reset password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ---------------------------- CHANGE PWD -------------------------- */
export const changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Admin not authenticated', HTTP_STATUS.UNAUTHORIZED);

    const result = await AuthService.changeAdminPassword(adminId, currentPassword, newPassword);
    logger.info(`Admin password changed: ${adminId}`);
    return success(res, result, 'Password changed successfully');
  } catch (err) {
    logger.error('[ChangeAdminPassword]:', err);
    if (err?.message === 'Current password is incorrect') {
      return error(res, err.message, HTTP_STATUS.UNAUTHORIZED);
    }
    return error(res, 'Failed to change password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ------------------------------ PROFILE --------------------------- */
export const getProfile = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Admin not authenticated', HTTP_STATUS.UNAUTHORIZED);

    const result = await AuthService.getAdminProfile(adminId);
    return success(res, result, 'Profile retrieved successfully');
  } catch (err) {
    logger.error('[GetProfile]:', err);
    return error(res, 'Failed to get profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ------------------------------ HEALTH ---------------------------- */
export const getHealthStatus = async (req, res) => {
  try {
    const healthData = await AuthService.getAdminAuthHealth();
    return success(res, healthData, 'Admin authentication service is healthy');
  } catch (err) {
    logger.error('[HealthCheck]:', err);
    return error(res, 'Admin authentication service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* -------------------------- ACTIVITY LOGS ------------------------- */
export const getAdminActivityLogs = async (req, res) => {
  try {
    const adminId = Number(req.params.adminId);
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 50);

    const result = await AuthService.getAdminActivityLogs(adminId, { page, limit });
    return success(res, result, 'Activity logs retrieved successfully');
  } catch (err) {
    logger.error('[GetActivityLogs]:', err);
    return error(res, 'Failed to get activity logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ------------------------- PERMISSIONS MGMT ----------------------- */
export const updatePermissions = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const adminId = Number(req.body.adminId);
    const { permissions } = req.body;
    const updatedBy = req.user?.uid;

    const result = await AuthService.updateAdminPermissions(adminId, permissions, updatedBy);
    return success(res, result, 'Permissions updated successfully');
  } catch (err) {
    logger.error('[UpdatePermissions]:', err);
    return error(res, 'Failed to update permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ----------------------------- CRUD ADMIN ------------------------- */
export const createAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const adminData = req.body;
    const createdBy = req.user?.uid;

    const result = await AuthService.createAdmin({ ...adminData, createdBy });
    logger.info(`New admin created: ${adminData?.username || adminData?.email} by ${createdBy}`);
    return success(res, result, 'Admin account created successfully');
  } catch (err) {
    logger.error('[CreateAdmin]:', err);
    if (String(err?.message || '').includes('already exists')) {
      return error(res, err.message, HTTP_STATUS.CONFLICT);
    }
    return error(res, 'Failed to create admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const listAdmins = async (req, res) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const result = await AuthService.listAdmins(page, limit);
    return success(res, result, 'Admins retrieved successfully');
  } catch (err) {
    logger.error('[ListAdmins]:', err);
    return error(res, 'Failed to retrieve admins', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deactivateAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const adminId = Number(req.body.adminId);
    const { reason } = req.body;
    const deactivatedBy = Number(req.user?.uid);

    if (adminId === deactivatedBy) {
      return error(res, 'Cannot deactivate your own account', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await AuthService.deactivateAdmin(adminId, reason, deactivatedBy);
    logger.info(`Admin deactivated: ${adminId} by ${deactivatedBy}`);
    return success(res, result, 'Admin account deactivated successfully');
  } catch (err) {
    logger.error('[DeactivateAdmin]:', err);
    if (err?.message === 'Admin not found') {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    return error(res, 'Failed to deactivate admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const reactivateAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }

  try {
    const adminId = Number(req.body.adminId);
    const reactivatedBy = Number(req.user?.uid);

    const result = await AuthService.reactivateAdmin(adminId, reactivatedBy);
    logger.info(`Admin reactivated: ${adminId} by ${reactivatedBy}`);
    return success(res, result, 'Admin account reactivated successfully');
  } catch (err) {
    logger.error('[ReactivateAdmin]:', err);
    if (err?.message === 'Admin not found') {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    return error(res, 'Failed to reactivate admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
