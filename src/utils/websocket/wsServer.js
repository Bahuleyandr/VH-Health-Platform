// src/utils/websocket/wsServer.js

import { WebSocketServer } from 'ws';
import logger from '../../logging/logger.js';
import { verifyToken } from '../jwtUtils.js';
import { isTokenBlacklisted, isUserTokensRevoked } from '../tokenBlacklist.js';
import { authorizeChannel } from './channelAuth.js';

/** @type {Map<string, Set<import('ws').WebSocket>>} userId → Set of sockets */
const clients = new Map();

/** @type {Map<import('ws').WebSocket, { userId: string, role: string, channels: Set<string> }>} */
const socketMeta = new Map();

let wss = null;

const HEARTBEAT_INTERVAL = 30_000; // 30s
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer limit per client
const MAX_CONNECTIONS_PER_USER = 5;

export function initWebSocket(server) {
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
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(interval));
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

  const userId = decoded.uid || decoded.id || decoded.sub;
  const role = decoded.role;
  if (!userId) {
    ws.close(4001, 'Invalid token payload');
    return;
  }

  // Check if all user tokens were revoked (force-logout)
  if (decoded.iat) {
    const revoked = await isUserTokensRevoked(String(userId), decoded.iat);
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
  socketMeta.set(ws, { userId, role, channels: new Set() });

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
        const decision = authorizeChannel(msg.channel, { userId: meta.userId, role: meta.role });
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
          const decision = authorizeChannel(channel, { userId: meta.userId, role: meta.role });
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

/**
 * Broadcast to all clients subscribed to a channel.
 */
export function broadcast(channel, data) {
  if (!wss) return;
  const payload = JSON.stringify({ event: channel, data });
  for (const [ws, meta] of socketMeta) {
    if (meta.channels.has(channel) && ws.readyState === 1) {
      // Skip slow clients to prevent memory buildup
      if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        logger.warn(`Skipping broadcast to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
        continue;
      }
      ws.send(payload);
    }
  }
}

/**
 * Send a message to a specific user (all their connected sockets).
 */
export function sendToUser(userId, event, data) {
  const sockets = clients.get(String(userId));
  if (!sockets) return;
  const payload = JSON.stringify({ event, data });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

/**
 * Get count of connected clients.
 */
export function getConnectedCount() {
  return wss ? wss.clients.size : 0;
}
