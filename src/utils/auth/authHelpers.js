// src/utils/auth/authHelpers.js - Authentication Helper Functions

import { AUTH_CONFIG } from '../../config/authConfig.js';
import bcrypt from 'bcrypt';
import logger from '../../logging/logger.js';

// Hash password
export const hashPassword = async (password) => {
  try {
    return await bcrypt.hash(password, AUTH_CONFIG.bcrypt.saltRounds);
  } catch (err) {
    logger.error('Password hashing error:', err);
    throw new Error('Failed to hash password');
  }
};

// Compare password
export const comparePassword = async (password, hash) => {
  try {
    return await bcrypt.compare(password, hash);
  } catch (err) {
    logger.error('Password comparison error:', err);
    throw new Error('Failed to compare password');
  }
};

// Validate password strength
export const validatePasswordStrength = (password) => {
  const policy = AUTH_CONFIG.passwordPolicy;
  const errors = [];
  
  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters long`);
  }
  
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (policy.requireNumbers && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (policy.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
};

// Generate session ID
export const generateSessionId = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Format authentication response
export const formatAuthResponse = (user, token, additionalData = {}) => {
  return {
    token,
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      role: user.role,
      profileComplete: !!(user.name && user.gender),
      ...additionalData
    }
  };
};

// Check if user profile is complete
export const isProfileComplete = (user) => {
  const requiredFields = ['name', 'gender', 'email'];
  return requiredFields.every(field => user[field] !== null && user[field] !== undefined);
};

// Sanitize user object for response
export const sanitizeUserResponse = (user) => {
  const { password, ...sanitizedUser } = user;
  return sanitizedUser;
};

// Generate random string
export const generateRandomString = (length = 32) => {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
};

import crypto from 'crypto';