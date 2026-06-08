// src/controllers/auth/firebaseAuthController.js - Firebase Authentication Controller

import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as firebaseAuthService from '../../services/auth/firebaseAuthService.js';
import { success, error } from '../../utils/responseHelper.js';

// Firebase ID Token Authentication
export const firebaseLogin = async (req, res) => {
  try {
    const { idToken, deviceInfo, deviceType } = req.body;

    const result = await firebaseAuthService.authenticateWithFirebase(idToken, deviceInfo, req, { deviceType });
    
    success(res, result, result.isNewUser ? 'User registered successfully' : 'Login successful');
  } catch (err) {
    logger.error('Firebase Login Error:', err);
    
    if (err.code === 'auth/id-token-expired') {
      return error(res, 'Firebase token has expired', HTTP_STATUS.UNAUTHORIZED);
    }
    
    if (err.code === 'auth/id-token-revoked') {
      return error(res, 'Firebase token has been revoked', HTTP_STATUS.UNAUTHORIZED);
    }

    if (err.statusCode) {
      return error(res, err.message || 'Firebase authentication failed', err.statusCode);
    }
    
    error(res, 'Invalid Firebase ID token', HTTP_STATUS.UNAUTHORIZED);
  }
};

// Complete user profile after Firebase auth
export const completeProfile = async (req, res) => {
  try {
    const profileData = req.body;
    
    const result = await firebaseAuthService.completeUserProfile(profileData);
    
    success(res, result, 'Profile completed successfully');
  } catch (err) {
    logger.error('Profile Completion Error:', err);
    error(res, 'Failed to complete profile', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Link Firebase account to existing user
export const linkAccount = async (req, res) => {
  try {
    const { phone, idToken, otp, deviceType } = req.body;

    const result = await firebaseAuthService.linkFirebaseAccount(phone, idToken, otp, req, { deviceType });

    success(res, result, 'Account linked successfully');
  } catch (err) {
    logger.error('Account Linking Error:', err);
    error(res, 'Failed to link account', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update FCM token for push notifications
export const updateFcmToken = async (req, res) => {
  try {
    const { phone, fcmToken, deviceId } = req.body;
    
    const result = await firebaseAuthService.updateFcmToken(phone, fcmToken, deviceId);
    
    success(res, result, 'FCM token updated successfully');
  } catch (err) {
    logger.error('FCM Token Update Error:', err);
    error(res, 'Failed to update FCM token', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Revoke Firebase session
export const revokeSession = async (req, res) => {
  try {
    const { firebaseUid } = req.body;
    
    const result = await firebaseAuthService.revokeFirebaseSession(firebaseUid);
    
    success(res, result, 'Firebase session revoked successfully');
  } catch (err) {
    logger.error('Session Revocation Error:', err);
    error(res, 'Failed to revoke session', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Verify token status
export const verifyToken = async (req, res) => {
  try {
    const { idToken } = req.query;
    
    if (!idToken) {
      return error(res, 'Firebase ID token is required', HTTP_STATUS.BAD_REQUEST);
    }
    
    const result = await firebaseAuthService.verifyTokenStatus(idToken);
    
    success(res, result, 'Token verified successfully');
  } catch (err) {
    logger.error('Token Verification Error:', err);
    
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      valid: false,
      message: 'Invalid or expired Firebase token'
    });
  }
};

// Get Firebase auth health status
export const getHealthStatus = async (req, res) => {
  try {
    const healthData = await firebaseAuthService.getHealthStatus();
    success(res, healthData, 'Firebase authentication service healthy');
  } catch (err) {
    logger.error('Firebase Health Check Error:', err);
    
    // Fallback response
    success(res, {
      status: 'degraded',
      firebaseConnection: 'unavailable',
      statistics: {
        firebase_users: 0,
        active_firebase_users_24h: 0,
        completed_profiles: 0,
        total_users: 0
      },
      deviceStatistics: [],
      note: 'Firebase connection failed or database tables may not exist',
      timestamp: new Date().toISOString()
    }, 'Firebase service status retrieved (degraded)');
  }
};

// Test route
export const testRoute = async (req, res) => {
  success(res, { 
    message: 'Firebase auth routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  }, 'Firebase auth routes operational');
};

// Legacy register user (maintained for backward compatibility)
export const registerUser = async (req, res) => {
  try {
    const { deviceType, ...userData } = req.body;
    const result = await firebaseAuthService.legacyRegisterUser(userData, req, { deviceType });
    success(res, result, 'User registered successfully');
  } catch (err) {
    logger.error('Legacy Register Error:', err);
    error(res, 'Registration failed', err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
