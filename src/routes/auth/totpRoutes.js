// src/routes/auth/totpRoutes.js
// TOTP Two-Factor Authentication routes for admin accounts.

import bcrypt from 'bcrypt';
import { Router } from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { generateToken } from '../../utils/jwtUtils.js';
import { success, error } from '../../utils/responseHelper.js';
import { logSecurityEvent } from '../../utils/securityAuditLogger.js';
import { generateTotpSetup, verifyTotp, generateBackupCodes } from '../../utils/totpUtils.js';

const router = Router();

/**
 * POST /auth/admin/totp/setup
 * Begin TOTP setup — returns QR code and backup codes.
 * Requires admin to be authenticated.
 */
router.post('/setup', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const adminId = String(req.user?.uid ?? "");
    const admin = await prisma.admins.findUnique({
      where: { uid: adminId },
      select: { id: true, username: true, totp_enabled: true },
    });

    if (!admin) return error(res, 'Admin not found', HTTP_STATUS.NOT_FOUND);
    if (admin.totp_enabled) return error(res, '2FA is already enabled. Disable it first.', HTTP_STATUS.CONFLICT);

    const setup = await generateTotpSetup(admin.username);
    const backupCodes = generateBackupCodes();

    // Store encrypted secret and hashed backup codes (not yet enabled)
    const hashedCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    await prisma.admins.update({
      where: { uid: adminId },
      data: {
        totp_secret: setup.encryptedSecret,
        totp_backup_codes: hashedCodes,
        // NOT enabled yet — requires verification
      },
    });

    logger.info('TOTP setup initiated', { adminId });

    return success(res, {
      qrCodeDataUrl: setup.qrCodeDataUrl,
      otpauthUrl: setup.otpauthUrl,
      backupCodes, // Show ONCE — user must save these
    }, 'Scan the QR code with your authenticator app, then verify with a code');
  } catch (err) {
    logger.error('TOTP setup error:', err);
    return error(res, 'Failed to set up 2FA', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * POST /auth/admin/totp/setup/verify
 * Confirm TOTP setup by verifying a code from the authenticator app.
 * Body: { code: "123456" }
 */
router.post('/setup/verify', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const adminId = String(req.user?.uid ?? "");
    const { code } = req.body;

    if (!code || code.length !== 6) {
      return error(res, 'A 6-digit verification code is required', HTTP_STATUS.BAD_REQUEST);
    }

    const admin = await prisma.admins.findUnique({
      where: { uid: adminId },
      select: { id: true, totp_secret: true, totp_enabled: true },
    });

    if (!admin || !admin.totp_secret) {
      return error(res, 'TOTP setup not initiated. Call /setup first.', HTTP_STATUS.BAD_REQUEST);
    }
    if (admin.totp_enabled) {
      return error(res, '2FA is already enabled', HTTP_STATUS.CONFLICT);
    }

    const isValid = await verifyTotp(code, admin.totp_secret);
    if (!isValid) {
      return error(res, 'Invalid verification code. Try again.', HTTP_STATUS.UNAUTHORIZED);
    }

    await prisma.admins.update({
      where: { uid: adminId },
      data: {
        totp_enabled: true,
        totp_enabled_at: new Date(),
      },
    });

    logSecurityEvent('TOTP_ENABLED', {
      userId: String(adminId),
      userRole: req.user?.role,
    });

    logger.info('TOTP setup verified and enabled', { adminId });

    return success(res, { enabled: true }, '2FA has been enabled successfully');
  } catch (err) {
    logger.error('TOTP verify error:', err);
    return error(res, 'Failed to verify 2FA setup', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * POST /auth/admin/totp/disable
 * Disable TOTP. Requires current password for security.
 * Body: { password: "current_password" }
 */
router.post('/disable', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const adminId = String(req.user?.uid ?? "");
    const { password } = req.body;

    if (!password) return error(res, 'Current password is required to disable 2FA', HTTP_STATUS.BAD_REQUEST);

    const admin = await prisma.admins.findUnique({
      where: { uid: adminId },
      select: { id: true, password_hash: true, totp_enabled: true },
    });

    if (!admin) return error(res, 'Admin not found', HTTP_STATUS.NOT_FOUND);
    if (!admin.totp_enabled) return error(res, '2FA is not enabled', HTTP_STATUS.BAD_REQUEST);

    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) return error(res, 'Invalid password', HTTP_STATUS.UNAUTHORIZED);

    await prisma.admins.update({
      where: { uid: adminId },
      data: {
        totp_enabled: false,
        totp_secret: null,
        totp_backup_codes: [],
        totp_enabled_at: null,
      },
    });

    logSecurityEvent('TOTP_DISABLED', {
      userId: String(adminId),
      userRole: req.user?.role,
    });

    logger.info('TOTP disabled', { adminId });

    return success(res, { enabled: false }, '2FA has been disabled');
  } catch (err) {
    logger.error('TOTP disable error:', err);
    return error(res, 'Failed to disable 2FA', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * POST /auth/admin/totp/verify
 * Verify a TOTP code during login (2FA step 2).
 * Body: { challengeToken: "...", code: "123456" }
 *
 * This is called after the initial login returns a challenge
 * instead of a JWT (when TOTP is enabled).
 */
router.post('/verify', async (req, res) => {
  try {
    const { challengeToken, code } = req.body;

    if (!challengeToken || !code) {
      return error(res, 'Challenge token and 6-digit code are required', HTTP_STATUS.BAD_REQUEST);
    }

    // Look up the challenge
    const challenge = await prisma.$queryRawUnsafe(
      `SELECT id, admin_id, expires_at, used FROM totp_challenges
       WHERE challenge_token = $1 AND used = false AND expires_at > NOW()`,
      [challengeToken]
    );

    if (challenge.length === 0) {
      return error(res, 'Invalid or expired challenge. Please log in again.', HTTP_STATUS.UNAUTHORIZED);
    }

    const ch = challenge[0];

    // Get the admin's TOTP secret
    const admin = await prisma.admins.findUnique({
      where: { id: ch.admin_id },
      select: { id: true, username: true, email: true, role: true, totp_secret: true, totp_backup_codes: true },
    });

    if (!admin || !admin.totp_secret) {
      return error(res, 'TOTP not configured', HTTP_STATUS.BAD_REQUEST);
    }

    // Try TOTP code first
    let isValid = await verifyTotp(code, admin.totp_secret);

    // If TOTP fails, try backup codes
    if (!isValid && admin.totp_backup_codes?.length > 0) {
      for (let i = 0; i < admin.totp_backup_codes.length; i++) {
        const match = await bcrypt.compare(code, admin.totp_backup_codes[i]);
        if (match) {
          isValid = true;
          // Remove used backup code
          const updatedCodes = [...admin.totp_backup_codes];
          updatedCodes.splice(i, 1);
          await prisma.admins.update({
            where: { id: admin.id },
            data: { totp_backup_codes: updatedCodes },
          });
          logger.info('Backup code used for 2FA', { adminId: admin.id, remainingCodes: updatedCodes.length });
          break;
        }
      }
    }

    if (!isValid) {
      logSecurityEvent('TOTP_VERIFICATION_FAILED', {
        userId: String(admin.id),
        userRole: admin.role,
      });
      return error(res, 'Invalid verification code', HTTP_STATUS.UNAUTHORIZED);
    }

    // Mark challenge as used
    await prisma.$queryRawUnsafe(
      `UPDATE totp_challenges SET used = true WHERE id = $1`,
      [ch.id]
    );

    // Issue the full JWT
    const token = generateToken({
      uid: String(admin.id),
      role: String(admin.role).toUpperCase(),
      email: admin.email ?? undefined,
      sub: String(admin.id),
      iss: 'vh-health-backend',
      aud: 'vh-health-admin',
      mfa: true, // Flag that 2FA was completed
    }, SECURITY_CONFIG.jwt.adminExpiry);

    logSecurityEvent('TOTP_VERIFICATION_SUCCESS', {
      userId: String(admin.id),
      userRole: admin.role,
    });

    return success(res, {
      token,
      admin: {
        uid: admin.id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
      },
    }, 'Two-factor authentication successful');
  } catch (err) {
    logger.error('TOTP verification error:', err);
    return error(res, 'Failed to verify 2FA code', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
