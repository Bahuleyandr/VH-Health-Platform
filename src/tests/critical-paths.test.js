/**
 * critical-paths.test.js
 *
 * Focused, meaningful tests for the VHHealth backend's critical paths.
 * Asserts specific HTTP status codes — no "any status is fine" waffling.
 *
 * Run: npm test -- --testPathPattern=critical-paths
 *   or: node --experimental-vm-modules node_modules/jest/bin/jest.js critical-paths --forceExit
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

// Load .env.local first, then fall back to .env so tests work in all environments.
// This mirrors what jest.setup.js does for .env.local, but also covers the plain .env case.
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') }); // fallback

import request from 'supertest';
import app from '../app.js';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

const VALID_API_KEY = process.env.API_KEY || '';
const WRONG_API_KEY = 'totally-wrong-key-xyz';

// The global validateApiKey runs at line ~122 in app.js (before authMiddleware).
// We test key validation behavior directly via /api/v1/departments:
//   - No key → 401 "Missing API Key"
//   - Wrong key → 401 "Invalid API Key"
//   - Correct key → proceeds past key check (may still 401 for missing JWT, which is expected)
// To confirm the key itself is accepted, we check the error body changes.
const API_KEY_GATED_ROUTE = '/api/v1/departments';

// ============================================================
// 1. Health endpoint
// ============================================================
describe('Health endpoint', () => {
  it('GET /api/v1/health returns 200', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.statusCode).toBe(200);
  });
});

// ============================================================
// 2 & 3 & 4. API key validation
// ============================================================
describe('API key validation', () => {
  it('rejects requests with no x-api-key header with 401', async () => {
    const res = await request(app).get(API_KEY_GATED_ROUTE);
    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('rejects requests with the wrong x-api-key with 401', async () => {
    const res = await request(app)
      .get(API_KEY_GATED_ROUTE)
      .set('x-api-key', WRONG_API_KEY);
    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('passes API key validation with the correct x-api-key (error changes from key-missing to auth-missing)', async () => {
    // With no key → "Missing API Key"
    const noKeyRes = await request(app).get(API_KEY_GATED_ROUTE);
    expect(noKeyRes.statusCode).toBe(401);
    const noKeyErr = noKeyRes.body.error || noKeyRes.body.message || '';
    expect(noKeyErr.toLowerCase()).toMatch(/missing|api key/i);

    // With correct key → past the key guard, but authMiddleware then requires JWT
    // The error body should now be about authorization token, NOT about API key
    const withKeyRes = await request(app)
      .get(API_KEY_GATED_ROUTE)
      .set('x-api-key', VALID_API_KEY);
    // Still 401 (missing JWT) but the error is now about the token, not the key
    expect(withKeyRes.statusCode).toBe(401);
    const withKeyErr = withKeyRes.body.error || withKeyRes.body.message || '';
    expect(withKeyErr.toLowerCase()).not.toMatch(/missing api key|api key missing/i);
    expect(withKeyErr.toLowerCase()).toMatch(/token|authorization/i);
  });
});

// ============================================================
// 5. Auth endpoints — admin login exists (not 404)
// ============================================================
describe('Auth endpoints exist', () => {
  it('POST /api/v1/auth/admin/login returns 400 (missing fields), not 404', async () => {
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .send({});
    // Validation should fire before any DB call → 400
    expect(res.statusCode).toBe(400);
  });

  // ============================================================
  // 6. Auth endpoints — firebase login exists (not 404)
  // ============================================================
  it('POST /api/v1/auth/firebase/firebase-login returns 400 (missing fields), not 404', async () => {
    const res = await request(app)
      .post('/api/v1/auth/firebase/firebase-login')
      .send({});
    // Validation fires before Firebase call → 400 or 401, never 404
    expect([400, 401]).toContain(res.statusCode);
  });
});

// ============================================================
// 7. Rate limiting — admin profile has a finite limit
// ============================================================
describe('Rate limiting', () => {
  it('admin rate limit profile has a finite max (not Infinity)', () => {
    const adminProfile = RATE_LIMIT_PROFILES.admin;
    expect(adminProfile).toBeDefined();
    expect(typeof adminProfile.max).toBe('number');
    expect(adminProfile.max).toBeGreaterThan(0);
    expect(adminProfile.max).not.toBe(Infinity);
  });

  it('default rate limit profile has a finite max', () => {
    const defaultProfile = RATE_LIMIT_PROFILES.default;
    expect(defaultProfile).toBeDefined();
    expect(typeof defaultProfile.max).toBe('number');
    expect(defaultProfile.max).toBeGreaterThan(0);
    expect(defaultProfile.max).not.toBe(Infinity);
  });
});

// ============================================================
// 8. Internal routes require API key
// ============================================================
describe('Internal routes require API key', () => {
  it('GET /api/v1/internal without x-api-key returns 401', async () => {
    const res = await request(app).get('/api/v1/internal');
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/internal with wrong x-api-key returns 401', async () => {
    const res = await request(app)
      .get('/api/v1/internal')
      .set('x-api-key', WRONG_API_KEY);
    expect(res.statusCode).toBe(401);
  });
});
