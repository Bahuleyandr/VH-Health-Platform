// src/controllers/auth/staffAuthController.js - Staff Authentication Controller
// Handles employee ID + password/PIN authentication for staff mobile app

import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as staffAuthService from '../../services/auth/staffAuthService.js';

// Staff login with employee ID and password
export const login = async (req, res) => {
  try {
    const { employeeId, password } = req.body;
    
    const result = await staffAuthService.authenticateStaff(employeeId, password, req);
    
    success(res, result, 'Staff login successful');
  } catch (err) {
    logger.error('Staff Login Error:', err);
    error(res, err.message || 'Login failed', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Register device for quick access
export const registerDevice = async (req, res) => {
  try {
    const { employeeId, password, deviceInfo } = req.body;
    
    const result = await staffAuthService.registerStaffDevice(employeeId, password, deviceInfo, req);
    
    success(res, result, 'Device registered successfully');
  } catch (err) {
    logger.error('Device Registration Error:', err);
    error(res, err.message || 'Failed to register device', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Quick login with PIN or biometric
export const quickLogin = async (req, res) => {
  try {
    const { deviceToken, pin, biometric, location } = req.body;
    
    const result = await staffAuthService.quickLogin(deviceToken, pin, biometric, location, req);
    
    success(res, result, 'Quick login successful');
  } catch (err) {
    logger.error('Quick Login Error:', err);
    error(res, err.message || 'Quick login failed', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Setup PIN for quick access
export const setupPin = async (req, res) => {
  try {
    const { deviceToken, pin } = req.body;
    const staffId = req.user.uid;
    
    const result = await staffAuthService.setupPin(staffId, deviceToken, pin);
    
    success(res, result, 'PIN setup successful');
  } catch (err) {
    logger.error('PIN Setup Error:', err);
    error(res, err.message || 'Failed to setup PIN', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Toggle biometric authentication
export const toggleBiometric = async (req, res) => {
  try {
    const { deviceToken, enabled } = req.body;
    const staffId = req.user.uid;
    
    const result = await staffAuthService.toggleBiometric(staffId, deviceToken, enabled);
    
    success(res, result, `Biometric ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    logger.error('Toggle Biometric Error:', err);
    error(res, err.message || 'Failed to toggle biometric', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Refresh session
export const refreshSession = async (req, res) => {
  try {
    const { refreshToken, deviceToken } = req.body;
    
    const result = await staffAuthService.refreshStaffSession(refreshToken, deviceToken);
    
    success(res, result, 'Session refreshed successfully');
  } catch (err) {
    logger.error('Refresh Session Error:', err);
    error(res, err.message || 'Failed to refresh session', err.statusCode || HTTP_STATUS.UNAUTHORIZED);
  }
};

// Logout
export const logout = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { deviceToken } = req.body;
    
    const result = await staffAuthService.logoutStaff(staffId, deviceToken, req);
    
    success(res, result, 'Logged out successfully');
  } catch (err) {
    logger.error('Logout Error:', err);
    error(res, err.message || 'Logout failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get staff profile with device info
export const getProfile = async (req, res) => {
  try {
    const staffId = req.user.uid;
    
    const profile = await staffAuthService.getStaffProfile(staffId);
    
    success(res, profile, 'Staff profile retrieved');
  } catch (err) {
    logger.error('Get Profile Error:', err);
    error(res, err.message || 'Failed to get profile', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// List registered devices
export const listDevices = async (req, res) => {
  try {
    const staffId = req.user.uid;
    
    const devices = await staffAuthService.listStaffDevices(staffId);
    
    success(res, devices, 'Devices retrieved');
  } catch (err) {
    logger.error('List Devices Error:', err);
    error(res, err.message || 'Failed to list devices', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Remove device
export const removeDevice = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { deviceId } = req.params;
    
    const result = await staffAuthService.removeDevice(staffId, deviceId);
    
    success(res, result, 'Device removed successfully');
  } catch (err) {
    logger.error('Remove Device Error:', err);
    error(res, err.message || 'Failed to remove device', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Mark attendance (integrated with auth)
export const markAttendance = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { type, location } = req.body;
    
    const result = await staffAuthService.markAttendance(staffId, type, location, req);
    
    success(res, result, `Attendance ${type} marked successfully`);
  } catch (err) {
    logger.error('Mark Attendance Error:', err);
    error(res, err.message || 'Failed to mark attendance', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get attendance status
export const getAttendanceStatus = async (req, res) => {
  try {
    const staffId = req.user.uid;
    
    const status = await staffAuthService.getAttendanceStatus(staffId);
    
    success(res, status, 'Attendance status retrieved');
  } catch (err) {
    logger.error('Get Attendance Status Error:', err);
    error(res, err.message || 'Failed to get attendance status', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Check device status
export const checkDeviceStatus = async (req, res) => {
  try {
    const { deviceToken } = req.params;
    
    const status = await staffAuthService.checkDeviceStatus(deviceToken);
    
    success(res, status, 'Device status retrieved');
  } catch (err) {
    logger.error('Check Device Status Error:', err);
    error(res, err.message || 'Failed to check device status', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get health status
export const getHealthStatus = async (req, res) => {
  try {
    const healthData = await staffAuthService.getHealthStatus();
    success(res, healthData, 'Staff authentication service is healthy');
  } catch (err) {
    logger.error('Staff Auth Health Check Error:', err);
    error(res, 'Staff authentication service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin functions
export const adminListAllDevices = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    
    const result = await staffAuthService.adminListAllDevices({
      page: parseInt(page),
      limit: parseInt(limit)
    });
    
    success(res, result, 'All staff devices retrieved');
  } catch (err) {
    logger.error('Admin List Devices Error:', err);
    error(res, err.message || 'Failed to list devices', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getStaffLoginActivity = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { page = 1, limit = 100 } = req.query;
    
    const result = await staffAuthService.getStaffLoginActivity(staffId, {
      page: parseInt(page),
      limit: parseInt(limit)
    });
    
    success(res, result, 'Login activity retrieved');
  } catch (err) {
    logger.error('Get Login Activity Error:', err);
    error(res, err.message || 'Failed to get login activity', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const adminForceLogout = async (req, res) => {
  try {
    const { staffId, reason } = req.body;
    const adminId = req.user.uid;
    
    const result = await staffAuthService.adminForceLogout(staffId, reason, adminId, req);
    
    success(res, result, 'Staff member logged out successfully');
  } catch (err) {
    logger.error('Admin Force Logout Error:', err);
    error(res, err.message || 'Failed to force logout', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const adminResetPin = async (req, res) => {
  try {
    const { staffId } = req.body;
    const adminId = req.user.uid;
    
    const result = await staffAuthService.adminResetPin(staffId, adminId, req);
    
    success(res, result, 'PIN reset successfully');
  } catch (err) {
    logger.error('Admin Reset PIN Error:', err);
    error(res, err.message || 'Failed to reset PIN', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const adminRemoveAllDevices = async (req, res) => {
  try {
    const { staffId } = req.params;
    const adminId = req.user.uid;
    
    const result = await staffAuthService.adminRemoveAllDevices(staffId, adminId, req);
    
    success(res, result, 'All devices removed successfully');
  } catch (err) {
    logger.error('Admin Remove Devices Error:', err);
    error(res, err.message || 'Failed to remove devices', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
// Verify device - NEW FUNCTION
export const verifyDevice = async (req, res) => {
  try {
    const { deviceToken } = req.body;
    
    const result = await staffAuthService.verifyDevice(deviceToken);
    
    success(res, result, 'Device verified successfully');
  } catch (err) {
    logger.error('Verify Device Error:', err);
    error(res, err.message || 'Failed to verify device', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get registered devices - FIXED FUNCTION NAME
export const getDevices = async (req, res) => {
  try {
    const staffId = req.user.uid;
    
    const devices = await staffAuthService.listStaffDevices(staffId);
    
    success(res, { devices }, 'Devices retrieved successfully');
  } catch (err) {
    logger.error('List Devices Error:', err);
    error(res, err.message || 'Failed to list devices', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Check-in - NEW FUNCTION
export const checkIn = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { location } = req.body;
    
    const result = await staffAuthService.markAttendance(staffId, 'check-in', location, req);
    
    success(res, result, 'Check-in successful');
  } catch (err) {
    logger.error('Check-in Error:', err);
    error(res, err.message || 'Failed to check-in', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Check-out - NEW FUNCTION
export const checkOut = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { location } = req.body;
    
    const result = await staffAuthService.markAttendance(staffId, 'check-out', location, req);
    
    success(res, result, 'Check-out successful');
  } catch (err) {
    logger.error('Check-out Error:', err);
    error(res, err.message || 'Failed to check-out', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get today's attendance - NEW FUNCTION
export const getTodayAttendance = async (req, res) => {
  try {
    const staffId = req.user.uid;
    
    const attendance = await staffAuthService.getTodayAttendance(staffId);
    
    success(res, attendance, 'Today\'s attendance retrieved');
  } catch (err) {
    logger.error('Get Today Attendance Error:', err);
    error(res, err.message || 'Failed to get attendance', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get attendance history - NEW FUNCTION
export const getAttendanceHistory = async (req, res) => {
  try {
    const staffId = req.user.uid;
    const { startDate, endDate, page = 1, limit = 30 } = req.query;
    
    const history = await staffAuthService.getAttendanceHistory(staffId, {
      startDate,
      endDate,
      page: parseInt(page),
      limit: parseInt(limit)
    });
    
    success(res, history, 'Attendance history retrieved');
  } catch (err) {
    logger.error('Get Attendance History Error:', err);
    error(res, err.message || 'Failed to get attendance history', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};