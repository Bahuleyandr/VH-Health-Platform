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
//
// This middleware is deliberately report-only. Enforcement needs a separate
// reviewed rollout after every supported client attaches the header and the
// expected app-ID lists are proven against fleet metrics.
import firebaseAdmin from '../utils/firebaseAdmin.js';
import logger from '../logging/logger.js';
import { recordAppCheckOutcome } from './prometheusMiddleware.js';

const MODES = new Set(['off', 'report']);
const CLIENT_APP_ID_ENV = Object.freeze({
  patient: 'FIREBASE_APP_CHECK_PATIENT_APP_IDS',
  staff: 'FIREBASE_APP_CHECK_STAFF_APP_IDS',
});

/** Read + normalize APP_CHECK_MODE per request (testable, hot-reloadable). */
function currentMode() {
  const mode = String(process.env.APP_CHECK_MODE || 'off').toLowerCase();
  return MODES.has(mode) ? mode : 'off';
}

/**
 * Factory so app.js can mount this in two contexts:
 *  - the pre-API-key-gate patient Firebase exchange, where `req.apiClient` is
 *    not yet populated and `expectedClient` supplies the exact client scope;
 *  - globally after validateApiKey, where the `req.apiClient` filter scopes it
 *    to the two mobile apps and exempts every integration/admin surface.
 *
 * @param {{ expectedClient?: 'patient'|'staff' }} options
 * @returns {import('express').RequestHandler}
 */
export default function appCheckMiddleware({ expectedClient } = {}) {
  return async function appCheckHandler(req, res, next) {
    try {
      const mode = currentMode();
      if (mode === 'off') return next();

      // Scope filter: only the two mobile apps carry App Check tokens. Admin
      // portal, SCIM/HL7/ABDM/NHCX/interface-engine/device-ingest and any
      // request without a recognized API client pass through untouched.
      const apiClient = req.apiClient === 'patient' || req.apiClient === 'staff'
        ? req.apiClient
        : undefined;
      const client = expectedClient === 'patient' || expectedClient === 'staff'
        ? expectedClient
        : apiClient;
      if (!client) return next();

      const token = req.get('X-Firebase-AppCheck');
      if (!token) {
        recordAppCheckOutcome('missing', client);
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
        // malformed) → invalid. Anything else — network failure or Admin SDK
        // not configured (the degradation stub) — is unverifiable.
        const isTokenInvalid = typeof err?.code === 'string' && err.code.startsWith('app-check/');
        if (isTokenInvalid) {
          recordAppCheckOutcome('invalid', client);
          logger.warn('App Check token invalid', { requestId: req.id, client, code: err.code });
          return next();
        }
        recordAppCheckOutcome('unverifiable', client);
        logger.error('App Check verification unavailable', {
          requestId: req.id,
          client,
          error: err?.message,
        });
        return next();
      }

      const appIdEnv = CLIENT_APP_ID_ENV[client];
      const allowedAppIds = new Set(
        String(process.env[appIdEnv] || '')
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      );
      if (allowedAppIds.size === 0) {
        recordAppCheckOutcome('unverifiable', client);
        logger.error('App Check expected app IDs are not configured', {
          requestId: req.id,
          client,
        });
        return next();
      }
      if (typeof claims?.app_id !== 'string' || !allowedAppIds.has(claims.app_id)) {
        recordAppCheckOutcome('invalid', client);
        logger.warn('App Check token belongs to an unexpected Firebase app', {
          requestId: req.id,
          client,
        });
        return next();
      }

      recordAppCheckOutcome('verified', client);
      req.appCheck = { appId: claims.app_id, verified: true };
      return next();
    } catch (err) {
      logger.error('App Check middleware internal error', {
        requestId: req?.id,
        error: err?.message,
      });
      return next();
    }
  };
}
