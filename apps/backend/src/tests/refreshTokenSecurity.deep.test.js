// src/tests/refreshTokenSecurity.deep.test.js
//
// Integration coverage for audit finding C-9 (2026-06-18): the public refresh
// endpoint must (a) reject access tokens — only type:'refresh' tokens may
// rotate a session — and (b) be rate-limited like the login endpoints.
//
// We mount the REAL authRoutes router (real authRateLimiter + real controller
// + real AuthService.refreshToken) on a minimal Express app rather than
// importing the whole src/app.js. That keeps the test self-contained and
// independent of unrelated global wiring, and exercises exactly the surface
// this change touches. authRateLimiter is NOT skipped in the test env — its
// skip is `isRateLimitingDisabled`, gated only by DISABLE_RATE_LIMITING /
// RATE_LIMIT_DISABLED (both unset here).
//
// The type guard rejects an access token BEFORE any DB lookup, so these
// assertions need no database.
//
// Run focused:
//   node --experimental-vm-modules --max-old-space-size=2048 \
//     node_modules/jest/bin/jest.js --runInBand src/tests/refreshTokenSecurity.deep.test.js

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import authRoutes from '../routes/auth/authRoutes.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-chars';

function buildApp() {
  const app = express();
  // app.js sets this; the auth rate limiter keys off req.ip (X-Forwarded-For)
  // so each test can use a distinct source IP for a clean bucket.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  return app;
}

const app = buildApp();

function signAccessToken(extra = {}) {
  // A normal access token: NO type:'refresh' claim. This is exactly what the
  // patient/admin clients used to replay at /refresh-token.
  return jwt.sign(
    { uid: '550e8400-e29b-41d4-a716-446655440000', id: 1, role: 'PATIENT', ...extra },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

describe('C-9 — /refresh-token type confusion (HTTP)', () => {
  it('rejects a valid ACCESS token (no type:refresh) with 401 and no new token', async () => {
    const accessToken = signAccessToken();
    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('X-Forwarded-For', '203.0.113.10')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.statusCode).toBe(401);
    // Never leak a fresh session credential in the rejection.
    expect(res.body?.data?.token).toBeUndefined();
    expect(res.body?.data?.accessToken).toBeUndefined();
    expect(res.body?.data?.refreshToken).toBeUndefined();
  });

  it('rejects when no Authorization header is supplied (401)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('X-Forwarded-For', '203.0.113.11')
      .send({});

    expect(res.statusCode).toBe(401);
  });

  it('also guards the /token alias against access-token replay (401)', async () => {
    const accessToken = signAccessToken();
    const res = await request(app)
      .post('/api/v1/auth/token')
      .set('X-Forwarded-For', '203.0.113.12')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.statusCode).toBe(401);
    expect(res.body?.data?.token).toBeUndefined();
  });
});

describe('C-9 — /refresh-token is rate limited', () => {
  // authRateLimiter: 5 attempts / 15 min, keyed by IP (refresh carries no
  // account in the body). skipSuccessfulRequests=true, so only the failed
  // (401) attempts here are counted — once the cap is hit the endpoint must
  // throttle with 429 instead of continuing to reach the handler.
  it('returns 429 once the per-IP attempt cap is exceeded', async () => {
    const accessToken = signAccessToken();
    const ip = '198.51.100.42'; // dedicated IP → clean bucket for this test
    const statuses = [];

    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post('/api/v1/auth/refresh-token')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});
      statuses.push(res.statusCode);
    }

    // The first attempt must reach the handler (401), not be pre-throttled.
    expect(statuses[0]).toBe(401);
    // The limiter must engage within the window …
    expect(statuses).toContain(429);
    // … and the final attempt must be throttled.
    expect(statuses[statuses.length - 1]).toBe(429);
    // At most the cap (5) of the attempts may be the un-throttled 401s.
    const allowed = statuses.filter((s) => s === 401).length;
    expect(allowed).toBeLessThanOrEqual(5);
  });
});
