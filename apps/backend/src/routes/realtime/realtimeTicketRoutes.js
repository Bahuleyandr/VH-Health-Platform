// src/routes/realtime/realtimeTicketRoutes.js
//
// JWT-protected ticket exchange for browser-side WebSocket clients that can't
// expose their long-lived JWT to JS (e.g. the admin portal, where the token is
// in an httpOnly cookie). Authenticated callers POST /realtime/ticket and
// receive a ~60s-TTL WS-scoped JWT; the WS handshake validates this like any
// other token.

import express from 'express';
import { generateToken } from '../../utils/jwtUtils.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

const router = express.Router();

const TICKET_TTL = '60s';

router.post('/ticket', (req, res) => {
  try {
    const user = req.user;
    if (!user?.uid) {
      return error(res, 'Unauthenticated', HTTP_STATUS.UNAUTHORIZED);
    }
    if (user.scope && user.scope !== 'full') {
      return error(res, 'Full-scope token required', HTTP_STATUS.FORBIDDEN);
    }
    const tenantId = req.tenantId || user.tenant_id || user.tenantId;
    if (!tenantId) {
      return error(res, 'Tenant context required', HTTP_STATUS.FORBIDDEN);
    }
    const ticket = generateToken(
      {
        uid: String(user.uid),
        role: user.role,
        phone: user.phone,
        tenant_id: tenantId,
        tenantId,
        scope: 'ws',
        // Bind this one-minute credential to the parent login session. Its own
        // jti is intentionally unique, so jti-only logout targeting cannot
        // identify the access-token session that minted it.
        sessionFamilyId: user.sessionFamilyId || user.jti,
        ...(user.stableDeviceId ? { stableDeviceId: user.stableDeviceId } : {}),
        ...(req.acting?.actorUid
          ? { revocationOwnerUid: String(req.acting.actorUid) }
          : {}),
      },
      TICKET_TTL,
    );
    success(res, { ticket, ttlSeconds: 60 }, 'WebSocket ticket issued');
  } catch (err) {
    logger.error('Failed to issue WS ticket:', err);
    error(res, 'Failed to issue ticket', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
