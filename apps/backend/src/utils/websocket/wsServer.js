// src/utils/websocket/wsServer.js

import { WebSocketServer } from 'ws';
import logger from '../../logging/logger.js';
import { verifyToken } from '../jwtUtils.js';
import { isTokenBlacklisted, isUserTokensRevoked } from '../tokenBlacklist.js';
import { authorizeChannel } from './channelAuth.js';
import { createWsFanout } from './wsRedisAdapter.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import { recordWsBroadcastDropped } from '../../observability/reliabilityMetrics.js';

// One fan-out per wsServer module instance (= one per process in production).
// Created here rather than imported as a shared singleton so the
// differential-delivery harness can load two independent wsServer realms (via
// query-string cache-busting) that own separate fan-outs over one shared bus.
const fanout = createWsFanout();

/** Wire this process's fan-out onto the Redis bus. Called from bin/www.js. */
export function initWsFanout(opts) {
  return fanout.init(opts);
}

/** Tear down this process's fan-out subscriber (graceful shutdown / tests). */
export function closeWsFanout() {
  return fanout.close();
}

/** @type {Map<string, Set<import('ws').WebSocket>>} userId → Set of sockets */
const clients = new Map();

/** @type {Map<import('ws').WebSocket, { userId: string, role: string, tenantId?: string, jti?: string, channels: Set<string> }>} */
const socketMeta = new Map();

let wss = null;
let heartbeatInterval = null;

const HEARTBEAT_INTERVAL = 30_000; // 30s
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer limit per client
const MAX_CONNECTIONS_PER_USER = 5;

export function initWebSocket(server) {
  if (wss) {
    closeWebSocket();
  }

  wss = new WebSocketServer({ server, path: '/ws' });

  logger.info('🔌 WebSocket server initialized on /ws');

  wss.on('connection', async (ws, req) => {
    // Accept token from Authorization header, ?token= query param, or first message frame.
    // Browsers cannot set custom headers on WebSocket connections, so query param
    // and message-based auth are the two client options.
    const wsUrl = new URL(req.url, 'ws://localhost');
    const queryToken = wsUrl.searchParams.get('token');
    const headerToken = req.headers.authorization?.replace('Bearer ', '');
    const token = headerToken || queryToken;

    if (token) {
      // Immediate auth via header or query param
      await authenticateAndRegister(ws, token);
    } else {
      // No token in URL — wait for auth message as first frame (5s timeout)
      const authTimeout = setTimeout(() => {
        if (!socketMeta.has(ws)) {
          ws.close(4001, 'Authentication timeout: send {"action":"auth","token":"..."} within 5 seconds');
        }
      }, 5000);

      ws.once('message', async (raw) => {
        clearTimeout(authTimeout);
        try {
          const msg = JSON.parse(raw);
          if (msg.action === 'auth' && msg.token) {
            await authenticateAndRegister(ws, msg.token);
          } else {
            ws.close(4001, 'First message must be {"action":"auth","token":"..."}');
          }
        } catch {
          ws.close(4001, 'Invalid auth message');
        }
      });
    }
  });

  // Heartbeat interval to detect dead connections
  heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  if (heartbeatInterval.unref) heartbeatInterval.unref();
  wss.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    clients.clear();
    socketMeta.clear();
  });
}

export function closeWebSocket() {
  const activeServer = wss;
  if (!activeServer) return Promise.resolve();

  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = null;

  for (const ws of activeServer.clients) {
    ws.terminate();
  }

  return new Promise((resolve) => {
    activeServer.close(() => {
      if (wss === activeServer) wss = null;
      clients.clear();
      socketMeta.clear();
      resolve();
    });
  });
}

/**
 * Authenticate a WebSocket connection and register it for messaging.
 * Shared by both URL-based and message-based auth flows.
 */
