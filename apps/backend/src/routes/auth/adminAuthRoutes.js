// src/routes/auth/adminAuthRoutes.js
// Admin Authentication Routes (username/email + password)

import express from 'express';
import { validationResult, body, oneOf, param } from 'express-validator';

import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as adminAuthController from '../../controllers/auth/adminAuthController.js';
import { logout as authLogout } from '../../controllers/auth/authController.js';
import jwtAuth, { requireSetupScope, enforceFullScope } from '../../middleware/jwtMiddleware.js';
import { otpRateLimiter, authRateLimiter } from '../../middleware/rateLimitMiddleware.js';

// Use the dedicated admin validators
import {
  adminLoginValidator,
  createAdminValidator,
  changeAdminPasswordValidator,
} from '../../validators/auth/adminAuthValidator.js';
import { passwordComplexityMiddleware } from '../../validators/passwordValidator.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';

const PASSWORD_MIN_LENGTH = SECURITY_CONFIG.password.minLength;

const router = express.Router();

/* ----------------------------- helpers ----------------------------- */
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }
  next();
};

// Inline validators for forgot/reset flows
const forgotPasswordValidator = [
  oneOf(
    [
      body('username').exists({ checkFalsy: true }).trim(),
      body('email').exists({ checkFalsy: true }).isEmail().normalizeEmail(),
    ],
    'Provide username or email'
  ),
];

const resetPasswordValidator = [
  oneOf(
    [
      body('username').optional({ nullable: true }).trim(),
      body('email').optional({ nullable: true }).isEmail().normalizeEmail(),
    ],
    'Provide username or email'
  ),
  body('otp').exists({ checkFalsy: true }).isLength({ min: 4, max: 8 }).withMessage('OTP is required'),
  body('newPassword')
    .exists({ checkFalsy: true }).withMessage('New password is required')
    .isLength({ min: PASSWORD_MIN_LENGTH }).withMessage(`New password must be at least ${PASSWORD_MIN_LENGTH} characters long`)
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must contain uppercase, lowercase, number and special character'),
];

/* ------------------------- public auth routes ---------------------- */
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Login (username OR email + password) — rate limited: 5 attempts/15min per IP
      ['/login', authRateLimiter, ...adminLoginValidator, handleValidation, adminAuthController.login],

      // Request password reset (send OTP)
      ['/forgot-password', otpRateLimiter, ...forgotPasswordValidator, handleValidation, adminAuthController.forgotPassword],

      // Reset password with OTP — rate limited to prevent brute-forcing the code
      ['/reset-password', otpRateLimiter, ...resetPasswordValidator, handleValidation, adminAuthController.resetPassword],

      // MFA challenge — completes the 2FA step after a successful password
      // login. Rate-limited same as /login to prevent code brute-forcing.
      ['/mfa/challenge/verify', authRateLimiter,
        body('challengeToken').notEmpty(),
        body('code').notEmpty(),
        body('useBackupCode').optional().isBoolean().toBoolean(),
        handleValidation,
        adminAuthController.mfaVerifyChallenge,
      ],
    ],
    get: [['/health', adminAuthController.getHealthStatus]],
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false,
  }
);

/* --------- first-time MFA enrollment (setup-scope token auth) ------ */
// These routes are public-entry but require the short-lived setup token
// returned by /login when REQUIRE_MFA_FOR_SUPER_ADMIN is on and the
// SUPER_ADMIN has not yet enrolled. `jwtAuth` verifies signature/expiry;
// `requireSetupScope` rejects any token without scope='mfa_setup'.
router.post(
  '/mfa/setup-enroll',
  authRateLimiter,
  jwtAuth,
  requireSetupScope,
  adminAuthController.mfaSetupEnroll
);
router.post(
  '/mfa/setup-confirm',
  authRateLimiter,
  jwtAuth,
  requireSetupScope,
  body('code').matches(/^\d{6}$/).withMessage('6-digit code required'),
  body('encryptedSecret').isString().notEmpty(),
  body('backupCodes').isArray({ min: 1 }),
  handleValidation,
  adminAuthController.mfaSetupConfirm
);

/* ------------------------ protected auth routes -------------------- */
router.use(jwtAuth);
// Narrow-scope tokens (e.g. mfa_setup) must never reach routes past this
// point — they're only valid on the /mfa/setup-* endpoints mounted above.
router.use(enforceFullScope);

wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Logout — blacklist the presented admin JWT's jti so a captured token is
      // actually revoked, not merely cookie-cleared (#2). The admin app already
      // POSTs here (/api/v1/auth/admin/logout), which previously 404'd. Reuses
      // the role-agnostic auth logout (bearer header -> AuthService.logout ->
      // blacklistToken); runs after jwtAuth above so the token is verified.
      ['/logout', authLogout],

      // Change password (self)
      ['/change-password', ...changeAdminPasswordValidator, handleValidation, passwordComplexityMiddleware, adminAuthController.changePassword],

      // MFA enrollment (self) — returns QR + otpauth URL + one-time backup codes.
      ['/mfa/enroll', adminAuthController.mfaEnroll],

      // MFA verify-setup (self) — confirms the first code and flips totp_enabled=true.
      ['/mfa/verify-setup',
        body('code').matches(/^\d{6}$/).withMessage('6-digit code required'),
        handleValidation,
        adminAuthController.mfaVerifySetup,
      ],

      // MFA disable (self) — requires current password + TOTP.
      ['/mfa/disable',
        body('currentPassword').notEmpty(),
        body('code').matches(/^\d{6}$/).withMessage('6-digit code required'),
        handleValidation,
        adminAuthController.mfaDisable,
      ],
    ],
    get: [
      // Current admin profile
      ['/profile', adminAuthController.getProfile],
    ],
  },
  {
    requireUID: true,
    requirePhone: false,
    skipAudit: false,
  }
);

/* -------------------------- super-admin only ----------------------- */
wrapAutoRBAC(
  router,
  'adminManagement',
  {
    post: [
      // Create another admin
      ['/create-admin', ...createAdminValidator, handleValidation, passwordComplexityMiddleware, adminAuthController.createAdmin],

      // Deactivate admin
      [
        '/deactivate',
        body('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        body('reason').notEmpty().withMessage('Reason is required'),
        handleValidation,
        adminAuthController.deactivateAdmin,
      ],

      // Reactivate admin
      [
        '/reactivate',
        body('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        handleValidation,
        adminAuthController.reactivateAdmin,
      ],

      // Revoke all sessions for a user (force-logout compromised accounts)
      [
        '/revoke-all-sessions/:userId',
        param('userId').isInt({ min: 1 }).withMessage('Invalid user ID').toInt(),
        handleValidation,
        adminAuthController.revokeAllSessions,
      ],
    ],
    get: [
      // List admins
      ['/list', adminAuthController.listAdmins],

      // Activity logs for a specific admin
      [
        '/activity-logs/:adminId',
        param('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        handleValidation,
        adminAuthController.getAdminActivityLogs,
      ],
    ],
    put: [
      // Update permissions
      [
        '/update-permissions',
        body('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        body('permissions').isArray().withMessage('Permissions must be an array'),
        handleValidation,
        adminAuthController.updatePermissions,
      ],
    ],
  },
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true,
    roles: ['SUPER_ADMIN'],
  }
);

export default router;
