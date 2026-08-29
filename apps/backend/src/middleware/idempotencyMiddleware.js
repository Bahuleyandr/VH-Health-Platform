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

function resolveIdempotencyRequestPath(req, requestPathForIdempotency) {
  const candidate = typeof requestPathForIdempotency === 'function'
    ? requestPathForIdempotency(req)
    : requestPathForIdempotency;
  const rawPath = candidate == null ? req.originalUrl : candidate;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new TypeError('Idempotency request path must resolve to a non-empty string');
  }
  const requestPath = rawPath.trim().split('?')[0];
  if (!requestPath.startsWith('/') || requestPath.length > 255) {
    throw new TypeError('Idempotency request path must be an absolute path of at most 255 characters');
  }
  return requestPath;
}

export function requireIdempotencyKey({
  required = true,
  scope = 'generic',
  onlyWhen = null,
  continuityReceiptRequired = false,
  // Secret-bearing routes project only non-secret action identity fields here;
  // the persisted request hash must never become a credential verifier.
  requestBodyForIdempotency = null,
  // Alias-mounted mutations can provide one stable public path (or derive one
  // from route params) so equivalent URLs share the same durable claim.
  requestPathForIdempotency = null,
  // ★ Set on any route whose handler can emit a 5xx AFTER it has already
  // committed irreversible effects (stock movements, money, statutory
  // registers). The default (false) releases the claim on a 5xx so a client
  // retry re-runs the handler — correct when a 5xx reliably means "nothing
  // happened", which is true of most routes. It is NOT true of a handler that
  // commits and then fails while assembling its response: releasing the claim
  // there is what lets the transport's automatic replay execute the effect a
  // second time. With this set, the claim is retained and the replay returns
  // the recorded 5xx instead of running again — the operator reconciles one
  // uncertain outcome rather than discovering two real ones.
  retainOnServerError = false,
  durableDomainReceipt = false,
} = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    if (onlyWhen && !onlyWhen(req)) return next();
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

    const requestBodyHash = hashRequestBody(
      requestBodyForIdempotency ? requestBodyForIdempotency(req) : (req.body || {}),
    );
    let claim;
    try {
      const requestPath = resolveIdempotencyRequestPath(req, requestPathForIdempotency);
      claim = await claimIdempotencyKey({
        tenantId: req.tenantId || null,
        userUid: req.user?.uid || null,
        requestKey: headerValue,
        requestMethod: req.method,
        requestPath,
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
      if (continuityReceiptRequired) {
        return error(res, 'Clinical continuity replay requires manual review', 409, {
          code: 'CONTINUITY_REPLAY_RECEIPT_MISSING_NEEDS_REVIEW',
          decision: 'needs_review',
          safe: true,
          scope,
        });
      }
      const status = claim.response_status || 200;
      res.status(status);
      // The cached body went in via JSON.stringify on the way out so
      // it's already a JSON-shaped object after the JSONB round-trip.
      return res.json(claim.response_body ?? {});
    }
    if (claim.state === 'in_flight') {
      if (durableDomainReceipt) {
        req.idempotencyClaim = {
          id: claim.id || null,
          requestKey: headerValue,
          requestBodyHash,
          scope,
          recoveringInFlight: true,
        };
        if (!claim.id) return next();
      } else {
      return error(res, 'A request with this Idempotency-Key is currently in flight', 409, {
        scope, idempotency_key: headerValue,
      });
      }
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
      if (status >= 500 && !retainOnServerError) {
        // Transient failure — free the claim so the client's retry re-runs the
        // handler instead of being pinned to this 5xx forever.
        releaseIdempotencyKey(claimId).catch((err) => {
          logger.warn('Idempotency release failed:', { error: err.message, claimId });
        });
      } else if (status >= 500) {
        // Effectful route: the handler may already have committed. Retain the
        // claim so an automatic replay cannot execute the effect twice; the
        // replay serves this recorded 5xx and a human reconciles.
        logger.warn('Idempotency claim RETAINED on 5xx (effectful route) — replay will not re-run', {
          claimId, scope, status,
        });
        finaliseIdempotencyKey({
          id: claimId, status: 'failed', responseStatus: status, responseBody: body,
        }).catch((err) => {
          logger.warn('Idempotency finalise failed:', { error: err.message, claimId });
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
