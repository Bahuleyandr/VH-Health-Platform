// src/routes/realtime/realtimeRoutes.js
//
// Documentation + operational-health endpoints for the real-time fabric.
// The actual transport is the WebSocket server at /ws (see utils/websocket/wsServer.js).

import express from 'express';
import { CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';
import { getConnectedCount } from '../../utils/websocket/wsServer.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

/** GET /api/v1/realtime/channels — list known channels and role scoping */
router.get('/channels', (req, res) => {
  success(res, {
    transport: 'websocket',
    endpoint: '/ws',
    auth: 'JWT via Authorization header, ?token= query, or first-frame {"action":"auth","token":"..."}',
    subscribe: { action: 'subscribe', channel: '<channel name>' },
    channels: CHANNEL_CATALOG,
  }, 'Realtime channel catalog');
});

/** GET /api/v1/realtime/health — live connection count */
router.get('/health', (req, res) => {
  success(res, {
    connectedClients: getConnectedCount(),
  }, 'Realtime health');
});

export default router;
