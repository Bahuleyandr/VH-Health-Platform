// src/utils/jwtUtils.js

import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

// ✅ Aggressively try to load environment variables from multiple sources
if (!process.env.JWT_SECRET) {
  console.log('🔄 JWT_SECRET not found, attempting to load .env files...');
  
  // Try multiple .env files in order of preference
  const envFiles = ['.env.local', '.env', '.env.render'];
  
  for (const envFile of envFiles) {
    try {
      const result = dotenv.config({ path: envFile });
      if (!result.error && process.env.JWT_SECRET) {
        console.log(`✅ Successfully loaded JWT_SECRET from ${envFile}`);
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
        console.log('✅ Loaded JWT_SECRET from default .env');
      }
    } catch (e) {
      // Continue
    }
  }
}

// Get the JWT_SECRET after attempting to load it
let JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// If still no JWT_SECRET, provide helpful error message and fallback
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET is missing from environment variables');
  console.error('🔍 Checked files: .env.local, .env, .env.render');
  console.error('📁 Current working directory:', process.cwd());
  
  // Use fallback for development to prevent app from crashing
  console.warn('⚠️ Using fallback JWT_SECRET for development. Please fix your environment variables!');
  JWT_SECRET = 'fallback-jwt-secret-for-development-only-please-set-proper-env-var-in-production';
}

/**
 * Generates a JWT token with Supabase-compatible claims.
 * @param {Object} payload - { uid, phone, role }
 * @returns {string} - Signed JWT token.
 */
export function generateToken({ uid, phone, role }) {
  return jwt.sign(
    {
      sub: uid,
      phone,
      role,
      'https://hyzrtspkmgelzqylokex.supabase.co/jwt/claims': {
        'x-hasura-default-role': role ? role.toLowerCase() : 'anonymous',
        'x-hasura-allowed-roles': [role ? role.toLowerCase() : 'anonymous'],
        'x-hasura-user-id': uid,
        'x-hasura-phone': phone
      }
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Verifies a JWT token.
 * @param {string} token - JWT token to verify.
 * @returns {Object|null} - Decoded payload if valid, otherwise null.
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    console.error('❌ JWT Verification Failed:', error.message || error);
    return null;
  }
}