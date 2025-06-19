// src/config/validationSchemas.js

import { body } from 'express-validator';

/**
 * ✅ Reusable Phone Validator (accepts 'phone' and 'phoneNumber' — flexible input)
 * Accepts +91 or 0 prefixed numbers by stripping non-digit characters and ensuring last 10 digits
 */
function phoneSanitizer(value) {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-10);
}

export const phoneValidator = [
  body('phone')
    .if(body('phone').exists())
    .trim()
    .customSanitizer(phoneSanitizer)
    .isLength({ min: 10, max: 10 })
    .withMessage('Phone number must be 10 digits')
    .isNumeric()
    .withMessage('Phone number must contain only numbers'),

  body('phoneNumber')
    .if(body('phoneNumber').exists())
    .trim()
    .customSanitizer(phoneSanitizer)
    .isLength({ min: 10, max: 10 })
    .withMessage('Phone number must be 10 digits')
    .isNumeric()
    .withMessage('Phone number must contain only numbers')
];

/**
 * ✅ Reusable OTP Validator
 */
export const otpValidator = body('otp')
  .trim()
  .notEmpty()
  .withMessage('OTP is required')
  .isLength({ min: 6, max: 6 })
  .withMessage('OTP must be 6 digits')
  .isNumeric()
  .withMessage('OTP must contain only numbers');

/**
 * ✅ User Profile Validator
 */
export const userProfileValidator = [
  ...phoneValidator,
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('gender')
    .trim()
    .notEmpty()
    .withMessage('Gender is required')
    .custom(value => typeof value === 'string' && ['male', 'female', 'other'].includes(value.toLowerCase()))
    .withMessage('Gender must be Male, Female, or Other'),
  body('email').optional().isEmail().withMessage('Invalid email format'),
  body('birthday')
    .optional()
    .isISO8601()
    .toDate()
    .withMessage('Invalid birthday format (YYYY-MM-DD)'),
  body('anniversary')
    .optional()
    .isISO8601()
    .toDate()
    .withMessage('Invalid anniversary format (YYYY-MM-DD)'),
  body('address').optional().isString().withMessage('Address must be a string'),

  // ✅ Only admins can set the 'role' field
  body('role')
    .optional()
    .custom((value, { req }) => {
      if (req.user?.role !== 'ADMIN') {
        throw new Error('Only admins can assign role');
      }
      return true;
    })
];

/**
 * ✅ Feedback Validator
 */
export const feedbackValidator = [
  ...phoneValidator,
  body('rating')
    .notEmpty()
    .withMessage('Rating is required')
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
  body('comment').optional().isString().withMessage('Comment must be a string')
];

/**
 * ✅ Appointment Validator
 */
export const appointmentValidator = [
  ...phoneValidator,
  body('doctor_name').trim().notEmpty().withMessage('Doctor name is required'),
  body('date').trim().notEmpty().withMessage('Date is required'),
  body('time').trim().notEmpty().withMessage('Time is required')
];

/**
 * ✅ Pharmacy Order Validator
 */
export const pharmacyOrderValidator = [
  ...phoneValidator,
  body('order_note').trim().notEmpty().withMessage('Order note is required'),
  body('file_key').optional().isString().withMessage('File key must be a string')
];

/**
 * ✅ Investigation Request Validator
 */
export const investigationRequestValidator = [
  ...phoneValidator,
  body('test_name').trim().notEmpty().withMessage('Test name is required'),
  body('file_key').optional().isString().withMessage('File key must be a string')
];

/**
 * ✅ Health Record Validator
 */
export const healthRecordValidator = [
  ...phoneValidator,
  body('file_key').trim().notEmpty().withMessage('File key is required')
];

/**
 * ✅ SOS Alert Validator
 */
export const sosAlertValidator = [
  ...phoneValidator,
  body('latitude').optional().isFloat().withMessage('Latitude must be a number'),
  body('longitude').optional().isFloat().withMessage('Longitude must be a number')
];
