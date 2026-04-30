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
 * The handler signals failure by setting res.statusCode >= 400 — that
 * response is still cached so retries see the same answer.
 */

import {
  claimIdempotencyKey,
  finaliseIdempotencyKey,
  hashRequestBody,
  isValidIdempotencyKey,
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
      logger.warn('Idempotency claim failed:', { error: err.message, scope });
      // Fail open — don't block real requests on idempotency infra issues.
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
    if (!claim.id || claim.schemaMissing) return next();

    const claimId = claim.id;
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      const out = originalJson(body);
      const status = res.statusCode;
      const persistStatus = status >= 400 ? 'failed' : 'complete';
      finaliseIdempotencyKey({
        id: claimId, status: persistStatus, responseStatus: status, responseBody: body,
      }).catch((err) => {
        logger.warn('Idempotency finalise failed:', { error: err.message, claimId });
      });
      return out;
    };
    return next();
  };
}

export default { requireIdempotencyKey };
