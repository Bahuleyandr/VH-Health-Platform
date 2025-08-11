// src/services/auth/authService.js
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import db from '../../config/database.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { generateToken, verifyToken } from '../../utils/jwtUtils.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import * as otpService from './otpService.js';

// Match your schema
const ADMIN_TABLE = process.env.ADMIN_TABLE ?? 'admin_users';
const ADMIN_PASSWORD_COLUMN = process.env.ADMIN_PASSWORD_COLUMN ?? 'password_hash';

export class AuthService {
  /* ---------------- Firebase (placeholder) ---------------- */
  static async authenticateWithFirebase(idToken) {
    try {
      return {
        uid: 'firebase-' + uuidv4(),
        email: 'user@example.com',
        phoneNumber: null,
      };
    } catch (error) {
      logger.error('Firebase authentication error:', error);
      throw error;
    }
  }

  static async linkFirebaseToPhone(firebaseUid, phone) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const existingUser = await db.query(
        'SELECT uid FROM users WHERE phone = $1',
        [normalizedPhone]
      );
      if (existingUser.rows.length > 0) {
        throw new Error('Phone number already linked to another account');
      }
      await db.query(
        'UPDATE users SET phone = $1 WHERE firebase_uid = $2',
        [normalizedPhone, firebaseUid]
      );
      return { success: true };
    } catch (error) {
      logger.error('Link Firebase to phone error:', error);
      throw error;
    }
  }

  /* ----------------------- OTP Flow ----------------------- */
  static async requestOtp(phone, purpose = 'login', req) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const userResult = await db.query(
        'SELECT uid, name, role FROM users WHERE phone = $1',
        [normalizedPhone]
      );
      const userExists = userResult.rows.length > 0;

      const otpResult = await otpService.requestOtp(
        normalizedPhone,
        purpose,
        null,
        req
      );

      return {
        phone: normalizedPhone,
        userExists,
        otpSent: true,
        ...otpResult,
      };
    } catch (error) {
      logger.error('Request OTP error:', error);
      throw error;
    }
  }

  static async verifyOtp(phone, otp, req) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const verification = await otpService.verifyOtp(
        normalizedPhone,
        otp,
        'login',
        req
      );

      if (!verification.valid) throw new Error(verification.reason || 'Invalid OTP');

      let user = await this.getUserByPhone(normalizedPhone);
      let isNewUser = false;

      if (!user) {
        const insertResult = await db.query(
          `INSERT INTO users (phone, role, registered_at, last_login) 
           VALUES ($1, $2, NOW(), NOW()) RETURNING *`,
          [normalizedPhone, 'PATIENT']
        );
        user = insertResult.rows[0];
        isNewUser = true;
        logger.info(`New user registered: ${normalizedPhone}`);
      } else {
        await db.query(
          'UPDATE users SET last_login = NOW() WHERE phone = $1',
          [normalizedPhone]
        );
      }

      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser,
        },
      };
    } catch (error) {
      logger.error('Verify OTP error:', error);
      throw error;
    }
  }

  static async directOtpLogin(phone) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const user = await this.getUserByPhone(normalizedPhone);
      if (!user) throw new Error('User not found');

      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role,
        },
      };
    } catch (error) {
      logger.error('Direct OTP login error:', error);
      throw error;
    }
  }

  /* ------------------- Admin Auth (matches admin_users) ------------------ */
  // identity = username OR email
  static async adminLogin(identity, password) {
    try {
      const { rows } = await db.query(
        `
        SELECT 
          id          AS uid,
          username,
          email,
          role,
          status,
          ${ADMIN_PASSWORD_COLUMN} AS pwd
        FROM ${ADMIN_TABLE}
        WHERE lower(username) = lower($1) OR lower(email) = lower($1)
        LIMIT 1
        `,
        [identity]
      );

      if (rows.length === 0) throw new Error('Invalid credentials');

      const admin = rows[0];
      if (admin.status && String(admin.status).toLowerCase() !== 'active') {
        throw new Error('Account is deactivated');
      }

      const ok = await bcrypt.compare(password, admin.pwd);
      if (!ok) {
        // optional: track failed attempts
        await db.query(
          `UPDATE ${ADMIN_TABLE}
             SET failed_login_attempts = COALESCE(failed_login_attempts,0) + 1,
                 last_failed_login = NOW()
           WHERE id = $1`,
          [admin.uid]
        );
        throw new Error('Invalid credentials');
      }

      const token = generateToken({ uid: admin.uid, role: admin.role });

      await db.query(
        `UPDATE ${ADMIN_TABLE} 
            SET last_login = NOW(), failed_login_attempts = 0
          WHERE id = $1`,
        [admin.uid]
      );

      return {
        token,
        admin: {
          uid: admin.uid,
          username: admin.username,
          email: admin.email,
          role: admin.role,
        },
      };
    } catch (error) {
      logger.error('Admin login error:', error);
      throw error;
    }
  }

  static async changeAdminPassword(adminId, currentPassword, newPassword) {
    try {
      const { rows } = await db.query(
        `SELECT ${ADMIN_PASSWORD_COLUMN} AS pwd FROM ${ADMIN_TABLE} WHERE id = $1`,
        [adminId]
      );
      if (rows.length === 0) throw new Error('Admin not found');

      const ok = await bcrypt.compare(currentPassword, rows[0].pwd);
      if (!ok) throw new Error('Current password is incorrect');

      const newHash = await bcrypt.hash(newPassword, 10);

      await db.query(
        `UPDATE ${ADMIN_TABLE} 
            SET ${ADMIN_PASSWORD_COLUMN} = $1, password_changed_at = NOW()
          WHERE id = $2`,
        [newHash, adminId]
      );

      return { message: 'Password changed successfully' };
    } catch (error) {
      logger.error('Change admin password error:', error);
      throw error;
    }
  }

  static async adminForgotPassword(identity) {
    try {
      const { rows } = await db.query(
        `
        SELECT id AS uid, username, email, phone 
        FROM ${ADMIN_TABLE}
        WHERE lower(username) = lower($1) OR lower(email) = lower($1)
        LIMIT 1
        `,
        [identity]
      );
      if (rows.length === 0) throw new Error('Admin not found');

      const admin = rows[0];
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await db.query(
        `INSERT INTO password_reset_otps (user_id, otp, expires_at, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [admin.uid, otp, expiresAt]
      );

      logger.info(`Password reset OTP for ${admin.username || admin.email}: ${otp}`);

      return {
        message: 'OTP sent to registered email/phone',
        ...(process.env.NODE_ENV === 'development' && { otp }),
      };
    } catch (error) {
      logger.error('Admin forgot password error:', error);
      throw error;
    }
  }

  static async adminResetPassword(identity, otp, newPassword) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const aRes = await client.query(
        `
        SELECT id AS uid
        FROM ${ADMIN_TABLE}
        WHERE lower(username) = lower($1) OR lower(email) = lower($1)
        LIMIT 1
        `,
        [identity]
      );
      if (aRes.rows.length === 0) throw new Error('Admin not found');

      const adminId = aRes.rows[0].uid;

      const oRes = await client.query(
        `SELECT id 
           FROM password_reset_otps
          WHERE user_id = $1
            AND otp = $2
            AND expires_at > NOW()
            AND used = false
          ORDER BY created_at DESC
          LIMIT 1`,
        [adminId, otp]
      );
      if (oRes.rows.length === 0) throw new Error('Invalid or expired OTP');

      const newHash = await bcrypt.hash(newPassword, 10);

      await client.query(
        `UPDATE ${ADMIN_TABLE}
            SET ${ADMIN_PASSWORD_COLUMN} = $1, password_changed_at = NOW()
          WHERE id = $2`,
        [newHash, adminId]
      );

      await client.query(
        'UPDATE password_reset_otps SET used = true WHERE id = $1',
        [oRes.rows[0].id]
      );

      await client.query('COMMIT');
      return { message: 'Password reset successfully' };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Admin reset password error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /* ---------------------- Staff Auth (PIN) ---------------------- */
  static async staffLogin(employeeId, pin) {
    try {
      const staffResult = await db.query(
        'SELECT uid, employee_id, pin_hash, name, role, is_active FROM staff WHERE employee_id = $1',
        [employeeId]
      );
      if (staffResult.rows.length === 0) throw new Error('Staff member not found');

      const staff = staffResult.rows[0];
      if (!staff.is_active) throw new Error('Account is deactivated');

      const ok = await bcrypt.compare(pin, staff.pin_hash);
      if (!ok) throw new Error('Invalid credentials');

      const token = generateToken({ uid: staff.uid, role: staff.role });
      await db.query('UPDATE staff SET last_login = NOW() WHERE uid = $1', [staff.uid]);

      return {
        token,
        staff: {
          uid: staff.uid,
          employeeId: staff.employee_id,
          name: staff.name,
          role: staff.role,
        },
      };
    } catch (error) {
      logger.error('Staff login error:', error);
      throw error;
    }
  }

  static async changeStaffPin(staffId, currentPin, newPin) {
    try {
      const staffResult = await db.query(
        'SELECT pin_hash FROM staff WHERE uid = $1',
        [staffId]
      );
      if (staffResult.rows.length === 0) throw new Error('Staff member not found');

      const ok = await bcrypt.compare(currentPin, staffResult.rows[0].pin_hash);
      if (!ok) throw new Error('Current PIN is incorrect');

      const newPinHash = await bcrypt.hash(newPin, 10);
      await db.query(
        'UPDATE staff SET pin_hash = $1, pin_changed_at = NOW() WHERE uid = $2',
        [newPinHash, staffId]
      );
      return { message: 'PIN changed successfully' };
    } catch (error) {
      logger.error('Change staff PIN error:', error);
      throw error;
    }
  }

  static async resetStaffPin(employeeId, newPin, adminId) {
    try {
      const staffResult = await db.query(
        'SELECT uid FROM staff WHERE employee_id = $1',
        [employeeId]
      );
      if (staffResult.rows.length === 0) throw new Error('Staff member not found');

      const newPinHash = await bcrypt.hash(newPin, 10);
      await db.query(
        'UPDATE staff SET pin_hash = $1, pin_changed_at = NOW(), pin_reset_by = $2 WHERE employee_id = $3',
        [newPinHash, adminId, employeeId]
      );
      return { message: 'Staff PIN reset successfully' };
    } catch (error) {
      logger.error('Reset staff PIN error:', error);
      throw error;
    }
  }

  /* -------------------- Admin CRUD / Profile -------------------- */
  static async createAdmin(adminData) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const { username, password, email, name, createdBy } = adminData;

      const existing = await client.query(
        `SELECT id FROM ${ADMIN_TABLE} WHERE lower(username) = lower($1)`,
        [username]
      );
      if (existing.rows.length > 0) throw new Error('Username already exists');

      const passwordHash = await bcrypt.hash(password, 10);

      const insert = await client.query(
        `INSERT INTO ${ADMIN_TABLE} 
         (username, ${ADMIN_PASSWORD_COLUMN}, email, name, role, created_by, status, created_at)
         VALUES ($1, $2, $3, $4, 'ADMIN', $5, 'active', NOW())
         RETURNING id AS uid, username, email, name`,
        [username, passwordHash, email, name, createdBy ?? null]
      );

      await client.query('COMMIT');
      return { admin: insert.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Create admin error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async listAdmins(page, limit) {
    try {
      const offset = (page - 1) * limit;

      const [adminsResult, countResult] = await Promise.all([
        db.query(
          `SELECT 
              id AS uid, username, email, name, status, created_at, last_login
           FROM ${ADMIN_TABLE}
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM ${ADMIN_TABLE}`)
      ]);

      return {
        admins: adminsResult.rows,
        pagination: {
          page,
          limit,
          total: parseInt(countResult.rows[0].count, 10),
          totalPages: Math.ceil(countResult.rows[0].count / limit),
        },
      };
    } catch (error) {
      logger.error('List admins error:', error);
      throw error;
    }
  }

  static async deactivateAdmin(adminId, reason, deactivatedBy) {
    try {
      const result = await db.query(
        `UPDATE ${ADMIN_TABLE} 
            SET status = 'inactive',
                deactivated_at = NOW(),
                deactivated_by = $2,
                deactivation_reason = $3
          WHERE id = $1 AND status = 'active'
          RETURNING id AS uid, username`,
        [adminId, deactivatedBy ?? null, reason ?? null]
      );
      if (result.rows.length === 0) {
        throw new Error('Admin not found or already deactivated');
      }
      return { message: 'Admin account deactivated', admin: result.rows[0] };
    } catch (error) {
      logger.error('Deactivate admin error:', error);
      throw error;
    }
  }

  static async reactivateAdmin(adminId /*, reactivatedBy */) {
    try {
      const result = await db.query(
        `UPDATE ${ADMIN_TABLE}
            SET status = 'active',
                deactivated_at = NULL,
                deactivated_by = NULL,
                deactivation_reason = NULL
          WHERE id = $1 AND status = 'inactive'
          RETURNING id AS uid, username`,
        [adminId]
      );
      if (result.rows.length === 0) {
        throw new Error('Admin not found or already active');
      }
      return { message: 'Admin account reactivated', admin: result.rows[0] };
    } catch (error) {
      logger.error('Reactivate admin error:', error);
      throw error;
    }
  }

  static async getAdminProfile(adminId) {
    try {
      const result = await db.query(
        `SELECT 
           id AS uid, username, email, name, role, status, 
           created_at, last_login, permissions
         FROM ${ADMIN_TABLE}
         WHERE id = $1`,
        [adminId]
      );
      if (result.rows.length === 0) throw new Error('Admin not found');

      const admin = result.rows[0];
      admin.created_at = admin.created_at ? formatDateDDMMYYYY(admin.created_at) : null;
      admin.last_login = admin.last_login ? formatDateDDMMYYYY(admin.last_login) : null;

      return { admin };
    } catch (error) {
      logger.error('Get admin profile error:', error);
      throw error;
    }
  }

  /* --------------------- Tokens / Sessions --------------------- */
  static async refreshToken(token) {
    try {
      const decoded = verifyToken(token);
      if (!decoded) throw new Error('Invalid or expired token');

      const userResult = await db.query(
        'SELECT * FROM users WHERE uid = $1',
        [decoded.uid]
      );
      if (userResult.rows.length === 0) throw new Error('User not found');

      const user = userResult.rows[0];
      const newToken = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role,
      });

      return {
        token: newToken,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role,
        },
      };
    } catch (error) {
      logger.error('Refresh token error:', error);
      throw error;
    }
  }

  static async logout(token, req) {
    try {
      const decoded = verifyToken(token);
      if (decoded) {
        await db.query(
          `INSERT INTO auth_logs (user_id, phone, action, success, created_at)
           VALUES ($1, $2, 'logout', true, NOW())`,
          [decoded.uid, decoded.phone]
        );
        return { phone: decoded.phone };
      }
      return {};
    } catch (error) {
      logger.error('Logout error:', error);
      return {};
    }
  }

  /* -------------------------- Misc -------------------------- */
  static async getUserByPhone(phone) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const result = await db.query(
        'SELECT * FROM users WHERE phone = $1',
        [normalizedPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Get user by phone error:', error);
      throw error;
    }
  }

  static async legacyLogin(phone, req) {
    return this.directOtpLogin(phone);
  }

  static async legacyRegister(phone, req) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const existingUser = await this.getUserByPhone(normalizedPhone);
      if (existingUser) throw new Error('User already exists');

      const insertResult = await db.query(
        `INSERT INTO users (phone, role, registered_at) 
         VALUES ($1, $2, NOW()) RETURNING *`,
        [normalizedPhone, 'PATIENT']
      );

      const user = insertResult.rows[0];
      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          role: user.role,
        },
      };
    } catch (error) {
      logger.error('Legacy register error:', error);
      throw error;
    }
  }

  /* ---------------------- Health / Stats --------------------- */
  static async getAdminAuthHealth() {
    try {
      const [totalAdmins, activeAdmins, recentLogins] = await Promise.all([
        db.query(`SELECT COUNT(*) FROM ${ADMIN_TABLE}`),
        db.query(`SELECT COUNT(*) FROM ${ADMIN_TABLE} WHERE lower(status) = 'active'`),
        db.query(
          `SELECT COUNT(*) FROM auth_logs 
            WHERE action = 'admin_login' AND success = true 
              AND created_at > NOW() - INTERVAL '24 hours'`
        ),
      ]);

      return {
        status: 'healthy',
        statistics: {
          totalAdmins: parseInt(totalAdmins.rows[0].count, 10),
          activeAdmins: parseInt(activeAdmins.rows[0].count, 10),
          recentLogins24h: parseInt(recentLogins.rows[0].count, 10),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Admin auth health check error:', error);
      return {
        status: 'degraded',
        message: 'Admin authentication service unavailable',
        timestamp: new Date().toISOString(),
      };
    }
  }

  static async getAdminActivityLogs(adminId, { page, limit }) {
    try {
      const offset = (page - 1) * limit;

      const [logs, total] = await Promise.all([
        db.query(
          `SELECT action, success, ip_address, user_agent, created_at
             FROM auth_logs 
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3`,
          [adminId, limit, offset]
        ),
        db.query('SELECT COUNT(*) FROM auth_logs WHERE user_id = $1', [adminId])
      ]);

      logs.rows.forEach((log) => {
        log.created_at = formatDateDDMMYYYY(log.created_at);
      });

      return {
        logs: logs.rows,
        pagination: {
          page,
          limit,
          total: parseInt(total.rows[0].count, 10),
          totalPages: Math.ceil(total.rows[0].count / limit),
        },
      };
    } catch (error) {
      logger.error('Get admin activity logs error:', error);
      throw error;
    }
  }

  static async getHealthStatus() {
    try {
      const [userStats, otpStats, sessionStats] = await Promise.all([
        db.query(`
          SELECT 
            COUNT(*) as total_users,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '24 hours') as active_24h,
            COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '7 days') as new_users_7d
          FROM users
        `),
        db.query(`
          SELECT 
            COUNT(*) as total_otps,
            COUNT(*) FILTER (WHERE verified = true) as verified_otps,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') as recent_otps
          FROM otp_sessions WHERE created_at > NOW() - INTERVAL '24 hours'
        `),
        db.query(`
          SELECT COUNT(*) as active_sessions
            FROM user_sessions 
           WHERE expires_at > NOW()
        `),
      ]);

      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        statistics: {
          users: userStats.rows[0],
          otps: otpStats.rows[0],
          sessions: sessionStats.rows[0],
        },
      };
    } catch (error) {
      logger.error('Auth health check error:', error);
      return {
        status: 'degraded',
        message: 'Authentication service partially available',
        timestamp: new Date().toISOString(),
      };
    }
  }

  static async getPublicStats() {
    try {
      const stats = await db.query(`
        SELECT 
          COUNT(DISTINCT phone) as registered_users,
          COUNT(*) FILTER (WHERE action = 'login' AND created_at > NOW() - INTERVAL '24 hours') as logins_24h,
          COUNT(*) FILTER (WHERE action = 'register' AND created_at > NOW() - INTERVAL '7 days') as new_users_7d
        FROM auth_logs
      `);

      return {
        ...stats.rows[0],
        lastUpdated: new Date(),
      };
    } catch (error) {
      logger.error('Get public stats error:', error);
      throw error;
    }
  }

  static async verifyOtpAndAuthenticate(phone, otp, req) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const verification = await otpService.verifyOtp(
        normalizedPhone,
        otp,
        'login',
        req
      );

      if (!verification.valid) {
        const err = new Error(verification.reason || 'Invalid OTP');
        err.statusCode = HTTP_STATUS.BAD_REQUEST;
        throw err;
      }

      let user = await this.getUserByPhone(normalizedPhone);
      let isNewUser = false;

      if (!user) {
        const insertResult = await db.query(
          `INSERT INTO users (phone, role, registered_at, last_login) 
           VALUES ($1, $2, NOW(), NOW()) RETURNING *`,
          [normalizedPhone, 'PATIENT']
        );
        user = insertResult.rows[0];
        isNewUser = true;
        logger.info(`New user registered: ${normalizedPhone}`);
      } else {
        await db.query(
          'UPDATE users SET last_login = NOW() WHERE phone = $1',
          [normalizedPhone]
        );
      }

      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser,
        },
      };
    } catch (error) {
      logger.error('Verify OTP and authenticate error:', error);
      throw error;
    }
  }
}

export default AuthService;
