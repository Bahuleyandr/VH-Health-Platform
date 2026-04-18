// validators/auth/firebaseAuthValidator.js
import { body, query } from 'express-validator';

// Firebase ID token validation
export const firebaseTokenValidator = [
  body('idToken')
    .notEmpty()
    .withMessage('Firebase ID token is required')
    .isString()
    .withMessage('ID token must be a string')
];

// Firebase user creation validation
export const createFirebaseUserValidator = [
  body('uid')
    .notEmpty()
    .withMessage('Firebase UID is required')
    .isString()
    .withMessage('UID must be a string'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('Invalid email format')
    .normalizeEmail(),
  body('displayName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Display name must be between 2 and 100 characters'),
  body('phoneNumber')
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Invalid phone number format')
];

// Firebase user update validation
export const updateFirebaseUserValidator = [
  body('displayName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Display name must be between 2 and 100 characters'),
  body('photoURL')
    .optional()
    .isURL()
    .withMessage('Invalid photo URL'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('Invalid email format')
    .normalizeEmail()
];

// Link phone to Firebase validation
export const linkPhoneValidator = [
  body('firebaseUid')
    .notEmpty()
    .withMessage('Firebase UID is required')
    .isString()
    .withMessage('UID must be a string'),
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone must be 10 digits')
];

// Firebase session validation
export const firebaseSessionValidator = [
  body('sessionToken')
    .notEmpty()
    .withMessage('Session token is required')
    .isString()
    .withMessage('Session token must be a string')
];

// Verify Firebase token query validation
export const verifyTokenQueryValidator = [
  query('token')
    .notEmpty()
    .withMessage('Token is required')
    .isString()
    .withMessage('Token must be a string')
];

// Custom claims validation
export const customClaimsValidator = [
  body('uid')
    .notEmpty()
    .withMessage('User UID is required')
    .isString()
    .withMessage('UID must be a string'),
  body('claims')
    .notEmpty()
    .withMessage('Claims object is required')
    .isObject()
    .withMessage('Claims must be an object')
    .custom((value) => {
      // Ensure claims object size is within Firebase limits
      const claimsString = JSON.stringify(value);
      if (claimsString.length > 1000) {
        throw new Error('Custom claims payload too large (max 1000 bytes)');
      }
      return true;
    })
];

// Revoke refresh tokens validation
export const revokeTokensValidator = [
  body('uid')
    .notEmpty()
    .withMessage('User UID is required')
    .isString()
    .withMessage('UID must be a string')
];

// Delete Firebase user validation
export const deleteFirebaseUserValidator = [
  body('uid')
    .notEmpty()
    .withMessage('User UID is required')
    .isString()
    .withMessage('UID must be a string'),
  body('confirmDelete')
    .equals('true')
    .withMessage('Please confirm deletion by setting confirmDelete to true')
];