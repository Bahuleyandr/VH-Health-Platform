// src/tests/logout-epoch-revocation.deep.test.js
//
// R1 / R12 / R14 (2026-08-10 independent audit, fix wave 1) — proves, against
// a REAL database and a REAL WebSocket server:
//
//   (a) R1 — a refresh token retained across logout is REFUSED at the refresh
//       endpoint afterwards. The gate is the ISSUANCE-TIME token_epoch check:
//       the sibling refresh token minted at login has a clean (never-rotated)
//       jti and the re-minted pair's iat=now would post-date the revoke-all
//       watermark, so before this fix it laundered the revocation into a
//       fresh session. A post-logout re-login must still work (epoch moves
//       forward, it does not lock the identity out).
//
//   (c) R14 — logout and force-revoke-all push `session:revoked` to the
//       user's live WebSocket and the server closes it (4001). Previously
//       nothing emitted the event outside the env-gated single-session path,
//       so a "revoked" session's socket kept delivering realtime data.
//
//   (d) R12 — logout FAILS (non-2xx over HTTP) when the durable revocation
//       store (Postgres) cannot record the revocation, even though Redis
//       might have accepted it — a Redis-only record is evictable
//       (allkeys-lru) and is not acceptable logout evidence.
//
// Run focused:
//   DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
//   node --experimental-vm-modules --max-old-space-size=4096 \
//     node_modules/jest/bin/jest.js --runInBand src/tests/logout-epoch-revocation.deep.test.js

import http from 'http';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';

import prisma from '../lib/prisma.js';
import authRoutes from '../routes/auth/authRoutes.js';
import { AuthService } from '../services/auth/authService.js';
import { generateRefreshToken } from '../services/auth/loginSessionHelper.js';
import { generateToken } from '../utils/jwtUtils.js';
import { getCurrentTokenEpoch } from '../utils/tokenBlacklist.js';
import {
  initWebSocket,
  closeWebSocket,
} from '../utils/websocket/wsServer.js';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

/** Insert a throwaway patient row; returns { uid, id, phone }. */
async function createPatient(phoneSuffix) {
  const phone = `+9198990${phoneSuffix}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, role, registered_at, updated_at)
     VALUES ($1, 'PATIENT', NOW(), NOW())
     RETURNING uid, id, phone`,
    phone,
  );
  return rows[0];
}

async function cleanupPatient(uid) {
  if (!uid) return;
  await prisma.$executeRawUnsafe('DELETE FROM user_active_sessions WHERE user_uid = $1::uuid', uid).catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM invalidated_tokens WHERE jti = $1', `user:${uid}`).catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM user_devices WHERE user_uid = $1::uuid', uid).catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM auth_logs WHERE user_id = $1', uid).catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM users WHERE uid = $1::uuid', uid).catch(() => {});
}

/**
 * Sign a realistic bearer for the user (jti + exp + tenant claim), shaped like
 * the /realtime/ticket payload: NO int `id` claim, so the WS server registers
 * the socket under the uid (generateToken maps uid → sub; wsServer resolves
 * decoded.uid || decoded.id || decoded.sub).
 */
function accessTokenFor(user) {
  return generateToken(
    {
      uid: user.uid,
      phone: user.phone,
      role: 'PATIENT',
      tenant_id: DEFAULT_TENANT,
    },
    '1h',
  );
}

