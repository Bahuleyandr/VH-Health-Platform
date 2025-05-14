// controllers/otpController.js
const { validationResult } = require('express-validator');
const { success, error } = require('../responseHelper');
const logger = require('../logging/logger');

exports.requestOtp = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation failed on requestOtp', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array() });
  }

  const { phoneNumber } = req.body;

  // Simulated OTP process (replace with real OTP logic later)
  logger.info(`Mock OTP 123456 sent to ${phoneNumber}`);
  success(res, { otp: '123456', phoneNumber }, `Mock OTP 123456 sent to ${phoneNumber}`);
};

exports.verifyOtp = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation failed on verifyOtp', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array() });
  }

  const { phoneNumber, otp } = req.body;

  if (otp === '123456') {
    logger.info(`OTP verified for ${phoneNumber}`);
    success(res, { phoneNumber }, 'OTP verified successfully');
  } else {
    logger.warn(`OTP verification failed for ${phoneNumber}`);
    error(res, 'Incorrect OTP', 400);
  }
};
