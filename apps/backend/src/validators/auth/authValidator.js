// src/validators/auth/authValidator.js - Authentication Validators

import { body, query } from 'express-validator';

// `deviceType` is sent by every login flow (Flutter staff/patient + admin
// web) after the single-active-session change. Marked optional so existing
// clients without the field still authenticate; their tokens then omit the
// claim and `requireDeviceType('mobile')` rejects them at the gated route
// (e.g. attendance), forcing a re-login on an updated build.
export const deviceTypeValidator = body('deviceType')
  .optional()
  .isIn(['mobile', 'tablet', 'desktop', 'web'])
  .withMessage('deviceType must be one of: mobile, tablet, desktop, web');

export const staffInstallationIdValidator = body('installationId')
  .notEmpty()
  .withMessage('Installation ID is required')
  .isUUID(4)
  .withMessage('Installation ID must be an opaque UUIDv4');

// Phone validators
export const phoneValidator = [
  body('phone')
    .optional()
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  body('phoneNumber')
    .optional()
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  body()
    .custom((value, { req }) => {
      if (!req.body.phone && !req.body.phoneNumber) {
        throw new Error('Phone number is required');
      }
      return true;
    }),
  deviceTypeValidator,
];

// OTP validators
export const otpValidator = [
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .matches(/^\d{6}$/)
    .withMessage('OTP must be exactly 6 digits')
];

// Phone and OTP validators combined
export const phoneOtpValidator = [...phoneValidator, ...otpValidator];

// Firebase login validator
export const firebaseLoginValidator = [
  body('idToken')
    .notEmpty()
    .withMessage('Firebase ID token is required')
    .isString()
    .withMessage('ID token must be a string')
    .isLength({ min: 10 })
    .withMessage('Invalid ID token format'),
  deviceTypeValidator,
];

// User profile validator
export const userProfileValidator = [
  // Accept either bare 10-digit (legacy) or E.164 (`+91…`, what the
  // patient app sends post-Firebase OTP). The service layer normalises
  // before the DB lookup.
  body('phone')
    .matches(/^(\+\d{10,15}|\d{10})$/)
    .withMessage('Phone number must be 10 digits or E.164 (+CC…)'),
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .trim(),
  // `.optional({ values: 'falsy' })` so null / '' / undefined all skip
  // the chain. Without this, the patient app's profile-setup form
  // (which sends `null` for unfilled date fields) was being rejected
  // with a "must be a valid date" error.
  body('gender')
    .optional({ values: 'falsy' })
    .isIn(['MALE', 'FEMALE', 'OTHER'])
    .withMessage('Gender must be MALE, FEMALE, or OTHER'),
  body('email')
    .optional({ values: 'falsy' })
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('birthday')
    .optional({ values: 'falsy' })
    .isISO8601()
    .withMessage('Birthday must be a valid date (YYYY-MM-DD)'),
  body('anniversary')
    .optional({ values: 'falsy' })
    .isISO8601()
    .withMessage('Anniversary must be a valid date (YYYY-MM-DD)'),
  body('address')
    .optional({ values: 'falsy' })
    .isLength({ max: 500 })
    .withMessage('Address must be less than 500 characters')
    .trim()
];

// User registration validator
export const userRegistrationValidator = [
  // Accept either bare 10-digit (legacy) or E.164 (`+91…`, what the
  // patient app sends post-Firebase OTP). The service layer normalises
  // before the DB lookup.
  body('phone')
    .matches(/^(\+\d{10,15}|\d{10})$/)
    .withMessage('Phone number must be 10 digits or E.164 (+CC…)'),
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .trim(),
  // `.optional({ values: 'falsy' })` so null / '' / undefined all skip
  // the chain. Without this, the patient app's profile-setup form
  // (which sends `null` for unfilled date fields) was being rejected
  // with a "must be a valid date" error.
  body('gender')
    .optional({ values: 'falsy' })
    .isIn(['MALE', 'FEMALE', 'OTHER'])
    .withMessage('Gender must be MALE, FEMALE, or OTHER'),
  body('email')
    .optional({ values: 'falsy' })
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('birthday')
    .optional({ values: 'falsy' })
    .isISO8601()
    .withMessage('Birthday must be a valid date (YYYY-MM-DD)'),
  body('anniversary')
    .optional({ values: 'falsy' })
    .isISO8601()
    .withMessage('Anniversary must be a valid date (YYYY-MM-DD)'),
  body('address')
    .optional({ values: 'falsy' })
    .isLength({ max: 500 })
    .withMessage('Address must be less than 500 characters')
    .trim()
];

// Admin OTP validators
export const adminOtpValidator = [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('purpose').optional().isString().withMessage('Purpose must be string'),
  body('reason').optional().isString().withMessage('Reason must be string')
];

// Analytics query validators
export const analyticsValidator = [
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date'),
  query('purpose').optional().isString().withMessage('Purpose must be string')
];

// OTP logs query validators
export const otpLogsValidator = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
  query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be 1-500'),
  query('phone').optional().isString().withMessage('Phone must be string'),
  query('purpose').optional().isString().withMessage('Purpose must be string'),
  query('action').optional().isIn(['request', 'verify', 'resend']).withMessage('Invalid action'),
  query('success').optional().isIn(['true', 'false']).withMessage('Success must be true or false'),
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date'),
  query('ipAddress').optional().isString().withMessage('IP address must be string')
];