async function authenticateAndRegister(ws, token) {
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    ws.close(4001, 'Invalid token');
    return;
  }

  if (!decoded) {
    ws.close(4001, 'Invalid token');
    return;
  }

  // Check token blacklist (revoked/rotated tokens)
  if (decoded.jti) {
    const blacklisted = await isTokenBlacklisted(decoded.jti);
    if (blacklisted) {
      ws.close(4001, 'Token has been revoked');
      return;
    }
  }

  const identityClaim = decoded.uid || decoded.sub || decoded.id;
  const userId = identityClaim === undefined || identityClaim === null
    ? null
    : String(identityClaim);
  const role = decoded.role;
  const tenantId = decoded.tenant_id || decoded.tenantId || null;
  if (!userId) {
    ws.close(4001, 'Invalid token payload');
    return;
  }
  if (!tenantId) {
    ws.close(4001, 'Invalid token tenant');
    return;
  }

  // Check if all user tokens were revoked (force-logout)
  if (decoded.iat) {
    const revoked = await isUserTokensRevoked(String(userId), decoded.iat, decoded.token_epoch);
    if (revoked) {
      ws.close(4001, 'All sessions revoked');
      return;
    }
  }

  // Enforce per-user connection limit
  const existingConnections = clients.get(userId);
  if (existingConnections && existingConnections.size >= MAX_CONNECTIONS_PER_USER) {
    ws.close(4029, 'Too many concurrent connections');
    return;
  }

  // Register client
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
  socketMeta.set(ws, { userId, role, tenantId, jti: decoded.jti ?? null, channels: new Set() });

  logger.info(`🔌 WS connected: user=${userId} role=${role || 'unknown'}`);

  // Ping/pong heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === 'subscribe' && msg.channel) {
        const meta = socketMeta.get(ws);
        if (!meta) return;
        const decision = authorizeChannel(msg.channel, { userId: meta.userId, role: meta.role, tenantId: meta.tenantId });
        if (!decision.allowed) {
          ws.send(JSON.stringify({
            event: 'subscribe-denied',
            channel: msg.channel,
            reason: decision.reason,
            ts: Date.now(),
          }));
          return;
        }
        meta.channels.add(msg.channel);
        ws.send(JSON.stringify({
          event: 'subscribed',
          channel: msg.channel,
          ts: Date.now(),
        }));
      } else if (msg.action === 'unsubscribe' && msg.channel) {
        socketMeta.get(ws)?.channels.delete(msg.channel);
        ws.send(JSON.stringify({
          event: 'unsubscribed',
          channel: msg.channel,
          ts: Date.now(),
        }));
      } else if (msg.action === 'ping') {
        // App-level ping/pong. Browsers hide WS-frame pings from JS, so
        // clients can't measure RTT or detect half-open connections that way.
        // This lets clients do both via normal JSON messages. Echo the
        // client ts back so the client can compute round-trip latency.
        ws.isAlive = true; // any traffic counts as alive for the WS-frame heartbeat too
        ws.send(JSON.stringify({
          event: 'pong',
          ts: typeof msg.ts === 'number' ? msg.ts : null,
          serverTs: Date.now(),
        }));
      } else if (msg.action === 'resync' && Array.isArray(msg.channels)) {
        // Client reconnected after a disconnect and wants to re-assert its
        // subscription list. We re-authorize each channel (role may have
        // changed since the old session) and emit one `subscribed` /
        // `subscribe-denied` event per channel so the client can reconcile
        // its local state.
        const meta = socketMeta.get(ws);
        if (!meta) return;
        for (const channel of msg.channels) {
          if (typeof channel !== 'string') continue;
          const decision = authorizeChannel(channel, { userId: meta.userId, role: meta.role, tenantId: meta.tenantId });
          if (decision.allowed) {
            meta.channels.add(channel);
            ws.send(JSON.stringify({ event: 'subscribed', channel, ts: Date.now() }));
          } else {
            meta.channels.delete(channel);
            ws.send(JSON.stringify({
              event: 'subscribe-denied',
              channel,
              reason: decision.reason,
              ts: Date.now(),
            }));
          }
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    const meta = socketMeta.get(ws);
    if (meta) {
      clients.get(meta.userId)?.delete(ws);
      if (clients.get(meta.userId)?.size === 0) clients.delete(meta.userId);
      socketMeta.delete(ws);
    }
  });

  ws.on('error', (err) => {
    logger.error(`WS error for user=${userId}:`, err.message);
  });

  // Send welcome
  ws.send(JSON.stringify({ event: 'connected', userId }));
}

