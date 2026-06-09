import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app.js';

// ✅ Ensure .env.local is loaded first
dotenv.config({ path: '.env.local' });

export const API_KEY = process.env.API_KEY || 'test-api-key';

/**
 * Generate a test JWT token with the given role (default: ADMIN for maximum access)
 */
export function generateTestToken(role = 'ADMIN', overrides = {}) {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret';
  return jwt.sign(
    {
      uid: '550e8400-e29b-41d4-a716-446655440000',
      id: 1,
      phone: '9876543210',
      role,
      // Every real auth realm stamps deviceType at login; clinical-write
      // routes 403 (DEVICE_TYPE_MISSING) without it since the phone-mode
      // gate (rejectMobileClinicalWrite). Desktop = full clinical access;
      // pass { deviceType: 'mobile' } to exercise the phone-mode denial.
      deviceType: 'desktop',
      ...overrides
    },
    secret,
    { expiresIn: '1h' }
  );
}

export const AUTH_TOKEN = `Bearer ${generateTestToken('ADMIN')}`;

/**
 * Returns a SuperTest client ready to make requests
 * @returns {SuperTest<Test>}
 */
export default function getClient() {
  return request(app);
}

/**
 * Returns a SuperTest client with API key + JWT auth pre-configured
 * Use this for routes that require authentication
 * @param {string} role - JWT role (default: ADMIN)
 */
export function authClient(role = 'ADMIN') {
  const token = generateTestToken(role);
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (path) => request(app).put(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    patch: (path) => request(app).patch(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (path) => request(app).delete(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}
