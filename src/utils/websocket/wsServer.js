// src/utils/websocket/wsServer.js

import { WebSocketServer } from 'ws';
import { verifyToken } from '../jwtUtils.js';
import { isTokenBlacklisted, isUserTokensRevoked } from '../tokenBlacklist.js';
import logger from '../../logging/logger.js';

/** @type {Map<string, Set<import('ws').WebSocket>>} userId → Set of sockets */
const clients = new Map();

/** @type {Map<import('ws').WebSocket, { userId: string, channels: Set<string> }>} */
const socketMeta = new Map();

let wss = null;

const HEARTBEAT_INTERVAL = 30_000; // 30s
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer limit per client
const MAX_CONNECTIONS_PER_USER = 5;

export function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  logger.info('🔌 WebSocket server initialized on /ws');

  wss.on('connection', async (ws, req) => {
    // Accept token from Authorization header (preferred) or ?token= query param
    // Browsers cannot set custom headers on WebSocket connections, so query param is the fallback.
    const wsUrl = new URL(req.url, 'ws://localhost');
    const queryToken = wsUrl.searchParams.get('token');
    const headerToken = req.headers.authorization?.replace('Bearer ', '');
    const token = headerToken || queryToken;

    if (!token) {
      ws.close(4001, 'Authorization required: provide Authorization header or ?token= query param');
      return;
    }

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
    socketMeta.set(ws, { userId, channels: new Set() });

    logger.info(`🔌 WS connected: user=${userId}`);

    // Ping/pong heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.action === 'subscribe' && msg.channel) {
          socketMeta.get(ws)?.channels.add(msg.channel);
          ws.send(JSON.stringify({ event: 'subscribed', channel: msg.channel }));
        } else if (msg.action === 'unsubscribe' && msg.channel) {
          socketMeta.get(ws)?.channels.delete(msg.channel);
          ws.send(JSON.stringify({ event: 'unsubscribed', channel: msg.channel }));
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