// ---------------------------------------------------------------------------
// Local (in-process) delivery loops.
//
// These are the ONLY place a socket.send() happens for a fan-out. They are
// invoked two ways:
//   1) directly, when the Redis bus is unavailable (degraded single-process), or
//   2) by the wsRedisAdapter SUBSCRIBE consumer, when a broadcast/sendToUser
//      published from THIS or ANY OTHER process arrives over the bus.
// Either way the 1MB bufferedAmount backpressure guard and the per-broadcast
// tenant filter apply identically.
// ---------------------------------------------------------------------------

/**
 * Per-broadcast tenant filter. A socket only receives a message whose tenant
 * matches the socket's own tenant (captured from the ws ticket at connect time).
 * `eventTenantId == null` means "no tenant scoping" (legacy / system events) and
 * is delivered to everyone subscribed — but every first-party emit now carries a
 * tenant, so the global staff:/admin: channels are tenant-isolated in practice.
 */
function tenantMatches(socketTenantId, eventTenantId) {
  if (eventTenantId == null) return true;
  return String(socketTenantId) === String(eventTenantId);
}

/** Deliver a channel broadcast to this process's subscribed sockets. */
function deliverBroadcastLocal(channel, event, data, tenantId) {
  if (!wss) return;
  const payload = JSON.stringify({ event: event ?? channel, data });
  for (const [ws, meta] of socketMeta) {
    if (!meta.channels.has(channel) || ws.readyState !== 1) continue;
    // Cross-tenant realtime leak guard: drop messages for a different tenant.
    if (!tenantMatches(meta.tenantId, tenantId)) continue;
    // Skip slow clients to prevent memory buildup (1MB buffer cap).
    if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      recordWsBroadcastDropped('backpressure');
      logger.warn(`Skipping broadcast to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
      continue;
    }
    ws.send(payload);
  }
}

// Session-revocation events must not leave the revoked session's sockets
// open: on shared ward devices the still-connected socket kept delivering
// message subjects/bodies onto the login screen after logout (STF-1 / H3).
// After delivering `session:revoked`, the socket is closed server-side —
// the client's own teardown is belt-and-braces, not the enforcement point.
const SESSION_REVOKED_EVENT = 'session:revoked';
const SESSION_REVOKED_CLOSE_CODE = 4001;

/** Deliver a user-targeted message to this process's sockets for that user. */
function deliverUserLocal(userId, event, data, tenantId) {
  const sockets = clients.get(String(userId));
  if (!sockets) return;
  const payload = JSON.stringify({ event, data });
  const isRevocation = event === SESSION_REVOKED_EVENT;
  const revokedJti = isRevocation && data?.jti ? String(data.jti) : null;
  // Copy: closing a socket mutates `sockets` via the ws 'close' handler.
  for (const ws of [...sockets]) {
    const meta = socketMeta.get(ws);
    if (!tenantMatches(meta?.tenantId, tenantId)) continue;
    if (revokedJti && String(meta?.jti || '') !== revokedJti) continue;
    const open = ws.readyState === 1;
    if (open) {
      if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        recordWsBroadcastDropped('backpressure');
        logger.warn(`Skipping sendToUser to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
      } else {
        ws.send(payload);
      }
    }
    if (isRevocation) {
      // Close even when the send was skipped (backpressure) or the socket
      // is still connecting — a revoked session gets no further delivery.
      try {
        ws.close(SESSION_REVOKED_CLOSE_CODE, 'Session revoked');
      } catch {
        ws.terminate();
      }
    }
  }
}

