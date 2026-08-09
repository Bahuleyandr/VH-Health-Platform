// src/services/auth/staffAuthService.js - Staff Authentication Service
// Handles employee authentication, device management, and attendance tracking

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { AUTH_CONFIG } from '../../config/authConfig.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { generateToken, verifyToken } from '../../utils/jwtUtils.js';
import { trackFailedLogin } from '../../utils/loginAnomalyDetector.js';
import { logSecurityEvent } from '../../utils/securityAuditLogger.js';
import { blacklistToken, isTokenBlacklisted, revokeAllUserTokens } from '../../utils/tokenBlacklist.js';
import { issueAccessTokenAndClaimSession } from './loginSessionHelper.js';
import { getUserSessionDeviceType } from './userActiveSession.js';


// Thin wrapper around prisma raw that returns the `pg`-style shape
// `{ rows, rowCount }`. Most of this file reads `result.rows[0]` / `rows[i]`;
// a couple of historical sites treat the result as a plain array instead —
// those are updated below to use `.rows`.
const query = async (sql, params = [], client = prisma) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    const rows = await client.$queryRawUnsafe(normalizedSql, ...params);
    return { rows: Array.isArray(rows) ? rows : [], rowCount: Array.isArray(rows) ? rows.length : 0 };
  }

  const rowCount = await client.$executeRawUnsafe(normalizedSql, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
};

const attendanceRecordedAtSql = 'COALESCE(sa.check_in_time, sa.timestamp)';
const attendanceLocalRecordedAtSql =
  `(((${attendanceRecordedAtSql}) AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone'))`;
const attendanceLocalCheckInSql =
  "((sa.check_in_time AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone'))";
const attendanceLocalCheckOutSql =
  "((sa.check_out_time AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone'))";
const attendanceLocalIsoSql = (expression) =>
  `to_char(${expression}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
const localDayStartUtcSql = (dateExpression) =>
  `(((${dateExpression})::timestamp AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC')`;

const SCIM_MANAGED_SOURCES = new Set(['scim', 'hybrid']);

const MAX_DEVICES_PER_STAFF = parseInt(process.env.MAX_DEVICES_PER_STAFF) || 5;
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || AUTH_CONFIG.rateLimit.loginAttempts;
const INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function installationId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!INSTALLATION_ID_PATTERN.test(normalized)) {
    const error = new Error('A valid installation ID is required');
    error.statusCode = 400;
    error.code = 'STAFF_INSTALLATION_ID_INVALID';
    throw error;
  }
  return normalized;
}

// ✅ FIX: All methods are now correctly inside the class block.
export class StaffAuthService {
  static async bindStaffInstallation(staff, rawInstallationId, deviceInfo = {}) {
    const stableDeviceId = installationId(rawInstallationId);
    if (!staff?.uid || !staff?.tenant_id) {
      throw new Error('Staff installation binding requires tenant and user identity');
    }

    await setTenant(staff.tenant_id, tx => query(
      `INSERT INTO user_devices (
         tenant_id, user_uid, device_id, device_name, platform,
         app_version, os_version, last_active, created_at,
         updated_at, device_type
       )
       VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
         NOW(), NOW(), NOW(), 'staff'
       )
       ON CONFLICT (tenant_id, user_uid, device_id)
       DO UPDATE SET
         device_name = COALESCE(EXCLUDED.device_name, user_devices.device_name),
         platform = COALESCE(EXCLUDED.platform, user_devices.platform),
         app_version = COALESCE(EXCLUDED.app_version, user_devices.app_version),
         os_version = COALESCE(EXCLUDED.os_version, user_devices.os_version),
         last_active = NOW(),
         updated_at = NOW(),
         device_type = 'staff'`,
      [
        staff.tenant_id,
        staff.uid,
        stableDeviceId,
        deviceInfo.name || deviceInfo.deviceName || null,
        deviceInfo.platform || null,
        deviceInfo.appVersion || null,
        deviceInfo.os || deviceInfo.osVersion || null,
      ],
      tx,
    ));

    return stableDeviceId;
  }
  // =================================================================
  // SHARED LOCKOUT CHECK
  // =================================================================

  /**
   * Check if a staff account is locked due to failed login attempts.
   * Shared across password, PIN, and quick login flows.
   * @param {string} employeeId - Employee ID to check
   * @param {Object} [req] - Express request (for security logging)
   * @param {string} [path] - Request path (for security logging)
   */
  static async _checkStaffLockout(employeeId, req, path = '/api/v1/auth/staff/login') {
    const lockCheck = await query(`
      SELECT COUNT(*) as cnt FROM auth_logs
      WHERE phone = $1 AND success = false
        AND action IN ('STAFF_LOGIN', 'STAFF_PIN_LOGIN', 'QUICK_LOGIN')
        AND created_at > NOW() - INTERVAL '15 minutes'
    `, [employeeId]);

    if (parseInt(lockCheck.rows[0].cnt) >= MAX_LOGIN_ATTEMPTS) {
      logSecurityEvent('ACCOUNT_LOCKED', {
        userName: employeeId,
        ip: req?.ip,
        userAgent: req?.headers?.['user-agent'],
        path,
        reason: `Staff lockout: ${MAX_LOGIN_ATTEMPTS} failed attempts across all auth methods in 15 minutes`,
      });
      trackFailedLogin(req?.ip, employeeId);
      throw new Error('Account temporarily locked due to multiple failed attempts');
    }
  }

