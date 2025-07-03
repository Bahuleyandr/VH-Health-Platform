import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import bcrypt from 'bcrypt';
import { generateToken, verifyToken } from '../../utils/jwtUtils.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { v4 as uuidv4 } from 'uuid';
import * as otpService from './otpService.js';
import { AUTH_CONFIG, AUTH_ACTIONS } from '../../config/authConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';

export class AuthService {
  // Patient Firebase authentication
  static async authenticateWithFirebase(idToken) {
    try {
      // This would integrate with Firebase Admin SDK
      // For now, we'll return a placeholder
      return {
        uid: 'firebase-' + uuidv4(),
        email: 'user@example.com',
        phoneNumber: null
      };
    } catch (error) {
      logger.error('Firebase authentication error:', error);
      throw error;
    }
  }

  // Link Firebase account to phone
  static async linkFirebaseToPhone(firebaseUid, phone) {
    try {
      const normalizedPhone = normalizePhone(phone);

      // Check if phone is already linked
      const existingUser = await db.query(
        'SELECT uid FROM users WHERE phone = $1',
        [normalizedPhone]
      );

      if (existingUser.rows.length > 0) {
        throw new Error('Phone number already linked to another account');
      }

      // Update user with phone
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

  // Request OTP
  static async requestOtp(phone, purpose = 'login', req) {
    try {
      const normalizedPhone = normalizePhone(phone);

      // Check if user exists
      const userResult = await db.query(
        'SELECT uid, name, role FROM users WHERE phone = $1',
        [normalizedPhone]
      );
      const userExists = userResult.rows.length > 0;

      // Generate and send OTP
      const otpResult = await otpService.requestOtp(normalizedPhone, purpose, null, req);

      return {
        phone: normalizedPhone,
        userExists,
        otpSent: true,
        ...otpResult
      };
    } catch (error) {
      logger.error('Request OTP error:', error);
      throw error;
    }
  }

  // Verify OTP and authenticate
  static async verifyOtp(phone, otp, req) {
    try {
      const normalizedPhone = normalizePhone(phone);

      // Verify OTP
      const verification = await otpService.verifyOtp(normalizedPhone, otp, 'login', req);

      if (!verification.valid) {
        throw new Error(verification.reason || 'Invalid OTP');
      }

      // Get or create user
      let user = await this.getUserByPhone(normalizedPhone);
      let isNewUser = false;

      if (!user) {
        // Create new user
        const insertResult = await db.query(
          `INSERT INTO users (phone, role, registered_at, last_login) 
           VALUES ($1, $2, NOW(), NOW()) RETURNING *`,
          [normalizedPhone, 'PATIENT']
        );
        user = insertResult.rows[0];
        isNewUser = true;
        logger.info(`New user registered: ${normalizedPhone}`);
      } else {
        // Update last login
        await db.query(
          'UPDATE users SET last_login = NOW() WHERE phone = $1',
          [normalizedPhone]
        );
      }

      // Generate token
      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser
        }
      };
    } catch (error) {
      logger.error('Verify OTP error:', error);
      throw error;
    }
  }

