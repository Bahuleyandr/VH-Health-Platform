// src/utils/jwtUtils.js

import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import logger from '../logging/logger.js';

// ✅ Aggressively try to load environment variables from multiple sources
if (!process.env.JWT_SECRET) {
  logger.info('🔄 JWT_SECRET not found, attempting to load .env files...');
  
  // Try multiple .env files in order of preference
  const envFiles = ['.env.local', '.env', '.env.render'];
  
  for (const envFile of envFiles) {
    try {
      const result = dotenv.config({ path: envFile });
      if (!result.error && process.env.JWT_SECRET) {
        logger.info(`✅ Successfully loaded JWT_SECRET from ${envFile}`);
        break;
      }
    } catch (e) {
      // Continue to next file
    }
  }
  
  // If still no JWT_SECRET, try loading without specifying path (default .env)
  if (!process.env.JWT_SECRET) {
    try {
      dotenv.config();
      if (process.env.JWT_SECRET) {
        logger.info('✅ Loaded JWT_SECRET from default .env');
      }
    } catch (e) {
      // Continue
    }
  }
}

// Get the JWT_SECRET after attempting to load it
let JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// If still no JWT_SECRET, crash on startup — never use a hardcoded fallback
if (!JWT_SECRET) {
  logger.error('❌ FATAL: JWT_SECRET is missing from environment variables.');
  logger.error('🔍 Checked files: .env.local, .env, .env.render');
  logger.error('📁 Current working directory:', process.cwd());
  process.exit(1);
}

/**
 * Generates a JWT token with Supabase-compatible claims.
 * @param {Object} payload - { uid, phone, role, ...extraClaims } — all fields are included in the token.
 * @param {string} [expiresIn] - Optional expiry override (e.g. '30d' for refresh tokens).
 * @returns {string} - Signed JWT token.
 */
export function generateToken(payload, expiresIn) {
  const { uid, phone, role, ...extraClaims } = payload;
  const tokenPayload = {
    jti: crypto.randomUUID(),  // Unique token ID for revocation/blacklisting
    sub: uid,
    role: role || 'PATIENT',
    ...(phone && { phone }),
    ...extraClaims,  // Include email, type, sub overrides, iss, aud, etc.
    'https://hyzrtspkmgelzqylokex.supabase.co/jwt/claims': {
      'x-hasura-default-role': role ? role.toLowerCase() : 'anonymous',
      'x-hasura-allowed-roles': [role ? role.toLowerCase() : 'anonymous'],
      'x-hasura-user-id': uid,
      ...(phone && { 'x-hasura-phone': phone })
    }
  };
  return jwt.sign(
    tokenPayload,
    JWT_SECRET,
    { expiresIn: expiresIn || JWT_EXPIRES_IN }
  );
}

/**
 * Verifies a JWT token (signature + expiry).
 * @param {string} token - JWT token to verify.
 * @returns {Object|null} - Decoded payload if valid, otherwise null.
 *   On failure, returns null. Check verifyToken.lastError for the reason.
 */
export function verifyToken(token) {
  verifyToken.lastError = null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    verifyToken.lastError = error.name; // 'TokenExpiredError' | 'JsonWebTokenError' | 'NotBeforeError'
    logger.error('❌ JWT Verification Failed:', error.message || error);
    return null;
  }
}
verifyToken.lastError = null;