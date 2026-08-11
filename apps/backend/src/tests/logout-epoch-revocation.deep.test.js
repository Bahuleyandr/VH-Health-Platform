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
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';

import prisma from '../lib/prisma.js';
import authRoutes from '../routes/auth/authRoutes.js';
import { AuthService } from '../services/auth/authService.js';
import { generateRefreshToken } from '../services/auth/loginSessionHelper.js';
import { generateToken } from '../utils/jwtUtils.js';
import {
  blacklistToken,
  getCurrentTokenEpoch,
  isUserTokensRevoked,
  revokeAllUserTokens,
} from '../utils/tokenBlacklist.js';
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
 *
 * Stamped with the identity's CURRENT token_epoch, exactly like production
 * mints (issueAccessTokenAndClaimSession). This matters mid-suite: once an
 * earlier test bumps the epoch, an epoch-LESS token is treated as minted at
 * epoch 0 and is (correctly) refused at the WS handshake — the fail-closed
 * legacy-token contract from the issuance-gate work, not a bug.
 */
async function accessTokenFor(user, jti = null) {
  const epoch = await getCurrentTokenEpoch(String(user.uid));
  return generateToken(
    {
      uid: user.uid,
      phone: user.phone,
      role: 'PATIENT',
      tenant_id: DEFAULT_TENANT,
      token_epoch: epoch,
      ...(jti ? { jti } : {}),
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

describe('P9 — durable revoke-all evidence stays honest', () => {
  let user;

  beforeAll(async () => {
    user = await createPatient('44');
  });

  afterAll(async () => {
    await cleanupPatient(user?.uid);
  });

  it('applies a durable watermark to an epoch-stamped token', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 5;
    const tokenEpoch = await getCurrentTokenEpoch(String(user.uid));
    await prisma.$queryRawUnsafe(
      `INSERT INTO invalidated_tokens (jti, expires_at, reason, created_at)
       VALUES ($1, NOW() + INTERVAL '1 hour', 'watermark_test', NOW())
       ON CONFLICT (jti) DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         reason = EXCLUDED.reason,
         created_at = EXCLUDED.created_at
       RETURNING jti`,
      `user:${user.uid}`,
    );

    await expect(
      isUserTokensRevoked(String(user.uid), issuedAt, tokenEpoch),
    ).resolves.toBe(true);
  });

  it('fails closed without writing a marker when no identity epoch row exists', async () => {
    const missingUid = randomUUID();

    await expect(
      revokeAllUserTokens(missingUid, {
        requireEvidence: true,
        reason: 'missing_identity_test',
      }),
    ).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });

    const markers = await prisma.$queryRawUnsafe(
      'SELECT jti FROM invalidated_tokens WHERE jti = $1',
      `user:${missingUid}`,
    );
    expect(markers).toEqual([]);
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
    const token = await accessTokenFor(user);
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
    // Fresh socket for the same user. The previous test's logout bumped the
    // identity's epoch, so this token MUST carry the current epoch (as any
    // real re-login token would) or the handshake is (correctly) refused
    // with 4001 before 'connected' ever fires. accessTokenFor reads the
    // current epoch, so no iat-granularity sleep is needed — the epoch
    // comparison, not the revoke-all timestamp, decides admission.
    const token = await accessTokenFor(user);
    const { ws, frames } = await connect(token);
    const closePromise = waitForClose(ws);

    await AuthService.revokeAllTokens(String(user.uid));

    const closed = await closePromise;
    expect(closed.code).toBe(4001);
    expect(frames.some((f) => f.event === 'session:revoked')).toBe(true);
  });

  it('a device-scoped logout closes only the socket authenticated by that jti', async () => {
    const revokedJti = randomUUID();
    const siblingJti = randomUUID();
    const revoked = await connect(await accessTokenFor(user, revokedJti));
    const sibling = await connect(await accessTokenFor(user, siblingJti));
    const closePromise = waitForClose(revoked.ws);

    try {
      await blacklistToken(
        revokedJti,
        Math.floor(Date.now() / 1000) + 3600,
        'logout',
        { requireEvidence: true, userId: String(user.uid) },
      );

      await expect(closePromise).resolves.toMatchObject({ code: 4001 });
      expect(revoked.frames.some((frame) => frame.event === 'session:revoked')).toBe(true);
      expect(sibling.ws.readyState).toBe(WebSocket.OPEN);
      expect(sibling.frames.some((frame) => frame.event === 'session:revoked')).toBe(false);
    } finally {
      sibling.ws.close();
      await prisma.$executeRawUnsafe(
        'DELETE FROM invalidated_tokens WHERE jti = $1',
        revokedJti,
      ).catch(() => {});
    }
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

  it('rejects logout without an authenticated bearer', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-For', '203.0.113.76')
      .send({});

    expect(res.statusCode).toBe(401);
    expect(res.body?.success).toBe(false);
  });

  it('throttles repeated unauthenticated logout attempts', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Forwarded-For', '198.51.100.176')
        .send({});
      statuses.push(res.statusCode);
    }

    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
  });

  it('returns 500 (not fake success) when Postgres rejects the revocation write', async () => {
    const token = await accessTokenFor(user);
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
    const token = await accessTokenFor(user);
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-For', '203.0.113.78')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.statusCode).toBe(200);
    expect(res.body?.success).toBe(true);
  });
});
