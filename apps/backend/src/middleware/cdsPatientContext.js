// src/middleware/cdsPatientContext.js
//
// CDS Hooks (https://cds-hooks.org/) addresses the patient differently from the
// rest of the platform: the patient reference lives inside the POST request
// body's hook `context`, not in a URL param/query the generic patient-access
// resolver understands:
//   POST /cds-services/:id  { hook, context: { patientId | patient }, ... }
// where the reference is a bare uuid or a FHIR `Patient/<uuid>` string. None of
// that is visible to resolvePatientForAccess (it only recognises
// `patient_uid`-style param/query/body keys). So a patientAccessGuard mounted on
// /api/v1/cds-services would hit `no_patient_context` on EVERY invoke and give
// zero care-team ABAC coverage — cosmetic parity, not real parity.
//
// This middleware lifts the context patient uid onto req.phiContext.patientUid,
// which resolvePatientForAccess() consults first. The standard governed guard
// then runs the same care-team / referral / appointment / admission decision
// (and shadow audit) the other PHI mounts get — bringing CDS Hooks to parity
// with the FHIR / nursing-assessments / encounters mounts. Mirrors
// fhirPatientContext. See audit finding #5 (CDS + clinical-document guard parity).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Accept a bare UUID or a FHIR `Patient/<uuid>` reference; return the lowercased
// uuid, or null when the value isn't a usable patient reference.
function normalizePatientToken(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const ref = /^Patient\/([0-9a-f-]{36})$/i.exec(text);
  const uid = String(ref?.[1] || text).trim().toLowerCase();
  return UUID_RE.test(uid) ? uid : null;
}

/**
 * Resolve the CDS-Hooks-addressed patient uid for a request, or null.
 *
 * The CDS Hooks spec puts the patient in the body hook context as a FHIR
 * Reference (`context.patientId` / `context.patient`, e.g. "Patient/<uuid>");
 * we also accept the bare uuid for convenience. Mirrors
 * cdsHooksAdapter.extractPatientUid but normalises + validates the uuid so the
 * downstream uuid-typed DB comparison matches.
 */
export function cdsPatientUidFromRequest(req) {
  const context = req?.body?.context;
  if (!context || typeof context !== 'object') return null;
  return normalizePatientToken(context.patientId ?? context.patient);
}

/**
 * Express middleware: best-effort stash of the CDS Hooks patient uid onto
 * req.phiContext so the downstream patientAccessGuard can resolve it. Never
 * blocks — a missing/unparseable context is handled safely by the guard
 * (no_patient_context → pass-through) and the route's own hook validation.
 */
export default function cdsPatientContext(req, _res, next) {
  try {
    const patientUid = cdsPatientUidFromRequest(req);
    if (patientUid) {
      req.phiContext = { ...(req.phiContext ?? {}), patientUid };
    }
  } catch {
    // Intentionally swallow — extraction must never take down a CDS route.
  }
  return next();
}
