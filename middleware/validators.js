const { body, validationResult } = require('express-validator');

exports.validatePhoneNumber = [
  body('phoneNumber')
    .isLength({ min: 10 })
    .withMessage('Phone number must be at least 10 digits'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    next();
  },
];

exports.validateOTP = [
  body('otp')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    next();
  },
];
