// src/services/auth/firebaseAuthService.js - Firebase Authentication Service

import { AUTH_ACTIONS } from '../../config/authConfig.js';
import db from '../../config/database.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { OTPService } from '../otpService.js';
import admin from '../../utils/firebaseAdmin.js';
import { generateToken } from '../../utils/jwtUtils.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

// Authenticate with Firebase ID token
export const authenticateWithFirebase = async (idToken, deviceInfo, req) => {
  // Verify Firebase ID token
  const decodedToken = await admin.auth().verifyIdToken(idToken);
  
  const firebasePhone = decodedToken.phone_number;
  if (!firebasePhone) {
    const error = new Error('Phone number not found in Firebase token');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  
  const phone = normalizePhone(firebasePhone);
  const firebaseUid = decodedToken.uid;
  
  // Check if user exists in our database
  const userResult = await db.query(
    'SELECT id, uid, name, phone, email, role, firebase_uid, gender, email_verified, is_active, last_login FROM users WHERE phone = $1 OR firebase_uid = $2',
    [phone, firebaseUid]
  );
  
  let user;
  let isNewUser = false;
  
  if (userResult.rows.length === 0) {
    // Create new user
    const insertResult = await db.query(
      `INSERT INTO users (
        phone, firebase_uid, role, registered_at, last_login,
        name, email, email_verified
      ) VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6) 
      RETURNING id, uid, name, phone, email, role, firebase_uid, gender, email_verified, is_active, last_login`,
      [
        phone,
        firebaseUid,
        'PATIENT', // Default role
        decodedToken.name || null,
        decodedToken.email || null,
        decodedToken.email_verified || false
      ]
    );
    user = insertResult.rows[0];
    isNewUser = true;
    logger.info(`🔥 New Firebase user created: ${phone} (${firebaseUid})`);
  } else {
    user = userResult.rows[0];
    
    // Update Firebase UID if missing
    if (!user.firebase_uid) {
      await db.query(
        'UPDATE users SET firebase_uid = $1, last_login = NOW() WHERE uid = $2',
        [firebaseUid, user.uid]
      );
    } else {
      await db.query(
        'UPDATE users SET last_login = NOW() WHERE uid = $1',
        [user.uid]
      );
    }
    
    logger.info(`🔥 Existing Firebase user logged in: ${phone}`);
  }
  
  // Generate our JWT token
  const accessToken = generateToken({
    uid: user.uid,
    id: user.id,
    phone: user.phone,
    role: user.role,
    firebaseUid: firebaseUid
  });
  
  // Store device info if provided
  if (deviceInfo) {
    await storeDeviceInfo(user.uid, deviceInfo);
  }
  
  // Log authentication
  await logFirebaseAuth(phone, isNewUser ? AUTH_ACTIONS.FIREBASE_REGISTER : AUTH_ACTIONS.FIREBASE_LOGIN, true, null, req);
  
  return {
    accessToken,
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      role: user.role,
      profileComplete: !!(user.name && user.gender),
      emailVerified: user.email_verified,
      isNewUser
    }
  };
};

// Complete user profile
export const completeUserProfile = async (profileData) => {
  const { phone, name, gender, email, birthday, anniversary, address, emergency_contact } = profileData;
  const normalizedPhone = normalizePhone(phone);
  
  // Update user profile
  const result = await db.query(
    `UPDATE users SET 
      name = $1, gender = $2, email = $3, birthday = $4,
      anniversary = $5, address = $6, emergency_contact = $7,
      profile_completed_at = NOW()
    WHERE phone = $8
    RETURNING id, uid, name, phone, email, role, gender, is_active`,
    [
      name, gender, email, birthday,
      anniversary, address, emergency_contact,
      normalizedPhone
    ]
  );
  
  if (result.rows.length === 0) {
    const error = new Error('User not found');
    error.statusCode = HTTP_STATUS.NOT_FOUND;
    throw error;
  }
  
  const user = result.rows[0];
  
  logger.info(`👤 Profile completed for user: ${normalizedPhone}`);
  
  return {
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      gender: user.gender,
      email: user.email,
      role: user.role,
      profileComplete: true
    }
  };
};

