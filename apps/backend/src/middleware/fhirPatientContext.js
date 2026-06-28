// src/middleware/fhirPatientContext.js
//
// FHIR R4 addresses the patient differently from the rest of the platform:
//   - instance read:   GET /Patient/<uuid> [ /$everything ]        (URL path)
//   - resource search: GET /Observation?patient=<uuid|Patient/uuid> (query)
//   - writes:          POST body .subject.reference / .patient.reference
// None of these are visible to the generic patient-access resolver, which only
// recognises `patient_uid`-style param/query/body keys. So a patientAccessGuard
// mounted on /api/v1/fhir would hit `no_patient_context` on EVERY FHIR request
// and provide zero care-team ABAC coverage — cosmetic parity, not real parity.
//
// This middleware extracts the addressed patient uid from FHIR's own addressing
// and stashes it on req.phiContext.patientUid, which resolvePatientForAccess()
// consults first. The standard guard then runs the same care-team / referral /
// appointment / admission decision (and shadow audit) that FHIR previously
// bypassed — bringing it to parity with the nursing-assessments / encounters
// mounts. See audit finding #4 (FHIR care-team guard parity).

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
 * Resolve the FHIR-addressed patient uid for a request, or null.
 *
 * Mount-relative path tolerant: works whether Express has stripped the
 * `/api/v1/fhir` mount prefix from req.path or not.
 */
export function fhirPatientUidFromRequest(req) {
  // (1) Patient instance read: /Patient/<uuid> [ /$everything ]
  const rel = String(req?.path || '').replace(/^\/api\/v1\/fhir/i, '');
  const segs = rel.split('/').filter(Boolean);
  if (segs[0] === 'Patient' && segs[1] && (segs.length === 2 || segs[2] === '$everything')) {
    const uid = normalizePatientToken(segs[1]);
    if (uid) return uid;
  }

  // (2) Resource search: ?patient= / ?subject=
  const fromQuery = normalizePatientToken(req?.query?.patient ?? req?.query?.subject);
  if (fromQuery) return fromQuery;

  // (3) Writes: body subject/patient reference (Patient/<uuid>)
  const fromBody = normalizePatientToken(
    req?.body?.subject?.reference ?? req?.body?.patient?.reference,
  );
  if (fromBody) return fromBody;

  return null;
}

/**
 * Express middleware: best-effort stash of the FHIR patient uid onto
 * req.phiContext so the downstream patientAccessGuard can resolve it.
 * Never blocks — a missing/unparseable context is handled safely by the guard
 * (no_patient_context → pass-through) and the route's own FHIR validation.
 */
export default function fhirPatientContext(req, _res, next) {
  try {
    const patientUid = fhirPatientUidFromRequest(req);
    if (patientUid) {
      req.phiContext = { ...(req.phiContext ?? {}), patientUid };
    }
  } catch {
    // Intentionally swallow — extraction must never take down a FHIR route.
  }
  return next();
}

// CAN-030: a FHIR resource COLLECTION search (GET /Observation, /Condition, …)
// with no ?patient/subject enumerates tenant PHI. Require a patient context for
// PHI collection searches; instance reads (/<Type>/<id>), /metadata, and an
// explicit export-role carve-out are unaffected. The care-team relationship for
// patient-scoped searches is still handled by the downstream guard.
const PHI_SEARCH_RESOURCES = new Set([
  'Observation', 'MedicationRequest', 'Condition', 'DiagnosticReport',
  'AllergyIntolerance', 'Encounter', 'DocumentReference', 'ServiceRequest',
  'Procedure', 'Immunization', 'CarePlan', 'MedicationStatement',
  'MedicationAdministration', 'MedicationDispense',
]);
const FHIR_EXPORT_ROLES = new Set(['MEDICAL_RECORDS', 'ADMIN', 'SUPER_ADMIN']);

export function requireFhirSearchPatientContext(req, res, next) {
  if (req.method !== 'GET') return next();
  const rel = String(req.path || '').replace(/^\/api\/v1\/fhir/i, '');
  const segs = rel.split('/').filter(Boolean);
  // Only collection-level searches (exactly the resource-type segment, no id).
  if (segs.length !== 1 || !PHI_SEARCH_RESOURCES.has(segs[0])) return next();
  // A patient-scoped search is fine (fhirPatientContext resolved the uid).
  if (req.phiContext?.patientUid) return next();
  // Explicit export/records roles may run an unscoped directory search.
  if (FHIR_EXPORT_ROLES.has(req.user?.role)) return next();
  return res.status(403).json({
    success: false,
    code: 'FHIR_PATIENT_CONTEXT_REQUIRED',
    message: 'FHIR resource search requires a patient/subject parameter',
  });
}
