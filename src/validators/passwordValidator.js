// src/validators/passwordValidator.js
// Password complexity enforcement following OWASP guidelines.

import { SECURITY_CONFIG } from '../config/securityConfig.js';

/**
 * Validate password complexity.
 * Returns { valid: boolean, errors: string[] }
 *
 * Requirements (from SECURITY_CONFIG.password):
 * - Minimum 8 characters
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 number
 * - At least 1 special character
 * - Not in common password list
 * - Maximum 128 characters (prevent bcrypt DoS)
 */
export function validatePasswordComplexity(password) {
  const errors = [];
  const config = SECURITY_CONFIG.password;

  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Password is required'] };
  }

  // Length checks
  if (password.length < (config.minLength || 8)) {
    errors.push(`Password must be at least ${config.minLength || 8} characters`);
  }
  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters');
  }

  // Character class checks
  if (config.requireUppercase !== false && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (config.requireLowercase !== false && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (config.requireNumbers !== false && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (config.requireSpecialChars !== false && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  // Common password check
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push('Password is too common. Please choose a stronger password.');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Express middleware that validates password in req.body.password
 * or req.body.newPassword.
 */
export function passwordComplexityMiddleware(req, res, next) {
  const password = req.body.password || req.body.newPassword;

  if (!password) return next(); // Let other validators handle required check

  const result = validatePasswordComplexity(password);
  if (!result.valid) {
    return res.status(400).json({
      success: false,
      message: 'Password does not meet complexity requirements',
      errors: result.errors,
    });
  }

  next();
}

// Top 100 most common passwords — reject these outright
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '1234567890',
  'qwerty', 'abc123', 'monkey', 'master', 'dragon', 'login', 'princess',
  'letmein', 'welcome', 'shadow', 'sunshine', 'trustno1', 'admin', 'admin123',
  'iloveyou', 'football', 'baseball', 'michael', 'superman', 'access',
  'batman', 'charlie', 'passw0rd', 'hello123', 'donald', 'password1!',
  'qwerty123', 'zaq1@wsx', 'qazwsx', 'p@ssw0rd', 'p@ssword', 'changeme',
  'welcome1', 'test123', 'test1234', 'hospital', 'hospital123', 'doctor',
  'doctor123', 'nurse', 'nurse123', 'health', 'health123', 'medical',
  'vhhealth', 'vhhealth123', 'staff123', 'admin1234', 'super123',
]);
