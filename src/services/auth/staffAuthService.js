// src/services/auth/staffAuthService.js - Staff Authentication Service
// Handles employee authentication, device management, and attendance tracking

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AUTH_CONFIG } from '../../config/authConfig.js';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { generateToken, verifyToken } from '../../utils/jwtUtils.js';

const MAX_DEVICES_PER_STAFF = parseInt(process.env.MAX_DEVICES_PER_STAFF) || 5;
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || AUTH_CONFIG.rateLimit.loginAttempts;

// ✅ FIX: All methods are now correctly inside the class block.
export class StaffAuthService {
  // =================================================================
  // PRIMARY AUTHENTICATION METHODS
  // =================================================================

  static async authenticateStaff(employeeId, password, req) {
    try {
      // Check if account is locked
      const lockCheck = await db.query(`
        SELECT failure_reason, created_at 
        FROM auth_logs 
        WHERE phone = $1 
          AND success = false 
          AND action = 'STAFF_LOGIN'
          AND created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY created_at DESC
        LIMIT $2
      `, [employeeId, MAX_LOGIN_ATTEMPTS]);

      if (lockCheck.rows.length >= MAX_LOGIN_ATTEMPTS) {
        throw new Error('Account temporarily locked due to multiple failed attempts');
      }

      // Find staff member by employee ID
      const result = await db.query(`
        SELECT 
          u.id, u.uid, u.name, u.email, u.phone, u.role, u.encrypted_password,
          s.employee_id, s.department, s.position, s.is_active, s.shift_type
        FROM staff s
        JOIN users u ON s.user_id = u.id
        WHERE s.employee_id = $1
      `, [employeeId]);

      if (result.rows.length === 0) {
        await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', false, 'Invalid employee ID', 'password', req);
        throw new Error('Invalid employee ID or password');
      }

      const staff = result.rows[0];

      if (!staff.is_active) {
        await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', false, 'Account deactivated', 'password', req);
        throw new Error('Account deactivated');
      }

      const isPasswordValid = await bcrypt.compare(password, staff.encrypted_password);
      if (!isPasswordValid) {
        await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', false, 'Invalid password', 'password', req);
        throw new Error('Invalid employee ID or password');
      }

      await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', true, null, 'password', req);

      const accessToken = this.generateAccessToken(staff);
      const refreshToken = this.generateRefreshToken(staff);

      await db.query('UPDATE users SET last_sign_in_at = NOW() WHERE id = $1', [staff.id]);
      await this.logActivity(staff.uid, 'STAFF_LOGIN', 'Staff login successful', req);

      return {
        accessToken,
        refreshToken,
        staff: {
          id: staff.id,
          uid: staff.uid,
          employeeId: staff.employee_id,
          name: staff.name,
          email: staff.email,
          department: staff.department,
          role: staff.role,
          position: staff.position,
        },
      };
    } catch (error) {
      logger.error('Staff authentication error:', error);
      throw error;
    }
  }

  static async registerStaffDevice(employeeId, password, deviceInfo, req) {
    try {
      // ✅ FIX: Re-uses the result from authenticateStaff, avoiding extra DB calls.
      const authResult = await this.authenticateStaff(employeeId, password, req);
      const staff = authResult.staff;
      const userId = staff.id;

      // Check device limit
      const deviceCountResult = await db.query(
        'SELECT COUNT(*) FROM staff_devices WHERE staff_id = $1 AND is_active = true',
        [userId]
      );

      if (parseInt(deviceCountResult.rows[0].count) >= MAX_DEVICES_PER_STAFF) {
        throw new Error(`Maximum ${MAX_DEVICES_PER_STAFF} devices allowed`);
      }

      const deviceToken = this.generateDeviceToken();
      const deviceId = uuidv4();

      await db.query(`
        INSERT INTO staff_devices (
          staff_id, device_id, device_name, device_token,
          is_active, registered_at, registered_location, trust_expires_at
        ) VALUES ($1, $2, $3, $4, true, NOW(), $5, NOW() + INTERVAL '30 days')
      `, [
        userId,
        deviceId,
        deviceInfo.name || 'Unknown Device',
        deviceToken,
        JSON.stringify({
          type: deviceInfo.type || 'mobile',
          model: deviceInfo.model,
          os: deviceInfo.os,
          appVersion: deviceInfo.appVersion,
        }),
      ]);

      const sessionToken = this.generateRefreshToken(staff);
      await this.createSession(userId, deviceId, sessionToken, req);

      await this.logActivity(staff.uid, 'DEVICE_REGISTERED',
        `Device registered: ${deviceInfo.name || 'Unknown Device'}`, req, { deviceId });

      return {
        ...authResult,
        refreshToken: sessionToken,
        deviceToken,
        deviceId,
      };
    } catch (error) {
      logger.error('Device registration error:', error);
      throw error;
    }
  }

