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
