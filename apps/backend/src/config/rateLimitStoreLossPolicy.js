// src/config/rateLimitStoreLossPolicy.js
//
// ONE declaration of what a rate-limit STORE OUTAGE means, per profile.
//
// WHY THIS EXISTS
// ---------------
// The 2026-08-15 Redis-loss drill proved by execution that with the shared
// Redis store unreachable, every request through a Redis-backed limiter died
// with an undifferentiated 500: express-rate-limit@8 propagates the store
// error into the Express error chain, and its `passOnStoreError` option
// (default false) was never set anywhere. The deployment's behaviour under
// store loss — deny everything with the wrong status and no operator signal —
// was a library default, chosen by nobody. This module makes the posture a
// DECISION: every profile declares, in code and on the record, whether a store
// outage denies or admits its traffic, and the runtime surfaces the state.
//
// THE TWO POSTURES
// ----------------
//   fail_closed
//     While the store is unreachable, requests through this profile are
//     REFUSED with an honest 429 + Retry-After (never a 500, never a pass).
//     For the profiles that meter abuse — credential guessing, OTP floods,
//     SOS false-alarm floods, bulk PHI export, phone enumeration, public
//     OAuth token grinding — unmetered access during an outage is strictly
//     worse than denying: the limiter IS the security control, and "Redis is
//     down" must not mean "brute force is free".
//
//   fail_open_unmetered
//     While the store is unreachable, requests through this profile are
//     ADMITTED without metering, and counted. For capacity-shaping profiles
//     the limiter protects throughput, not credentials — failing closed there
//     would convert a cache outage into a hospital-wide API outage (every
//     patient, staff and admin request 429ing because Redis died). Most such
//     traffic is authenticated; the few deliberately pre-auth fail-open
//     surfaces carry their rationale inline in the table below. The DB
//     circuit breaker in lib/prisma.js still guards capacity. This is the
//     same "the permissive branch must never be the accident" doctrine as
//     FILE_SCAN_POLICY (#871): fail-open exists, but only as an explicit,
//     per-profile, documented choice.
//
//     READINESS COHERENCE (873-F2, 2026-08-15): for this rationale to hold,
//     /health/ready must keep an initialized pod IN the Service through a
//     store outage. It does: REDIS_REQUIRE_SENTINEL is a boot-only gate
//     (uptimeRoutes.js reports run-time Redis loss in a `degraded` block
//     without flipping the HTTP status). Before that fix, strict prod
//     readiness 503'd on any Redis loss and kubelet pulled every pod in
//     ~15s — nullifying this table entirely: the fail-open postures were
//     live only in the ≤15s pre-NotReady window. Do not re-add Redis
//     reachability to the readiness gate.
//
// INVARIANTS — pinned by src/tests/unit/rateLimitStoreLossPolicy.test.js
//   * auth, otp and sos are fail_closed, always. Not configurable. An
//     unmetered credential-guessing or OTP-request window during a Redis
//     outage is an incident, not a degradation. (sos is the deliberate hard
//     call: a real SOS may be refused while the store is down — its 429
//     message already directs callers to emergency services — because an
//     unmetered false-alarm flood suppresses real emergency response.)
//   * EVERY profile in RATE_LIMIT_PROFILES has an explicit entry here. A new
//     profile cannot land with an accidental posture: an unlisted profile
//     resolves to fail_closed AND fails the pinning test until someone writes
//     the decision down.
//   * The denial is 429 + Retry-After, through the profile's normal handler.
//     Store loss must never surface as a 500 storm again.
//
// Runtime state (breaker, counters, operator signal) lives in
// src/middleware/rateLimitStoreHealth.js; this module is the pure decision
// table.

export const RATE_LIMIT_STORE_LOSS_POSTURE = Object.freeze({
  /** Store unreachable => this profile's requests are refused with 429. */
  FAIL_CLOSED: 'fail_closed',
  /** Store unreachable => this profile's requests pass unmetered (counted). */
  FAIL_OPEN_UNMETERED: 'fail_open_unmetered',
});

/**
 * Retry-After (seconds) attached to a store-loss denial. Deliberately SHORT —
 * unlike a genuine over-quota 429, whose Retry-After reflects the profile
 * window (up to an hour for sos), a store-loss denial should clear as soon as
 * Redis returns: it tells honest clients "temporarily throttled, back off
 * briefly and retry", keeping them in a polite retry loop rather than parked
 * for a full window that has nothing to do with their own request rate.
 */
export const RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS = 30;

/**
 * The decision table. Keys match RATE_LIMIT_PROFILES exactly (set equality is
 * pinned by test). Postures for limiters built from a profile name resolve
 * through storeLossPostureFor() below.
 */
