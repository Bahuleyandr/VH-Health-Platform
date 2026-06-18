// src/services/auth/authService.js
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { generateToken, issueSetupToken, verifyToken } from '../../utils/jwtUtils.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { trackFailedLogin } from '../../utils/loginAnomalyDetector.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { isLegacyPhoneAuthAllowed } from '../../utils/authCompatibilityGates.js';
import { logSecurityEvent } from '../../utils/securityAuditLogger.js';
import { blacklistToken, isTokenBlacklisted, revokeAllUserTokens } from '../../utils/tokenBlacklist.js';
import { generateChallengeToken } from '../../utils/totpUtils.js';
import * as firebaseAuthService from './firebaseAuthService.js';
import { issueAccessTokenAndClaimSession, generateRefreshToken } from './loginSessionHelper.js';
import * as otpService from './otpService.js';

// ✅ Use your real Firebase service

// Password-reset OTPs are hashed before storage (B0.3 / SEC-1). Bcrypt cost is
// kept low because OTPs are short-lived — mirrors OTP_HASH_ROUNDS in
// services/otpService.js and services/auth/otpService.js so every OTP surface
// uses the same cost. Verifiers detect a $2-prefixed value and bcrypt.compare;
// any in-flight legacy plaintext row still matches via the === fallback.
const OTP_HASH_ROUNDS = 6;

// Lock a single password-reset OTP after this many failed verify attempts
// (matches SECURITY_CONFIG.otp.maxAttemptsPerPhone). Once locked the row is
// marked used so the admin must request a fresh OTP — blocks online guessing
// of the 6-digit code.
const PASSWORD_RESET_OTP_MAX_ATTEMPTS = 5;