// Register the local loops with the Redis adapter once, at module load. The
// adapter's SUBSCRIBE consumer calls these on every bus message. This wiring is
// independent of whether Redis is actually configured — if it isn't, the
// publish() helpers below return false and we run these loops directly.
fanout.registerLocalDelivery({
  deliverBroadcast: deliverBroadcastLocal,
  deliverUser: deliverUserLocal,
});

/**
 * Resolve the tenant to stamp on a fan-out. A broadcast issued by a service has
 * no per-message tenant, so we derive it from the request-scoped tenant context
 * (AsyncLocalStorage) when present. Falls back to null (no scoping) so a missing
 * context degrades to the pre-existing broadcast-to-all behaviour rather than
 * dropping the event entirely.
 */
function resolveTenantId(explicitTenantId) {
  if (explicitTenantId != null) return explicitTenantId;
  try {
    return getCurrentTenantId() ?? null;
  } catch {
    return null;
  }
}

/**
 * Broadcast to all clients subscribed to a channel, across EVERY process.
 *
 * Publishes the event onto the Redis bus so every process's SUBSCRIBE consumer
 * delivers it to its own local sockets. When the bus is unavailable, falls back
 * to delivering only to this process's sockets (degraded, single-process).
 *
 * @param {string} channel
 * @param {*} data
 * @param {object} [opts]
 * @param {string} [opts.tenantId] - explicit tenant scope; defaults to the
 *        request-scoped tenant context. Pass null to broadcast unscoped.
 */
export function broadcast(channel, data, opts = {}) {
  if (!wss) return;
  const tenantId = resolveTenantId(opts.tenantId);
  const published = fanout.publishBroadcast(channel, channel, data, tenantId);
  if (!published) {
    recordWsBroadcastDropped('fanout_local_fallback');
    // Redis down / not configured — deliver locally so single-process dev and
    // degraded prod still work.
    deliverBroadcastLocal(channel, channel, data, tenantId);
  }
}

/**
 * Send a message to a specific user (all their connected sockets) across EVERY
 * process. Publishes onto the bus; falls back to local delivery when the bus is
 * unavailable.
 *
 * @param {string} userId
 * @param {string} event
 * @param {*} data
 * @param {object} [opts]
 * @param {string} [opts.tenantId]
 */
export function sendToUser(userId, event, data, opts = {}) {
  const tenantId = resolveTenantId(opts.tenantId);
  const published = fanout.publishUser(userId, event, data, tenantId);
  if (!published) {
    recordWsBroadcastDropped('fanout_local_fallback');
    deliverUserLocal(String(userId), event, data, tenantId);
  }
}

/**
 * Push `session:revoked` to every open socket of a user, across EVERY process,
 * and close those sockets server-side (deliverUserLocal's revocation branch).
 *
 * Called by the revocation chokepoint (tokenBlacklist.revokeAllUserTokens) so
 * logout, force-revoke-all, and SCIM deprovisioning all tear down live sockets
 * — previously only the env-gated single-session replacement path emitted this
 * event, so a "revoked" session's socket kept delivering realtime data (R14).
 *
 * Deliberately UNSCOPED by tenant (explicit null, bypassing the ambient
 * request tenant context): a revocation must reach every socket the identity
 * holds regardless of the caller's tenant stamp — mirroring the deliberately
 * unscoped SCIM session-kill queries. uid is globally unique, so this cannot
 * leak across identities.
 *
 * @param {string} userId
 * @param {object} [data] - payload delivered with the event (e.g. { reason }).
 */
export function pushSessionRevoked(userId, data = {}) {
  const uid = String(userId);
  // Close this process's sockets synchronously. Redis publish acknowledgement
  // is asynchronous, so its immediate boolean cannot prove remote delivery or
  // safely decide whether local fallback is necessary.
  deliverUserLocal(uid, SESSION_REVOKED_EVENT, data, null);
  fanout.publishUser(uid, SESSION_REVOKED_EVENT, data, null);
}

/**
 * Get count of connected clients.
 */
export function getConnectedCount() {
  return wss ? wss.clients.size : 0;
}