  static async quickLogin(deviceToken, pin, biometric, location, req) {
    try {
      const deviceResult = await db.query(`
        SELECT 
          d.id as internal_device_id, d.staff_id, d.device_id, d.pin_hash, d.biometric_enabled,
          u.uid, u.name, u.email, u.phone, u.role, u.encrypted_password,
          s.employee_id, s.department, s.position, s.is_active
        FROM staff_devices d
        JOIN users u ON d.staff_id = u.id
        JOIN staff s ON u.id = s.user_id
        WHERE d.device_token = $1 
          AND d.is_active = true
          AND (d.trust_expires_at IS NULL OR d.trust_expires_at > NOW())
      `, [deviceToken]);

      if (deviceResult.rows.length === 0) {
        throw new Error('Invalid or expired device token');
      }

      const deviceAndStaff = deviceResult.rows[0];

      if (!deviceAndStaff.is_active) {
        throw new Error('Account deactivated');
      }

      let authMethod = '';
      if (pin) {
        if (!deviceAndStaff.pin_hash) throw new Error('PIN not set for this device');
        const isPinValid = await bcrypt.compare(pin, deviceAndStaff.pin_hash);
        if (!isPinValid) {
          await this.logAuthAttempt(deviceAndStaff.employee_id, 'QUICK_LOGIN', false, 'Invalid PIN', 'pin', req);
          throw new Error('Invalid PIN');
        }
        authMethod = 'pin';
      } else if (biometric) {
        if (!deviceAndStaff.biometric_enabled) throw new Error('Biometric not enabled for this device');
        authMethod = 'biometric';
      } else {
        throw new Error('PIN or biometric required');
      }

      await this.logAuthAttempt(deviceAndStaff.employee_id, 'QUICK_LOGIN', true, null, authMethod, req);

      const accessToken = this.generateAccessToken(deviceAndStaff);
      const refreshToken = this.generateRefreshToken(deviceAndStaff);

      await this.createSession(deviceAndStaff.staff_id, deviceAndStaff.device_id, refreshToken, req);
      await db.query('UPDATE staff_devices SET last_used = NOW() WHERE id = $1', [deviceAndStaff.internal_device_id]);
      await this.logActivity(deviceAndStaff.uid, 'QUICK_LOGIN', `Quick login via ${authMethod}`, req, { deviceId: deviceAndStaff.device_id });

      return {
  accessToken,
  refreshToken,
  staff: {
    id: deviceAndStaff.staff_id,
    uid: deviceAndStaff.uid,
    employeeId: deviceAndStaff.employee_id,
    name: deviceAndStaff.name,
    email: deviceAndStaff.email,
    department: deviceAndStaff.department,
    role: deviceAndStaff.role,
    position: deviceAndStaff.position
  }
};
    } catch (error) {
      logger.error('Quick login error:', error);
      throw error;
    }
  }

  // =================================================================
  // DEVICE AND SESSION MANAGEMENT
  // =================================================================

  static async setupPin(staffUid, deviceToken, pin) {
    try {
      // ✅ FIX: Uses the new helper method to reduce duplication.
      const internalDeviceId = await this._verifyDeviceOwnership(staffUid, deviceToken);
      const pinHash = await bcrypt.hash(pin, 10);
      await db.query('UPDATE staff_devices SET pin_hash = $1 WHERE id = $2', [pinHash, internalDeviceId]);
      return { success: true, message: 'PIN setup successfully' };
    } catch (error) {
      logger.error('PIN setup error:', error);
      throw error;
    }
  }

  static async toggleBiometric(staffUid, deviceToken, enabled) {
    try {
      // ✅ FIX: Uses the new helper method to reduce duplication.
      const internalDeviceId = await this._verifyDeviceOwnership(staffUid, deviceToken);
      await db.query('UPDATE staff_devices SET biometric_enabled = $1 WHERE id = $2', [enabled, internalDeviceId]);
      return { success: true, biometricEnabled: enabled };
    } catch (error) {
      logger.error('Toggle biometric error:', error);
      throw error;
    }
  }