export class AuthService {
  /* ======================= Firebase (pass-through) ======================= */
  static async authenticateWithFirebase(idToken, deviceInfo, req, opts = {}) {
    return firebaseAuthService.authenticateWithFirebase(idToken, deviceInfo, req, opts);
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
      const now = new Date();

      // Upsert: create if new, update last_login if existing
      const user = await prisma.users.upsert({
        where: { phone: normalizedPhone },
        create: {
          phone: normalizedPhone,
          role: 'PATIENT',
          registered_at: now,
          updated_at: now,
        },
        update: { updated_at: now },
        select: { uid: true, id: true, name: true, phone: true, role: true },
      });

      if (isNewUser) {
        logger.info(`New user registered: ${maskPhoneForLog(normalizedPhone)}`);
      }

      const token = generateToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      // C-9 (audit 2026-06-18): issue a separate type:'refresh' token so the
      // access token is never the refresh credential.
      const refreshToken = this._generateRefreshToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        refreshToken,
        user: {
          uid: user.uid,
          id: user.id,
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
      if (!user) {
        const err = new Error('User not found');
        err.statusCode = HTTP_STATUS.NOT_FOUND;
        throw err;
      }

      const token = generateToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      // C-9 (audit 2026-06-18): issue a separate type:'refresh' token.
      const refreshToken = this._generateRefreshToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        refreshToken,
        user: {
          uid: user.uid,
          id: user.id,
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
  static async adminLogin(identity, password, req, { deviceType } = {}) {
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

      // 2FA check: if TOTP is enabled, return a challenge instead of a JWT.
      // FAIL CLOSED (audit 2026-06-18 §3): a 2FA-enabled admin must NEVER be
      // downgraded to password-only because the challenge could not be
      // persisted. If the challenge-store write fails we abort the login with
      // a 503 — we never fall through to issue a full admin JWT.
      if (admin.totp_enabled) {
        const { challengeToken, expiresAt } = generateChallengeToken();

        try {
          await prisma.$queryRawUnsafe(
            `INSERT INTO totp_challenges (admin_id, challenge_token, expires_at, created_at)
             VALUES ($1, $2, $3, NOW())`,
            admin.uid, challengeToken, expiresAt
          );
        } catch (challengeErr) {
          logger.error('TOTP challenge persistence failed — failing CLOSED (no JWT issued)', {
            adminId: admin.uid,
            error: challengeErr.message,
          });
          logSecurityEvent('MFA_CHALLENGE_STORE_FAILED', {
            userId: admin.uid,
            userName: admin.username,
            userRole: admin.role,
            reason: 'TOTP challenge could not be persisted; login aborted (fail-closed)',
          });
          throw new AppError(
            'Two-factor authentication is temporarily unavailable. Please try again.',
            503,
            'MFA_UNAVAILABLE',
          );
        }

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

      // Issue the admin JWT and register it as the single active session for
      // this admin. Any previously-active admin session is blacklisted and a
      // `session:revoked` event is pushed to that admin's WS sockets — so a
      // second browser tab / device is bounced to login.
      const { accessToken: token } = await issueAccessTokenAndClaimSession({
        userUid: admin.uid,
        tokenPayload: {
          uid: admin.uid,
          role: String(admin.role).toUpperCase(),
          email: admin.email ?? undefined,
          sub: admin.uid,
          iss: 'vh-health-backend',
          aud: 'vh-health-admin',
        },
        expiresIn: SECURITY_CONFIG.jwt.adminExpiry,
        deviceType,
        req,
      });

      // C-9 (audit 2026-06-18): issue a separate type:'refresh' token. Admins
      // previously got no refresh token, so the short-lived admin access token
      // was being replayed at /refresh-token. The refresh endpoint now only
      // accepts type:'refresh' tokens.
      const refreshToken = this._generateRefreshToken({
        uid: admin.uid,
        role: String(admin.role).toUpperCase(),
      });

      return {
        token,
        refreshToken,
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

      // B0.3 / SEC-1: never persist the plaintext OTP — store a bcrypt hash so
      // a DB read cannot reveal a live admin password-reset code. The plaintext
      // is only returned below for delivery (and only in development).
      const otpHash = await bcrypt.hash(otp, OTP_HASH_ROUNDS);

      await prisma.password_reset_otps.create({
        data: {
          user_id: admin.uid,
          otp: otpHash,
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
      // ── Phase 0 (plain prisma): identify admin, find the live OTP, verify it,
      // and count failed attempts. The attempt increment / lock MUST happen
      // outside the transaction — a throw inside $transaction would roll the
      // counter back, defeating the lockout. Only the password mutation needs
      // transactional atomicity (Phase 1 below).
      const admin = await prisma.admins.findFirst({
        where: {
          OR: [
            { username: { equals: identity, mode: 'insensitive' } },
            { email: { equals: identity, mode: 'insensitive' } },
          ],
        },
        select: { uid: true },
      });
      if (!admin) throw new Error('Admin not found');

      // B0.3 / SEC-1: fetch the latest live OTP row by user_id ONLY — never by
      // `otp`, because the stored value is now a bcrypt hash and a
      // plaintext-equality match would never succeed (and matching by hash
      // input is impossible). We compare the supplied code against the hash
      // with a timing-safe bcrypt.compare.
      const otpRecord = await prisma.password_reset_otps.findFirst({
        where: {
          user_id: admin.uid,
          expires_at: { gt: new Date() },
          used: false,
        },
        orderBy: { created_at: 'desc' },
        select: { id: true, otp: true, attempts: true },
      });
      if (!otpRecord) throw new Error('Invalid or expired OTP');

      // Timing-safe comparison for hashed OTPs; the plaintext branch only
      // matches legacy rows written before B0.3 hashing (they expire within
      // minutes) so in-flight resets keep working during rollout.
      const otpMatches = typeof otpRecord.otp === 'string' && otpRecord.otp.startsWith('$2')
        ? await bcrypt.compare(otp, otpRecord.otp)
        : otpRecord.otp === otp;

      if (!otpMatches) {
        // Count this failure; once the per-OTP cap is reached, burn the OTP
        // (mark used) so an attacker cannot keep guessing the 6-digit code.
        const newAttempts = (otpRecord.attempts ?? 0) + 1;
        await prisma.password_reset_otps.update({
          where: { id: otpRecord.id },
          data: {
            attempts: newAttempts,
            ...(newAttempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS && { used: true }),
          },
        });
        if (newAttempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS) {
          throw new Error('Too many invalid attempts. Please request a new OTP.');
        }
        throw new Error('Invalid or expired OTP');
      }

      const newHash = await bcrypt.hash(newPassword, 10);

      // ── Phase 1 (transaction): rotate the password and burn the OTP
      // atomically, scoped so the OTP can only be consumed once even under
      // concurrent requests (used=false guard in the conditional update).
      return await prisma.$transaction(async (tx) => {
        const burned = await tx.password_reset_otps.updateMany({
          where: { id: otpRecord.id, used: false },
          data: { used: true },
        });
        // Lost the race (another concurrent reset already consumed this OTP).
        if (burned.count === 0) throw new Error('Invalid or expired OTP');

        await tx.admins.update({
          where: { uid: admin.uid },
          data: { password_hash: newHash, password_changed_at: new Date() },
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

  static async listAdmins(filters = {}) {
    try {
      const sortFields = {
        name: 'name',
        username: 'username',
        email: 'email',
        role: 'role',
        status: 'status',
        created_at: 'created_at',
        last_login: 'last_login',
      };
      const listQuery = parseListQuery(filters, {
        defaultLimit: 20,
        maxLimit: 100,
        defaultSortBy: 'created_at',
        defaultSortOrder: 'DESC',
        allowedSortFields: Object.keys(sortFields),
      });
      const where = {};
      if (listQuery.search) {
        where.OR = [
          { name: { contains: listQuery.search, mode: 'insensitive' } },
          { username: { contains: listQuery.search, mode: 'insensitive' } },
          { email: { contains: listQuery.search, mode: 'insensitive' } },
        ];
      }
      if (filters.role) {
        where.role = String(filters.role).toUpperCase();
      }
      if (filters.status) {
        where.status = String(filters.status).toLowerCase();
      }

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
          where,
          orderBy: { [sortFields[listQuery.sortBy]]: listQuery.sortOrder.toLowerCase() },
          skip: listQuery.offset,
          take: listQuery.limit,
        }),
        prisma.admins.count({ where }),
      ]);

      return {
        admins: admins.map((a) => ({ ...a })),  // uid is already the PK
        pagination: buildPagination(total, listQuery.page, listQuery.limit),
        filters: {
          search: listQuery.search || null,
          role: filters.role || null,
          status: filters.status || null,
          sortBy: listQuery.sortBy,
          sortOrder: listQuery.sortOrder,
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

  // Mint a long-lived refresh token (type:'refresh') for a patient/admin
  // session. Delegates to the SHARED loginSessionHelper.generateRefreshToken so
  // every realm — patient OTP, admin, and the Firebase patient path — mints
  // through one source of truth (no duplicated `type:'refresh'` / expiry logic
  // that could drift). See audit 2026-06-18 C-9.
  static _generateRefreshToken({ uid, id, phone, role }) {
    return generateRefreshToken({ uid, id, phone, role });
  }

  static async refreshToken(token, req) {
    try {
      // C-9 (audit 2026-06-18): the refresh endpoint must ONLY accept genuine
      // refresh tokens. Verify signature + expiry — a real 30-day refresh
      // token that has expired means the session is genuinely over, so we do
      // NOT use verifyTokenAllowExpired here (that previously let any signed,
      // even expired, ACCESS token be rotated into a fresh live session).
      const decoded = verifyToken(token);
      if (!decoded) throw AppError.unauthorized('Invalid or expired refresh token', 'TOKEN_INVALID');

      // Type confusion guard: reject access tokens (which carry no `type`
      // claim) presented at the refresh endpoint. Only `type:'refresh'`
      // tokens minted at login may rotate a session.
      if (decoded.type !== 'refresh') {
        throw AppError.unauthorized('Invalid or expired refresh token', 'TOKEN_INVALID');
      }

      // Replay protection: a logged-out / already-rotated refresh token whose
      // jti is blacklisted must not mint new tokens.
      if (decoded.jti && await isTokenBlacklisted(decoded.jti)) {
        throw AppError.tokenRevoked();
      }

      // A genuine refresh token carries the uid in `sub` — jwtUtils.generateToken
      // maps uid -> sub, so a real token has NO top-level `uid` claim (only
      // test-minted tokens set one). Resolve the subject the same way
      // jwtMiddleware does, or the lookup runs against `undefined` and every
      // real refresh 401s with "user not found" (i.e. refresh never works).
      const subjectUid = decoded.uid ?? decoded.sub;
      const user = subjectUid
        ? await prisma.users.findUnique({
            where: { uid: subjectUid },
            select: { uid: true, id: true, phone: true, name: true, role: true },
          })
        : null;
      if (!user) throw AppError.unauthorized('User not found', 'TOKEN_INVALID');

      // Rotate the refresh token: blacklist the presented refresh jti so it
      // cannot be replayed. For tokens already past exp, blacklistToken
      // short-circuits.
      if (decoded.jti && decoded.exp) {
        await blacklistToken(decoded.jti, decoded.exp, 'refresh_rotation');
      }

      // Mint a fresh access token *and* rotate the user_active_sessions row
      // to its jti. Without this update a subsequent login-elsewhere would
      // blacklist the *original* login's jti (whatever's still in the table)
      // instead of the refreshed one, and the booted device would survive.
      // `pushRevoked: false` because this is the same logical session — the
      // device must NOT receive its own session:revoked event.
      const { accessToken: newToken } = await issueAccessTokenAndClaimSession({
        userUid: user.uid,
        tokenPayload: {
          uid: user.uid,
          id: user.id,
          phone: user.phone,
          role: user.role,
        },
        deviceType: decoded.deviceType,
        req,
        pushRevoked: false,
      });

      // Issue a fresh refresh token too (rotation) so the client always holds
      // a current refresh credential and the old one is dead.
      const newRefreshToken = this._generateRefreshToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return {
        token: newToken,
        refreshToken: newRefreshToken,
        user: {
          uid: user.uid,
          id: user.id,
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
        select: { uid: true, id: true, phone: true, name: true, role: true },
      });
      return user || null;
    } catch (error) {
      logger.error('Get user by phone error:', error);
      throw error;
    }
  }

  // The legacy phone-only login/register issues a usable JWT with NO OTP,
  // password, or any verification. It is disabled by default everywhere and
  // may only be enabled for an explicit local compatibility harness outside
  // production. Production patient login is Firebase OTP via
  // POST /api/v1/auth/firebase/firebase-login.
  // Finding 2026-05-22-walk-in-opd-patient-36657889.
  static _assertLegacyPhoneAuthAllowed(action) {
    if (!isLegacyPhoneAuthAllowed()) {
      const err = new Error(
        `Phone-only ${action} is disabled. Use OTP login `
        + '(POST /api/v1/auth/firebase/firebase-login).',
      );
      err.statusCode = HTTP_STATUS.FORBIDDEN;
      err.code = 'PHONE_AUTH_DISABLED';
      throw err;
    }
  }

  static async legacyLogin(phone, _req) {
    this._assertLegacyPhoneAuthAllowed('login');
    return this.directOtpLogin(phone);
  }

  static async legacyRegister(phone, _req) {
    try {
      this._assertLegacyPhoneAuthAllowed('registration');
      const normalizedPhone = normalizePhone(phone);

      const existingUser = await prisma.users.findUnique({
        where: { phone: normalizedPhone },
        select: { uid: true },
      });

      if (existingUser) {
        const err = new Error('User already exists');
        err.statusCode = HTTP_STATUS.CONFLICT;
        throw err;
      }
      const now = new Date();

      const user = await prisma.users.create({
        data: {
          phone: normalizedPhone,
          role: 'PATIENT',
          registered_at: now,
          updated_at: now,
        },
        select: { uid: true, id: true, phone: true, role: true },
      });

      const token = generateToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        user: {
          uid: user.uid,
          id: user.id,
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
        pagination: buildPagination(total, page, limit),
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
      const now = new Date();

      const user = await prisma.users.upsert({
        where: { phone: normalizedPhone },
        create: {
          phone: normalizedPhone,
          role: 'PATIENT',
          registered_at: now,
          updated_at: now,
        },
        update: { updated_at: now },
        select: { uid: true, id: true, name: true, phone: true, role: true },
      });

      if (isNewUser) {
        logger.info(`New user registered: ${maskPhoneForLog(normalizedPhone)}`);
      }

      const token = generateToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      // C-9 (audit 2026-06-18): issue a SEPARATE refresh token. Patients
      // previously got no refresh token, so the access token was being used as
      // the refresh credential at /refresh-token. The refresh endpoint now
      // only accepts type:'refresh' tokens.
      const refreshToken = this._generateRefreshToken({
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return {
        token,
        refreshToken,
        user: {
          uid: user.uid,
          id: user.id,
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
