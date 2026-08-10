// src/controllers/auth/adminAuthController.js

import bcrypt from 'bcrypt';
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AuthService } from '../../services/auth/authService.js';
import { StaffAuthService } from '../../services/auth/staffAuthService.js';
import {
  generateRefreshToken,
  issueAccessTokenAndClaimSession,
  resolveTenantIdForUid,
} from '../../services/auth/loginSessionHelper.js';
import { success, error } from '../../utils/responseHelper.js';
import {
  generateTotpSetup,
  verifyTotp,
  generateBackupCodes,
} from '../../utils/totpUtils.js';
import { parseListQuery } from '../../utils/listQuery.js';

/* util: pick username OR email from body */
const pickIdentity = (body) => (body?.username?.trim() || body?.email?.trim() || null);

const validationError = (res, errors) => error(
  res,
  RESPONSE_MESSAGES.VALIDATION_FAILED,
  HTTP_STATUS.BAD_REQUEST,
  { topLevel: { errors: errors.array() } },
);

/* ----------------------------- LOGIN ------------------------------ */
// Admin login (username OR email + password)
export const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const identity = pickIdentity(req.body);
    const { password, deviceType } = req.body;

    const result = await AuthService.adminLogin(identity, password, req, { deviceType });
    if (result?.requiresMfaSetup) {
      logger.info(`Admin login requires MFA setup: ${identity}`);
      return success(res, result, 'MFA setup required before full access');
    }
    if (result?.requiresTwoFactor) {
      logger.info(`Admin login requires MFA challenge: ${identity}`);
      return success(res, result, 'MFA challenge issued');
    }
    logger.info(`Admin login successful: ${identity}`);
    return success(res, result, 'Admin login successful');
  } catch (err) {
    logger.error('[AdminLogin]:', err);
    if (err?.message === 'Invalid credentials') {
      return error(res, 'Invalid username or password', HTTP_STATUS.UNAUTHORIZED);
    }
    return error(res, 'Admin login failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ----------------------- PASSWORD: FORGOT/RESET ------------------- */
// Request password reset (send OTP)
export const forgotPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const identity = pickIdentity(req.body);
    const result = await AuthService.adminForgotPassword(identity);
    return success(res, result, 'Password reset OTP sent successfully');
  } catch (err) {
    logger.error('[ForgotPassword]:', err);
    return error(res, 'Failed to send password reset OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Reset password with OTP
export const resetPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const identity = pickIdentity(req.body);
    const { otp, newPassword } = req.body;

    const result = await AuthService.adminResetPassword(identity, otp, newPassword);
    return success(res, result, 'Password reset successfully');
  } catch (err) {
    logger.error('[ResetPassword]:', err);
    return error(res, 'Failed to reset password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ---------------------------- CHANGE PWD -------------------------- */
export const changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Admin not authenticated', HTTP_STATUS.UNAUTHORIZED);

    const result = await AuthService.changeAdminPassword(adminId, currentPassword, newPassword);
    logger.info(`Admin password changed: ${adminId}`);
    return success(res, result, 'Password changed successfully');
  } catch (err) {
    logger.error('[ChangeAdminPassword]:', err);
    if (err?.message === 'Current password is incorrect') {
      return error(res, 'Current password is incorrect', HTTP_STATUS.UNAUTHORIZED);
    }
    return error(res, 'Failed to change password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ------------------------------ PROFILE --------------------------- */
export const getProfile = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Admin not authenticated', HTTP_STATUS.UNAUTHORIZED);

    const result = await AuthService.getAdminProfile(adminId);
    return success(res, result, 'Profile retrieved successfully');
  } catch (err) {
    logger.error('[GetProfile]:', err);
    return error(res, 'Failed to get profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ------------------------------ HEALTH ---------------------------- */
export const getHealthStatus = async (req, res) => {
  try {
    const healthData = await AuthService.getAdminAuthHealth();
    return success(res, healthData, 'Admin authentication service is healthy');
  } catch (err) {
    logger.error('[HealthCheck]:', err);
    return error(res, 'Admin authentication service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* -------------------------- ACTIVITY LOGS ------------------------- */
export const getAdminActivityLogs = async (req, res) => {
  try {
    const adminId = String(req.params.adminId);
    const listQuery = parseListQuery(req.query, {
      defaultLimit: 50,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const result = await AuthService.getAdminActivityLogs(adminId, {
      page: listQuery.page,
      limit: listQuery.limit
    });
    return success(res, result, 'Activity logs retrieved successfully');
  } catch (err) {
    logger.error('[GetActivityLogs]:', err);
    return error(res, 'Failed to get activity logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ------------------------- PERMISSIONS MGMT ----------------------- */
export const updatePermissions = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const adminId = String(req.body.adminId);
    const { permissions } = req.body;
    const updatedBy = req.user?.uid;

    const result = await AuthService.updateAdminPermissions(adminId, permissions, updatedBy);
    return success(res, result, 'Permissions updated successfully');
  } catch (err) {
    logger.error('[UpdatePermissions]:', err);
    return error(res, 'Failed to update permissions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ----------------------------- CRUD ADMIN ------------------------- */
export const createAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const adminData = req.body;
    const createdBy = req.user?.uid;

    const result = await AuthService.createAdmin({ ...adminData, createdBy });
    logger.info(`New admin created: ${adminData?.username || adminData?.email} by ${createdBy}`);
    return success(res, result, 'Admin account created successfully');
  } catch (err) {
    logger.error('[CreateAdmin]:', err);
    if (String(err?.message || '').includes('already exists')) {
      return error(res, 'Admin account already exists', HTTP_STATUS.CONFLICT);
    }
    return error(res, 'Failed to create admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const listAdmins = async (req, res) => {
  try {
    const result = await AuthService.listAdmins(req.query);
    return success(res, result, 'Admins retrieved successfully');
  } catch (err) {
    logger.error('[ListAdmins]:', err);
    return error(res, 'Failed to retrieve admins', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deactivateAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const adminId = String(req.body.adminId);
    const { reason } = req.body;
    const deactivatedBy = req.user?.uid;

    if (adminId === deactivatedBy) {
      return error(res, 'Cannot deactivate your own account', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await AuthService.deactivateAdmin(adminId, reason, deactivatedBy);
    logger.info(`Admin deactivated: ${adminId} by ${deactivatedBy}`);
    return success(res, result, 'Admin account deactivated successfully');
  } catch (err) {
    logger.error('[DeactivateAdmin]:', err);
    if (err?.message === 'Admin not found') {
      return error(res, 'Admin not found', HTTP_STATUS.NOT_FOUND);
    }
    if (err?.message === 'SCIM_OWNED_FIELD_OVERRIDE_REQUIRED') {
      return error(res, 'SCIM-owned admin status requires an explicit override reason', HTTP_STATUS.CONFLICT, err.details);
    }
    return error(res, 'Failed to deactivate admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const reactivateAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return validationError(res, errors);
  }

  try {
    const adminId = String(req.body.adminId);
    const reactivatedBy = req.user?.uid;
    const overrideReason = req.body.reason || req.body.scimOverrideReason || req.body.identityOverrideReason || null;

    const result = await AuthService.reactivateAdmin(adminId, reactivatedBy, overrideReason);
    logger.info(`Admin reactivated: ${adminId} by ${reactivatedBy}`);
    return success(res, result, 'Admin account reactivated successfully');
  } catch (err) {
    logger.error('[ReactivateAdmin]:', err);
    if (err?.message === 'Admin not found') {
      return error(res, 'Admin not found', HTTP_STATUS.NOT_FOUND);
    }
    if (err?.message === 'SCIM_OWNED_FIELD_OVERRIDE_REQUIRED') {
      return error(res, 'SCIM-owned admin status requires an explicit override reason', HTTP_STATUS.CONFLICT, err.details);
    }
    return error(res, 'Failed to reactivate admin account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* -------------------- REVOKE ALL SESSIONS ----------------------- */
export const revokeAllSessions = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return error(res, 'User ID is required', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await StaffAuthService.revokeAllSessions(parseInt(userId, 10));
    logger.info(`Admin ${req.user?.uid} revoked all sessions for user ${userId}`);
    return success(res, result, `Revoked ${result.revokedCount} session(s)`);
  } catch (err) {
    logger.error('Revoke all sessions error:', err);
    return error(res, 'Failed to revoke sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/* ================================================================== */
/* =========================== MFA / 2FA ============================ */
/* ================================================================== */
// TOTP (Time-based One-Time Password) via an authenticator app. Supporting
// infra is already in place:
//   * src/utils/totpUtils.js            — secret gen, QR, encryption, verify
//   * src/services/auth/authService.js  — login returns challenge when totp_enabled
//   * migrations 023, 026, 032          — totp_challenges table + admins columns
//
// These endpoints complete the flow for the admin portal.

const BCRYPT_ROUNDS = 10;

/**
 * POST /auth/admin/mfa/enroll — (authed)
 * Starts enrollment for the caller. Returns QR data URL + otpauth URL +
 * fresh backup codes. `totp_enabled` is NOT flipped until the admin proves
 * possession via /mfa/verify-setup.
 */
export const mfaEnroll = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const admin = await prisma.admins.findUnique({
      where: { uid: String(adminId) },
      select: { username: true, email: true, totp_enabled: true },
    });
    if (!admin) return error(res, 'Admin not found', HTTP_STATUS.NOT_FOUND);
    if (admin.totp_enabled) {
      return error(res, 'MFA is already enabled. Disable it first to re-enroll.', HTTP_STATUS.CONFLICT);
    }

    const label = admin.username || admin.email || adminId;
    const { encryptedSecret, qrCodeDataUrl, otpauthUrl } = await generateTotpSetup(label);

    // Hash backup codes before storage so even a DB leak cannot reuse them.
    const plainCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(
      plainCodes.map((c) => bcrypt.hash(c, BCRYPT_ROUNDS))
    );

    await prisma.admins.update({
      where: { uid: String(adminId) },
      data: {
        totp_secret_encrypted: encryptedSecret,
        totp_backup_codes: hashedCodes,
        totp_enabled: false,        // flipped on successful verify-setup
        totp_enrolled_at: null,
      },
    });

    logger.info('Admin MFA enrollment started', { adminId });
    return success(res, {
      qrCodeDataUrl,
      otpauthUrl,
      backupCodes: plainCodes,      // show ONCE in the UI — never returned again
      next: 'Confirm a code from your authenticator at /auth/admin/mfa/verify-setup',
    }, 'MFA enrollment initialised');
  } catch (err) {
    logger.error('[MFA Enroll]', err);
    return error(res, 'Failed to start MFA enrollment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * POST /auth/admin/mfa/verify-setup — (authed)
 * Verifies the first TOTP code and flips `totp_enabled = true`. After this
 * call, subsequent logins for this admin will return a challenge instead of
 * a JWT.
 */
export const mfaVerifySetup = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { code } = req.body || {};
    if (!code || !/^\d{6}$/.test(String(code))) {
      return error(res, 'Provide a 6-digit authenticator code', HTTP_STATUS.BAD_REQUEST);
    }

    const admin = await prisma.admins.findUnique({
      where: { uid: String(adminId) },
      select: { totp_secret_encrypted: true, totp_enabled: true },
    });
    if (!admin?.totp_secret_encrypted) {
      return error(res, 'No MFA enrollment in progress. Call /mfa/enroll first.', HTTP_STATUS.BAD_REQUEST);
    }
    if (admin.totp_enabled) {
      return error(res, 'MFA is already enabled.', HTTP_STATUS.CONFLICT);
    }

    const ok = await verifyTotp(String(code), admin.totp_secret_encrypted);
    if (!ok) {
      return error(res, 'Invalid authenticator code', HTTP_STATUS.UNAUTHORIZED);
    }

    // Sol Ultra #21: the totp_enabled pre-check above is TOCTOU — a concurrent
    // or replayed setup-confirm could both pass it and the second write would
    // overwrite the first-enrolled factor. Make the false->true transition
    // atomic by putting the state predicate INTO the write; a lost race /
    // replay updates 0 rows and is rejected before any session is issued.
    const enabled = await prisma.admins.updateMany({
      where: { uid: String(adminId), totp_enabled: false },
      data: { totp_enabled: true, totp_enrolled_at: new Date() },
    });
    if (enabled.count !== 1) {
      return error(res, 'MFA is already enabled.', HTTP_STATUS.CONFLICT);
    }

    logger.info('Admin MFA enabled', { adminId });
    return success(res, { enabled: true }, 'MFA enabled');
  } catch (err) {
    logger.error('[MFA VerifySetup]', err);
    return error(res, 'Failed to verify MFA code', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * POST /auth/admin/mfa/disable — (authed)
 * Disables MFA. Requires both the admin's current password and a current
 * TOTP code to prevent a session-hijack from silently turning off 2FA.
 */
export const mfaDisable = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { currentPassword, code } = req.body || {};
    if (!currentPassword || !code) {
      return error(res, 'currentPassword and code are required', HTTP_STATUS.BAD_REQUEST);
    }

    const admin = await prisma.admins.findUnique({
      where: { uid: String(adminId) },
      select: { password_hash: true, totp_enabled: true, totp_secret_encrypted: true },
    });
    if (!admin) return error(res, 'Admin not found', HTTP_STATUS.NOT_FOUND);
    if (!admin.totp_enabled || !admin.totp_secret_encrypted) {
      return error(res, 'MFA is not currently enabled', HTTP_STATUS.BAD_REQUEST);
    }

    const pwOk = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!pwOk) return error(res, 'Incorrect password', HTTP_STATUS.UNAUTHORIZED);

    const totpOk = await verifyTotp(String(code), admin.totp_secret_encrypted);
    if (!totpOk) return error(res, 'Invalid authenticator code', HTTP_STATUS.UNAUTHORIZED);

    await prisma.admins.update({
      where: { uid: String(adminId) },
      data: {
        totp_enabled: false,
        totp_secret_encrypted: null,
        totp_backup_codes: null,
        totp_enrolled_at: null,
      },
    });

    logger.info('Admin MFA disabled', { adminId });
    return success(res, { enabled: false }, 'MFA disabled');
  } catch (err) {
    logger.error('[MFA Disable]', err);
    return error(res, 'Failed to disable MFA', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * POST /auth/admin/mfa/setup-enroll — (auth: setup-scope token)
 * First leg of mandatory-MFA enrollment for SUPER_ADMIN accounts that hit
 * the mfa_setup_required branch in /login. The caller authenticates with the
 * short-lived setup token returned by /login, not a full-access JWT.
 * Returns QR + encrypted secret + plaintext backup codes — the client must
 * echo the encryptedSecret back to /mfa/setup-confirm to finalise enrollment.
 * We deliberately do NOT persist the secret yet — a failed confirm leaves the
 * admin row untouched, so a retry starts cleanly.
 */
export const mfaSetupEnroll = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const admin = await prisma.admins.findUnique({
      where: { uid: String(adminId) },
      select: { username: true, email: true, role: true, totp_enabled: true },
    });
    if (!admin) return error(res, 'Admin not found', HTTP_STATUS.NOT_FOUND);
    if (admin.totp_enabled) {
      return error(res, 'MFA is already enabled on this account.', HTTP_STATUS.CONFLICT);
    }

    const label = admin.username || admin.email || adminId;
    const { encryptedSecret, qrCodeDataUrl, otpauthUrl } = await generateTotpSetup(label);
    const backupCodes = generateBackupCodes();

    logger.info('Admin first-time MFA setup initiated', { adminId });
    return success(res, {
      qrCodeDataUrl,
      otpauthUrl,
      backupCodes,      // shown ONCE — the client must save them before /setup-confirm
      encryptedSecret,  // client echoes this back to /setup-confirm
      next: 'POST the 6-digit code, encryptedSecret, and backupCodes to /auth/admin/mfa/setup-confirm',
    }, 'MFA setup ready');
  } catch (err) {
    logger.error('[MFA SetupEnroll]', err);
    return error(res, 'Failed to start MFA setup', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * POST /auth/admin/mfa/setup-confirm — (auth: setup-scope token)
 * Body: { code, encryptedSecret, backupCodes }
 * Second leg of first-time MFA enrollment. Verifies the TOTP code against
 * the encryptedSecret the client received from /setup-enroll, persists the
 * secret + bcrypt-hashed backup codes, flips totp_enabled=true, and issues a
 * standard full-access JWT — identical to the shape returned by /login.
 */
export const mfaSetupConfirm = async (req, res) => {
  try {
    const adminId = req.user?.uid;
    if (!adminId) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { code, encryptedSecret, backupCodes } = req.body || {};
    if (!code || !/^\d{6}$/.test(String(code))) {
      return error(res, 'Provide a 6-digit authenticator code', HTTP_STATUS.BAD_REQUEST);
    }
    if (!encryptedSecret || typeof encryptedSecret !== 'string') {
      return error(res, 'encryptedSecret is required', HTTP_STATUS.BAD_REQUEST);
    }
    if (!Array.isArray(backupCodes) || backupCodes.length === 0) {
      return error(res, 'backupCodes are required', HTTP_STATUS.BAD_REQUEST);
    }

    const ok = await verifyTotp(String(code), encryptedSecret);
    if (!ok) {
      logger.warn('[MFA SetupConfirm] invalid TOTP code', { adminId });
      return error(res, 'Invalid authenticator code', HTTP_STATUS.UNAUTHORIZED);
    }

    const hashedBackupCodes = await Promise.all(
      backupCodes.map((c) => bcrypt.hash(String(c), BCRYPT_ROUNDS))
    );

    await prisma.admins.update({
      where: { uid: String(adminId) },
      data: {
        totp_secret_encrypted: encryptedSecret,
        totp_backup_codes: hashedBackupCodes,
        totp_enabled: true,
        totp_enrolled_at: new Date(),
      },
    });

    const admin = await prisma.admins.findUnique({
      where: { uid: String(adminId) },
      select: { uid: true, username: true, email: true, role: true },
    });
    if (!admin) return error(res, 'Admin not found after enrollment', HTTP_STATUS.INTERNAL_SERVER_ERROR);

    const { accessToken: token, tokenEpoch } = await issueAccessTokenAndClaimSession({
      userUid: admin.uid,
      tokenPayload: {
        uid: admin.uid,
        role: String(admin.role).toUpperCase(),
        email: admin.email ?? undefined,
        sub: admin.uid,
        iss: 'vh-health-backend',
        aud: 'vh-health-admin',
        tenant_id: await resolveTenantIdForUid(admin.uid),
        // Only these paths prove possession of the admin's second factor.
        mfa: true,
      },
      expiresIn: SECURITY_CONFIG.jwt.adminExpiry,
      deviceType: 'web',
      req,
    });
    const refreshToken = await generateRefreshToken({
      uid: admin.uid,
      role: String(admin.role).toUpperCase(),
      tokenEpoch,
      realm: 'admin',
      mfa: true,
    });

    logger.info('Admin MFA enrolled via first-time setup', { adminId });
    return success(res, {
      token,
      refreshToken,
      admin: {
        uid: admin.uid,
        username: admin.username,
        email: admin.email,
        role: admin.role,
      },
    }, 'MFA enrolled and session established');
  } catch (err) {
    logger.error('[MFA SetupConfirm]', err);
    return error(res, 'Failed to complete MFA setup', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * POST /auth/admin/mfa/challenge/verify — (public, paired with /login)
 * Body: { challengeToken, code, useBackupCode? }
 * Completes the 2FA step after a successful password login. On success
 * returns the admin JWT with the configured admin expiry.
 */
export const mfaVerifyChallenge = async (req, res) => {
  try {
    const { challengeToken, code, useBackupCode = false } = req.body || {};
    if (!challengeToken || !code) {
      return error(res, 'challengeToken and code are required', HTTP_STATUS.BAD_REQUEST);
    }

    // Atomically reserve an attempt on a live challenge (M3 — audit 2026-06-22).
    // A single conditional UPDATE increments attempts only while under the cap, so
    // every verify (success OR failure) consumes one attempt. Previously the
    // challenge was deleted ONLY on success, and there was no counter — so one
    // token could be retried with unlimited codes within its expiry window,
    // making the 6-digit TOTP brute-forceable. count===0 means expired/invalid OR
    // the cap was hit.
    const reserved = await prisma.$queryRawUnsafe(
      `UPDATE totp_challenges
          SET attempts = attempts + 1
        WHERE challenge_token = $1 AND expires_at > NOW() AND attempts < $2
        RETURNING admin_id`,
      challengeToken,
      SECURITY_CONFIG.mfa.challengeMaxAttempts,
    );
    if (reserved.length === 0) {
      // Burn the token so a capped (or expired) challenge can never be retried,
      // and force a fresh login.
      await prisma.$queryRawUnsafe(
        `DELETE FROM totp_challenges WHERE challenge_token = $1`,
        challengeToken,
      );
      return error(res, 'Challenge expired, invalid, or too many attempts. Please log in again.', HTTP_STATUS.UNAUTHORIZED);
    }
    const adminId = reserved[0].admin_id;

    const admin = await prisma.admins.findUnique({
      where: { uid: String(adminId) },
      select: {
        uid: true,
        username: true,
        email: true,
        role: true,
        totp_enabled: true,
        totp_secret_encrypted: true,
        totp_backup_codes: true,
      },
    });
    if (!admin?.totp_enabled || !admin.totp_secret_encrypted) {
      return error(res, 'MFA not configured on this account', HTTP_STATUS.BAD_REQUEST);
    }

    let ok = false;
    if (useBackupCode) {
      const codes = Array.isArray(admin.totp_backup_codes) ? admin.totp_backup_codes : [];
      let matchedIdx = -1;
      for (let i = 0; i < codes.length; i++) {
        const hash = codes[i];
        if (!hash) continue;

        if (await bcrypt.compare(String(code), hash)) {
          matchedIdx = i;
          break;
        }
      }
      if (matchedIdx >= 0) {
        // Consume the code — null it out to prevent reuse.
        const updated = [...codes];
        updated[matchedIdx] = null;
        await prisma.admins.update({
          where: { uid: String(adminId) },
          data: { totp_backup_codes: updated },
        });
        ok = true;
      }
    } else {
      ok = await verifyTotp(String(code), admin.totp_secret_encrypted);
    }

    if (!ok) {
      return error(res, 'Invalid MFA code', HTTP_STATUS.UNAUTHORIZED);
    }

    // Consume the challenge so it can't be replayed.
    await prisma.$queryRawUnsafe(
      `DELETE FROM totp_challenges WHERE challenge_token = $1`,
      challengeToken
    );

    const { accessToken: token, tokenEpoch } = await issueAccessTokenAndClaimSession({
      userUid: admin.uid,
      tokenPayload: {
        uid: admin.uid,
        role: String(admin.role).toUpperCase(),
        email: admin.email ?? undefined,
        sub: admin.uid,
        iss: 'vh-health-backend',
        aud: 'vh-health-admin',
        tenant_id: await resolveTenantIdForUid(admin.uid),
        mfa: true,
      },
      expiresIn: SECURITY_CONFIG.jwt.adminExpiry,
      deviceType: 'web',
      req,
    });
    const refreshToken = await generateRefreshToken({
      uid: admin.uid,
      role: String(admin.role).toUpperCase(),
      tokenEpoch,
      realm: 'admin',
      mfa: true,
    });

    logger.info('Admin MFA challenge verified', { adminId, viaBackup: !!useBackupCode });
    return success(res, {
      token,
      refreshToken,
      admin: {
        uid: admin.uid,
        username: admin.username,
        email: admin.email,
        role: admin.role,
      },
    }, 'MFA verified');
  } catch (err) {
    logger.error('[MFA VerifyChallenge]', err);
    return error(res, 'Failed to verify MFA challenge', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