  static async refreshStaffSession(refreshToken) {
    try {
      const decoded = verifyToken(refreshToken);
      if (!decoded) throw new Error('Invalid or expired refresh token');

      const sessionResult = await db.query(`
        SELECT s.*, u.uid, u.name, u.email, u.role, st.employee_id, st.is_active
        FROM staff_auth_sessions s
        JOIN users u ON s.staff_id = u.id
        JOIN staff st ON u.id = st.user_id
        WHERE s.session_token = $1 AND s.expires_at > NOW()
      `, [refreshToken]);

      if (sessionResult.rows.length === 0) throw new Error('Invalid or expired session');
      const session = sessionResult.rows[0];
      if (!session.is_active) throw new Error('Account deactivated');

      await db.query('UPDATE staff_auth_sessions SET last_activity = NOW() WHERE id = $1', [session.id]);
      const accessToken = this.generateAccessToken(session);

      return {
        accessToken,
        staff: { /* ... staff details ... */ },
      };
    } catch (error) {
      logger.error('Session refresh error:', error);
      throw error;
    }
  }

// Add this new method right after the 'authenticateStaff' method

  static async authenticateStaffWithPin(employeeId, pin, req) {
    try {
      // Check if account is locked (same logic as password auth)
      const lockCheck = await db.query(`
        SELECT failure_reason FROM auth_logs 
        WHERE phone = $1 AND success = false AND action = 'STAFF_PIN_LOGIN'
        AND created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY created_at DESC LIMIT $2
      `, [employeeId, MAX_LOGIN_ATTEMPTS]);

      if (lockCheck.rows.length >= MAX_LOGIN_ATTEMPTS) {
        throw new Error('Account temporarily locked due to multiple failed attempts');
      }

      // Find staff member by employee ID
      const result = await db.query(`
        SELECT 
          u.id, u.uid, u.name, u.email, u.phone, u.role,
          s.employee_id, s.department, s.position, s.is_active,
          s.pin_hash -- Assumes a PIN hash is stored on the staff table
        FROM staff s
        JOIN users u ON s.user_id = u.id
        WHERE s.employee_id = $1
      `, [employeeId]);

      if (result.rows.length === 0) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'Invalid employee ID', 'pin', req);
        throw new Error('Invalid employee ID or PIN');
      }

      const staff = result.rows[0];

