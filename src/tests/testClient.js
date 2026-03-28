import dotenv from 'dotenv';
import request from 'supertest';
import app from '../app.js';

// ✅ Ensure .env.local is loaded first
dotenv.config({ path: '.env.local' });

export const API_KEY = process.env.API_KEY || '';
export const AUTH_TOKEN =
  process.env.TEST_BEARER_TOKEN || '';

/**
 * Returns a SuperTest client ready to make requests
 * @returns {SuperTest<Test>}
 */
export default function getClient() {
  return request(app);
}
