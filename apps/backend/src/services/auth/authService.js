// src/services/auth/authService.js
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { generateToken, issueSetupToken, verifyToken, verifyTokenAllowExpired } from '../../utils/jwtUtils.js';
import { trackFailedLogin } from '../../utils/loginAnomalyDetector.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { logSecurityEvent } from '../../utils/securityAuditLogger.js';
import { blacklistToken, isTokenBlacklisted, revokeAllUserTokens } from '../../utils/tokenBlacklist.js';
import { generateChallengeToken } from '../../utils/totpUtils.js';
import * as firebaseAuthService from './firebaseAuthService.js';
import * as otpService from './otpService.js';

// ✅ Use your real Firebase service

export class AuthService {
  /* ======================= Firebase (pass-through) ======================= */
  static async authenticateWithFirebase(idToken, deviceInfo, req) {
    return firebaseAuthService.authenticateWithFirebase(idToken, deviceInfo, req);
  }

  static async completeUserProfile(profileData) {
    return firebaseAuthService.completeUserProfile(profileData);
  }

  static async linkFirebaseAccount(phone, idToken, otp) {
    return firebaseAuthService.linkFirebaseAccount(phone, idToken, otp);
  }

  static async linkFirebaseToPhone(phone, idToken, otp) {
    return firebaseAuthService.linkFirebaseAccount(phone, idToken, otp);
  }

  static async updateFcmToken(phone, fcmToken, deviceId) {
    return firebaseAuthService.updateFcmToken(phone, fcmToken, deviceId);
  }

  static async revokeFirebaseSession(firebaseUid) {
    return firebaseAuthService.revokeFirebaseSession(firebaseUid);
  }

  static async verifyFirebaseTokenStatus(idToken) {
    return firebaseAuthService.verifyTokenStatus(idToken);
  }

  static async getFirebaseHealthStatus() {
    return firebaseAuthService.getHealthStatus();
  }

