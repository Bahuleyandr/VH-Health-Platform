// src/utils/jwtUtils.js

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in environment variables');
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
        'x-hasura-default-role': role.toLowerCase(),
        'x-hasura-allowed-roles': [role.toLowerCase()],
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
