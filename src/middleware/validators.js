// src/middleware/validators.js
const { body } = require('express-validator');

/**
 * Phone number validation middleware
 * Ensures the phone number is a 10-digit numeric string.
 */
const validatePhoneNumber = body('phoneNumber')
  .trim()
  .notEmpty().withMessage('Phone number is required')
  .isLength({ min: 10, max: 10 }).withMessage('Phone number must be 10 digits')
  .isNumeric().withMessage('Phone number must contain only numbers');

/**
 * OTP validation middleware
 * Ensures the OTP is a 6-digit numeric string.
 */
const validateOTP = body('otp')
  .trim()
  .notEmpty().withMessage('OTP is required')
  .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
  .isNumeric().withMessage('OTP must contain only numbers');

module.exports = {
  validatePhoneNumber,
  validateOTP,
};
