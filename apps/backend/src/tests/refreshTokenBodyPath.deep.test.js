// src/tests/refreshTokenBodyPath.deep.test.js
//
// C-9 companion (audit 2026-06-18): integration coverage for the PRIMARY
// patient refresh path. After C-9, /refresh-token accepts ONLY type:'refresh'
// tokens. The shared Flutter client (vhhealth_core VHHttpClient._performRefresh)
// switches to POSTing `{ refreshToken }` in the BODY with auth:false once it
// holds a stored refresh token. This suite proves that path actually works:
//
//   1. A real refresh token delivered in the request BODY rotates the session
//      (200 + fresh access + rotated refresh) — the controller must read
//      req.body.refreshToken, not only the Authorization header.
//   2. The legacy bearer-header path still rotates (backward compat for the
//      pre-stored-refresh client + staff).
//   3. The body path is type-guarded too: an ACCESS token in the body is
//      rejected (401) — the body fallback must not weaken C-9.
//
// The token is minted via the REAL shared loginSessionHelper.generateRefreshToken,
// so it carries the uid in `sub` (the codebase's canonical uid claim) with NO
// top-level `uid` — exactly what a production refresh token looks like. That is
// the regression these tests lock down: AuthService.refreshToken must resolve
// the user from `decoded.sub` (it previously read only `decoded.uid`, which is
// undefined on a real token → user-not-found → 401, i.e. refresh never worked).
//
// Needs the dev Postgres (the success path does a real users lookup + session
// claim + blacklist write):
//   DATABASE_URL=postgresql://vhhealth:vhhealth@localhost:5433/vhhealth \
//   node --experimental-vm-modules --max-old-space-size=2048 \
//     node_modules/jest/bin/jest.js --runInBand src/tests/refreshTokenBodyPath.deep.test.js

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import authRoutes from '../routes/auth/authRoutes.js';
import prisma from '../lib/prisma.js';
import { generateRefreshToken } from '../services/auth/loginSessionHelper.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-chars';
const TEST_PHONE = '+919900000931';

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  return app;
}

const app = buildApp();

let user;
let accessTokenNoType;

// A fresh refresh token per use: refresh ROTATION blacklists the presented
// jti (replay protection), so a token is single-use. Reusing one across tests
// would (correctly) 401 as revoked — each login mints its own, so each test does too.
const mintRefresh = () =>
  generateRefreshToken({ uid: user.uid, id: user.id, phone: user.phone, role: user.role });

beforeAll(async () => {
  // Seed via raw SQL (only real columns) rather than the Prisma model: the dev
  // DB lags schema.prisma on some newer columns, and prisma.users.create()
  // materialises Prisma-side defaults for columns the dev DB may not have yet.
  // The refresh path's own findUnique selects an explicit column subset, so it
  // is unaffected by that drift.
  await prisma.$executeRawUnsafe('DELETE FROM users WHERE phone = $1', TEST_PHONE);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, role, registered_at, updated_at)
     VALUES ($1, 'PATIENT', NOW(), NOW())
     RETURNING uid::text AS uid, id::int AS id, phone, role`,
    TEST_PHONE,
  );
  user = rows[0];

  // A plain access token: NO type:'refresh'. Must be rejected at /refresh-token.
  accessTokenNoType = jwt.sign(
    { uid: user.uid, id: user.id, role: 'PATIENT' },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
});

afterAll(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM users WHERE phone = $1', TEST_PHONE);
});

describe('C-9 companion — /refresh-token accepts a refresh token in the BODY', () => {
  it('rotates the session for a real refresh token POSTed in the body (no auth header)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('X-Forwarded-For', '203.0.113.31')
      .send({ refreshToken: mintRefresh() });

    expect(res.statusCode).toBe(200);
    // Fresh access token + rotated refresh token returned to the client.
    expect(typeof res.body?.data?.token).toBe('string');
    expect(res.body.data.token.length).toBeGreaterThan(0);
    expect(typeof res.body?.data?.refreshToken).toBe('string');
    expect(res.body.data.refreshToken.length).toBeGreaterThan(0);
    // Resolved the right user — proves uid was read from `sub`, not `decoded.uid`.
    expect(res.body.data.user.uid).toBe(user.uid);
  });

  it('still rotates when the refresh token is sent in the Authorization header (legacy bearer path)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('X-Forwarded-For', '203.0.113.32')
      .set('Authorization', `Bearer ${mintRefresh()}`)
      .send({});

    expect(res.statusCode).toBe(200);
    expect(typeof res.body?.data?.token).toBe('string');
    expect(res.body.data.user.uid).toBe(user.uid);
  });

  it('rejects an ACCESS token sent in the body (body path is type-guarded too)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('X-Forwarded-For', '203.0.113.33')
      .send({ refreshToken: accessTokenNoType });

    expect(res.statusCode).toBe(401);
    expect(res.body?.data?.token).toBeUndefined();
    expect(res.body?.data?.refreshToken).toBeUndefined();
  });
});
