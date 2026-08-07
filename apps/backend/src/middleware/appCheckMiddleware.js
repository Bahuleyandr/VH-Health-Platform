// src/middleware/appCheckMiddleware.js
//
// Firebase App Check token verification for app-facing traffic (mobile apps).
// Complements the API-key + JWT chain: App Check attests that the CALLING
// BINARY is a genuine, unmodified build of our Flutter apps (Play Integrity /
// DeviceCheck), where the API key only attests possession of a shared secret.
//
// Rollout is staged via APP_CHECK_MODE (validated in src/utils/validateEnv.js):
//   off     — skip entirely, zero overhead (default).
//   report  — verify + log + metrics only; NEVER rejects a request. Safe to
//             run even while console-side App Check registration is incomplete
//             and before any client build sends the header.
//   enforce — reject missing/invalid tokens with 401. Only after the fleet's
//             `verified` ratio on app_check_requests_total is sustainably
//             healthy (see docs/runbooks/FIREBASE_KEY_ROTATION.md §"Backend
//             App Check verification").
//
// Fail-open invariant: an infrastructure failure (Firebase unreachable, Admin
// SDK not configured) is NEVER a reason to reject a request, even in enforce
// mode — a Firebase outage must not take down the hospital API. Only a token
// that Firebase positively rejected (`app-check/*` error codes) counts as
// invalid.
import firebaseAdmin from '../utils/firebaseAdmin.js';
import logger from '../logging/logger.js';
import { error } from '../utils/responseHelper.js';
import { recordAppCheckOutcome } from './prometheusMiddleware.js';

const MODES = new Set(['off', 'report', 'enforce']);

/** Read + normalize APP_CHECK_MODE per request (testable, hot-reloadable). */
function currentMode() {
  const mode = String(process.env.APP_CHECK_MODE || 'off').toLowerCase();
  return MODES.has(mode) ? mode : 'off';
}

/**
 * Factory so app.js can mount this in two contexts:
 *  - pre-API-key-gate mobile entry mounts (/api/v1/auth, /api/v1/otp), where
 *    `req.apiClient` is not yet populated → `assumeAppFacing: true`;
 *  - globally after validateApiKey, where the `req.apiClient` filter scopes it
 *    to the two mobile apps and exempts every integration/admin surface.
 *
 * @param {{ assumeAppFacing?: boolean }} options
 * @returns {import('express').RequestHandler}
 */
export default function appCheckMiddleware({ assumeAppFacing = false } = {}) {
  return async function appCheckHandler(req, res, next) {
    try {
      const mode = currentMode();
      if (mode === 'off') return next();

      // Scope filter: only the two mobile apps carry App Check tokens. Admin
      // portal, SCIM/HL7/ABDM/NHCX/interface-engine/device-ingest and any
      // request without a recognized API client pass through untouched.
      const client = req.apiClient === 'patient' || req.apiClient === 'staff'
        ? req.apiClient
        : undefined;
      if (!assumeAppFacing && !client) return next();

      const token = req.get('X-Firebase-AppCheck');
      if (!token) {
        recordAppCheckOutcome('missing', client);
        if (mode === 'enforce') {
          return error(res, 'App Check token required', 401);
        }
        // report mode: this is ~100% of traffic until client builds attach
        // the header — debug level only, never warn-spam.
        logger.debug('App Check token missing', { requestId: req.id, client });
        return next();
      }

      let claims;
      try {
        claims = await firebaseAdmin.appCheck().verifyToken(token);
      } catch (err) {
        // Firebase positively rejected the token (expired, wrong project,
        // malformed) → invalid. Anything else — network failure, Admin SDK
        // not configured (the degradation stub) — is unverifiable and fails
        // OPEN even in enforce mode.
        const isTokenInvalid = typeof err?.code === 'string' && err.code.startsWith('app-check/');
        if (isTokenInvalid) {
          recordAppCheckOutcome('invalid', client);
          logger.warn('App Check token invalid', { requestId: req.id, client, code: err.code });
          if (mode === 'enforce') {
            return error(res, 'App Check token invalid', 401);
          }
          return next();
        }
        recordAppCheckOutcome('unverifiable', client);
        logger.error('App Check verification unavailable — failing open', {
          requestId: req.id,
          client,
          error: err?.message,
        });
        return next();
      }

      recordAppCheckOutcome('verified', client);
      req.appCheck = { appId: claims.appId, verified: true };
      return next();
    } catch (err) {
      // Belt-and-braces: this middleware must never throw out of itself or
      // block traffic on its own bugs.
      logger.error('App Check middleware internal error — failing open', {
        requestId: req?.id,
        error: err?.message,
      });
      return next();
    }
  };
}