export const RATE_LIMIT_STORE_LOSS_POLICY = Object.freeze({
  // ── Abuse guards: the limiter is the security control. FAIL CLOSED. ──────
  // Pre-auth brute-force guard on every login surface (5/15min/IP+account).
  //
  // DOCUMENTED TRADEOFF (2026-08-15, 873-F5): /auth/refresh-token and /auth/
  // token ride this profile, so during a store outage refresh is refused and
  // live sessions die as their access tokens expire. That is deliberate: a
  // captured refresh token mints real sessions, and "Redis is down" must not
  // mean it can be ground unmetered. Self-revocation stays available through
  // the separate fail-open `logout` profile below.
  auth: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  // Per-phone OTP request cap (3/10min) — unmetered = SMS bombing + cost burn.
  otp: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  // False-alarm flood guard (3/user/hour). Message already directs real
  // emergencies to call emergency services directly.
  sos: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  // Bulk PHI export cap (5/user/hour) — unmetered = exfiltration amplifier.
  dataExport: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  clinicalImport: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  // Exists specifically to stop pre-auth phone enumeration (10/min/IP).
  dashboard: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  // Public-by-design SMART-on-FHIR token/authorize endpoints (30/min).
  smartFhirOAuth: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  // Pre-auth SCIM provisioning bearer ingress (120/min/IP, keyed by source
  // IP — never by the presented token, which a guesser mints freely). The
  // limiter is the online-guessing brake on a provisioning credential that can
  // deactivate/delete users; IdPs retry, so a 429 window during an outage is
  // recoverable (873-F3).
  scimProvisioning: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,
  // Pre-auth HMAC connector ingress (300/min/IP). Signature verification CPU
  // must not become unmetered during an outage; sending engines spool and
  // retry by design, so an honest 429 loses nothing (873-F3).
  interfaceEngineIngress: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED,

  // ── Capacity shaping. FAIL OPEN. ──────────────────────────────────────────
  // Denying these during a Redis outage would take the whole hospital API
  // down with the cache. patient/staff/admin/patientInvestigation traffic is
  // authenticated (auth and RBAC still gate every request). `default` is the
  // generic bucket; after the 2026-08-15 873-F3 remediation its pre-auth
  // riders are, deliberately: /api/v1/storage (HMAC-signed download URLs —
  // the token is unforgeable, the limiter is only DoS shaping);
  // /api/v1/health and the non-probe /health/* surfaces (monitoring reads);
  // the ABDM + NHCX gateway callback routers (partner-signed webhooks —
  // signature verification rejects forgeries, and refusing a partner
  // gateway's callbacks during an outage would strand in-flight consent/claim
  // flows); and the terminal 404 fallback (no resource behind it — denying
  // unmatched paths during an outage buys nothing). Every pre-auth surface
  // where the limiter IS the security control carries its own fail-closed
  // profile above; do NOT mount `default` on a new credential-bearing
  // surface.
  patient: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
  patientInvestigation: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
  staff: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
  admin: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
  default: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
  // Self-revocation must stay available while the store is down: blacklisting
  // is DB-authoritative (tokenBlacklist.js R12 — the Redis write is a caught
  // best-effort cache fill), so a logout has no Redis dependency to protect.
  // Refusing it would block a security action to guard nothing (873-F5).
  // Post-auth, keyed per uid, 30/15min in normal operation.
  logout: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,

  // ── Operability surfaces: blinding these DURING an incident is the worst
  //    possible time. FAIL OPEN. ─────────────────────────────────────────────
  // Monitoring/probe traffic is per-pod and inherently bounded; blast radius
  // is a SELECT 1 per hit.
  probe: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
  clientReadiness: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
  // Downtime-pack policy delivery is precisely the surface that must keep
  // working while infrastructure is failing.
  clinicalContinuityPolicyDelivery: RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED,
});

/**
 * Resolve the store-loss posture for a profile. Unknown names fail CLOSED —
 * the permissive branch must never be the accident — and the pinning test
 * additionally requires every real profile to carry an explicit entry.
 * (873-F8: getRateLimiter also THROWS on an unknown profile name at
 * construction time, so in production this fail-closed branch is a true
 * backstop rather than a dead one contradicted by a silent `default`
 * fallback.)
 *
 * @param {string} profileName
 * @returns {string} one of RATE_LIMIT_STORE_LOSS_POSTURE
 */
export function storeLossPostureFor(profileName) {
  return RATE_LIMIT_STORE_LOSS_POLICY[profileName]
    ?? RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED;
}

export default {
  RATE_LIMIT_STORE_LOSS_POSTURE,
  RATE_LIMIT_STORE_LOSS_POLICY,
  RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS,
  storeLossPostureFor,
};
