// src/validators/otpValidators.js
// ✅ COPY THIS EXACT CODE - Fixed OTP Validation Schemas

import { body } from 'express-validator';

/**
 * ✅ Phone Validator - MUST be exported as array
 */
export const phoneValidator = [
  body('phone')
    .if(body('phone').exists())
    .trim()
    .customSanitizer(value => {
      if (!value) return value;
      const digits = value.replace(/\D/g, '');
      return digits.slice(-10);
    })
    .isLength({ min: 10, max: 10 })
    .withMessage('Phone number must be 10 digits')
    .isNumeric()
    .withMessage('Phone number must contain only numbers'),

  body('phoneNumber')
    .if(body('phoneNumber').exists())
    .trim()
    .customSanitizer(value => {
      if (!value) return value;
      const digits = value.replace(/\D/g, '');
      return digits.slice(-10);
    })
    .isLength({ min: 10, max: 10 })
    .withMessage('Phone number must be 10 digits')
    .isNumeric()
    .withMessage('Phone number must contain only numbers')
];

/**
 * ✅ OTP Validator - MUST be exported as array
 */
export const otpValidator = [
  body('otp')
    .trim()
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must contain only numbers')
];

/**
 * ✅ Combined validators
 */
export const phoneOtpValidator = [...phoneValidator, ...otpValidator];
export const requestOtpValidator = phoneValidator;
export const verifyOtpValidator = phoneOtpValidator;