// src/routes/otpRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { validatePhoneNumber, validateOTP } = require('../middleware/validators');
const { success, error } = require('../utils/responseHelper');

const router = express.Router();

// Request OTP (Mock)
router.post('/request-otp', validatePhoneNumber, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  res.json({ message: `Mock OTP 123456 sent to ${req.body.phoneNumber}` });
});

// Verify OTP (Mock)
router.post('/verify-otp', [validatePhoneNumber, validateOTP], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  if (req.body.otp === '123456') {
    return success(res, { verified: true }, 'OTP verified');
  } else {
    return error(res, 'Incorrect OTP', 400);
  }
});

module.exports = router;
