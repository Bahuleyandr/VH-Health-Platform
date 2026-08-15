// src/routes/realtime/realtimeTicketRoutes.js
//
// JWT-protected ticket exchange for browser-side WebSocket clients that can't
// expose their long-lived JWT to JS (e.g. the admin portal, where the token is
// in an httpOnly cookie). Authenticated callers POST /realtime/ticket and
// receive a ~60s-TTL WS-scoped JWT; the WS handshake validates this like any
// other token.

import express from 'express';
import { generateToken } from '../../utils/jwtUtils.js';
import {
  getCurrentTokenEpoch,
  RevocationCheckUnavailableError,
} from '../../utils/tokenBlacklist.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

const router = express.Router();

const TICKET_TTL = '60s';

router.post('/ticket', async (req, res) => {
  try {
    const user = req.user;
    if (!user?.uid) {
      return error(res, 'Unauthenticated', HTTP_STATUS.UNAUTHORIZED);
    }
    if (user.scope && user.scope !== 'full') {
      return error(res, 'Full-scope token required', HTTP_STATUS.FORBIDDEN);
    }
    if (!user.jti) {
      return error(res, 'Access session identity required', HTTP_STATUS.FORBIDDEN);
    }
    const tenantId = req.tenantId || user.tenant_id || user.tenantId;
    if (!tenantId) {
      return error(res, 'Tenant context required', HTTP_STATUS.FORBIDDEN);
    }

    // R1 (issuance-time revocation gate, migration 650): the ticket MUST carry
    // a token_epoch, or the WS handshake's fail-closed gate treats it as a
    // legacy epoch-0 token and refuses it (4001) for any identity whose epoch
    // was ever bumped — i.e. every user who has ever logged out or been
    // force-revoked, even with a perfectly fresh session.
    //
    // The ticket inherits the SAME epoch as the bearer that requested it
    // (surfaced by jwtMiddleware as req.user.token_epoch): the ticket is a
    // 60s-TTL derivative of that session, so it must be exactly as revoked as
    // its parent — a revoke-all bumps past both together, and a bearer from a
    // stale epoch can't launder itself into a fresher ticket.
    //
    // Fallback to the durable store's current epoch when:
    //   - the bearer predates the epoch claim (legacy, pre-#833). Minting at
    //     the CURRENT epoch is correct: the bearer itself just passed the full
    //     revocation gate (an epoch-less bearer is only admitted while the
    //     identity's epoch is still 0), so this mirrors what a login-time mint
    //     (issueAccessTokenAndClaimSession) would stamp right now.
    //   - an acting-as delegation hop rewrote req.user to the dependent: the
    //     bearer's epoch belongs to the guardian's identity, not the ticket's
    //     subject, so resolve the dependent's own epoch instead.
    // getCurrentTokenEpoch fails CLOSED (throws) when the store is unreachable.
    const tokenEpoch = !req.acting && Number.isFinite(user.token_epoch)
      ? user.token_epoch
      : await getCurrentTokenEpoch(String(user.uid));

    const ticket = generateToken(
      {
        uid: String(user.uid),
        role: user.role,
        phone: user.phone,
        tenant_id: tenantId,
        tenantId,
        scope: 'ws',
        token_epoch: tokenEpoch,
        // This value comes from the already-authenticated access JWT, never
        // request input. It lets a selectorless legacy registry row correlate
        // its access jti with this ticket's intentionally distinct jti.
        accessSessionJti: String(user.jti),
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
    if (err instanceof RevocationCheckUnavailableError) {
      logger.error('WS ticket refused (fail closed): token-epoch store unreachable', {
        error: err.message,
      });
      return error(
        res,
        'Authentication service temporarily unavailable. Please retry.',
        HTTP_STATUS.SERVICE_UNAVAILABLE,
      );
    }
    logger.error('Failed to issue WS ticket:', err);
    error(res, 'Failed to issue ticket', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
