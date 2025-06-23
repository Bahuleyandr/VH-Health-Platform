// src/routes/firebaseAuthRoutes.js
import express from 'express';
import { validationResult, body } from 'express-validator';
import * as firebaseAuthController from '../controllers/firebaseAuthController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';

const router = express.Router();

// ✅ Firebase-specific validators (no phone validation needed for login)
const firebaseLoginValidator = [
  body('idToken')
    .notEmpty()
    .withMessage('Firebase ID token is required')
    .isString()
    .withMessage('ID token must be a string')
    .isLength({ min: 10 })
    .withMessage('Invalid ID token format')
];

const userRegistrationValidator = [
  body('phone')
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .trim(),
  body('gender')
    .optional()
    .isIn(['MALE', 'FEMALE', 'OTHER'])
    .withMessage('Gender must be MALE, FEMALE, or OTHER'),
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('birthday')
    .optional()
    .isISO8601()
    .withMessage('Birthday must be a valid date (YYYY-MM-DD)'),
  body('anniversary')
    .optional()
    .isISO8601()
    .withMessage('Anniversary must be a valid date (YYYY-MM-DD)'),
  body('address')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Address must be less than 500 characters')
    .trim()
];

// ✅ Validation middleware helper
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }
  next();
};

/**
 * ✅ Firebase Login - Public route, no auth required
 * Validates idToken, extracts phone from Firebase token
 */
router.post('/firebase-login', 
  firebaseLoginValidator,
  handleValidation,
  firebaseAuthController.firebaseLogin
);

/**
 * ✅ User Registration - Public route, no auth required  
 * Validates user profile data directly
 */
router.post('/register',
  userRegistrationValidator,
  handleValidation,
  firebaseAuthController.registerUser
);

export default router;