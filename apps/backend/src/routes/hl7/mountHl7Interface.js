// src/routes/hl7/mountHl7Interface.js
//
// The HL7 HTTP-bridge mount, in ONE place, because its ORDER is a security
// property rather than a formatting detail.
//
// `app.use('/api/v1/hl7/receive', …)` short-circuits before
// `app.use('/api/v1/hl7', hl7Routes)`, so anything the router registers ahead of
// its own handlers — its rate limiter, in particular — is unreachable for a
// request the app-level chain answers itself. That is exactly how the review of
// 8f9251fb0 found a disabled `POST /api/v1/hl7/receive` behaving as an
// un-rate-limited 403 sink that emitted a log line per request: correct order
// inside the router, wrong order across the two mounts.
//
// Three mounts that must stay in this relationship:
//   1. `/api/v1/hl7` — the limiter, ahead of everything, so a refusal costs the
//      sender quota whether the interface is on or off.
//   2. `/api/v1/hl7/receive` — the HL7_INBOUND_ENABLED ingress gate.
//   3. `/api/v1/hl7` — the router, which re-applies the same once-per-request
//      limiter (a pass-through for requests that came through 1) and repeats the
//      gate, so the router stays fail-closed under any other mount.
//
// ★ The limiter is mounted at the BASE path, NOT at `/receive`, and that is
// load-bearing rather than stylistic. Express rewrites `req.url` relative to the
// mount point, so a middleware mounted at the exact path `/api/v1/hl7/receive`
// observes `req.path === '/'` — and the default rate-limit profile's `skip()`
// exempts `'/'` along with `/health` and `/api-docs`
// (middleware/rateLimitMiddleware.js). Mounted there, the limiter would silently
// skip EVERY request and the disabled endpoint would stay exactly as
// un-rate-limited as it was, with a green-looking mount to prove otherwise.
// Mounted at the base path it sees the same relative path it has always seen
// inside the router (`/receive`, `/generate`, `/capability`), so its skip
// semantics are identical to the router-level mount it front-runs.
//
// Keeping all three statements here means a test can drive the real composition
// without booting the entire application, and app.js has no HL7 ordering left to
// get wrong.

import hl7Routes from './hl7Routes.js';
import { hl7InboundIngressGate } from './hl7InboundIngressGate.js';
import { hl7IngressLimiter } from './hl7IngressRateLimit.js';

export const HL7_BASE_PATH = '/api/v1/hl7';
export const HL7_RECEIVE_PATH = `${HL7_BASE_PATH}/receive`;

export function mountHl7Interface(app) {
  app.use(HL7_BASE_PATH, hl7IngressLimiter);
  app.use(HL7_RECEIVE_PATH, hl7InboundIngressGate);
  app.use(HL7_BASE_PATH, hl7Routes);
  return app;
}

export default mountHl7Interface;
