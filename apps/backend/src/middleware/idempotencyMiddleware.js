/**
 * Idempotency-Key middleware (Phase E4).
 *
 * Use on critical POST routes (orders, payments, prescriptions, claims):
 *
 *   router.post('/orders',
 *     requireIdempotencyKey({ scope: 'orders' }),
 *     orderController.create);
 *
 * Behaviour:
 *   - When `Idempotency-Key` header is missing on a `required: true` mount,
 *     responds 400.
 *   - When the same key is replayed with the same payload, responds with
 *     the original cached response (status + body), bypassing the handler.
 *   - When the same key is replayed with a *different* payload hash,
 *     responds 422 (idempotency violation).
 *   - When the same key is currently in flight, responds 409.
 *   - On schema-missing (table not migrated), the middleware fails OPEN so
 *     endpoints keep working. A warning is logged.
 *
 * Caching policy:
 *   - 2xx/3xx success      → cached + replayed (the deterministic happy path).
 *   - 4xx client error     → cached + replayed (deterministic — a retry with
 *                            the same payload will fail identically).
 *   - 5xx / transient fail → NOT cached; the in-flight claim is DELETED so the
 *                            client's retry re-executes and can succeed. A
 *                            transient 500/503 must never be pinned under the
 *                            key, which would make recovery impossible.
 */

import {
  claimIdempotencyKey,
  finaliseIdempotencyKey,
  hashRequestBody,
  isValidIdempotencyKey,
  releaseIdempotencyKey,
} from '../services/idempotency/idempotencyService.js';
import { error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';

const HEADER = 'idempotency-key';

export function requireIdempotencyKey({ required = true, scope = 'generic' } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const headerValue = req.get(HEADER);
    if (!headerValue) {
      if (!required) return next();
      return error(res, 'Idempotency-Key header is required for this endpoint', 400, {
        scope,
      });
    }
    if (!isValidIdempotencyKey(headerValue)) {
      return error(res, 'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]', 400);
    }

    const requestBodyHash = hashRequestBody(req.body || {});
    let claim;
    try {
      claim = await claimIdempotencyKey({
        tenantId: req.tenantId || null,
        userUid: req.user?.uid || null,
        requestKey: headerValue,
        requestMethod: req.method,
        requestPath: req.originalUrl.split('?')[0],
        requestBodyHash,
      });
    } catch (err) {
      logger.error('Idempotency claim failed:', { error: err.message, scope });
      // DELTA-001: a `required: true` route (e.g. clinical orders) MUST fail
      // closed when the idempotency store is unavailable — otherwise an offline
      // re-drain of a lost-2xx can create a duplicate clinical record. Only
      // explicitly noncritical (`required: false`) routes fail open.
      if (required) {
        return error(res, 'Idempotency store unavailable; request rejected to prevent duplication', 503, { scope });
      }
      return next();
    }

    if (claim.state === 'replay') {
      const status = claim.response_status || 200;
      res.status(status);
      // The cached body went in via JSON.stringify on the way out so
      // it's already a JSON-shaped object after the JSONB round-trip.
      return res.json(claim.response_body ?? {});
    }
    if (claim.state === 'in_flight') {
      return error(res, 'A request with this Idempotency-Key is currently in flight', 409, {
        scope, idempotency_key: headerValue,
      });
    }
    if (claim.state === 'mismatch') {
      return error(res, 'Idempotency-Key reused with a different request body', 422, {
        scope, idempotency_key: headerValue,
      });
    }

    // Claimed — let the handler run, capture the response.
    // DELTA-001: schema-missing (idempotency table not migrated) is an infra
    // fault — fail closed on required routes rather than silently running the
    // handler unprotected.
    if (claim.schemaMissing) {
      if (required) {
        return error(res, 'Idempotency store not available; request rejected to prevent duplication', 503, { scope });
      }
      return next();
    }
    if (!claim.id) return next();

    const claimId = claim.id;
    req.idempotencyClaim = {
      id: claimId,
      requestKey: headerValue,
      requestBodyHash,
      scope,
    };
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      const out = originalJson(body);
      const status = res.statusCode;
      if (status >= 500) {
        // Transient failure — free the claim so the client's retry re-runs the
        // handler instead of being pinned to this 5xx forever.
        releaseIdempotencyKey(claimId).catch((err) => {
          logger.warn('Idempotency release failed:', { error: err.message, claimId });
        });
      } else {
        // Deterministic outcome (2xx/3xx success or 4xx client error) — cache it.
        const persistStatus = status >= 400 ? 'failed' : 'complete';
        finaliseIdempotencyKey({
          id: claimId, status: persistStatus, responseStatus: status, responseBody: body,
        }).catch((err) => {
          logger.warn('Idempotency finalise failed:', { error: err.message, claimId });
        });
      }
      return out;
    };
    return next();
  };
}

export default { requireIdempotencyKey };
