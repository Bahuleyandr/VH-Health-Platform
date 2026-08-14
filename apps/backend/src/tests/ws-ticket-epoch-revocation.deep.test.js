// src/tests/ws-ticket-epoch-revocation.deep.test.js
//
// Production gap (2026-08-10, post-#833 fail-closed epoch gate): POST
// /api/v1/realtime/ticket minted WS tickets WITHOUT a `token_epoch` claim.
// The WS handshake gate (wsServer → isUserTokensRevoked) treats an epoch-less
// token as minted at epoch 0 and fails closed, so once an identity's epoch is
// ever bumped (any logout / force-revoke), EVERY subsequent ticket-based WS
// handshake was refused 4001 — even for a perfectly fresh, valid session.
//
// Proves, against the REAL database, the REAL jwtMiddleware, the REAL ticket
// route, and a REAL WebSocket server (no mocks):
//
//   (a) identity with epoch >= 1 (post-logout) + a fresh login-equivalent
//       bearer → POST /realtime/ticket succeeds, the ticket carries the SAME
//       token_epoch as the bearer, and the ticket-based WS handshake connects.
//       (Pre-fix: the handshake was refused 4001 before 'connected'.)
//   (b) a revoked identity's ticket is still refused: a ticket minted at
//       epoch N is closed 4001 at the handshake after a revoke-all bumps the
//       identity to epoch N+1 — the fix does not weaken the gate.
//   (c) legacy fallback: an epoch-LESS bearer (pre-#833 mint) for an
//       identity still at epoch 0 gets a ticket stamped with the CURRENT
//       durable epoch (0) and the handshake connects — mirroring what a
//       login-time mint (issueAccessTokenAndClaimSession) would stamp.
//
// Run focused:
//   DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
//   node --experimental-vm-modules --max-old-space-size=4096 \
//     node_modules/jest/bin/jest.js --runInBand src/tests/ws-ticket-epoch-revocation.deep.test.js

import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import WebSocket from 'ws';

import prisma from '../lib/prisma.js';
import jwtAuth from '../middleware/jwtMiddleware.js';
import realtimeTicketRoutes from '../routes/realtime/realtimeTicketRoutes.js';
import { generateToken } from '../utils/jwtUtils.js';
import {
  getCurrentTokenEpoch,
  revokeAllUserTokens,
} from '../utils/tokenBlacklist.js';
import { initWebSocket, closeWebSocket } from '../utils/websocket/wsServer.js';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

/** Insert a throwaway patient row; returns { uid, id, phone }. */
async function createPatient(phoneSuffix) {
  const phone = `+9198991${phoneSuffix}`;
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
 * A fresh login-equivalent bearer: stamped with the identity's CURRENT
 * token_epoch, exactly like production mints (issueAccessTokenAndClaimSession).
 */
async function freshBearerFor(user) {
  const epoch = await getCurrentTokenEpoch(String(user.uid));
  return generateToken(
    {
      uid: user.uid,
      phone: user.phone,
      role: 'PATIENT',
      tenant_id: DEFAULT_TENANT,
      token_epoch: epoch,
    },
    '1h',
  );
}

/** A pre-#833 "legacy" bearer: same shape but NO token_epoch claim. */
function legacyBearerFor(user) {
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

/** Mirrors the app.js chain for the ticket route: global jwtAuth → router. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(jwtAuth);
  app.use('/api/v1/realtime', realtimeTicketRoutes);
  return app;
}

describe('WS ticket carries the bearer token_epoch (post-revocation handshake gap)', () => {
  let app;
  let server;
  let port;
  let user;        // identity with epoch >= 1 (has logged out before)
  let legacyUser;  // identity still at epoch 0 with an epoch-less bearer

  beforeAll(async () => {
    user = await createPatient('41');
    legacyUser = await createPatient('42');

    // The identity has been revoked before (logout / admin force-logout):
    // durable epoch moves to >= 1. This is the state in which every epoch-less
    // ticket is (correctly) refused by the fail-closed handshake gate.
    await revokeAllUserTokens(String(user.uid), { reason: 'test_prior_logout' });
    await expect(getCurrentTokenEpoch(String(user.uid))).resolves.toBeGreaterThanOrEqual(1);

    app = buildApp();
    server = http.createServer();
    initWebSocket(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await closeWebSocket();
    await new Promise((resolve) => server.close(resolve));
    await cleanupPatient(user?.uid);
    await cleanupPatient(legacyUser?.uid);
  });

  function connect(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      const timer = setTimeout(
        () => reject(new Error('timeout: no "connected" event received')),
        5000,
      );
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.event === 'connected') {
            clearTimeout(timer);
            resolve(ws);
          }
        } catch { /* ignore non-JSON frames */ }
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`socket closed before connected (code ${code})`));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Resolves with the close code when the handshake is refused pre-'connected'. */
  function expectRefused(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      const timer = setTimeout(
        () => reject(new Error('timeout: socket neither connected nor closed')),
        5000,
      );
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.event === 'connected') {
            clearTimeout(timer);
            ws.close();
            reject(new Error('handshake unexpectedly succeeded'));
          }
        } catch { /* ignore non-JSON frames */ }
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.on('error', () => { /* close event follows */ });
    });
  }

  async function mintTicket(bearer) {
    const res = await request(app)
      .post('/api/v1/realtime/ticket')
      .set('Authorization', `Bearer ${bearer}`)
      .send({});
    return res;
  }

  // (a) — the regression this fix exists for.
  it('post-logout identity + fresh epoch-stamped bearer → ticket carries the bearer epoch and the WS handshake connects', async () => {
    const epoch = await getCurrentTokenEpoch(String(user.uid));
    expect(epoch).toBeGreaterThanOrEqual(1);

    const bearer = await freshBearerFor(user);
    const res = await mintTicket(bearer);
    expect(res.status).toBe(200);
    const ticket = res.body?.data?.ticket;
    expect(ticket).toBeTruthy();

    // The ticket inherits the SAME epoch the bearer was minted under —
    // pre-fix the claim was absent and the handshake below closed 4001.
    const decoded = jwt.decode(ticket);
    expect(decoded.scope).toBe('ws');
    expect(decoded.token_epoch).toBe(epoch);

    const ws = await connect(ticket);
    ws.close();
  });

  // (b) — the gate itself is not weakened.
  it('a ticket minted before a revoke-all is still refused 4001 at the handshake', async () => {
    const bearer = await freshBearerFor(user);
    const res = await mintTicket(bearer);
    expect(res.status).toBe(200);
    const staleTicket = res.body.data.ticket;

    // Force-revoke bumps the identity epoch past the ticket's stamped epoch.
    await revokeAllUserTokens(String(user.uid), { reason: 'test_force_revoke' });

    const closeCode = await expectRefused(staleTicket);
    expect(closeCode).toBe(4001);
  });

  // (c) — legacy epoch-less bearer fallback (identity still at epoch 0).
  it('legacy epoch-less bearer (epoch-0 identity) → ticket stamped with the current durable epoch and the handshake connects', async () => {
    await expect(getCurrentTokenEpoch(String(legacyUser.uid))).resolves.toBe(0);

    const bearer = legacyBearerFor(legacyUser);
    const res = await mintTicket(bearer);
    expect(res.status).toBe(200);
    const ticket = res.body.data.ticket;

    const decoded = jwt.decode(ticket);
    expect(decoded.scope).toBe('ws');
    expect(decoded.token_epoch).toBe(0);

    const ws = await connect(ticket);
    ws.close();
  });
});