      if (!staff.is_active) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'Account deactivated', 'pin', req);
        throw new Error('Account deactivated');
      }

      // Check if PIN hash exists and is valid
      if (!staff.pin_hash) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'PIN not set', 'pin', req);
        throw new Error('PIN not set for this account.');
      }
      
      const isPinValid = await bcrypt.compare(pin, staff.pin_hash);
      if (!isPinValid) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'Invalid PIN', 'pin', req);
        throw new Error('Invalid employee ID or PIN');
      }

      await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', true, null, 'pin', req);

      const accessToken = this.generateAccessToken(staff);
      const refreshToken = this.generateRefreshToken(staff);

      await db.query('UPDATE users SET last_sign_in_at = NOW() WHERE id = $1', [staff.id]);
      await this.logActivity(staff.uid, 'STAFF_PIN_LOGIN', 'Staff login with PIN successful', req);

      return {
        accessToken,
        refreshToken,
        staff: {
          id: staff.id,
          uid: staff.uid,
          employeeId: staff.employee_id,
          name: staff.name,
          email: staff.email,
          department: staff.department,
          role: staff.role,
          position: staff.position,
        },
      };
    } catch (error) {
      logger.error('Staff PIN authentication error:', error);
      throw error;
    }
  }

  static async logoutStaff(staffUid, deviceToken, req) {
    try {
      const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [staffUid]);
      if (userResult.rows.length === 0) throw new Error('Staff not found');
      const userId = userResult.rows[0].id;

      if (deviceToken) {
        const deviceResult = await db.query('SELECT device_id FROM staff_devices WHERE device_token = $1 AND staff_id = $2', [deviceToken, userId]);
        if (deviceResult.rows.length > 0) {
          await db.query('DELETE FROM staff_auth_sessions WHERE staff_id = $1 AND device_id = $2', [userId, deviceResult.rows[0].device_id]);
        }
      } else {
        await db.query('DELETE FROM staff_auth_sessions WHERE staff_id = $1', [userId]);
      }

      await this.logActivity(staffUid, 'STAFF_LOGOUT', 'Logged out', req);
      return { success: true, message: 'Logged out successfully' };
    } catch (error) {
      logger.error('Logout error:', error);
      throw error;
    }
  }

  static async listStaffDevices(staffUid) {
    try {
      const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [staffUid]);
      if (userResult.rows.length === 0) throw new Error('Staff not found');
      const userId = userResult.rows[0].id;

      const devices = await db.query(`
        SELECT 
          device_id as id,
          device_name as "deviceName",
          registered_location->>'type' as "deviceType",
          registered_location->>'model' as "deviceModel",
          last_used as "lastActiveAt",
          biometric_enabled as "biometricEnabled",
          registered_at as "registeredAt"
        FROM staff_devices
        WHERE staff_id = $1 AND is_active = true
        ORDER BY last_used DESC NULLS LAST
      `, [userId]);
      return devices.rows;
    } catch (error) {
      logger.error('List devices error:', error);
      throw error;
    }
  }

  // =================================================================
  // ADMIN METHODS
  // =================================================================

  static async adminForceLogout(staffId, reason, adminUid, req) {
    try {
      await db.query('DELETE FROM staff_auth_sessions WHERE staff_id = $1', [staffId]);
      // ✅ FIX: Uses the logActivity helper for consistency.
      await this.logActivity(adminUid, 'ADMIN_FORCE_LOGOUT', `Force logout staff ${staffId}: ${reason}`, req, { affectedStaffId: staffId, reason });
      return { success: true, message: 'Staff member logged out from all devices' };
    } catch (error) {
      logger.error('Admin force logout error:', error);
      throw error;
    }
  }

  static async adminResetPin(staffId, adminUid, req) {
    try {
      const result = await db.query(
        'UPDATE staff_devices SET pin_hash = NULL WHERE staff_id = $1 AND is_active = true RETURNING id',
        [staffId]
      );
      // ✅ FIX: Uses the logActivity helper for consistency.
      await this.logActivity(adminUid, 'ADMIN_RESET_PIN', `Reset PIN for staff ${staffId}`, req, { affectedStaffId: staffId, devicesAffected: result.rows.length });
      return { success: true, message: 'PIN reset successfully', devicesAffected: result.rows.length };
    } catch (error) {
      logger.error('Admin reset PIN error:', error);
      throw error;
    }
  }

  // =================================================================
  // HELPER METHODS
  // =================================================================

  /**
   * ✅ FIX: New private helper to verify device ownership and reduce code duplication.
   */
  static async _verifyDeviceOwnership(staffUid, deviceToken) {
    const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [staffUid]);
    if (userResult.rows.length === 0) {
      throw new Error('Staff not found');
    }
    const userId = userResult.rows[0].id;

    const deviceResult = await db.query(
      'SELECT id FROM staff_devices WHERE device_token = $1 AND staff_id = $2 AND is_active = true',
      [deviceToken, userId]
    );

    if (deviceResult.rows.length === 0) {
      throw new Error('Device not found or unauthorized');
    }
    return deviceResult.rows[0].id; // Return the internal (auto-incrementing) device ID
  }

  static generateAccessToken(staff) {
    return generateToken({ uid: staff.uid, role: staff.role });
  }

  static generateRefreshToken(staff) {
    // Refresh tokens get a longer expiry (30 days)
    return generateToken({ uid: staff.uid, role: staff.role, type: 'refresh' }, '30d');
  }

  static generateDeviceToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  static async createSession(staffId, deviceId, sessionToken, req) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await db.query(`
      INSERT INTO staff_auth_sessions (
        staff_id, device_id, session_token, expires_at, ip_address, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
    `, [staffId, deviceId, sessionToken, expiresAt, req.ip || '']);
  }

  static async logAuthAttempt(phone, action, success, failureReason, authMethod, req) {
    try {
      await db.query(`
        INSERT INTO auth_logs (
          phone, action, success, failure_reason, auth_method, ip_address, user_agent, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [phone, action, success, failureReason, authMethod, req.ip || '', req.headers['user-agent']]);
    } catch (error) {
      logger.error('Failed to log auth attempt:', error);
    }
  }

  static async logActivity(uid, action, description, req, details = {}) {
    try {
      await db.query(`
        INSERT INTO admin_activity_logs (
          admin_uid, action, description, details, ip_address, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
      `, [uid, action, description, JSON.stringify(details), req.ip || '']);
    } catch (error) {
      logger.error('Failed to log activity:', error);
    }
  }
}