  /**
   * PIN-login lockout (audit finding M5). Two tiers:
   *   - Per-vantage: ≥ MAX_LOGIN_ATTEMPTS failed PIN attempts in 15 min from
   *     the SAME ip or device token ⇒ lock that vantage point. A remote
   *     attacker cannot lock the clinician's own registered device.
   *   - Account-wide backstop: ≥ 10×MAX failed PIN attempts from anywhere
   *     ⇒ lock the account and alert (distributed guessing).
   */
  static async _checkStaffPinLockout(employeeId, req, deviceToken = null) {
    const vantageCheck = await query(`
      SELECT COUNT(*) as cnt FROM auth_logs
      WHERE phone = $1 AND success = false
        AND action = 'STAFF_PIN_LOGIN'
        AND created_at > NOW() - INTERVAL '15 minutes'
        AND (ip_address = $2 OR ($3::text IS NOT NULL AND device_info = $3::text))
    `, [employeeId, req?.ip || '', deviceToken ? String(deviceToken) : null]);

    if (parseInt(vantageCheck.rows[0].cnt) >= MAX_LOGIN_ATTEMPTS) {
      logSecurityEvent('ACCOUNT_LOCKED', {
        userName: employeeId,
        ip: req?.ip,
        userAgent: req?.headers?.['user-agent'],
        path: '/api/v1/auth/staff/login-pin',
        reason: `PIN lockout: ${MAX_LOGIN_ATTEMPTS} failed PIN attempts from this device/IP in 15 minutes`,
      });
      trackFailedLogin(req?.ip, employeeId);
      throw new Error('Too many failed PIN attempts from this device. Try again later or use password login.');
    }

    const globalCheck = await query(`
      SELECT COUNT(*) as cnt FROM auth_logs
      WHERE phone = $1 AND success = false
        AND action = 'STAFF_PIN_LOGIN'
        AND created_at > NOW() - INTERVAL '15 minutes'
    `, [employeeId]);

    if (parseInt(globalCheck.rows[0].cnt) >= MAX_LOGIN_ATTEMPTS * 10) {
      logSecurityEvent('ACCOUNT_LOCKED', {
        userName: employeeId,
        ip: req?.ip,
        userAgent: req?.headers?.['user-agent'],
        path: '/api/v1/auth/staff/login-pin',
        reason: 'PIN lockout backstop: distributed failed-PIN attempts across many sources',
      });
      trackFailedLogin(req?.ip, employeeId);
      throw new Error('Account temporarily locked due to multiple failed attempts');
    }
  }

  // =================================================================
  // PRIMARY AUTHENTICATION METHODS
  // =================================================================