  // Direct OTP login for testing
  static async directOtpLogin(phone) {
    try {
      const normalizedPhone = normalizePhone(phone);

      // Check if user exists
      const user = await this.getUserByPhone(normalizedPhone);
      if (!user) {
        throw new Error('User not found');
      }

      // Generate token
      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role
        }
      };
    } catch (error) {
      logger.error('Direct OTP login error:', error);
      throw error;
    }
  }

  // Admin login with username/password
  static async adminLogin(username, password) {
    try {
      // Check admin credentials
      const adminResult = await db.query(
        'SELECT uid, username, password_hash, role, is_active FROM admins WHERE username = $1',
        [username]
      );

      if (adminResult.rows.length === 0) {
        throw new Error('Invalid credentials');
      }

      const admin = adminResult.rows[0];

      if (!admin.is_active) {
        throw new Error('Account is deactivated');
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, admin.password_hash);
      if (!isValidPassword) {
        throw new Error('Invalid credentials');
      }

      // Generate token
      const token = generateToken({ uid: admin.uid, role: admin.role });

      // Update last login
      await db.query(
        'UPDATE admins SET last_login = NOW() WHERE uid = $1',
        [admin.uid]
      );

      return {
        token,
        admin: {
          uid: admin.uid,
          username: admin.username,
          role: admin.role
        }
      };
    } catch (error) {
      logger.error('Admin login error:', error);
      throw error;
    }
  }

  // Staff login with employee ID and PIN
  static async staffLogin(employeeId, pin) {
    try {
      // Get staff member
      const staffResult = await db.query(
        'SELECT uid, employee_id, pin_hash, name, role, is_active FROM staff WHERE employee_id = $1',
        [employeeId]
      );

      if (staffResult.rows.length === 0) {
        throw new Error('Staff member not found');
      }

      const staff = staffResult.rows[0];

      if (!staff.is_active) {
        throw new Error('Account is deactivated');
      }

      // Verify PIN
      const isValidPin = await bcrypt.compare(pin, staff.pin_hash);
      if (!isValidPin) {
        throw new Error('Invalid credentials');
      }

      // Generate token
      const token = generateToken({ uid: staff.uid, role: staff.role });

      // Update last login
      await db.query(
        'UPDATE staff SET last_login = NOW() WHERE uid = $1',
        [staff.uid]
      );

      return {
        token,
        staff: {
          uid: staff.uid,
          employeeId: staff.employee_id,
          name: staff.name,
          role: staff.role
        }
      };
    } catch (error) {
      logger.error('Staff login error:', error);
      throw error;
    }
  }

  // Change admin password
  static async changeAdminPassword(adminId, currentPassword, newPassword) {
    try {
      // Get current password hash
      const adminResult = await db.query(
        'SELECT password_hash FROM admins WHERE uid = $1',
        [adminId]
      );

      if (adminResult.rows.length === 0) {
        throw new Error('Admin not found');
      }

      // Verify current password
      const isValidPassword = await bcrypt.compare(currentPassword, adminResult.rows[0].password_hash);
      if (!isValidPassword) {
        throw new Error('Current password is incorrect');
      }

      // Hash new password
      const newPasswordHash = await bcrypt.hash(newPassword, 10);

      // Update password
      await db.query(
        'UPDATE admins SET password_hash = $1, password_changed_at = NOW() WHERE uid = $2',
        [newPasswordHash, adminId]
      );

      return { message: 'Password changed successfully' };
    } catch (error) {
      logger.error('Change admin password error:', error);
      throw error;
    }
  }

  // Change staff PIN
  static async changeStaffPin(staffId, currentPin, newPin) {
    try {
      // Get current PIN hash
      const staffResult = await db.query(
        'SELECT pin_hash FROM staff WHERE uid = $1',
        [staffId]
      );

      if (staffResult.rows.length === 0) {
        throw new Error('Staff member not found');
      }

      // Verify current PIN
      const isValidPin = await bcrypt.compare(currentPin, staffResult.rows[0].pin_hash);
      if (!isValidPin) {
        throw new Error('Current PIN is incorrect');
      }

      // Hash new PIN
      const newPinHash = await bcrypt.hash(newPin, 10);

      // Update PIN
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

  // Reset staff PIN (Admin only)
  static async resetStaffPin(employeeId, newPin, adminId) {
    try {
      // Get staff member
      const staffResult = await db.query(
        'SELECT uid FROM staff WHERE employee_id = $1',
        [employeeId]
      );

      if (staffResult.rows.length === 0) {
        throw new Error('Staff member not found');
      }

      // Hash new PIN
      const newPinHash = await bcrypt.hash(newPin, 10);

      // Update PIN
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

  // Create admin account
  static async createAdmin(adminData) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const { username, password, email, name, createdBy } = adminData;

      // Check if username already exists
      const existingAdmin = await client.query(
        'SELECT uid FROM admins WHERE username = $1',
        [username]
      );

      if (existingAdmin.rows.length > 0) {
        throw new Error('Username already exists');
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create admin
      const adminResult = await client.query(
        `INSERT INTO admins (username, password_hash, email, name, role, created_by, created_at, is_active)
         VALUES ($1, $2, $3, $4, 'ADMIN', $5, NOW(), true)
         RETURNING uid, username, email, name`,
        [username, passwordHash, email, name, createdBy]
      );

      await client.query('COMMIT');

      return { admin: adminResult.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Create admin error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // List all admins
  static async listAdmins(page, limit) {
    try {
      const offset = (page - 1) * limit;

      const [adminsResult, countResult] = await Promise.all([
        db.query(
          `SELECT uid, username, email, name, is_active, created_at, last_login
           FROM admins
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        db.query('SELECT COUNT(*) FROM admins')
      ]);

      return {
        admins: adminsResult.rows,
        pagination: {
          page,
          limit,
          total: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(countResult.rows[0].count / limit)
        }
      };
    } catch (error) {
      logger.error('List admins error:', error);
      throw error;
    }
  }

  // Deactivate admin account (Consolidated Method)
  static async deactivateAdmin(adminId, reason, deactivatedBy) {
    try {
      const result = await db.query(
        `UPDATE admins 
         SET is_active = false, deactivated_at = NOW(), 
             deactivated_by = $2, deactivation_reason = $3
         WHERE uid = $1 AND is_active = true
         RETURNING uid, username`,
        [adminId, deactivatedBy, reason]
      );

      if (result.rows.length === 0) {
        throw new Error('Admin not found or already deactivated');
      }

      return {
        message: 'Admin account deactivated',
        admin: result.rows[0]
      };
    } catch (error) {
      logger.error('Deactivate admin error:', error);
      throw error;
    }
  }


  // Reactivate admin account
  static async reactivateAdmin(adminId, reactivatedBy) {
    try {
      const result = await db.query(
        `UPDATE admins 
         SET is_active = true, reactivated_at = NOW(), reactivated_by = $2
         WHERE uid = $1 AND is_active = false
         RETURNING uid, username`,
        [adminId, reactivatedBy]
      );

      if (result.rows.length === 0) {
        throw new Error('Admin not found or already active');
      }

      return {
        message: 'Admin account reactivated',
        admin: result.rows[0]
      };
    } catch (error) {
      logger.error('Reactivate admin error:', error);
      throw error;
    }
  }

  // Refresh token
  static async refreshToken(token) {
    try {
      const decoded = verifyToken(token);

      if (!decoded) {
        throw new Error('Invalid or expired token');
      }

      // Verify user still exists
      const userResult = await db.query(
        'SELECT * FROM users WHERE uid = $1',
        [decoded.uid]
      );

      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = userResult.rows[0];

      // Generate new token
      const newToken = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role
      });

      return {
        token: newToken,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role
        }
      };
    } catch (error) {
      logger.error('Refresh token error:', error);
      throw error;
    }
  }

  // Logout (Consolidated Method)
  static async logout(token, req) {
    try {
      const decoded = verifyToken(token);
      if (decoded) {
        // Log logout event
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

  // Get user by phone
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

  // Legacy methods for backward compatibility
  static async legacyLogin(phone, req) {
    return this.directOtpLogin(phone);
  }

  static async legacyRegister(phone, req) {
    try {
      const normalizedPhone = normalizePhone(phone);

      // Check if user exists
      const existingUser = await this.getUserByPhone(normalizedPhone);
      if (existingUser) {
        throw new Error('User already exists');
      }

      // Create new user
      const insertResult = await db.query(
        `INSERT INTO users (phone, role, registered_at) 
         VALUES ($1, $2, NOW()) RETURNING *`,
        [normalizedPhone, 'PATIENT']
      );

      const user = insertResult.rows[0];

      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          role: user.role
        }
      };
    } catch (error) {
      logger.error('Legacy register error:', error);
      throw error;
    }
  }


  static async adminForgotPassword(username) {
    try {
      // Get admin by username
      const adminResult = await db.query(
        'SELECT uid, email, phone FROM admins WHERE username = $1',
        [username]
      );

      if (adminResult.rows.length === 0) {
        throw new Error('Admin not found');
      }

      const admin = adminResult.rows[0];

      // Generate OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Store OTP
      await db.query(
        `INSERT INTO password_reset_otps (user_id, otp, expires_at, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [admin.uid, otp, expiresAt]
      );

      // In production, send OTP via email/SMS
      logger.info(`Password reset OTP for ${username}: ${otp}`);

      return {
        message: 'OTP sent to registered email/phone',
        ...(process.env.NODE_ENV === 'development' && { otp })
      };
    } catch (error) {
      logger.error('Admin forgot password error:', error);
      throw error;
    }
  }

  static async adminResetPassword(username, otp, newPassword) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // Get admin
      const adminResult = await client.query(
        'SELECT uid FROM admins WHERE username = $1',
        [username]
      );

      if (adminResult.rows.length === 0) {
        throw new Error('Admin not found');
      }

      const adminId = adminResult.rows[0].uid;

      // Verify OTP
      const otpResult = await client.query(
        `SELECT * FROM password_reset_otps 
         WHERE user_id = $1 AND otp = $2 AND expires_at > NOW() 
         AND used = false
         ORDER BY created_at DESC LIMIT 1`,
        [adminId, otp]
      );

      if (otpResult.rows.length === 0) {
        throw new Error('Invalid or expired OTP');
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(newPassword, 10);

      // Update password
      await client.query(
        'UPDATE admins SET password_hash = $1, password_changed_at = NOW() WHERE uid = $2',
        [passwordHash, adminId]
      );

      // Mark OTP as used
      await client.query(
        'UPDATE password_reset_otps SET used = true WHERE user_id = $1 AND otp = $2',
        [adminId, otp]
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

  static async getAdminProfile(adminId) {
    try {
      const result = await db.query(
        `SELECT uid, username, email, name, role, is_active, 
                created_at, last_login, permissions
         FROM admins WHERE uid = $1`,
        [adminId]
      );

      if (result.rows.length === 0) {
        throw new Error('Admin not found');
      }

      const admin = result.rows[0];

      // Format dates to DD-MM-YYYY
      admin.created_at = formatDateDDMMYYYY(admin.created_at);
      admin.last_login = admin.last_login ? formatDateDDMMYYYY(admin.last_login) : null;

      return { admin };
    } catch (error) {
      logger.error('Get admin profile error:', error);
      throw error;
    }
  }

  static async getAdminAuthHealth() {
    try {
      const [totalAdmins, activeAdmins, recentLogins] = await Promise.all([
        db.query('SELECT COUNT(*) FROM admins'),
        db.query('SELECT COUNT(*) FROM admins WHERE is_active = true'),
        db.query(
          `SELECT COUNT(*) FROM auth_logs 
           WHERE action = 'admin_login' AND success = true 
           AND created_at > NOW() - INTERVAL '24 hours'`
        )
      ]);

      return {
        status: 'healthy',
        statistics: {
          totalAdmins: parseInt(totalAdmins.rows[0].count),
          activeAdmins: parseInt(activeAdmins.rows[0].count),
          recentLogins24h: parseInt(recentLogins.rows[0].count)
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Admin auth health check error:', error);
      return {
        status: 'degraded',
        message: 'Admin authentication service unavailable',
        timestamp: new Date().toISOString()
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
        db.query(
          'SELECT COUNT(*) FROM auth_logs WHERE user_id = $1',
          [adminId]
        )
      ]);

      // Format dates to DD-MM-YYYY
      logs.rows.forEach(log => {
        log.created_at = formatDateDDMMYYYY(log.created_at);
      });

      return {
        logs: logs.rows,
        pagination: {
          page,
          limit,
          total: parseInt(total.rows[0].count),
          totalPages: Math.ceil(total.rows[0].count / limit)
        }
      };
    } catch (error) {
      logger.error('Get admin activity logs error:', error);
      throw error;
    }
  }

  static async updateAdminPermissions(adminId, permissions, updatedBy) {
    try {
      const result = await db.query(
        `UPDATE admins 
         SET permissions = $1, permissions_updated_by = $2, permissions_updated_at = NOW()
         WHERE uid = $3
         RETURNING uid, username, permissions`,
        [permissions, updatedBy, adminId]
      );

      if (result.rows.length === 0) {
        throw new Error('Admin not found');
      }

      logger.info(`Admin permissions updated: ${adminId} by ${updatedBy}`);

      return {
        admin: result.rows[0],
        message: 'Permissions updated successfully'
      };
    } catch (error) {
      logger.error('Update admin permissions error:', error);
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
        `)
      ]);

      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        statistics: {
          users: userStats.rows[0],
          otps: otpStats.rows[0],
          sessions: sessionStats.rows[0]
        }
      };
    } catch (error) {
      logger.error('Auth health check error:', error);
      return {
        status: 'degraded',
        message: 'Authentication service partially available',
        timestamp: new Date().toISOString()
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
        lastUpdated: new Date()
      };
    } catch (error) {
      logger.error('Get public stats error:', error);
      throw error;
    }
  }

  static async verifyOtpAndAuthenticate(phone, otp, req) {
    try {
      const normalizedPhone = normalizePhone(phone);

      // Verify OTP
      const verification = await otpService.verifyOtp(normalizedPhone, otp, 'login', req);

      if (!verification.valid) {
        const error = new Error(verification.reason || 'Invalid OTP');
        error.statusCode = HTTP_STATUS.BAD_REQUEST;
        throw error;
      }

      // Get or create user
      let user = await this.getUserByPhone(normalizedPhone);
      let isNewUser = false;

      if (!user) {
        // Create new user
        const insertResult = await db.query(
          `INSERT INTO users (phone, role, registered_at, last_login) 
           VALUES ($1, $2, NOW(), NOW()) RETURNING *`,
          [normalizedPhone, 'PATIENT']
        );
        user = insertResult.rows[0];
        isNewUser = true;
        logger.info(`New user registered: ${normalizedPhone}`);
      } else {
        // Update last login
        await db.query(
          'UPDATE users SET last_login = NOW() WHERE phone = $1',
          [normalizedPhone]
        );
      }

      // Generate token
      const token = generateToken({
        uid: user.uid,
        phone: user.phone,
        role: user.role
      });

      return {
        token,
        user: {
          uid: user.uid,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser
        }
      };
    } catch (error) {
      logger.error('Verify OTP and authenticate error:', error);
      throw error;
    }
  }
}

// Export default for cleaner imports
export default AuthService;