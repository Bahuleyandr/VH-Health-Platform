// src/controllers/auth/staffAuthController.js - Staff Authentication Controller
// Handles employee ID + password/PIN authentication for staff mobile app

import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { StaffAuthService } from '../../services/auth/staffAuthService.js';
// Profile data is owned by staffService.getStaffProfile (not the auth class).
// Importing it lets the auth controller's GET /staff/profile route return
// the same payload the rest of the staff routes use, instead of crashing
// with `StaffAuthService.getStaffProfile is not a function`.
import { getStaffProfile as fetchStaffProfile } from '../../services/staff/staffService.js';
import { success, error } from '../../utils/responseHelper.js';

// Staff login with employee ID and password
export const login = async (req, res) => {
  try {
    const { employeeId, password, deviceType } = req.body;
    const result = await StaffAuthService.authenticateStaff(employeeId, password, req, { deviceType });
    success(res, result, 'Staff login successful');
  } catch (err) {
    logger.error('Staff Login Error:', err);
    error(res, 'Login failed', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Staff login with employee ID and PIN
export const pinLogin = async (req, res) => {
  try {
    const { employeeId, pin, deviceType } = req.body;
    const result = await StaffAuthService.authenticateStaffWithPin(employeeId, pin, req, { deviceType });
    success(res, result, 'Staff login with PIN successful');
  } catch (err) {
    logger.error('Staff PIN Login Error:', err);
    error(res, 'Login failed', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Register device for quick access
export const registerDevice = async (req, res) => {
  try {
    const { employeeId, password, deviceInfo, deviceType } = req.body;
    const result = await StaffAuthService.registerStaffDevice(employeeId, password, deviceInfo, req, { deviceType });
    success(res, result, 'Device registered successfully');
  } catch (err) {
    logger.error('Device Registration Error:', err);
    error(res, 'Failed to register device', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Quick login with PIN or biometric
export const quickLogin = async (req, res) => {
  try {
    const { deviceToken, pin, biometric, location, deviceType } = req.body;
    const result = await StaffAuthService.quickLogin(deviceToken, pin, biometric, location, req, { deviceType });
    success(res, result, 'Quick login successful');
  } catch (err) {
    logger.error('Quick Login Error:', err);
    error(res, 'Quick login failed', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Setup PIN for quick access
export const setupPin = async (req, res) => {
  try {
    const { deviceToken, pin } = req.body;
    const staffId = req.user.uid;
    const result = await StaffAuthService.setupPin(staffId, deviceToken, pin);
    success(res, result, 'PIN setup successful');
  } catch (err) {
    logger.error('PIN Setup Error:', err);
    error(res, 'Failed to setup PIN', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Toggle biometric authentication
export const toggleBiometric = async (req, res) => {
  try {
    const { deviceToken, enabled } = req.body;
    const staffId = req.user.uid;
    const result = await StaffAuthService.toggleBiometric(staffId, deviceToken, enabled);
    success(res, result, `Biometric ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    logger.error('Toggle Biometric Error:', err);
    error(res, 'Failed to toggle biometric', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Refresh session
export const refreshSession = async (req, res) => {
  try {
    const { refreshToken, deviceToken } = req.body;
    const result = await StaffAuthService.refreshStaffSession(refreshToken, deviceToken, req);
    success(res, result, 'Session refreshed successfully');
  } catch (err) {
    logger.error('Refresh Session Error:', err);
    error(res, 'Failed to refresh session', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Logout
export const logout = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { deviceToken } = req.body;
    const result = await StaffAuthService.logoutStaff(staffId, deviceToken, req);
    success(res, result, 'Logged out successfully');
  } catch (err) {
    logger.error('Logout Error:', err);
    error(res, 'Logout failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get staff profile with device info.
//
// Delegates to `staffService.getStaffProfile`, which handles all three
// identifier shapes the staff app might send (UUID via req.user.uid,
// EMP-* via employee_id, or numeric via users.id). The previous
// implementation called `StaffAuthService.getStaffProfile` — a method
// that doesn't exist on the class — and 500'd on every staff role.
//
// The service throws a plain `Error('NOT_FOUND')` rather than returning
// null when the role hierarchy filter excludes the requesting role
// (notably SUPER_ADMIN, which isn't in any other role's `viewable`
// list). Catch that specific shape and surface a real 404 instead of
// a 500 — the staff app's Profile screen handles 404 gracefully but
// blank-screens on 500.
export const getProfile = async (req, res) => {
  try {
    const staffUid = req.user.uid;
    const profile = await fetchStaffProfile(staffUid, req.user.role, req.user.uid, true);
    if (!profile) {
      return error(res, 'Staff profile not found', HTTP_STATUS.NOT_FOUND);
    }
    success(res, profile, 'Staff profile retrieved');
  } catch (err) {
    if (err?.message === 'NOT_FOUND') {
      return error(res, 'Staff profile not found', HTTP_STATUS.NOT_FOUND);
    }
    logger.error('Get Profile Error:', err);
    error(res, 'Failed to get profile', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateProfile = async (req, res) => {
  try {
    const staffUid = req.user.uid;
    const result = await StaffAuthService.updateOwnProfile(staffUid, req.body, req);
    success(res, result, 'Profile updated');
  } catch (err) {
    if (err?.statusCode) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Update Profile Error:', err);
    error(res, 'Failed to update profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const changePassword = async (req, res) => {
  try {
    const staffUid = req.user.uid;
    const { currentPassword, newPassword } = req.body;
    const result = await StaffAuthService.changeOwnPassword(staffUid, currentPassword, newPassword, req);
    success(res, result, 'Password changed');
  } catch (err) {
    if (err?.statusCode) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Change Password Error:', err);
    error(res, 'Failed to change password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get registered devices
export const getDevices = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const devices = await StaffAuthService.listStaffDevices(staffId);
    success(res, { devices }, 'Devices retrieved successfully');
  } catch (err) {
    logger.error('List Devices Error:', err);
    error(res, 'Failed to list devices', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Remove device
export const removeDevice = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { deviceId } = req.params;
    const result = await StaffAuthService.removeDevice(staffId, deviceId);
    success(res, result, 'Device removed successfully');
  } catch (err) {
    logger.error('Remove Device Error:', err);
    error(res, 'Failed to remove device', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Check-in
export const checkIn = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { location } = req.body;
    const result = await StaffAuthService.markAttendance(staffId, 'check-in', location, req);
    success(res, result, 'Check-in successful');
  } catch (err) {
    logger.error('Check-in Error:', err);
    error(res, 'Failed to check-in', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Check-out
export const checkOut = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { location } = req.body;
    const result = await StaffAuthService.markAttendance(staffId, 'check-out', location, req);
    success(res, result, 'Check-out successful');
  } catch (err) {
    logger.error('Check-out Error:', err);
    error(res, 'Failed to check-out', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get attendance status
export const getAttendanceStatus = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const status = await StaffAuthService.getAttendanceStatus(staffId);
    success(res, status, 'Attendance status retrieved');
  } catch (err) {
    logger.error('Get Attendance Status Error:', err);
    error(res, 'Failed to get attendance status', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Check device status
export const checkDeviceStatus = async (req, res) => {
  try {
    const { deviceToken } = req.params;
    const status = await StaffAuthService.checkDeviceStatus(deviceToken);
    success(res, status, 'Device status retrieved');
  } catch (err) {
    logger.error('Check Device Status Error:', err);
    error(res, 'Failed to check device status', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get health status
export const getHealthStatus = async (req, res) => {
  success(res, {
    service: 'staff-auth',
    status: 'healthy',
    authMethods: ['password', 'pin', 'quick-login'],
    timestamp: new Date().toISOString(),
  }, 'Staff authentication service is healthy');
};

// Admin functions
export const adminListAllDevices = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const result = await StaffAuthService.adminListAllDevices({ page: parseInt(page), limit: parseInt(limit) });
    success(res, result, 'All staff devices retrieved');
  } catch (err) {
    logger.error('Admin List Devices Error:', err);
    error(res, 'Failed to list devices', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getStaffLoginActivity = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { page = 1, limit = 100 } = req.query;
    const result = await StaffAuthService.getStaffLoginActivity(staffId, { page: parseInt(page), limit: parseInt(limit) });
    success(res, result, 'Login activity retrieved');
  } catch (err) {
    logger.error('Get Login Activity Error:', err);
    error(res, 'Failed to get login activity', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const adminForceLogout = async (req, res) => {
  try {
    const { staffId, reason } = req.body;
    const adminId = req.user.uid;
    const result = await StaffAuthService.adminForceLogout(staffId, reason, adminId, req);
    success(res, result, 'Staff member logged out successfully');
  } catch (err) {
    logger.error('Admin Force Logout Error:', err);
    error(res, 'Failed to force logout', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const adminResetPin = async (req, res) => {
  try {
    const { staffId } = req.body;
    const adminId = req.user.uid;
    const result = await StaffAuthService.adminResetPin(staffId, adminId, req);
    success(res, result, 'PIN reset successfully');
  } catch (err) {
    logger.error('Admin Reset PIN Error:', err);
    error(res, 'Failed to reset PIN', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const adminRemoveAllDevices = async (req, res) => {
  try {
    const { staffId } = req.params;
    const adminId = req.user.uid;
    const result = await StaffAuthService.adminRemoveAllDevices(staffId, adminId, req);
    success(res, result, 'All devices removed successfully');
  } catch (err) {
    logger.error('Admin Remove Devices Error:', err);
    error(res, 'Failed to remove devices', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Verify device
export const verifyDevice = async (req, res) => {
  try {
    const { deviceToken } = req.body;
    const result = await StaffAuthService.verifyDevice(deviceToken);
    success(res, result, 'Device verified successfully');
  } catch (err) {
    logger.error('Verify Device Error:', err);
    error(res, 'Failed to verify device', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get today's attendance
export const getTodayAttendance = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const attendance = await StaffAuthService.getTodayAttendance(staffId);
    success(res, attendance, 'Today\'s attendance retrieved');
  } catch (err) {
    logger.error('Get Today Attendance Error:', err);
    error(res, 'Failed to get attendance', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get attendance history
export const getAttendanceHistory = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { startDate, endDate, page = 1, limit = 30 } = req.query;
    const history = await StaffAuthService.getAttendanceHistory(staffId, {
      startDate,
      endDate,
      page: parseInt(page),
      limit: parseInt(limit)
    });
    success(res, history, 'Attendance history retrieved');
  } catch (err) {
    logger.error('Get Attendance History Error:', err);
    error(res, 'Failed to get attendance history', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ✅ CLEANUP: Removed duplicate/unused functions like 'markAttendance' and 'listDevices'
// 'getDevices' is used instead of 'listDevices' for consistency.
// 'checkIn' and 'checkOut' are used instead of a generic 'markAttendance'.
