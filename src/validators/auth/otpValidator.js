// validators/auth/otpValidator.js
import { body, query } from 'express-validator';

// Request OTP validation
export const requestOtpValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('purpose')
    .optional()
    .isIn(['login', 'register', 'reset_password', 'verify_phone'])
    .withMessage('Invalid OTP purpose')
];

// Verify OTP validation
export const verifyOtpValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must contain only numbers')
];

// Direct OTP login validation (for testing)
export const directOtpLoginValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits')
];

// Resend OTP validation
export const resendOtpValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('sessionId')
    .optional()
    .isUUID()
    .withMessage('Invalid session ID format')
];

// OTP status check validation
export const checkOtpStatusValidator = [
  query('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits')
];

// Validate OTP session
export const validateOtpSessionValidator = [
  body('sessionId')
    .notEmpty()
    .withMessage('Session ID is required')
    .isUUID()
    .withMessage('Invalid session ID format')
];

// Block phone number validation (admin)
export const blockPhoneValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('reason')
    .notEmpty()
    .withMessage('Block reason is required')
    .isLength({ min: 10, max: 500 })
    .withMessage('Reason must be between 10 and 500 characters'),
  body('duration')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('Block duration must be between 1 and 365 days')
];

// Unblock phone number validation (admin)
export const unblockPhoneValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('reason')
    .notEmpty()
    .withMessage('Unblock reason is required')
    .isLength({ min: 10, max: 500 })
    .withMessage('Reason must be between 10 and 500 characters')
];

// OTP configuration validation (admin)
export const otpConfigValidator = [
  body('otpLength')
    .optional()
    .isInt({ min: 4, max: 8 })
    .withMessage('OTP length must be between 4 and 8'),
  body('otpExpiry')
    .optional()
    .isInt({ min: 60, max: 1800 })
    .withMessage('OTP expiry must be between 60 and 1800 seconds'),
  body('maxAttempts')
    .optional()
    .isInt({ min: 3, max: 10 })
    .withMessage('Max attempts must be between 3 and 10'),
  body('cooldownPeriod')
    .optional()
    .isInt({ min: 60, max: 86400 })
    .withMessage('Cooldown period must be between 60 and 86400 seconds'),
  body('enableTestMode')
    .optional()
    .isBoolean()
    .withMessage('Enable test mode must be boolean')
];

// Whitelist phone number validation (admin)
export const whitelistPhoneValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('purpose')
    .notEmpty()
    .withMessage('Whitelist purpose is required')
    .isIn(['testing', 'vip', 'internal', 'demo'])
    .withMessage('Invalid whitelist purpose'),
  body('expiresAt')
    .optional()
    .isISO8601()
    .withMessage('Expiry date must be valid ISO 8601 date')
];