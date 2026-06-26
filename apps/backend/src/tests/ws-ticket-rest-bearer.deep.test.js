// src/tests/ws-ticket-rest-bearer.deep.test.js
//
// Security regression: a short-lived WebSocket ticket (scope:'ws', minted by
// POST /api/v1/realtime/ticket for the WS handshake) must NEVER authenticate a
// normal REST request.
//
// The bug: jwtMiddleware collapsed every non-'mfa_setup' scope to 'full'
// (`const scope = decoded.scope === 'mfa_setup' ? 'mfa_setup' : 'full'`), so a
// leaked / intercepted ws ticket — routinely passed in `?token=` query params
// that proxies and referrers log — was treated as a full-access REST bearer for
// its 60s lifetime.
//
// Proves, end-to-end with the REAL auth middleware + REAL JWTs (no mocks):
//   (a) a ws ticket is 403'd on a representative protected REST endpoint
//       (jwtAuth + enforceFullScope, mirroring the app.js global chain), AND on
//       a route that mounts jwtAuth WITHOUT enforceFullScope (mirroring the
//       local mounts in staffAuthRoutes / hl7 / health / infra) — proving the
//       rejection holds at the single JWT chokepoint, not just where
//       enforceFullScope happens to be mounted.
//   (b) the same ws ticket still authenticates the WebSocket handshake.
//   (c) a normal full-scope token still works on REST.
//   (d) the mfa_setup setup-token flow is unchanged (accepted by
//       requireSetupScope on the setup route; still rejected by enforceFullScope
//       on a normal route).

import http from 'http';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';

import jwtAuth, { enforceFullScope, requireSetupScope } from '../middleware/jwtMiddleware.js';
import { generateToken, issueSetupToken } from '../utils/jwtUtils.js';
import { initWebSocket, closeWebSocket } from '../utils/websocket/wsServer.js';

// Any non-null tenant — wsServer requires a tenant claim; the value is irrelevant.
// UIDs are valid UUIDs (hex only) so the incidental uid→users.id lookup in
// jwtMiddleware resolves cleanly (no row) instead of erroring on a bad uuid.
const TENANT = 'fa11ed00-0000-4000-8000-0000000000aa';
const WS_UID = 'fa11ed00-0000-4000-8000-000000000001';
const FULL_UID = 'fa11ed00-0000-4000-8000-000000000002';
const SETUP_UID = 'fa11ed00-0000-4000-8000-000000000003';

// A ws ticket exactly as realtimeTicketRoutes mints it.
function wsTicket() {
  return generateToken(
    { uid: WS_UID, role: 'PATIENT', tenant_id: TENANT, tenantId: TENANT, scope: 'ws' },
    '60s',
  );
}
function fullToken() {
  return generateToken({ uid: FULL_UID, role: 'PATIENT', tenant_id: TENANT }, '1h');
}
function setupToken() {
  return issueSetupToken({ uid: SETUP_UID, role: 'SUPER_ADMIN' });
}

function buildApp() {
  const app = express();
  // Mirrors the app.js protected chain: jwtAuth → enforceFullScope.
  app.get('/protected', jwtAuth, enforceFullScope, (req, res) => {
    res.json({ ok: true, scope: req.user.scope, uid: req.user.uid });
  });
  // Mirrors a router that mounts jwtAuth LOCALLY without enforceFullScope
  // (staffAuthRoutes / hl7 /generate / health / infra). The ws rejection must
  // still fire here — that is the whole point of enforcing it inside jwtAuth.
  app.get('/local-mount', jwtAuth, (req, res) => {
    res.json({ ok: true, scope: req.user.scope });
  });
  // Mirrors the /mfa/setup-enroll mount: jwtAuth → requireSetupScope.
  app.post('/setup', jwtAuth, requireSetupScope, (req, res) => {
    res.json({ ok: true, scope: req.user.scope });
  });
  return app;
}

describe('ws ticket cannot be used as a REST bearer (security)', () => {
  let app;
  beforeAll(() => {
    app = buildApp();
  });

  // (a)
  it('403s a ws-scope ticket on a protected REST endpoint (jwtAuth + enforceFullScope)', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${wsTicket()}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WS_SCOPE_NOT_ALLOWED');
  });

  // (a) — local-mount gap: jwtAuth only, no enforceFullScope.
  it('403s a ws-scope ticket even on a route that mounts jwtAuth without enforceFullScope', async () => {
    const res = await request(app)
      .get('/local-mount')
      .set('Authorization', `Bearer ${wsTicket()}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WS_SCOPE_NOT_ALLOWED');
  });

  // (c)
  it('still allows a normal full-scope token on the same protected endpoint', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${fullToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scope: 'full' });
  });

  // (d) mfa_setup flow unchanged.
  describe('mfa_setup setup-token flow is unchanged', () => {
    it('is accepted by the setup route (requireSetupScope)', async () => {
      const res = await request(app)
        .post('/setup')
        .set('Authorization', `Bearer ${setupToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe('mfa_setup');
    });

    it('is still rejected by enforceFullScope on a normal route', async () => {
      const res = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${setupToken()}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    });
  });
});

describe('the same ws ticket still authenticates the WS handshake', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = http.createServer();
    initWebSocket(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await closeWebSocket();
    await new Promise((resolve) => server.close(resolve));
  });

  // (b)
  it('accepts the ws ticket on the /ws upgrade and emits "connected"', async () => {
    const ticket = wsTicket();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${ticket}`);

    const event = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout: no "connected" event received')),
        5000,
      );
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.event === 'connected') {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {
          /* ignore non-JSON frames */
        }
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

    expect(event.event).toBe('connected');
    // wsServer derives userId from decoded.sub (generateToken stamps uid → sub).
    expect(String(event.userId)).toBe(WS_UID);

    ws.close();
  });
});