  static async authenticateStaff(
    employeeId,
    password,
    req,
    { deviceType, installationId: rawInstallationId } = {},
  ) {
    try {
      await this._checkStaffLockout(employeeId, req, '/api/v1/auth/staff/login');

      // Find staff member by employee ID
      const result = await query(`
        SELECT
          u.id, u.uid, u.tenant_id, u.name, u.email, u.phone, u.role,
          u.encrypted_password,
          s.employee_id, s.department, s.position, s.is_active, s.shift_type
        FROM staff s
        JOIN users u ON s.user_id = u.uid
        WHERE s.employee_id = $1
      `, [employeeId]);

      if (result.rows.length === 0) {
        await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', false, 'Invalid employee ID', 'password', req);
        logSecurityEvent('LOGIN_FAILED', {
          userName: employeeId,
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          path: '/api/v1/auth/staff/login',
          reason: 'Invalid employee ID',
        });
        throw new Error('Invalid employee ID or password');
      }

      const staff = result.rows[0];

      if (!staff.is_active) {
        await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', false, 'Account deactivated', 'password', req);
        logSecurityEvent('LOGIN_FAILED', {
          userId: String(staff.uid),
          userName: employeeId,
          userRole: staff.role,
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          path: '/api/v1/auth/staff/login',
          reason: 'Account deactivated',
        });
        throw new Error('Account deactivated');
      }

      const isPasswordValid = await bcrypt.compare(password, staff.encrypted_password);
      if (!isPasswordValid) {
        await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', false, 'Invalid password', 'password', req);
        logSecurityEvent('LOGIN_FAILED', {
          userId: String(staff.uid),
          userName: employeeId,
          userRole: staff.role,
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          path: '/api/v1/auth/staff/login',
          reason: 'Invalid password',
        });
        throw new Error('Invalid employee ID or password');
      }

      await this.logAuthAttempt(employeeId, 'STAFF_LOGIN', true, null, 'password', req);
      const stableDeviceId = await this.bindStaffInstallation(
        staff,
        rawInstallationId,
        { platform: deviceType },
      );

      const { accessToken } = await issueAccessTokenAndClaimSession({
        userUid: staff.uid,
        tokenPayload: { id: staff.id, uid: staff.uid, role: staff.role },
        expiresIn: SECURITY_CONFIG.jwt.staffAccessExpiry,
        deviceType,
        stableDeviceId,
        req,
      });
      const refreshToken = this.generateRefreshToken(staff, stableDeviceId);

      await query('UPDATE users SET last_sign_in_at = NOW() WHERE id = $1', [staff.id]);
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
          tenantId: staff.tenant_id,
          stableDeviceId,
        },
      };
    } catch (error) {
      logger.error('Staff authentication error:', error);
      throw error;
    }
  }

  static async updateOwnProfile(staffUid, updates, req) {
    const forbiddenFields = [
      'phone',
      'phoneNumber',
      'phone_number',
      'role',
      'roles',
      'employeeId',
      'employee_id',
      'department',
      'position',
      'salary',
    ];

    const touchedForbidden = forbiddenFields.filter((field) => Object.prototype.hasOwnProperty.call(updates || {}, field));
    if (touchedForbidden.length > 0) {
      const err = new Error('Phone number, role, and employment fields are managed by HR/Admin');
      err.statusCode = 403;
      throw err;
    }

    const unsupportedFields = Object.keys(updates || {}).filter((field) => field !== 'name');
    if (unsupportedFields.length > 0) {
      const err = new Error('Only name can be updated from staff self-service profile');
      err.statusCode = 400;
      throw err;
    }

    const name = String(updates?.name || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 120) {
      const err = new Error('Name must be between 2 and 120 characters');
      err.statusCode = 400;
      throw err;
    }

    const identity = await query(`
      SELECT identity_source
      FROM users
      WHERE uid = $1::uuid
      LIMIT 1
    `, [staffUid]);
    if (identity.rowCount > 0 && SCIM_MANAGED_SOURCES.has(String(identity.rows[0].identity_source || 'local').toLowerCase())) {
      const err = new Error('Name is managed by SCIM provisioning for this staff identity');
      err.statusCode = 403;
      err.code = 'SCIM_OWNED_FIELD';
      throw err;
    }

    const result = await query(`
      UPDATE users
      SET name = $2, updated_at = NOW()
      WHERE uid = $1::uuid
      RETURNING id, uid, name, email, phone, role
    `, [staffUid, name]);

    if (result.rowCount === 0) {
      const err = new Error('Staff not found');
      err.statusCode = 404;
      throw err;
    }

    await this.logActivity(staffUid, 'STAFF_SELF_PROFILE_UPDATE', 'Staff updated own display name', req, {
      fields: ['name'],
    });

    return { profile: result.rows[0] };
  }

  static async changeOwnPassword(staffUid, currentPassword, newPassword, req) {
    if (!currentPassword || !newPassword) {
      const err = new Error('Current password and new password are required');
      err.statusCode = 400;
      throw err;
    }

    if (currentPassword === newPassword) {
      const err = new Error('New password must be different from current password');
      err.statusCode = 400;
      throw err;
    }

    const result = await query(`
      SELECT id, uid, role, encrypted_password
      FROM users
      WHERE uid = $1::uuid
      LIMIT 1
    `, [staffUid]);

    if (result.rowCount === 0) {
      const err = new Error('Staff not found');
      err.statusCode = 404;
      throw err;
    }

    const staff = result.rows[0];
    const ok = await bcrypt.compare(currentPassword, staff.encrypted_password || '');
    if (!ok) {
      const err = new Error('Current password is incorrect');
      err.statusCode = 401;
      throw err;
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await query(`
      UPDATE users
      SET encrypted_password = $2, password_changed_at = NOW(), updated_at = NOW()
      WHERE uid = $1::uuid
    `, [staffUid, newHash]);

    await this.logActivity(staffUid, 'STAFF_PASSWORD_CHANGED', 'Staff changed own password', req, {
      deviceType: req?.user?.deviceType || null,
    });

    return { success: true };
  }

  static async registerStaffDevice(
    employeeId,
    password,
    deviceInfo,
    req,
    { deviceType, installationId: rawInstallationId } = {},
  ) {
    try {
      // Re-uses the result from authenticateStaff, avoiding extra DB calls.
      // The inner call already claims the single active session.
      const authResult = await this.authenticateStaff(employeeId, password, req, {
        deviceType,
        installationId: rawInstallationId,
      });
      const staff = authResult.staff;
      const userId = staff.id;
      const stableDeviceId = installationId(rawInstallationId);

      // Check device limit
      const deviceCountResult = await query(
        `SELECT COUNT(*)
           FROM staff_devices
          WHERE tenant_id = $1::uuid
            AND staff_id = $2
            AND is_active = true`,
        [staff.tenantId, userId]
      );

      if (parseInt(deviceCountResult.rows[0].count) >= MAX_DEVICES_PER_STAFF) {
        throw new Error(`Maximum ${MAX_DEVICES_PER_STAFF} devices allowed`);
      }

      const deviceToken = this.generateDeviceToken();
      const deviceId = stableDeviceId;

      await query(`
        INSERT INTO staff_devices (
          tenant_id, staff_id, user_uid, device_id, device_name, device_token,
          is_active, registered_at, registered_location, trust_expires_at
        ) VALUES (
          $1::uuid, $2, $3::uuid, $4, $5, $6,
          true, NOW(), $7, NOW() + INTERVAL '30 days'
        )
        ON CONFLICT (tenant_id, user_uid, device_id)
        DO UPDATE SET
          device_name = EXCLUDED.device_name,
          device_token = EXCLUDED.device_token,
          is_active = true,
          registered_at = NOW(),
          registered_location = EXCLUDED.registered_location,
          trust_expires_at = EXCLUDED.trust_expires_at
      `, [
        staff.tenantId,
        userId,
        staff.uid,
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

      const sessionToken = this.generateRefreshToken(staff, stableDeviceId);
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

  static async quickLogin(
    deviceToken,
    pin,
    biometric,
    location,
    req,
    { deviceType, installationId: rawInstallationId } = {},
  ) {
    try {
      const stableDeviceId = installationId(rawInstallationId);
      const deviceResult = await query(`
        SELECT 
          d.id as internal_device_id, d.staff_id, d.device_id, d.pin_hash, d.biometric_enabled,
          u.uid, u.tenant_id, u.name, u.email, u.phone, u.role, u.encrypted_password,
          s.employee_id, s.department, s.position, s.is_active
        FROM staff_devices d
        JOIN users u ON d.staff_id = u.id
        JOIN staff s ON u.uid = s.user_id
        WHERE d.device_token = $1
          AND d.device_id = $2
          AND d.is_active = true
          AND (
            (d.trust_expires_at IS NOT NULL AND d.trust_expires_at > NOW())
            OR (d.trust_expires_at IS NULL AND d.created_at > NOW() - INTERVAL '90 days')
          )
      `, [deviceToken, stableDeviceId]);

      if (deviceResult.rows.length === 0) {
        throw new Error('Invalid or expired device token');
      }

      const deviceAndStaff = deviceResult.rows[0];
      await this.bindStaffInstallation(deviceAndStaff, stableDeviceId, {
        platform: deviceType,
      });

      // Check lockout across all auth methods for this employee
      await this._checkStaffLockout(deviceAndStaff.employee_id, req, '/api/v1/auth/staff/quick-login');

      if (!deviceAndStaff.is_active) {
        throw new Error('Account deactivated');
      }

      let authMethod = '';
      if (pin) {
        if (!deviceAndStaff.pin_hash) throw new Error('PIN not set for this device');
        const isPinValid = await bcrypt.compare(pin, deviceAndStaff.pin_hash);
        if (!isPinValid) {
          await this.logAuthAttempt(deviceAndStaff.employee_id, 'QUICK_LOGIN', false, 'Invalid PIN', 'pin', req);
          logSecurityEvent('LOGIN_FAILED', {
            userId: String(deviceAndStaff.uid),
            userName: deviceAndStaff.employee_id,
            userRole: deviceAndStaff.role,
            ip: req?.ip,
            userAgent: req?.headers?.['user-agent'],
            path: '/api/v1/auth/staff/quick-login',
            reason: 'Invalid PIN (quick login)',
          });
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

      const { accessToken } = await issueAccessTokenAndClaimSession({
        userUid: deviceAndStaff.uid,
        tokenPayload: {
          id: deviceAndStaff.staff_id,
          uid: deviceAndStaff.uid,
          role: deviceAndStaff.role,
        },
        expiresIn: SECURITY_CONFIG.jwt.staffAccessExpiry,
        deviceType,
        stableDeviceId,
        req,
      });
      const refreshToken = this.generateRefreshToken(deviceAndStaff, stableDeviceId);

      await this.createSession(deviceAndStaff.staff_id, deviceAndStaff.device_id, refreshToken, req);
      await query('UPDATE staff_devices SET last_used = NOW() WHERE id = $1', [deviceAndStaff.internal_device_id]);
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
  },
  stableDeviceId,
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
      await query('UPDATE staff_devices SET pin_hash = $1 WHERE id = $2', [pinHash, internalDeviceId]);
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
      await query('UPDATE staff_devices SET biometric_enabled = $1 WHERE id = $2', [enabled, internalDeviceId]);
      return { success: true, biometricEnabled: enabled };
    } catch (error) {
      logger.error('Toggle biometric error:', error);
      throw error;
    }
  }

  static async refreshStaffSession(
    refreshToken,
    _deviceToken,
    rawInstallationId,
    req,
  ) {
    try {
      const stableDeviceId = installationId(rawInstallationId);
      const decoded = verifyToken(refreshToken);
      if (!decoded) throw new Error('Invalid or expired refresh token');

      // B0.4 / SEC-2: the refresh endpoint must only accept genuine refresh
      // tokens. Without this check an *access* token (minted on every login,
      // no `type` claim) could be replayed here to mint fresh access tokens
      // indefinitely. generateRefreshToken() stamps `type: 'refresh'`.
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid or expired refresh token');
      }
      if (
        !decoded.stableDeviceId
        || String(decoded.stableDeviceId).toLowerCase() !== stableDeviceId
      ) {
        throw new Error('Invalid or expired refresh token');
      }

      // B0.4 / SEC-2: honour revocation. A logged-out / rotated refresh token
      // whose staff_auth_sessions row still exists must not mint new tokens —
      // check the jti blacklist before doing any work (logout bypass).
      if (decoded.jti && await isTokenBlacklisted(decoded.jti)) {
        throw new Error('Token has been revoked');
      }

      const incomingHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const sessionResult = await query(`
        SELECT s.*, u.uid, u.tenant_id, u.name, u.email, u.role,
               st.employee_id, st.is_active
        FROM staff_auth_sessions s
        JOIN users u ON s.staff_id = u.id
        JOIN staff st ON u.id = st.user_id
        WHERE s.session_token = $1
          AND s.device_id = $2
          AND s.expires_at > NOW()
      `, [incomingHash, stableDeviceId]);

      if (sessionResult.rows.length === 0) throw new Error('Invalid or expired session');
      const session = sessionResult.rows[0];
      if (!session.is_active) throw new Error('Account deactivated');
      await this.bindStaffInstallation(session, stableDeviceId, {
        platform: await getUserSessionDeviceType(session.uid),
      });

      await query('UPDATE staff_auth_sessions SET last_activity = NOW() WHERE id = $1', [session.id]);

      // Mint the new access token *and* rotate the user_active_sessions row
      // to its jti — same logical session, new token. Without this update
      // a subsequent login-elsewhere would blacklist the original login's
      // jti (still in the table) instead of the refreshed one. Preserve
      // the deviceType from the existing session row; refresh requests
      // don't carry a deviceType claim of their own. `pushRevoked: false`
      // because the device must NOT receive its own session:revoked event.
      const deviceType = await getUserSessionDeviceType(session.uid);
      const { accessToken } = await issueAccessTokenAndClaimSession({
        userUid: session.uid,
        tokenPayload: { id: session.staff_id, uid: session.uid, role: session.role },
        expiresIn: SECURITY_CONFIG.jwt.staffAccessExpiry,
        deviceType,
        stableDeviceId,
        req,
        pushRevoked: false,
      });

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

  /**
   * PIN login (audit finding M5, 2026-06-10). Hardened in three ways:
   *   1. DEVICE BINDING — a 4-6 digit PIN is only acceptable as a second
   *      factor on a device the staff member registered with their full
   *      password. `deviceToken` must match an active staff_devices row for
   *      this account; PIN login from an unregistered device is rejected.
   *   2. PER-DEVICE/IP LOCKOUT — failed-PIN counting is keyed on
   *      (employeeId, deviceToken/IP), so a remote attacker spamming wrong
   *      PINs locks only THEIR vantage point, not the clinician's real
   *      device (the old account-wide counter enabled a trivial DoS on any
   *      clinician mid-shift).
   *   3. ACCOUNT-WIDE BACKSTOP — a higher distributed-attack cap still
   *      locks the account (with a loud security event) if failures arrive
   *      from many sources at once.
   */
  static async authenticateStaffWithPin(
    employeeId,
    pin,
    req,
    { deviceType, deviceToken, installationId: rawInstallationId } = {},
  ) {
    try {
      const stableDeviceId = installationId(rawInstallationId);
      await this._checkStaffPinLockout(employeeId, req, deviceToken);

      // Device binding (M5): PIN login requires a registered, active device.
      if (!deviceToken || !String(deviceToken).trim()) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'No device token (PIN requires registered device)', 'pin', req, deviceToken);
        const err = new Error('PIN login requires a registered device. Please log in with your password first.');
        err.statusCode = 403;
        err.code = 'PIN_DEVICE_NOT_REGISTERED';
        throw err;
      }

      // Find staff member by employee ID
      const result = await query(`
        SELECT
          u.id, u.uid, u.tenant_id, u.name, u.email, u.phone, u.role,
          s.employee_id, s.department, s.position, s.is_active,
          s.pin_hash -- Assumes a PIN hash is stored on the staff table
        FROM staff s
        JOIN users u ON s.user_id = u.uid
        WHERE s.employee_id = $1
      `, [employeeId]);

      if (result.rows.length === 0) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'Invalid employee ID', 'pin', req);
        logSecurityEvent('LOGIN_FAILED', {
          userName: employeeId,
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          path: '/api/v1/auth/staff/login-pin',
          reason: 'Invalid employee ID (PIN login)',
        });
        throw new Error('Invalid employee ID or PIN');
      }

      const staff = result.rows[0];

      if (!staff.is_active) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'Account deactivated', 'pin', req, deviceToken);
        logSecurityEvent('LOGIN_FAILED', {
          userId: String(staff.uid),
          userName: employeeId,
          userRole: staff.role,
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          path: '/api/v1/auth/staff/login-pin',
          reason: 'Account deactivated (PIN login)',
        });
        throw new Error('Account deactivated');
      }

      // Device binding (M5): the token must belong to an active registered
      // device of THIS staff member.
      const deviceResult = await query(`
        SELECT id FROM staff_devices
        WHERE device_token = $1
          AND staff_id = $2
          AND tenant_id = $3::uuid
          AND device_id = $4
          AND is_active = true
          AND (trust_expires_at IS NULL OR trust_expires_at > NOW())
        LIMIT 1
      `, [deviceToken, staff.id, staff.tenant_id, stableDeviceId]);
      if (deviceResult.rows.length === 0) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'Unregistered device for PIN login', 'pin', req, deviceToken);
        logSecurityEvent('LOGIN_FAILED', {
          userId: String(staff.uid),
          userName: employeeId,
          userRole: staff.role,
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          path: '/api/v1/auth/staff/login-pin',
          reason: 'PIN login attempted from unregistered device (M5 device binding)',
        });
        const err = new Error('PIN login requires a registered device. Please log in with your password first.');
        err.statusCode = 403;
        err.code = 'PIN_DEVICE_NOT_REGISTERED';
        throw err;
      }

      // Check if PIN hash exists and is valid
      if (!staff.pin_hash) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'PIN not set', 'pin', req, deviceToken);
        throw new Error('PIN not set for this account.');
      }

      const isPinValid = await bcrypt.compare(pin, staff.pin_hash);
      if (!isPinValid) {
        await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', false, 'Invalid PIN', 'pin', req, deviceToken);
        logSecurityEvent('LOGIN_FAILED', {
          userId: String(staff.uid),
          userName: employeeId,
          userRole: staff.role,
          ip: req?.ip,
          userAgent: req?.headers?.['user-agent'],
          path: '/api/v1/auth/staff/login-pin',
          reason: 'Invalid PIN',
        });
        throw new Error('Invalid employee ID or PIN');
      }

      await this.logAuthAttempt(employeeId, 'STAFF_PIN_LOGIN', true, null, 'pin', req, deviceToken);
      await this.bindStaffInstallation(staff, stableDeviceId, {
        platform: deviceType,
      });

      const { accessToken } = await issueAccessTokenAndClaimSession({
        userUid: staff.uid,
        tokenPayload: { id: staff.id, uid: staff.uid, role: staff.role },
        expiresIn: SECURITY_CONFIG.jwt.staffAccessExpiry,
        deviceType,
        stableDeviceId,
        req,
      });
      const refreshToken = this.generateRefreshToken(staff, stableDeviceId);

      await query('UPDATE users SET last_sign_in_at = NOW() WHERE id = $1', [staff.id]);
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
          stableDeviceId,
        },
      };
    } catch (error) {
      logger.error('Staff PIN authentication error:', error);
      throw error;
    }
  }

  // Ends a staff session. Both of the device's credentials have to die here:
  //
  //   refresh token — killed by deleting the staff_auth_sessions row, because
  //     refreshStaffSession() requires a live row keyed by the token hash +
  //     device_id before it will mint anything (see that method).
  //   access token  — survives the row deletion for the rest of its own `exp`
  //     (SECURITY_CONFIG.jwt.staffAccessExpiry) unless its jti is blacklisted.
  //     Logout never did that, so it reported success while the presented
  //     bearer token stayed usable (audit follow-up P12).
  //
  // Scope follows the branch that was already here. With a deviceToken only
  // that device's row is deleted, and blacklisting the presented jti ends that
  // session completely. WITHOUT one — which is what the staff app sends — every
  // session row for the user is deleted, so the intent is already all-device;
  // revokeAllUserTokens then closes the matching access-token window on the
  // sibling devices, which would otherwise stay usable for up to
  // SECURITY_CONFIG.jwt.staffAccessExpiry after an "all devices" logout.
  static async logoutStaff(
    staffUid,
    deviceToken,
    req,
    { accessTokenJti = null, accessTokenExpiresAt = null } = {},
  ) {
    let revocationError = null;
    let allDevices = false;
    try {
      const userResult = await query('SELECT id FROM users WHERE uid = $1', [staffUid]);
      if (userResult.rows.length === 0) throw new Error('Staff not found');
      const userId = userResult.rows[0].id;

      if (deviceToken) {
        const deviceResult = await query('SELECT device_id FROM staff_devices WHERE device_token = $1 AND staff_id = $2', [deviceToken, userId]);
        if (deviceResult.rows.length > 0) {
          await query('DELETE FROM staff_auth_sessions WHERE staff_id = $1 AND device_id = $2', [userId, deviceResult.rows[0].device_id]);
        }
      } else {
        allDevices = true;
        await query('DELETE FROM staff_auth_sessions WHERE staff_id = $1', [userId]);
      }

      // Deleting the session rows above is unconditionally useful, so it stays
      // done even if a blacklist write fails — the failure is reported, not
      // rolled back, leaving the strongest partial result we can achieve.
      try {
        if (accessTokenJti && accessTokenExpiresAt) {
          await blacklistToken(accessTokenJti, accessTokenExpiresAt, 'logout', { requireEvidence: true });
        }
        if (allDevices) {
          await revokeAllUserTokens(String(staffUid), { requireEvidence: true });
        }
      } catch (err) {
        revocationError = err;
        logger.error('Staff logout could not revoke the session token(s)', {
          staffUid, jti: accessTokenJti, allDevices, error: err?.message,
        });
      }

      await this.logActivity(staffUid, 'STAFF_LOGOUT', 'Logged out', req);
    } catch (error) {
      logger.error('Logout error:', error);
      throw error;
    }

    if (revocationError) {
      throw new AppError(
        'Signed out on this device, but the session token could not be revoked. Please try again.',
        503,
        'REVOCATION_STORE_UNAVAILABLE',
      );
    }

    return {
      success: true,
      message: 'Logged out successfully',
      allDevices,
      // A device-scoped logout with no jti on the token revoked nothing, and
      // says so rather than implying a revocation that did not happen.
      accessTokenRevoked: allDevices || Boolean(accessTokenJti && accessTokenExpiresAt),
    };
  }

  static async listStaffDevices(staffUid) {
    try {
      const userResult = await query('SELECT id FROM users WHERE uid = $1', [staffUid]);
      if (userResult.rows.length === 0) throw new Error('Staff not found');
      const userId = userResult.rows[0].id;

      const devices = await query(`
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
      // `query()` returns the pg-style wrapper `{ rows, rowCount }`; callers
      // (controller → `{ devices }`, staff app casts `data['devices']` to a
      // List) expect a bare array, so unwrap `.rows` here.
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
      await query('DELETE FROM staff_auth_sessions WHERE staff_id = $1', [staffId]);
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
      const result = await query(
        'UPDATE staff_devices SET pin_hash = NULL WHERE staff_id = $1 AND is_active = true RETURNING id',
        [staffId]
      );
      // ✅ FIX: Uses the logActivity helper for consistency.
      await this.logActivity(adminUid, 'ADMIN_RESET_PIN', `Reset PIN for staff ${staffId}`, req, { affectedStaffId: staffId, devicesAffected: result.rowCount });
      return { success: true, message: 'PIN reset successfully', devicesAffected: result.rowCount };
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
    const userResult = await query('SELECT id FROM users WHERE uid = $1', [staffUid]);
    if (userResult.rows.length === 0) {
      throw new Error('Staff not found');
    }
    const userId = userResult.rows[0].id;

    const deviceResult = await query(
      'SELECT id FROM staff_devices WHERE device_token = $1 AND staff_id = $2 AND is_active = true',
      [deviceToken, userId]
    );

    if (deviceResult.rows.length === 0) {
      throw new Error('Device not found or unauthorized');
    }
    return deviceResult.rows[0].id; // Return the internal (auto-incrementing) device ID
  }

  static generateAccessToken(staff) {
    // `id` is the int DB id (users.id). jwtMiddleware surfaces it as
    // `req.user.id` and downstream IDOR checks (appointments.doctor_id ===
    // req.user.id, etc.) compare against integer FK columns. Without this
    // claim, every doctor IDOR check returns 403 — see finding
    // 2026-05-08-walk-in-opd-doctor-idor-check-always-fails-for-staff-jwt.
    return generateToken({ id: staff.id, uid: staff.uid, role: staff.role }, SECURITY_CONFIG.jwt.staffAccessExpiry);
  }

  static generateRefreshToken(staff, stableDeviceId) {
    // Refresh tokens get a longer expiry (30 days)
    return generateToken({
      id: staff.id,
      uid: staff.uid,
      role: staff.role,
      type: 'refresh',
      ...(stableDeviceId ? { stableDeviceId } : {}),
    }, '30d');
  }

  static generateDeviceToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  static async createSession(staffId, deviceId, sessionToken, req) {
    const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_STAFF_SESSIONS || '3');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await prisma.$transaction(async (tx) => {
      const activeSessions = await tx.$queryRawUnsafe(
        'SELECT id FROM staff_auth_sessions WHERE staff_id = $1 AND expires_at > NOW() ORDER BY created_at ASC FOR UPDATE',
        staffId
      );

      const excess = activeSessions.length - (MAX_CONCURRENT_SESSIONS - 1);
      if (excess > 0) {
        const idsToRevoke = activeSessions.slice(0, excess).map((row) => row.id);
        await tx.$executeRawUnsafe(
          'DELETE FROM staff_auth_sessions WHERE id = ANY($1)',
          idsToRevoke
        );
        logger.info(`Evicted ${excess} oldest session(s) for staff ${staffId} (limit: ${MAX_CONCURRENT_SESSIONS})`);
      }

      await tx.$executeRawUnsafe(
        `INSERT INTO staff_auth_sessions (
          staff_id, device_id, session_token, expires_at, ip_address, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        staffId,
        deviceId,
        sessionHash,
        expiresAt,
        req.ip || ''
      );
    });
  }

  /**
   * Revoke all active sessions for a given staff user.
   * Used by admin to force-logout a compromised account.
   */
  static async revokeAllSessions(staffId) {
    const result = await query(
      'DELETE FROM staff_auth_sessions WHERE staff_id = $1',
      [staffId]
    );
    logger.info(`Revoked all sessions for staff ${staffId} (${result.rowCount} sessions deleted)`);
    return { revokedCount: result.rowCount };
  }

  static async logAuthAttempt(phone, action, success, failureReason, authMethod, req, deviceInfo = null) {
    try {
      await query(`
        INSERT INTO auth_logs (
          phone, action, success, failure_reason, auth_method, ip_address, user_agent, device_info, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [phone, action, success, failureReason, authMethod, req.ip || '', req.headers['user-agent'], deviceInfo ? String(deviceInfo) : null]);
    } catch (error) {
      logger.error('Failed to log auth attempt:', error);
    }
  }

  static async logActivity(uid, action, description, req, details = {}) {
    try {
      await query(`
        INSERT INTO admin_activity_logs (
          admin_uid, action, description, details, ip_address, created_at
        ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5, NOW())
      `, [uid, action, description, JSON.stringify(details), req.ip || '']);
    } catch (error) {
      logger.error('Failed to log activity:', error);
    }
  }

  static async getTodayAttendance(staffUid) {
    const emptyStatus = {
      check_in_time: null,
      check_out_time: null,
      checkInTime: null,
      checkOutTime: null,
      type: null,
      location: null,
      isCheckedIn: false,
      status: 'not-checked-in'
    };
    if (!staffUid) {
      return emptyStatus;
    }
    const result = await query(`
      SELECT sa.id, sa.staff_id, sa.staff_uid, sa.type, sa.location,
             sa.check_in_time, sa.check_out_time, sa.attendance_type,
             sa.attendance_status, sa.minutes_late, sa.notes, sa.created_at,
             sa.timestamp,
             ${attendanceLocalIsoSql(attendanceLocalCheckInSql)} AS local_check_in_time,
             ${attendanceLocalIsoSql(attendanceLocalCheckOutSql)} AS local_check_out_time,
             ${attendanceLocalIsoSql(attendanceLocalRecordedAtSql)} AS recorded_at
      FROM staff_attendance sa
      LEFT JOIN users u ON u.id = sa.staff_id
      WHERE (sa.staff_uid = $1::uuid OR u.uid = $1::uuid)
        AND ${attendanceRecordedAtSql} >= ${localDayStartUtcSql('CURRENT_DATE')}
        AND ${attendanceRecordedAtSql} < ${localDayStartUtcSql("CURRENT_DATE + INTERVAL '1 day'")}
      ORDER BY ${attendanceRecordedAtSql} DESC
      LIMIT 1
    `, [staffUid]);
    const row = result.rows[0];
    if (!row) {
      return emptyStatus;
    }

    const isCheckedIn = Boolean(row.check_in_time) && !row.check_out_time;
    return {
      ...row,
      checkInTime: row.local_check_in_time || row.check_in_time,
      checkOutTime: row.local_check_out_time || row.check_out_time,
      isCheckedIn,
      status: isCheckedIn
        ? 'checked-in'
        : row.check_out_time
          ? 'checked-out'
          : 'not-checked-in'
    };
  }

  /**
   * List attendance rows for a staff member in a date range.
   * The staff app's dashboard hits this immediately on login (typically
   * with a 7-day window starting today). Returns `{ items, total, page, limit }`
   * shape so the client can paginate without a follow-up count query.
   */
  static async getAttendanceHistory(staffUid, { startDate, endDate, page = 1, limit = 30 } = {}) {
    if (!staffUid) {
      return { items: [], total: 0, page, limit };
    }
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    // Date filters are optional; default to last 30 days when both unset so
    // the response stays small even if the client forgets to scope.
    const params = [staffUid];
    let where = 'WHERE (sa.staff_uid = $1::uuid OR u.uid = $1::uuid)';
    if (startDate) {
      params.push(startDate);
      where += ` AND ${attendanceRecordedAtSql} >= ${localDayStartUtcSql(`$${params.length}::date`)}`;
    }
    if (endDate) {
      params.push(endDate);
      where += ` AND ${attendanceRecordedAtSql} < ${localDayStartUtcSql(`$${params.length}::date + INTERVAL '1 day'`)}`;
    }
    if (!startDate && !endDate) {
      where += ` AND ${attendanceRecordedAtSql} >= NOW() - INTERVAL '30 days'`;
    }

    params.push(safeLimit, offset);
    const items = await query(`
      SELECT sa.id, sa.staff_id, sa.staff_uid, sa.type, sa.location,
             sa.check_in_time, sa.check_out_time, sa.attendance_type,
             sa.attendance_status, sa.minutes_late, sa.notes, sa.created_at,
             sa.timestamp,
             ${attendanceLocalIsoSql(attendanceLocalCheckInSql)} AS local_check_in_time,
             ${attendanceLocalIsoSql(attendanceLocalCheckOutSql)} AS local_check_out_time,
             ${attendanceLocalIsoSql(attendanceLocalRecordedAtSql)} AS recorded_at
      FROM staff_attendance sa
      LEFT JOIN users u ON u.id = sa.staff_id
      ${where}
      ORDER BY ${attendanceRecordedAtSql} DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const totalRow = await query(
      `SELECT COUNT(*)::int AS total
       FROM staff_attendance sa
       LEFT JOIN users u ON u.id = sa.staff_id
       ${where}`,
      params.slice(0, params.length - 2)
    );
    return {
      items: items.rows,
      total: totalRow.rows[0]?.total || 0,
      page: safePage,
      limit: safeLimit
    };
  }
}
