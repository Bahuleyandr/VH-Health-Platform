// src/config/rateLimitProfiles.js

// RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX override ONLY the generic `default`
// profile below. The named profiles (patient/staff/auth/otp/...) are tuned
// per-surface and deliberately ignore these knobs — loosening auth/otp via a
// blanket env var would reopen brute-force windows. Both were documented in
// .env.example and validated in validateEnv.js but never read until wired
// here (audit CFG-L1).
function positiveIntFromEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export const RATE_LIMIT_PROFILES = {
  patient: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
    message: 'Too many requests from this patient. Please try again later.'
  },
  patientInvestigation: {
    windowMs: 15 * 60 * 1000,
    max: 400,
    message: 'Too many investigation requests. Please pause briefly and try again.'
  },
  staff: {
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'Too many requests from staff. Please try again later.'
  },
  admin: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this admin. Please try again later.'
  },
  default: {
    windowMs: positiveIntFromEnv('RATE_LIMIT_WINDOW_MS') ?? 15 * 60 * 1000,
    max: positiveIntFromEnv('RATE_LIMIT_MAX') ?? 60,
    message: 'Too many requests. Please try again later.'
  },

  // Probe surfaces — `GET /`, `HEAD /` (each runs a real `SELECT 1` against
  // the primary) and the token-gated `/metrics` scrape target. Tuned
  // per-surface and, per this file's header, deliberately ignoring
  // RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX.
  //
  // WHY `default` WAS THE WRONG BUCKET (finding 2026-08-15, follow-up to the
  // backend-HTTP P2 no-op fix). Two independent defects, profile and key:
  //
  //   Profile. Prod sets RATE_LIMIT_WINDOW_MS=900000 / RATE_LIMIT_MAX=100
  //   (infra/kubernetes/apps/backend/configmap.yaml:25-26), so `default` is
  //   100 requests per 15 minutes. That is the generic API bucket governed by
  //   a blanket operator knob; probes are not generic API traffic.
  //
  //   Key. The ServiceMonitor sends one static Bearer and no x-api-key
  //   (infra/kubernetes/apps/backend/service-monitor.yaml:31-35), and the
  //   mount sits ahead of auth, so defaultKeyGenerator falls through to its
  //   Bearer branch: every scrape from every pod derives the identical key
  //   `t:default:jwt:<sha256(token)[0:24]>`. REDIS_SENTINEL_HOSTS is set in
  //   prod (configmap.yaml:33), so the store is shared cluster-wide — ONE
  //   bucket for the entire fleet.
  //
  //   Arithmetic. Per pod per 15-minute window: 900s / 30s interval
  //   (service-monitor.yaml:23) = 30 scrapes, x2 Prometheus HA replicas
  //   (infra/kubernetes/base/monitoring/kube-prometheus-values.yaml:40) = 60.
  //   At the HPA floor of 3 (hpa.yaml:16) that is 180 into a bucket of 100 —
  //   44% of scrapes already 429 at steady state — and at the ceiling of 10
  //   (hpa.yaml:17) it is 600 into 100, or 83% refused. Monitoring degraded
  //   hardest exactly when the HPA scaled up, i.e. during an incident, taking
  //   SLO burn-rate alerting down with it.
  //
  // SIZING. The limiter is mounted instanceScoped (see rateLimitMiddleware.js)
  // because Prometheus scrapes pod endpoints directly: a pod always observes
  // its own scrape rate no matter how large the fleet is, so a per-pod budget
  // is invariant to replica count — the only way a static number can stay
  // correct under an HPA. Legitimate per-pod ceiling, per 60s window:
  //
  //     2 scrapes/min   60s / 30s interval
  //   x 2               Prometheus HA replicas (prometheusSpec.replicas: 2)
  //   x 2               the pods also carry prometheus.io/scrape annotations
  //                     (deployment.yaml:35-37) — inert while no annotation
  //                     scrape job exists, but a standing invitation for one
  //   x 3               incident-time interval tightening; 30s can be cut no
  //                     lower than the 10s scrapeTimeout (service-monitor.yaml:24)
  //   = 24 requests/pod/minute
  //
  // max 120 is 5x that stacked ceiling and 30x the 4/min steady state, so no
  // combination of scale-up, HA, annotation scraping and interval tightening
  // can blind monitoring. src/tests/unit/probeRateLimitProfile.test.js pins
  // the derivation against the live infra manifests and fails if any input
  // moves.
  //
  // A 60s window rather than 15 minutes because a monitoring surface has to
  // self-heal within one scrape cycle: under a 15-minute window one transient
  // burst blinds Prometheus for the rest of the window — the same failure in
  // a different costume. Matches the other tuned narrow surfaces here
  // (clientReadiness / dashboard / smartFhirOAuth are all 60s).
  //
  // ABUSE BOUND retained on the DB-touching root probe: 120/min/pod/caller is
  // 2 rps of `SELECT 1`, and a single attacker key round-robined across the
  // HPA ceiling of 10 pods tops out near 20 rps against a 3-replica CNPG
  // cluster — bounded and cheap, versus completely unmetered before the
  // probeLimiter landed. /metrics is NOT exempted; it shares this profile.
  probe: {
    windowMs: 60 * 1000,
    max: 120,
    message: 'Too many probe requests. Please try again shortly.'
  },

  clientReadiness: {
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many client readiness requests. Please try again shortly.',
    enforceOnHealthRoutes: true,
    enforceInTest: true
  },
  clinicalContinuityPolicyDelivery: {
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many clinical continuity policy requests. Please try again shortly.',
    enforceInTest: true
  },

  // Auth login rate limiting — max 5 login attempts per IP per 15 minutes
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: 'Too many login attempts. Please try again later.'
  },

  // P0: Per-phone OTP rate limiting — max 3 OTP requests per phone per 10 minutes
  otp: {
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 3,
    message: 'Too many OTP requests for this phone number. Please try again later.'
  },

  // Data export rate limiting — max 5 exports per user per hour
  dataExport: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: 'Too many data export requests. Please try again later.'
  },

  // Dashboard rate limiting — stricter to prevent phone enumeration
  // 10 requests per minute per IP (dashboard is pre-auth, API key only)
  dashboard: {
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    message: 'Too many dashboard requests. Please try again shortly.'
  },

  // Public SMART-on-FHIR discovery/OAuth/FHIR resource access. Token and
  // authorize endpoints are public by design, so keep this tighter than the
  // generic API-key-gated profile.
  smartFhirOAuth: {
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many SMART-on-FHIR requests. Please try again shortly.'
  },

  // P2: SOS rate limiting — max 3 alerts per user per hour
  sos: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: 'Too many emergency alerts. If this is a real emergency, please call emergency services directly.'
  }
};