describe('R1 — refresh token retained across logout is refused at issuance', () => {
  let user;

  beforeAll(async () => {
    user = await createPatient('11');
  });

  afterAll(async () => {
    await cleanupPatient(user?.uid);
  });

  it('epoch gate: logout retires the sibling refresh token; a fresh login works again', async () => {
    // Login-time state: epoch 0, refresh token stamped with it.
    const retainedRefresh = await generateRefreshToken({
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      role: 'PATIENT',
    });

    // Sanity: before logout the refresh token rotates fine.
    const rotated = await AuthService.refreshToken(retainedRefresh, { body: {} });
    expect(rotated.token).toBeTruthy();
    expect(rotated.refreshToken).toBeTruthy();

    // The attacker keeps the ROTATED refresh token (clean jti, epoch 0) across
    // the victim's logout — the exact laundering scenario from the audit.
    const survivorRefresh = rotated.refreshToken;

    await AuthService.logout(rotated.token, {});

    // Epoch moved forward durably.
    await expect(getCurrentTokenEpoch(String(user.uid))).resolves.toBeGreaterThanOrEqual(1);

    // The retained refresh token must NOT mint a new session any more.
    await expect(
      AuthService.refreshToken(survivorRefresh, { body: {} }),
    ).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });

    // And the originally-presented (already-rotated) token stays dead too.
    await expect(
      AuthService.refreshToken(retainedRefresh, { body: {} }),
    ).rejects.toMatchObject({ statusCode: 401 });

    // A genuine re-login mints under the NEW epoch and refreshes normally —
    // the gate revokes credentials, not the identity.
    const freshRefresh = await generateRefreshToken({
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      role: 'PATIENT',
    });
    const freshRotation = await AuthService.refreshToken(freshRefresh, { body: {} });
    expect(freshRotation.token).toBeTruthy();
  });
});

describe('R14 — logout and revoke-all close the revoked session WebSockets', () => {
  let user;
  let server;
  let port;

  beforeAll(async () => {
    user = await createPatient('22');
    server = http.createServer();
    initWebSocket(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await closeWebSocket();
    await new Promise((resolve) => server.close(resolve));
    await cleanupPatient(user?.uid);
  });

  function connect(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      const frames = [];
      const timer = setTimeout(
        () => reject(new Error('timeout: no "connected" event received')),
        5000,
      );
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          frames.push(msg);
          if (msg.event === 'connected') {
            clearTimeout(timer);
            resolve({ ws, frames });
          }
        } catch { /* ignore non-JSON frames */ }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function waitForClose(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve({ code: null, alreadyClosed: true });
        return;
      }
      const timer = setTimeout(
        () => reject(new Error('timeout: socket was not closed')),
        timeoutMs,
      );
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason?.toString() });
      });
    });
  }

  it('logout pushes session:revoked and the server closes the socket (4001)', async () => {
    const token = accessTokenFor(user);
    const { ws, frames } = await connect(token);
    const closePromise = waitForClose(ws);

    await AuthService.logout(token, {});

    const closed = await closePromise;
    expect(closed.code).toBe(4001);
    const revoked = frames.find((f) => f.event === 'session:revoked');
    expect(revoked).toBeDefined();
    expect(revoked.data.reason).toBe('logout');
  });

  it('force revoke-all pushes session:revoked and closes the socket too', async () => {
    // Fresh socket for the same user. The token's iat must post-date the
    // previous test's revoke-all watermark, or the WS handshake itself is
    // (correctly) refused — wait out the 1-second iat granularity.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const token = accessTokenFor(user);
    const { ws, frames } = await connect(token);
    const closePromise = waitForClose(ws);

    await AuthService.revokeAllTokens(String(user.uid));

    const closed = await closePromise;
    expect(closed.code).toBe(4001);
    expect(frames.some((f) => f.event === 'session:revoked')).toBe(true);
  });
});

describe('R12 — logout fails closed (non-2xx) when the durable DB write fails', () => {
  let user;
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);

  beforeAll(async () => {
    user = await createPatient('33');
  });

  afterAll(async () => {
    await cleanupPatient(user?.uid);
  });

  it('returns 500 (not fake success) when Postgres rejects the revocation write', async () => {
    const token = accessTokenFor(user);
    // Simulate the durable store being down for the revocation write. Plain
    // method swap (not jest.spyOn) — the prisma client extension proxy does
    // not expose spy-able descriptors under ESM jest.
    const original = prisma.$queryRawUnsafe;
    prisma.$queryRawUnsafe = async () => {
      throw new Error('database unavailable');
    };

    try {
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Forwarded-For', '203.0.113.77')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body?.success).toBe(false);
    } finally {
      prisma.$queryRawUnsafe = original;
    }
  });

  it('control: with the durable store healthy the same logout succeeds (2xx)', async () => {
    const token = accessTokenFor(user);
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-For', '203.0.113.78')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.statusCode).toBe(200);
    expect(res.body?.success).toBe(true);
  });
});
