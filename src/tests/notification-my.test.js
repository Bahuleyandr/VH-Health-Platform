// src/tests/notification-my.test.js
// Integration tests for the /my notification endpoints.
//
// These tests run WITHOUT a database. Tests that require DB data are marked .skip.
// The goal is to verify auth gating, route existence, and that the /my endpoints
// correctly derive the phone from the JWT rather than requiring it in the URL.

import request from 'supertest';
import app from '../app.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

// ── Test tokens ─────────────────────────────────────────────────────────────
const patientToken = generateToken({
  uid: 'test-notif-patient',
  id: 5,
  phone: '1234567890',
  role: 'PATIENT'
});

const staffToken = generateToken({
  uid: 'test-notif-staff',
  id: 101,
  phone: '5551112222',
  role: 'ADMIN'
});

const tokenWithoutPhone = generateToken({
  uid: 'test-notif-nophone',
  id: 50,
  role: 'PATIENT'
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Authenticated supertest request with API key + Bearer token */
const authRequest = (method, path, token) => {
  return request(app)[method](path)
    .set('X-API-Key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. GET /api/v1/notifications/my — AUTHENTICATION
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/notifications/my — Authentication', () => {
  it('should return 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .get('/api/v1/notifications/my')
      .set('X-API-Key', API_KEY);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when no API key is provided', async () => {
    const res = await request(app)
      .get('/api/v1/notifications/my')
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when neither API key nor token is provided', async () => {
    const res = await request(app)
      .get('/api/v1/notifications/my');

    expect(res.statusCode).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. GET /api/v1/notifications/my — ROUTE EXISTS
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/notifications/my — Route Existence', () => {
  it('should not return 404 for authenticated ADMIN request', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', staffToken);

    // The /my route derives phone from JWT. Without a DB the query may fail (500),
    // but the route itself must exist (not 404).
    expect(res.statusCode).not.toBe(404);
  });

  it('should not return 404 for authenticated PATIENT request', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', patientToken);

    // RBAC config includes PATIENT for notificationRoutes. The route should exist.
    // Depending on RBAC enforcement: 400 (validation), 403, or 500 (no DB).
    expect(res.statusCode).not.toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. GET /api/v1/notifications/my — RESPONSE FOR AUTHENTICATED USER
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/notifications/my — Authenticated Access', () => {
  it('should allow ADMIN to reach the /my endpoint (not 403)', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', staffToken);

    // Admin passes RBAC. Without a DB, expect 500. Should not be 403.
    expect(res.statusCode).not.toBe(403);
  });

  it('should return 400 when JWT has no phone claim (cannot derive phone)', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', tokenWithoutPhone);

    // The /my handler checks req.user.phone; if absent, returns 400 with message.
    // RBAC may also reject first (403). Either way, never 200 with wrong data.
    expect([400, 403]).toContain(res.statusCode);
  });

  it.skip('should return notifications for the authenticated user (requires test DB)', async () => {
    // Seed notifications for patientToken's phone, GET /my, verify array response.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PATCH /api/v1/notifications/my/mark-all-read — AUTHENTICATION
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/v1/notifications/my/mark-all-read — Authentication', () => {
  it('should return 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .patch('/api/v1/notifications/my/mark-all-read')
      .set('X-API-Key', API_KEY);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when no API key is provided', async () => {
    const res = await request(app)
      .patch('/api/v1/notifications/my/mark-all-read')
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. PATCH /api/v1/notifications/my/mark-all-read — ROUTE EXISTS
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/v1/notifications/my/mark-all-read — Route Existence', () => {
  it('should not return 404 for authenticated ADMIN request', async () => {
    const res = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', staffToken);

    // The route must exist. Without a DB: 500. With DB: 200.
    expect(res.statusCode).not.toBe(404);
  });

  it('should return 400 when JWT has no phone claim', async () => {
    const res = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', tokenWithoutPhone);

    // The /my/mark-all-read handler checks req.user.phone; if absent, returns 400.
    // RBAC may block first (403).
    expect([400, 403]).toContain(res.statusCode);
  });

  it.skip('should mark all notifications as read for the authenticated user (requires test DB)', async () => {
    // Seed unread notifications, PATCH /my/mark-all-read, verify they are now read.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PATCH /api/v1/notifications/my/mark-all-read — AUTHENTICATED ACCESS
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/v1/notifications/my/mark-all-read — Authenticated Access', () => {
  it('should allow ADMIN to reach the mark-all-read endpoint (not 403)', async () => {
    const res = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', staffToken);

    // Admin passes RBAC. Without DB: 500. Should not be 403.
    expect(res.statusCode).not.toBe(403);
  });
});
