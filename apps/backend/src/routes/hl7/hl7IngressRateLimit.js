// src/routes/hl7/hl7IngressRateLimit.js
//
// ONE generic limiter for the HL7 HTTP bridge, applied exactly once per
// request, and always AHEAD of the HL7_INBOUND_ENABLED ingress gate.
//
// Why this module exists (review of 8f9251fb0): the ingress gate was mounted in
// `app.js` at `/api/v1/hl7/receive`, i.e. BEFORE `app.use('/api/v1/hl7',
// hl7Routes)`. The router's own `router.use(genericLimiter)` therefore never ran
// while the interface was disabled — the gate answered 403 first and returned.
// A disabled `POST /api/v1/hl7/receive` was consequently an UN-RATE-LIMITED
// endpoint that also emitted one `logger.warn` per request: a free request sink
// and a log-volume amplifier. The router comment claiming "registered AFTER the
// limiter on purpose, so a disabled interface is still rate limited" described a
// layer that was dead in production.
//
// The naive fix — `app.use('/api/v1/hl7/receive', genericLimiter,
// hl7InboundIngressGate)` — is wrong twice over, and both failures are silent:
//   * Mounted at that exact path, the limiter observes `req.path === '/'`
//     (Express strips the mount prefix) and the default profile's `skip()`
//     exempts `'/'`, so it would never count anything. See mountHl7Interface.js,
//     which mounts it at the base path for exactly this reason.
//   * On the ENABLED path an accepted request would pass the SAME limiter
//     instance twice — once at the app mount, once inside the router — and
//     express-rate-limit increments per invocation, not per request. Two hits
//     per request halves the effective quota: with `max` 2, the SECOND request
//     429s instead of the third (measured against express-rate-limit 8.6).
//
// Hence a once-per-request wrapper. The first mount to see a request marks it
// and runs the limiter; any later mount is a pass-through. Consequences:
//   * `/receive` is limited at the app.js mount, ahead of the gate, so the
//     disabled path burns quota and turns into 429 instead of an unbounded
//     stream of 403s.
//   * every HL7 route is limited exactly once, in the same chain position, on
//     the same bucket, with the same response shape as before — no behaviour
//     change (pinned by hl7-receive-body-limit.test.js).
//
// The bucket is unchanged because both mount points sit at the same place in
// the chain: after `validateApiKey`, before `jwtAuth`, with nothing between the
// app-level mount and the router mount. Nothing there touches `req.user`,
// `req.tenantId`, `req.body` or the headers `tenantKeyGenerator` reads, so the
// app-level invocation computes the very key the router-level one used to.

import { genericLimiter } from '../../middleware/rateLimitMiddleware.js';
import { generateACK } from '../../services/hl7/hl7Parser.js';

// Marker property (mirrors the existing `req.hl7InboundRecoveryRequest`
// convention) rather than a closure: the two mounts live in different modules
// and must agree per request object.
export const HL7_RATE_LIMIT_APPLIED_PROPERTY = 'hl7GenericRateLimitApplied';

// Recovery senders speak HL7v2, not JSON. Moved here verbatim from
// hl7Routes.js, which used it for this one limiter only: the wrapper has to
// travel with the limiter so a 429 keeps its ACK wire format at whichever mount
// point actually enforces the limit.
const rawHl7RecoveryResponses = middleware => (req, res, next) => {
  if (req.hl7InboundRecoveryRequest !== true) return middleware(req, res, next);
  const originalJson = res.json;
  const restoreAndNext = (err) => {
    res.json = originalJson;
    return next(err);
  };
  res.json = function sendRawHl7RecoveryRejection() {
    res.json = originalJson;
    const status = Number(res.statusCode) || 500;
    const ackCode = status >= 500 || status === 429 ? 'AE' : 'AR';
    res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
    return res.send(generateACK('UNKNOWN', ackCode, 'HL7 receive request rejected'));
  };
  try {
    const pending = middleware(req, res, restoreAndNext);
    if (pending && typeof pending.catch === 'function') pending.catch(restoreAndNext);
    return pending;
  } catch (err) {
    return restoreAndNext(err);
  }
};

const limitOnce = rawHl7RecoveryResponses(genericLimiter);

// The invariant is "the limiter chain has run once for this request", not "a
// hit was recorded" — a request the limiter's own skip() exempts is still
// marked. That is only sound because both mount points present the SAME
// relative path to skip() (mountHl7Interface mounts at the base path, exactly
// where this router is mounted), so the second invocation could not have
// decided differently.
export function hl7IngressLimiter(req, res, next) {
  if (req[HL7_RATE_LIMIT_APPLIED_PROPERTY] === true) return next();
  // Marked BEFORE delegating: a 429 ends the request here, and a later mount
  // must not re-enter the limiter on the way out of an early response either.
  req[HL7_RATE_LIMIT_APPLIED_PROPERTY] = true;
  return limitOnce(req, res, next);
}

export default hl7IngressLimiter;
