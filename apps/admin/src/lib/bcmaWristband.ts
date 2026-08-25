// src/lib/bcmaWristband.ts
//
// The browser URL for the printable patient wristband.
//
// The producer is GET /api/v1/bcma/wristband/:patientUid?format=html
// (apps/backend/src/routes/clinical/bcmaRoutes.js). It renders a Code 39
// barcode of the patient UID — the exact value the bedside scan screens expect
// as "right patient" — plus the allergy strip.
//
// That mount authenticates on HEADERS only (bearer + x-api-key), so a browser
// cannot navigate to the backend directly, and it must not: an API key in a
// URL leaks into history, logs and the Referer. The reachable route is the
// portal's same-origin reverse proxy, which authenticates on the httpOnly
// auth_token cookie and attaches both credentials server-side. The proxy
// forwards the CALLER'S own bearer, so the role that reaches the backend is
// the role of whoever is signed in — the proxy grants nothing.
//
// Who that link works for is decided by the backend, and it is not everyone who
// can open the MAR page. The wristband route enforces its own policy code,
// `patient.wristband.print`, which needs a care relationship to the patient:
// bedside nursing roles have one to any admitted patient and treating clinicians
// have one through the care-team/authorship checks. A staff role with no
// relationship still receives 403.
//
// ADMIN and SUPER_ADMIN are the exception, by owner decision of 2026-08-25:
// they may print a band without a care relationship and without break-glass,
// and every such print is recorded as administrative access in
// patient_access_audit_log (metadata.administrative_access) and in audit_logs
// (action 'wristband-print-administrative-access'). That grant is keyed on this
// one policy code, so it does not extend to any other clinical surface — an
// administrator is still refused on the routes that run
// PATIENT_CLINICAL_WORKFLOW_ACCESS. See the header of
// apps/backend/src/routes/clinical/bcmaRoutes.js for the exact gate chain and
// docs/ROADMAP.md for the decision.
//
// The link is rendered unconditionally on purpose: the backend is the single
// authority on patient access, and duplicating its relationship logic in the
// browser would produce a second, drifting answer.
//
// The `/api/proxy` prefix is written literally rather than read from
// API_BASE_URL because this string is an href for a browser navigation. On the
// server API_BASE_URL is the backend origin, so an SSR pass would emit a link
// the browser cannot follow, and a click before hydration would take the
// operator there.
//
// `autoprint=1` opens the print dialog on load. The band's own
// Content-Security-Policy admits that one inline script by SHA-256 hash, and
// src/middleware.ts leaves this response's CSP alone so the hash survives. If
// a browser suppresses the dialog anyway the band is still on screen and
// Ctrl+P prints it, so nothing depends on the script running.
const PROXY_PREFIX = "/api/proxy/api/v1";

/** Matches the backend's own `UUID_RE` guard on :patientUid. */
const PATIENT_UID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * URL of the printable wristband for `patientUid`, or `null` when the value is
 * not a patient UUID — the backend answers those with a 400, so a caller
 * should render no control rather than a link that cannot work.
 */
export function printableWristbandUrl(patientUid: string): string | null {
  const uid = String(patientUid ?? "").trim();
  if (!PATIENT_UID_RE.test(uid)) return null;
  return `${PROXY_PREFIX}/bcma/wristband/${uid}?format=html&autoprint=1`;
}
