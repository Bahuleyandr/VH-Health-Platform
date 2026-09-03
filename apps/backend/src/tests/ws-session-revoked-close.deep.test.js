// src/tests/ws-session-revoked-close.deep.test.js
//
// STF-1 / H3 (2026-08-10 re-review): a `session:revoked` push must not leave
// the revoked session's WebSocket open. Before the fix, wsServer delivered
// the revocation event over the still-open socket and kept the socket
// registered — on shared ward devices the next realtime message (subject +
// body snackbars) rendered on the LOGIN SCREEN after logout.
//
// Proves, with a real WebSocket server + real JWTs (no mocks):
//   (a) a connected socket that is sent `session:revoked` receives the event
//       AND is then closed server-side with code 4001;
//   (b) an ordinary user-targeted event does NOT close the socket (control);
//   (c) after the revocation close, further sendToUser deliveries for that
//       user reach zero sockets (the registration is gone).

import http from 'http';
import prisma from '../lib/prisma.js';
import { ensureTestIdentity } from './testClient.js';
import WebSocket from 'ws';

import { generateToken } from '../utils/jwtUtils.js';
import {
  initWebSocket,
  closeWebSocket,
  sendToUser,
  getConnectedCount,
} from '../utils/websocket/wsServer.js';

const TENANT = 'fa11ed00-0000-4000-8000-0000000000bb';
const STAFF_UID = 'fa11ed00-0000-4000-8000-000000000011';

function staffToken() {
  return generateToken(
    { uid: STAFF_UID, role: 'NURSE', tenant_id: TENANT, tenantId: TENANT },
    '1h',
  );
}

/** Open a socket and resolve once the server has emitted `connected`. */
function connectAndRegister(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${staffToken()}`);
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('session:revoked closes the delivered-to sockets server-side', () => {
  let server;
  let port;

  beforeAll(async () => {
    // The socket subject has to be a live identity AND sit in the tenant its
    // token claims: the ws handshake resolves it through the same durable
    // revocation gate as HTTP and then compares the ticket's tenant against
    // users.tenant_id. An unseeded uid — or one seeded into a different tenant
    // — never completes registration, and connectAndRegister just hangs to the
    // test timeout. TENANT has no tenants row of its own, so create it first;
    // otherwise ensureTestIdentity falls back to the default tenant and the
    // equality check rejects the socket.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      TENANT, 'ws-session-revoked-close', 'WS session revoked close',
    );
    await ensureTestIdentity(STAFF_UID, { role: 'NURSE', tenantId: TENANT });
    server = http.createServer();
    initWebSocket(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await closeWebSocket();
    await new Promise((resolve) => server.close(resolve));
  });

  it('an ordinary user event does NOT close the socket (control)', async () => {
    const { ws, frames } = await connectAndRegister(port);

    sendToUser(STAFF_UID, 'notification', { title: 'hello' }, { tenantId: null });
    await wait(300);

    expect(frames.some((f) => f.event === 'notification')).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await waitForClose(ws);
  });

  it('delivers session:revoked, then closes the socket with 4001', async () => {
    const { ws, frames } = await connectAndRegister(port);
    const closePromise = waitForClose(ws);

    sendToUser(
      STAFF_UID,
      'session:revoked',
      { reason: 'new_login_elsewhere' },
      { tenantId: null },
    );

    const closed = await closePromise;
    expect(closed.code).toBe(4001);

    const revoked = frames.find((f) => f.event === 'session:revoked');
    expect(revoked).toBeDefined();
    expect(revoked.data.reason).toBe('new_login_elsewhere');
  });

  it('after the revocation close, the user has no registered sockets left', async () => {
    // The previous test closed the only socket for STAFF_UID; the server
    // side of the close handshake can land a tick later than the client's
    // close event, so poll briefly instead of asserting instantly.
    const deadline = Date.now() + 3000;
    while (getConnectedCount() > 0 && Date.now() < deadline) {
      await wait(50);
    }
    expect(getConnectedCount()).toBe(0);
    // A fresh revocation push must be a clean no-op (no throw).
    expect(() =>
      sendToUser(STAFF_UID, 'session:revoked', { reason: 'again' }, { tenantId: null }),
    ).not.toThrow();
  });
});