// Config update validators
export const configUpdateValidator = [
  body('expirationMinutes').optional().isInt({ min: 1, max: 60 }).withMessage('Expiration must be 1-60 minutes'),
  body('maxAttempts').optional().isInt({ min: 1, max: 10 }).withMessage('Max attempts must be 1-10'),
  body('dailyLimit').optional().isInt({ min: 1, max: 100 }).withMessage('Daily limit must be 1-100'),
  body('resendCooldownMinutes').optional().isInt({ min: 0, max: 10 }).withMessage('Cooldown must be 0-10 minutes')
];

// Force send OTP validators
export const forceSendOtpValidator = [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('purpose').optional().isString().withMessage('Purpose must be string'),
  body('reason').notEmpty().withMessage('Reason is required for force send'),
  body('bypassLimits').optional().isBoolean().withMessage('Bypass limits must be boolean')
];

// Bulk delete validators
export const bulkDeleteValidator = [
  body('phone').optional().isString().withMessage('Phone must be string'),
  body('purpose').optional().isString().withMessage('Purpose must be string'),
  body('olderThanHours').optional().isInt({ min: 1 }).withMessage('Hours must be positive integer'),
  body('reason').notEmpty().withMessage('Reason is required for bulk delete')
];

// Admin auth logs validators
export const authLogsValidator = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
  query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be 1-500'),
  query('action').optional().isString().withMessage('Action must be string'),
  query('success').optional().isIn(['true', 'false']).withMessage('Success must be true or false')
];

// Username/password validators
export const usernamePasswordValidator = [
  body('username')
    .notEmpty()
    .withMessage('Username is required')
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be between 3 and 50 characters')
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Username can only contain letters, numbers, underscore and hyphen'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
];

// Admin registration validator
export const adminRegistrationValidator = [
  body('username')
    .notEmpty()
    .withMessage('Username is required')
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be between 3 and 50 characters')
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Username can only contain letters, numbers, underscore and hyphen'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must contain uppercase, lowercase, number and special character'),
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  body('email')
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('phone')
    .optional()
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  body('role')
    .optional()
    .isIn(['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'MANAGER'])
    .withMessage('Invalid role'),
  body('permissions')
    .optional()
    .isArray()
    .withMessage('Permissions must be an array')
];

// Password reset validator
export const passwordResetValidator = [
  body('username')
    .notEmpty()
    .withMessage('Username is required'),
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .matches(/^\d{6}$/)
    .withMessage('OTP must be exactly 6 digits'),
  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must contain uppercase, lowercase, number and special character')
];

// Change password validator
export const changePasswordValidator = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must contain uppercase, lowercase, number and special character')
    .custom((value, { req }) => value !== req.body.currentPassword)
    .withMessage('New password must be different from current password')
];

// Staff login validators
export const staffPasswordLoginValidator = [
  body('employeeId')
    .notEmpty()
    .withMessage('Employee ID is required')
    .matches(/^[A-Z0-9-]{3,20}$/)
    .withMessage('Invalid employee ID format'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  staffInstallationIdValidator,
  deviceTypeValidator,
];

// Device registration validator
export const deviceRegistrationValidator = [
  body('employeeId')
    .notEmpty()
    .withMessage('Employee ID is required')
    .matches(/^[A-Z0-9-]{3,20}$/)
    .withMessage('Invalid employee ID format'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  body('deviceInfo.deviceId')
    .notEmpty()
    .withMessage('Device ID is required'),
  staffInstallationIdValidator,
  body('deviceInfo.deviceId')
    .custom((value, { req }) => value === req.body.installationId)
    .withMessage('Device ID must match the installation ID'),
  body('deviceInfo.deviceName')
    .notEmpty()
    .withMessage('Device name is required'),
  body('deviceInfo.platform')
    .isIn(['ios', 'android'])
    .withMessage('Platform must be ios or android'),
  deviceTypeValidator,
];

// PIN setup validator
export const pinSetupValidator = [
  body('pin')
    .notEmpty()
    .withMessage('PIN is required')
    .matches(/^\d{4,6}$/)
    .withMessage('PIN must be 4-6 digits'),
  body('deviceToken')
    .notEmpty()
    .withMessage('Device token is required')
];

// Quick login validator
export const quickLoginValidator = [
  body('deviceToken')
    .notEmpty()
    .withMessage('Device token is required'),
  staffInstallationIdValidator,
  body('pin')
    .optional()
    .matches(/^\d{4,6}$/)
    .withMessage('PIN must be 4-6 digits'),
  body('biometric')
    .optional()
    .isBoolean()
    .withMessage('Biometric must be boolean'),
  deviceTypeValidator,
  body()
    .custom((value, { req }) => {
      if (!req.body.pin && !req.body.biometric) {
        throw new Error('Either PIN or biometric authentication is required');
      }
      return true;
    })
];

// Attendance validator
export const attendanceValidator = [
  body('location.latitude')
    .notEmpty()
    .withMessage('Latitude is required')
    .isFloat({ min: -90, max: 90 })
    .withMessage('Invalid latitude'),
  body('location.longitude')
    .notEmpty()
    .withMessage('Longitude is required')
    .isFloat({ min: -180, max: 180 })
    .withMessage('Invalid longitude'),
  body('deviceToken')
    .optional()
    .isString()
    .withMessage('Device token must be string')
];
