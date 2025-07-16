import dotenv from 'dotenv';
import request from 'supertest';
import app from '../app.js';

// ✅ Ensure .env.local is loaded first
dotenv.config({ path: '.env.local' });

export const API_KEY = process.env.API_KEY || 'vhhealth123';
export const AUTH_TOKEN =
  process.env.TEST_BEARER_TOKEN ||
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJ0ZXN0LWFkbWluLXVpZCIsInBob25lIjoiOTg3NjU0MzIxMCIsInJvbGUiOiJBRE1JTiIsImlhdCI6MTc0NzY3MDA0MiwiZXhwIjoxNzQ3NzU2NDQyfQ.IyyBTcTrTc9z_Em-UUNlpwigxSZviJg7X-lZAlqPqk4';

/**
 * Returns a SuperTest client ready to make requests
 * @returns {SuperTest<Test>}
 */
export default function getClient() {
  return request(app);
}