// Link Firebase account to existing user
export const linkFirebaseAccount = async (phone, idToken, otp) => {
  if (!idToken || !otp) {
    const error = new Error('Firebase ID token and OTP are required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  
  // Verify Firebase ID token
  const decodedToken = await admin.auth().verifyIdToken(idToken);
  const firebaseUid = decodedToken.uid;
  const normalizedPhone = normalizePhone(phone);
  
  // Verify OTP using the OTP service
  const otpResult = await OTPService.verifyOTP(normalizedPhone, otp, 'account_linking');
  if (!otpResult.valid) {
    const error = new Error(otpResult.message || 'Invalid or expired OTP');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  
  // Check if user exists
  const userResult = await db.query(
    'SELECT id, uid, name, phone, email, role, firebase_uid, is_active FROM users WHERE phone = $1',
    [normalizedPhone]
  );
  
  if (userResult.rows.length === 0) {
    const error = new Error('User not found');
    error.statusCode = HTTP_STATUS.NOT_FOUND;
    throw error;
  }
  
  const user = userResult.rows[0];
  
  // Link Firebase UID to existing user
  await db.query(
    'UPDATE users SET firebase_uid = $1 WHERE uid = $2',
    [firebaseUid, user.uid]
  );
  
  // Generate new token with Firebase UID
  const accessToken = generateToken({
    uid: user.uid,
    id: user.id,
    phone: user.phone,
    role: user.role,
    firebaseUid: firebaseUid
  });
  
  logger.info(`🔗 Firebase account linked to existing user: ${normalizedPhone}`);
  
  return {
    accessToken,
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      linkedToFirebase: true
    }
  };
};

// Update FCM token
export const updateFcmToken = async (phone, fcmToken, deviceId) => {
  if (!phone || !fcmToken) {
    const error = new Error('Phone and FCM token are required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  
  const normalizedPhone = normalizePhone(phone);
  
  // Update or insert FCM token
  await db.query(
    `INSERT INTO user_devices (user_uid, device_id, fcm_token, last_active, created_at)
     SELECT uid, $2, $3, NOW(), NOW() FROM users WHERE phone = $1
     ON CONFLICT (user_uid, device_id)
     DO UPDATE SET fcm_token = EXCLUDED.fcm_token, last_active = NOW()`,
    [normalizedPhone, deviceId || 'default', fcmToken]
  );
  
  logger.info(`📱 FCM token updated for user: ${normalizedPhone}`);
  
  return {
    phone: normalizedPhone,
    fcmToken: fcmToken.substring(0, 10) + '...[REDACTED]',
    deviceId
  };
};

// Revoke Firebase session
export const revokeFirebaseSession = async (firebaseUid) => {
  if (!firebaseUid) {
    const error = new Error('Firebase UID is required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  
  // Revoke Firebase tokens
  await admin.auth().revokeRefreshTokens(firebaseUid);
  
  // Log the revocation
  await db.query(
    `UPDATE users SET firebase_tokens_revoked_at = NOW() 
     WHERE firebase_uid = $1`,
    [firebaseUid]
  );
  
  logger.info(`🔐 Firebase session revoked for UID: ${firebaseUid}`);
  
  return {
    firebaseUid,
    revokedAt: new Date().toISOString()
  };
};

// Verify token status
export const verifyTokenStatus = async (idToken) => {
  const decodedToken = await admin.auth().verifyIdToken(idToken, true);
  
  // Check if user exists in our system
  const userResult = await db.query(
    'SELECT uid, phone, name, role FROM users WHERE firebase_uid = $1',
    [decodedToken.uid]
  );
  
  const userExists = userResult.rows.length > 0;
  
  return {
    valid: true,
    userExists,
    tokenInfo: {
      uid: decodedToken.uid,
      phone: decodedToken.phone_number,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
      issuedAt: new Date(decodedToken.iat * 1000),
      expiresAt: new Date(decodedToken.exp * 1000)
    },
    user: userExists ? userResult.rows[0] : null
  };
};

// Get health status
export const getHealthStatus = async () => {
  // Test Firebase Admin connection
  await admin.auth().listUsers(1);
  
  // Get Firebase auth statistics
  const stats = await db.query(`
    SELECT 
      COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL) as firebase_users,
      COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND last_login > NOW() - INTERVAL '24 hours') as active_firebase_users_24h,
      COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND profile_completed_at IS NOT NULL) as completed_profiles,
      COUNT(*) as total_users
    FROM users
  `);
  
  const deviceStats = await db.query(`
    SELECT 
      platform,
      COUNT(*) as device_count,
      COUNT(*) FILTER (WHERE last_active > NOW() - INTERVAL '24 hours') as active_24h
    FROM user_devices
    GROUP BY platform
  `);
  
  return {
    status: 'healthy',
    firebaseConnection: 'connected',
    statistics: stats.rows[0],
    deviceStatistics: deviceStats.rows,
    timestamp: new Date().toISOString()
  };
};

// Store device information
const storeDeviceInfo = async (userUid, deviceInfo) => {
  try {
    await db.query(
      `INSERT INTO user_devices (
        user_uid, device_id, device_name, platform, app_version, 
        fcm_token, last_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (user_uid, device_id) 
      DO UPDATE SET 
        device_name = EXCLUDED.device_name,
        platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        fcm_token = EXCLUDED.fcm_token,
        last_active = NOW()`,
      [
        userUid,
        deviceInfo.deviceId,
        deviceInfo.deviceName,
        deviceInfo.platform,
        deviceInfo.appVersion,
        deviceInfo.fcmToken
      ]
    );
  } catch (deviceErr) {
    logger.warn('Failed to store device info:', deviceErr.message);
  }
};

// Log Firebase authentication
const logFirebaseAuth = async (phone, action, success, failureReason, req) => {
  try {
    await db.query(
      `INSERT INTO auth_logs (
        phone, action, success, auth_method, ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        phone,
        action,
        success,
        'firebase',
        req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
        req.headers['user-agent']
      ]
    );
  } catch (logErr) {
    logger.warn('Failed to log authentication:', logErr.message);
  }
};

// Legacy register user (for backward compatibility)
export const legacyRegisterUser = async (userData) => {
  const { phone, name, gender, email, birthday, anniversary, address } = userData;
  const normalizedPhone = normalizePhone(phone);
  
  // Check if user already exists
  const existingUser = await db.query('SELECT id, uid, phone FROM users WHERE phone = $1', [normalizedPhone]);
  
  if (existingUser.rows.length > 0) {
    const error = new Error('User already exists');
    error.statusCode = HTTP_STATUS.CONFLICT;
    throw error;
  }
  
  // Create new user
  const insertResult = await db.query(
    `INSERT INTO users (
      phone, name, gender, email, birthday, anniversary, address,
      role, registered_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    RETURNING id, uid, name, phone, email, role, is_active`,
    [
      normalizedPhone, name, gender, email, birthday, 
      anniversary, address, 'PATIENT'
    ]
  );
  
  const user = insertResult.rows[0];
  
  // Generate token
  const token = generateToken({
    uid: user.uid,
    phone: user.phone,
    role: user.role,
    id: user.id
  });
  
  return {
    token,
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role
    }
  };
};