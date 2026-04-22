// src/utils/auth/tokenHelpers.js - Token Helper Functions

import jwt from 'jsonwebtoken';
import { AUTH_CONFIG } from '../../config/authConfig.js';
import logger from '../../logging/logger.js';

// Generate JWT token
export const generateToken = (payload, expiresIn = AUTH_CONFIG.jwt.expiresIn) => {
  try {
    return jwt.sign(
      payload,
      AUTH_CONFIG.jwt.secret,
      {
        expiresIn,
        algorithm: AUTH_CONFIG.jwt.algorithm
      }
    );
  } catch (err) {
    logger.error('Token generation error:', err);
    throw new Error('Failed to generate token');
  }
};

// Verify JWT token
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, AUTH_CONFIG.jwt.secret);
  } catch (err) {
    logger.debug('Token verification failed:', err.message);
    return null;
  }
};

// Generate refresh token
export const generateRefreshToken = (payload) => {
  return generateToken(payload, AUTH_CONFIG.jwt.refreshExpiresIn);
};

// Decode token without verification
export const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch (err) {
    logger.debug('Token decode failed:', err.message);
    return null;
  }
};

// Extract token from authorization header
export const extractTokenFromHeader = (authHeader) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.split(' ')[1];
};

// Check if token is expired
export const isTokenExpired = (token) => {
  const decoded = decodeToken(token);
  if (!decoded || !decoded.exp) {
    return true;
  }
  return Date.now() >= decoded.exp * 1000;
};

// Generate token payload
export const generateTokenPayload = (user) => {
  return {
    uid: user.uid,
    id: user.id,
    phone: user.phone,
    role: user.role,
    tenant_id: user.tenant_id || undefined,
    firebaseUid: user.firebase_uid || undefined,
    iat: Math.floor(Date.now() / 1000)
  };
};

// Validate token payload
export const validateTokenPayload = (payload) => {
  const requiredFields = ['uid', 'phone', 'role'];
  return requiredFields.every(field => payload[field] !== undefined);
};

// Create token response
export const createTokenResponse = (user, additionalData = {}) => {
  const token = generateToken(generateTokenPayload(user));
  const refreshToken = generateRefreshToken({ uid: user.uid });
  
  return {
    accessToken: token,
    refreshToken,
    expiresIn: AUTH_CONFIG.jwt.expiresIn,
    tokenType: 'Bearer',
    ...additionalData
  };
};

// Blacklist token — delegates to the canonical tokenBlacklist module
export const blacklistToken = async (token) => {
  const decoded = decodeToken(token);
  if (!decoded || !decoded.jti || !decoded.exp) {
    logger.warn('Cannot blacklist token: missing jti or exp claim');
    return false;
  }
  const { blacklistToken: bl } = await import('../tokenBlacklist.js');
  await bl(decoded.jti, decoded.exp, 'logout');
  logger.info('Token blacklisted: jti=' + decoded.jti);
  return true;
};

// Check if token is blacklisted — delegates to the canonical tokenBlacklist module
export const isTokenBlacklisted = async (token) => {
  const decoded = decodeToken(token);
  if (!decoded || !decoded.jti) return false;
  const { isTokenBlacklisted: check } = await import('../tokenBlacklist.js');
  return check(decoded.jti);
};

// Re-export from jwtUtils for backward compatibility
export { generateToken as default } from '../../utils/jwtUtils.js';
export { verifyToken as verifyJWT } from '../../utils/jwtUtils.js';