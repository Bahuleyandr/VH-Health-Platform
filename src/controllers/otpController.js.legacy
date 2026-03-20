// src/controllers/otpController.js

import { validationResult } from 'express-validator';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';

/**
 * ✅ Request OTP (Mock)
 */
export function requestOtp(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation failed on requestOtp', { errors: errors.array() });
    return res.status(400).json({
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const phone = req.body.phone;

  if (!phone) {
    return error(res, 'Phone number is required', 400);
  }

  logger.info(`📲 Mock OTP 123456 sent to ${phone}`);
  success(res, { otp: '123456', phone }, `Mock OTP 123456 sent to ${phone}`);
}

/**
 * ✅ Verify OTP (Mock)
 */
export function verifyOtp(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation failed on verifyOtp', { errors: errors.array() });
    return res.status(400).json({
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return error(res, 'Phone and OTP are required', 400);
  }

  if (otp === '123456') {
    logger.info(`✅ OTP verified for ${phone}`);
    success(res, { phone }, 'OTP verified successfully');
  } else {
    logger.warn(`❌ OTP verification failed for ${phone}`);
    error(res, 'Incorrect OTP', 400);
  }
}