  /* =========================== OTP Flow (SMS) =========================== */
  static async requestOtp(phone, purpose = 'login', req) {
    try {
      const normalizedPhone = normalizePhone(phone);

      const existingUser = await prisma.users.findUnique({
        where: { phone: normalizedPhone },
        select: { uid: true, name: true, role: true },
      });

      const otpResult = await otpService.requestOtp(
        normalizedPhone,
        purpose,
        null,
        req
      );

      return { phone: normalizedPhone, userExists: !!existingUser, otpSent: true, ...otpResult };
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
      if (!verification.valid) {
        throw new Error(verification.reason || 'Invalid OTP');
      }

      // Check if user already exists to determine isNewUser
      const existingUser = await prisma.users.findUnique({
        where: { phone: normalizedPhone },
        select: { uid: true },
      });
      const isNewUser = !existingUser;

      // Upsert: create if new, update last_login if existing
      const user = await prisma.users.upsert({
        where: { phone: normalizedPhone },
        create: {
          phone: normalizedPhone,
          role: 'PATIENT',
          registered_at: new Date(),
        },
        update: {},
        select: { uid: true, id: true, name: true, phone: true, role: true },
      });

      if (isNewUser) {
        logger.info(`New user registered: ${normalizedPhone}`);
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

  /* =================== Admin Auth (matches admin_users) ================== */
  static async adminLogin(identity, password) {
    try {
      const admin = await prisma.admins.findFirst({
        where: {
          OR: [
            { username: { equals: identity, mode: 'insensitive' } },
            { email: { equals: identity, mode: 'insensitive' } },
          ],
        },
        select: {
          uid: true,
          username: true,
          email: true,
          role: true,
          status: true,
          failed_login_attempts: true,
          last_failed_login: true,
          password_hash: true,
          totp_enabled: true,
          updated_at: true,
        },
      });

      if (!admin) throw new Error('Invalid credentials');

      if (admin.status && String(admin.status).toLowerCase() !== 'active') {
        throw new Error('Account is deactivated');
      }

      // Enforce account lockout after too many failed attempts
      const MAX_FAILED_ATTEMPTS = SECURITY_CONFIG.admin.maxFailedAttempts;
      const LOCKOUT_DURATION_MINUTES = SECURITY_CONFIG.admin.lockoutDurationMinutes;

      if (admin.failed_login_attempts >= MAX_FAILED_ATTEMPTS) {
        const lastFailedAt = admin.last_failed_login || admin.updated_at;
        if (lastFailedAt) {
          const lockoutExpiry = new Date(new Date(lastFailedAt).getTime() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
          if (new Date() < lockoutExpiry) {
            logger.warn(`Admin account locked: ${identity} (${admin.failed_login_attempts} failed attempts)`);
            logSecurityEvent('ACCOUNT_LOCKED', {
              userId: admin.uid,
              userName: identity,
              userRole: admin.role,
              reason: `Lockout active: ${admin.failed_login_attempts} failed attempts`,
            });
            throw new Error('Account temporarily locked due to too many failed attempts. Try again later.');
          }
        }
        // Lockout period has expired, reset the counter
        await prisma.admins.update({
          where: { uid: admin.uid },
          data: { failed_login_attempts: 0 },
        });
      }

      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) {
        await prisma.admins.update({
          where: { uid: admin.uid },
          data: {
            failed_login_attempts: { increment: 1 },
            last_failed_login: new Date(),
          },
        });
        logSecurityEvent('LOGIN_FAILED', {
          userId: admin.uid,
          userName: identity,
          userRole: admin.role,
          reason: 'Invalid password',
        });
        trackFailedLogin(null, identity); // IP not available here; tracked at middleware level
        throw new Error('Invalid credentials');
      }

      // Reset failed attempts on successful password verification
      await prisma.admins.update({
        where: { uid: admin.uid },
        data: { last_login: new Date(), failed_login_attempts: 0 },
      });

      // Mandatory-MFA enforcement for SUPER_ADMIN.
      // When the feature flag is on, a SUPER_ADMIN without TOTP cannot be
      // issued a full-access JWT — we return a short-lived setup token that
      // the client exchanges for a JWT via /mfa/setup-enroll + /mfa/setup-confirm.
      // The flag is on by default in prod; tests pin it to 'false' via jest.setup.cjs.
      const requireMfa = process.env.REQUIRE_MFA_FOR_SUPER_ADMIN !== 'false';
      const isSuperAdmin = String(admin.role || '').toUpperCase() === 'SUPER_ADMIN';
      if (requireMfa && isSuperAdmin && !admin.totp_enabled) {
        const setupToken = issueSetupToken({
          uid: admin.uid,
          role: admin.role,
          username: admin.username,
        });
        logSecurityEvent('MFA_SETUP_REQUIRED', {
          userId: admin.uid,
          userName: admin.username,
          userRole: admin.role,
        });
        logger.info('MFA setup required for SUPER_ADMIN login', { adminId: admin.uid });
        return {
          requiresMfaSetup: true,
          setupToken,
          expiresIn: 600,
          admin: {
            uid: admin.uid,
            username: admin.username,
          },
        };
      }

      // 2FA check: if TOTP is enabled, return a challenge instead of a JWT
      if (admin.totp_enabled) {
        const { challengeToken, expiresAt } = generateChallengeToken();

        // Store the challenge in the database
        try {
          await prisma.$queryRawUnsafe(
            `INSERT INTO totp_challenges (admin_id, challenge_token, expires_at, created_at)
             VALUES ($1, $2, $3, NOW())`,
            admin.uid, challengeToken, expiresAt
          );
        } catch (challengeErr) {
          logger.warn('TOTP challenge table may not exist, falling back to direct login:', challengeErr.message);
          // Fall through to normal login if table doesn't exist yet
        }

        if (admin.totp_enabled) {
          logger.info('2FA challenge issued for admin login', { adminId: admin.uid });
          return {
            requiresTwoFactor: true,
            challengeToken,
            expiresAt: expiresAt.toISOString(),
            admin: {
              uid: admin.uid,
              username: admin.username,
            },
          };
        }
      }

      const token = generateToken({
        uid: admin.uid,
        role: String(admin.role).toUpperCase(),
        email: admin.email ?? undefined,
        sub: admin.uid,
        iss: 'vh-health-backend',
        aud: 'vh-health-admin',
      }, SECURITY_CONFIG.jwt.adminExpiry);

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
      const admin = await prisma.admins.findUnique({
        where: { uid: String(adminId) },
        select: { password_hash: true },
      });
      if (!admin) throw new Error('Admin not found');

      const ok = await bcrypt.compare(currentPassword, admin.password_hash);
      if (!ok) throw new Error('Current password is incorrect');

      const newHash = await bcrypt.hash(newPassword, 10);

      await prisma.admins.update({
        where: { uid: String(adminId) },
        data: { password_hash: newHash, password_changed_at: new Date() },
      });

      return { message: 'Password changed successfully' };
    } catch (error) {
      logger.error('Change admin password error:', error);
      throw error;
    }
  }

  static async adminForgotPassword(identity) {
    try {
      const admin = await prisma.admins.findFirst({
        where: {
          OR: [
            { username: { equals: identity, mode: 'insensitive' } },
            { email: { equals: identity, mode: 'insensitive' } },
          ],
        },
        select: { uid: true, username: true, email: true },
      });
      if (!admin) throw new Error('Admin not found');

      const otp = crypto.randomInt(100000, 999999).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await prisma.password_reset_otps.create({
        data: {
          user_id: admin.uid,
          otp,
          expires_at: expiresAt,
        },
      });

      logger.info(`Password reset OTP requested for admin ${admin.username || admin.email}`);

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
    try {
      // Use Prisma transaction for atomicity
      return await prisma.$transaction(async (tx) => {
        const admin = await tx.admins.findFirst({
          where: {
            OR: [
              { username: { equals: identity, mode: 'insensitive' } },
              { email: { equals: identity, mode: 'insensitive' } },
            ],
          },
          select: { uid: true },
        });
        if (!admin) throw new Error('Admin not found');

        const otpRecord = await tx.password_reset_otps.findFirst({
          where: {
            user_id: admin.uid,
            otp,
            expires_at: { gt: new Date() },
            used: false,
          },
          orderBy: { created_at: 'desc' },
          select: { id: true },
        });
        if (!otpRecord) throw new Error('Invalid or expired OTP');

        const newHash = await bcrypt.hash(newPassword, 10);

        await tx.admins.update({
          where: { uid: admin.uid },
          data: { password_hash: newHash, password_changed_at: new Date() },
        });

        await tx.password_reset_otps.update({
          where: { id: otpRecord.id },
          data: { used: true },
        });

        return { message: 'Password reset successfully' };
      });
    } catch (error) {
      logger.error('Admin reset password error:', error);
      throw error;
    }
  }

  /* ========================= Staff Auth (PIN) ========================= */
  static async staffLogin(employeeId, pin) {
    try {
      const staff = await prisma.staff.findUnique({
        where: { employee_id: employeeId },
        select: {
          uid: true,
          employee_id: true,
          pin_hash: true,
          name: true,
          role: true,
          is_active: true,
          phone: true,
        },
      });
      if (!staff) throw new Error('Staff member not found');
      if (!staff.is_active) throw new Error('Account is deactivated');

      const ok = await bcrypt.compare(pin, staff.pin_hash);
      if (!ok) throw new Error('Invalid credentials');

      const token = generateToken({
        uid: String(staff.uid),
        phone: staff.phone,
        role: String(staff.role).toUpperCase(),
        sub: String(staff.uid),
      });

      await prisma.staff.update({
        where: { employee_id: employeeId },
        data: { last_login: new Date() },
      });

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
      const staff = await prisma.staff.findFirst({
        where: { uid: staffId },
        select: { id: true, pin_hash: true },
      });
      if (!staff) throw new Error('Staff member not found');

      const ok = await bcrypt.compare(currentPin, staff.pin_hash);
      if (!ok) throw new Error('Current PIN is incorrect');

      const newPinHash = await bcrypt.hash(newPin, 10);
      await prisma.staff.update({
        where: { id: staff.id },
        data: { pin_hash: newPinHash, pin_changed_at: new Date() },
      });
      return { message: 'PIN changed successfully' };
    } catch (error) {
      logger.error('Change staff PIN error:', error);
      throw error;
    }
  }

  static async resetStaffPin(employeeId, newPin, adminId) {
    try {
      const staff = await prisma.staff.findUnique({
        where: { employee_id: employeeId },
        select: { id: true },
      });
      if (!staff) throw new Error('Staff member not found');

      const newPinHash = await bcrypt.hash(newPin, 10);
      await prisma.staff.update({
        where: { id: staff.id },
        data: {
          pin_hash: newPinHash,
          pin_changed_at: new Date(),
          pin_reset_by: adminId,
        },
      });
      return { message: 'Staff PIN reset successfully' };
    } catch (error) {
      logger.error('Reset staff PIN error:', error);
      throw error;
    }
  }

  /* ======================= Admin CRUD / Profile ======================= */
  static async createAdmin(adminData) {
    try {
      const { username, password, email, name, createdBy } = adminData;

      const existing = await prisma.admins.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { uid: true },
      });
      if (existing) throw new Error('Username already exists');

      const passwordHash = await bcrypt.hash(password, 10);

      const newAdmin = await prisma.admins.create({
        data: {
          username,
          password_hash: passwordHash,
          email,
          name,
          role: 'ADMIN',
          status: 'active',
          created_by: createdBy ?? null,
        },
        select: { uid: true, username: true, email: true, name: true },
      });

      return { admin: { ...newAdmin } };  // uid is already the PK
    } catch (error) {
      logger.error('Create admin error:', error);
      throw error;
    }
  }

  static async listAdmins(page, limit) {
    try {
      const offset = (page - 1) * limit;

      const [admins, total] = await Promise.all([
        prisma.admins.findMany({
          select: {
            uid: true,
            username: true,
            email: true,
            name: true,
            role: true,
            permissions: true,
            status: true,
            is_active: true,
            created_at: true,
            last_login: true,
          },
          orderBy: { created_at: 'desc' },
          skip: offset,
          take: limit,
        }),
        prisma.admins.count(),
      ]);

      return {
        admins: admins.map((a) => ({ ...a })),  // uid is already the PK
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('List admins error:', error);
      throw error;
    }
  }

  static async deactivateAdmin(adminId, reason, deactivatedBy) {
    try {
      const admin = await prisma.admins.updateMany({
        where: { uid: String(adminId), status: 'active' },
        data: {
          status: 'inactive',
          is_active: false,
          deactivated_at: new Date(),
          deactivated_by: deactivatedBy ?? null,
          deactivation_reason: reason ?? null,
        },
      });
      if (admin.count === 0) {
        throw new Error('Admin not found or already deactivated');
      }

      const updated = await prisma.admins.findUnique({
        where: { uid: String(adminId) },
        select: { uid: true, username: true },
      });
      return { message: 'Admin account deactivated', admin: { uid: updated.uid, username: updated.username } };
    } catch (error) {
      logger.error('Deactivate admin error:', error);
      throw error;
    }
  }

  static async reactivateAdmin(adminId) {
    try {
      const admin = await prisma.admins.updateMany({
        where: { uid: String(adminId), status: 'inactive' },
        data: {
          status: 'active',
          is_active: true,
          deactivated_at: null,
          deactivated_by: null,
          deactivation_reason: null,
        },
      });
      if (admin.count === 0) {
        throw new Error('Admin not found or already active');
      }

      const updated = await prisma.admins.findUnique({
        where: { uid: String(adminId) },
        select: { uid: true, username: true },
      });
      return { message: 'Admin account reactivated', admin: { uid: updated.uid, username: updated.username } };
    } catch (error) {
      logger.error('Reactivate admin error:', error);
      throw error;
    }
  }

  static async updateAdminPermissions(adminId, permissions, updatedBy) {
    try {
      const updated = await prisma.admins.update({
        where: { uid: String(adminId) },
        data: { permissions: permissions ?? [] },
        select: { uid: true, username: true, permissions: true },
      });
      logger.info(`Admin permissions updated: ${adminId} by ${updatedBy}`);
      return { message: 'Permissions updated', admin: { uid: updated.uid, username: updated.username, permissions: updated.permissions } };
    } catch (error) {
      logger.error('Update admin permissions error:', error);
      throw error;
    }
  }

  static async getAdminProfile(adminId) {
    try {
      const admin = await prisma.admins.findUnique({
        where: { uid: String(adminId) },
        select: {
          uid: true,
          username: true,
          email: true,
          name: true,
          role: true,
          status: true,
          created_at: true,
          last_login: true,
          permissions: true,
        },
      });
      if (!admin) throw new Error('Admin not found');

      return {
        admin: {
          uid: admin.uid,
          ...admin,
          created_at: admin.created_at ? formatDateDDMMYYYY(admin.created_at) : null,
          last_login: admin.last_login ? formatDateDDMMYYYY(admin.last_login) : null,
        },
      };
    } catch (error) {
      logger.error('Get admin profile error:', error);
      throw error;
    }
  }

  /* ======================== Tokens / Sessions ======================== */
  static async refreshToken(token) {
    try {
      // Refresh must accept a JUST-EXPIRED access token — that's the whole
      // point. We still verify the signature and reject already-revoked
      // tokens (replay protection via jti blacklist).
      const decoded = verifyTokenAllowExpired(token);
      if (!decoded) throw new Error('Invalid token signature');

      if (decoded.jti && await isTokenBlacklisted(decoded.jti)) {
        throw new Error('Token has been revoked');
      }

      const user = await prisma.users.findUnique({
        where: { uid: decoded.uid },
        select: { uid: true, phone: true, name: true, role: true },
      });
      if (!user) throw new Error('User not found');

      // Token rotation: blacklist the old token before issuing a new one.
      // For tokens that have already expired, blacklisting is a no-op
      // (tokenBlacklist.js short-circuits when ttl <= 0) — safe.
      if (decoded.jti && decoded.exp) {
        await blacklistToken(decoded.jti, decoded.exp, 'refresh_rotation');
      }

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

  static async logout(token, _req) {
    try {
      const decoded = verifyToken(token);
      if (decoded) {
        // Blacklist the token so it can't be reused
        if (decoded.jti && decoded.exp) {
          await blacklistToken(decoded.jti, decoded.exp, 'logout');
        }

        await prisma.auth_logs.create({
          data: {
            user_id: decoded.uid,
            phone: decoded.phone,
            action: 'logout',
            success: true,
          },
        });
        return { phone: decoded.phone };
      }
      return {};
    } catch (error) {
      logger.error('Logout error:', error);
      return {};
    }
  }

  /**
   * Force-revoke all tokens for a user (e.g., after password reset or account compromise).
   */
  static async revokeAllTokens(userId) {
    await revokeAllUserTokens(userId);
    return { revoked: true };
  }

  /* ============================== Misc ============================== */
  static async getUserByPhone(phone) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const user = await prisma.users.findUnique({
        where: { phone: normalizedPhone },
        select: { uid: true, phone: true, name: true, role: true },
      });
      return user || null;
    } catch (error) {
      logger.error('Get user by phone error:', error);
      throw error;
    }
  }

  static async legacyLogin(phone, _req) {
    return this.directOtpLogin(phone);
  }

  static async legacyRegister(phone, _req) {
    try {
      const normalizedPhone = normalizePhone(phone);

      const existingUser = await prisma.users.findUnique({
        where: { phone: normalizedPhone },
        select: { uid: true },
      });

      if (existingUser) {
        throw new Error('User already exists');
      }

      const user = await prisma.users.create({
        data: {
          phone: normalizedPhone,
          role: 'PATIENT',
          registered_at: new Date(),
        },
        select: { uid: true, id: true, phone: true, role: true },
      });

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

  /* =========================== Health / Stats ========================== */
  static async getAdminAuthHealth() {
    try {
      const [totalAdmins, activeAdmins, recentLogins] = await Promise.all([
        prisma.admins.count(),
        prisma.admins.count({ where: { status: 'active' } }),
        prisma.auth_logs.count({
          where: {
            action: 'admin_login',
            success: true,
            created_at: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        }),
      ]);

      return {
        status: 'healthy',
        statistics: { totalAdmins, activeAdmins, recentLogins24h: recentLogins },
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
        prisma.auth_logs.findMany({
          where: { user_id: adminId },
          select: {
            action: true,
            success: true,
            ip_address: true,
            user_agent: true,
            created_at: true,
          },
          orderBy: { created_at: 'desc' },
          skip: offset,
          take: limit,
        }),
        prisma.auth_logs.count({ where: { user_id: adminId } }),
      ]);

      return {
        logs: logs.map((log) => ({
          ...log,
          created_at: formatDateDDMMYYYY(log.created_at),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Get admin activity logs error:', error);
      throw error;
    }
  }

  static async getHealthStatus() {
    try {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const [totalUsers, active24h, newUsers7d, otpStats, activeSessions] = await Promise.all([
        prisma.users.count(),
        prisma.users.count({ where: { updated_at: { gt: oneDayAgo } } }),
        prisma.users.count({ where: { registered_at: { gt: oneWeekAgo } } }),
        Promise.all([
          prisma.otp_sessions.count({ where: { created_at: { gt: oneDayAgo } } }),
          prisma.otp_sessions.count({ where: { verified: true, created_at: { gt: oneDayAgo } } }),
          prisma.otp_sessions.count({ where: { created_at: { gt: oneHourAgo } } }),
        ]),
        prisma.user_sessions.count({ where: { expires_at: { gt: now } } }),
      ]);

      return {
        status: 'healthy',
        timestamp: now.toISOString(),
        statistics: {
          users: {
            total_users: totalUsers,
            active_24h: active24h,
            new_users_7d: newUsers7d,
          },
          otps: {
            total_otps: otpStats[0],
            verified_otps: otpStats[1],
            recent_otps: otpStats[2],
          },
          sessions: { active_sessions: activeSessions },
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
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [registeredUsers, logins24h, newUsers7d] = await Promise.all([
        prisma.auth_logs.groupBy({
          by: ['phone'],
          _count: true,
        }).then((r) => r.length),
        prisma.auth_logs.count({
          where: { action: 'login', created_at: { gt: oneDayAgo } },
        }),
        prisma.auth_logs.count({
          where: { action: 'register', created_at: { gt: oneWeekAgo } },
        }),
      ]);

      return {
        registered_users: registeredUsers,
        logins_24h: logins24h,
        new_users_7d: newUsers7d,
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

      const existingUser = await prisma.users.findUnique({
        where: { phone: normalizedPhone },
        select: { uid: true },
      });
      const isNewUser = !existingUser;

      const user = await prisma.users.upsert({
        where: { phone: normalizedPhone },
        create: {
          phone: normalizedPhone,
          role: 'PATIENT',
          registered_at: new Date(),
        },
        update: {},
        select: { uid: true, id: true, name: true, phone: true, role: true },
      });

      if (isNewUser) {
        logger.info(`New user registered: ${normalizedPhone}`);
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
