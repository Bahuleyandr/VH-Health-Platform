// validators/auth/adminAuthValidator.js
import { body, param, oneOf } from 'express-validator';
import { deviceTypeValidator } from './authValidator.js';

// --- Admin login (username OR email) ---
export const adminLoginValidator = [
  oneOf(
    [
      body('username')
        .exists({ checkFalsy: true }).withMessage('Username is required')
        .trim()
        .isLength({ min: 3, max: 50 }).withMessage('Username must be between 3 and 50 characters')
        .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Username can only contain letters, numbers, underscore, and hyphen'),
      body('email')
        .exists({ checkFalsy: true }).withMessage('Email is required')
        .trim()
        .isEmail().withMessage('Invalid email format')
        .normalizeEmail(),
    ],
    'Provide username or email'
  ),
  body('password')
    .exists({ checkFalsy: true }).withMessage('Password is required')
    .isLength({ min: 6, max: 100 }).withMessage('Password must be between 6 and 100 characters'),
  deviceTypeValidator,
];

// --- Staff PIN login ---
export const staffPinLoginValidator = [
  body('employeeId')
    .trim()
    .notEmpty().withMessage('Employee ID is required')
    .matches(/^[A-Z0-9]+$/).withMessage('Invalid employee ID format'),
  body('pin')
    .notEmpty().withMessage('PIN is required')
    .isLength({ min: 4, max: 6 }).withMessage('PIN must be between 4 and 6 digits')
    .isNumeric().withMessage('PIN must contain only numbers'),
  deviceTypeValidator,
];

// --- Change admin password ---
export const changeAdminPasswordValidator = [
  body('currentPassword')
    .notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 6 }).withMessage('New password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must contain uppercase, lowercase, number and special character')
    .custom((value, { req }) => value !== req.body.currentPassword)
    .withMessage('New password must be different from current password'),
];

// --- Change staff PIN ---
export const changeStaffPinValidator = [
  body('currentPin')
    .notEmpty().withMessage('Current PIN is required')
    .isNumeric().withMessage('PIN must contain only numbers'),
  body('newPin')
    .notEmpty().withMessage('New PIN is required')
    .isLength({ min: 4, max: 6 }).withMessage('PIN must be between 4 and 6 digits')
    .isNumeric().withMessage('PIN must contain only numbers')
    .custom((value, { req }) => value !== req.body.currentPin)
    .withMessage('New PIN must be different from current PIN'),
];

// --- Reset staff PIN ---
export const resetStaffPinValidator = [
  body('employeeId')
    .trim()
    .notEmpty().withMessage('Employee ID is required')
    .matches(/^[A-Z0-9]+$/).withMessage('Invalid employee ID format'),
  body('newPin')
    .notEmpty().withMessage('New PIN is required')
    .isLength({ min: 4, max: 6 }).withMessage('PIN must be between 4 and 6 digits')
    .isNumeric().withMessage('PIN must contain only numbers'),
];

// --- Create admin ---
export const createAdminValidator = [
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required')
    .isLength({ min: 3, max: 50 }).withMessage('Username must be between 3 and 50 characters')
    .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Username can only contain letters, numbers, underscore, and hyphen'),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must contain uppercase, lowercase, number and special character'),
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format')
    .normalizeEmail(),
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
];

// --- Admin id in params (your ids are integers, not UUIDs) ---
export const adminIdValidator = [
  param('adminId')
    .isInt({ min: 1 }).withMessage('Invalid admin ID')
    .toInt(),
];
