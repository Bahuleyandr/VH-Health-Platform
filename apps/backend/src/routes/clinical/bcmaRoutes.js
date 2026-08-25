// src/routes/clinical/bcmaRoutes.js
//
// Roadmap B1 — BCMA support surfaces. Mounted at /api/v1/bcma behind the
// clinical-staff gate + PHI logger (app.js).
//
//   GET /wristband/:patientUid            — wristband payload (JSON)
//   GET /wristband/:patientUid?format=html — printable wristband with a
//       Code 39 rendering of the patient UID (the exact value
//       mar_scan_screen.dart expects from the wristband scan).
//
// Reachability (re-audit lane J): this mount sits behind validateApiKey +
// jwtAuth, both of which read HEADERS only — validateApiKey has no query
// fallback (middleware/validateApiKey.js:55). A plain browser navigation
// therefore cannot reach the printable variant directly, and it must not:
// putting the API key in a URL would leak it into history, logs and the
// Referer. The browser route is the admin portal's same-origin reverse proxy
// (apps/admin/src/app/api/proxy/[...path]/route.ts), which authenticates on
// the httpOnly auth_token cookie and attaches the bearer + x-api-key
// server-side.
//
// WHO CAN ACTUALLY PRINT A BAND. Passing the mount's
// requireRole(CLINICAL_STAFF_ROLES) is not enough. Two patient-access guards
// appear in the chain, but only ONE of them decides anything:
//
//   1. app.js admits all 34 CLINICAL_STAFF_ROUTE_ROLES, ADMIN and SUPER_ADMIN
//      among them, then runs patientAccessGuard('BCMA', {
//      careTeamModeGoverned: true }). That guard NEVER decides this request:
//      Express has not matched the route when a mount-level middleware runs,
//      so `:patientUid` is not in req.params, no patient resolves, and
//      authorizePatientAccessRequest returns no_patient_context without
//      evaluating a policy or writing an audit row — in shadow and in enforce
//      alike. Measured, not assumed: one wristband request produces exactly
//      one patient_access_audit_log row, pinned in
//      tests/bcma-wristband-admin-access.deep.test.js.
//   2. `guardWristbandView` below is a LEGACY-mode guard (no
//      careTeamModeGoverned), so it always enforces, and it is the sole
//      authority on who gets a band. It runs PATIENT_WRISTBAND_PRINT.
//
// The roles that reach a band on a care relationship are the bedside ones the
// MAR round is for — NURSING_STAFF, IP_STAFF_NURSE, ICU_NURSE,
// NURSING_INCHARGE, IP_INCHARGE gain an `admission` relationship to any
// admitted patient in the tenant
// (accessDecisionService#findAdmissionRelationship, IP_RELATIONSHIP_ROLES), and
// treating clinicians gain one through the doctor/care-team/authorship checks.
// The portal's MAR page is reachable at STAFF rank (routePolicy.ts) and staff
// sign in with employeeId, so those roles hold real portal sessions; the deep
// round-trip in tests/bcma-closed-loop.deep.test.js exercises exactly this with
// a NURSING_STAFF token.
//
// ADMINISTRATORS — owner decision, 2026-08-25 (docs/ROADMAP.md):
//
//   "Yes administrator should be able to print a wristband without
//    break-glass, but such an action should be noted in logs for future audit
//    if needed."
//
// Implemented as a policy code of its own — PATIENT_WRISTBAND_PRINT — rather
// than by widening PATIENT_CLINICAL_WORKFLOW_ACCESS, which gates 27 other
// clinical surfaces. accessDecisionService grants ADMIN / SUPER_ADMIN a
// LAST-RESORT allow for that code only, evaluated after every relationship
// check has failed, so:
//   * an administrator with no care relationship prints the band, no
//     break-glass, and the decision is stamped administrative_access;
//   * an administrator who does hold a relationship (or a live break-glass
//     session) is attributed to it and is NOT stamped administrative;
//   * a nursing print is attributed to `admission` and is NOT stamped
//     administrative;
//   * any other role with no relationship is still refused, exactly as before.
//
// WHERE THE AUDIT LANDS — two sinks, both append-only (migration 324):
//   * patient_access_audit_log — written automatically by the guard for every
//     decision on this route. Actor, patient, tenant, route, action, time, plus
//     metadata->>'administrative_access' = 'true' and
//     metadata->>'administrative_grant' = 'administrator_no_relationship'.
//     Surfaced by the portal's Clinical Governance access-audit tab.
//   * audit_logs — the administrative-action sink with a REST reader
//     (/api/v1/logs/audit) and the System Logs UI. This route adds one row per
//     administrative print, action 'wristband-print-administrative-access',
//     resource 'patient_wristband'. See recordAdministrativeWristbandAudit
//     below; it is best-effort and can never fail the print.
// The mount's phiAccessLogger('BCMA') keeps writing the ordinary
// hipaa_access_log PHI-read row for every caller, administrator or not.

import express from 'express';
import { createHash } from 'node:crypto';
import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success, error } from '../../utils/responseHelper.js';
import { code39Svg } from '../../utils/barcode/code39.js';
import { getUnifiedActiveAllergiesDetailed } from '../../services/clinical/allergySourceService.js';
import { logAudit } from '../../utils/logAudit.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The selector is load-bearing, not decoration. resolvePatientForAccess
// consults req.phiContext.patientUid FIRST and only then req.params / req.query
// (accessDecisionService.js ~951), and every guard that resolves a patient
// writes that field UNCONDITIONALLY — including on a denial (~2204). The
// /api/v1/bcma mount guard runs earlier and DOES see req.query, so without an
// explicit selector `GET /wristband/<A>?patient_uid=<B>` authorises B while
// this handler prints A: the disclosure is A's, the decision and both audit
// rows say B. Binding to req.params.patientUid — the same value the handler
// serves — makes the decision, the audit and the disclosure the same patient
// by construction. requirePatientContext refuses rather than falling back if
// the selector yields nothing.
const guardWristbandView = patientAccessGuard('BCMA', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT,
  patientSelector: (req) => ({ uid: req.params?.patientUid }),
  requirePatientContext: true,
});

// The administrative-action row for the owner's "noted in logs for future
// audit" requirement. Distinct from the guard's own patient_access_audit_log
// row: that one records the ACCESS DECISION, this one records the
// ADMINISTRATIVE ACTION in the sink compliance actually reads
// (/api/v1/logs/audit, /dashboard/system-logs).
export const WRISTBAND_ADMIN_AUDIT_ACTION = 'wristband-print-administrative-access';

// Best-effort by construction, twice over. A wristband is a bedside safety
// artifact and a PHI READ: an audit sink that is down must never turn a band
// into a 500 at the bedside. logAudit already swallows its own DB failure into
// the Winston sink (utils/logAudit.js), and this wrapper additionally refuses
// to propagate anything the helper itself could throw (import-time/serialisation
// failure), so no path from here can reject.
//
// Fires ONLY when the access decision came from the administrative last-resort
// grant. A nursing print (accessSource 'admission') and an administrator who
// held a real relationship or a break-glass session never reach the write, so
// they are never labelled administrative.
export async function recordAdministrativeWristbandAudit(req, patient, format) {
  const decision = req?.patientAccessDecision;
  if (decision?.administrativeAccess !== true) return false;
  try {
    await logAudit(
      req,
      WRISTBAND_ADMIN_AUDIT_ACTION,
      {
        patient_uid: patient?.uid ?? null,
        patient_id: patient?.id == null ? null : Number(patient.id),
        // The band prints the patient's name — say so, without copying the
        // name into a second sink.
        discloses_patient_name: Boolean(patient?.name),
        format: format === 'html' ? 'printable_html' : 'json',
        policy_code: decision.policy_code ?? null,
        access_source: decision.accessSource ?? null,
        // jwtMiddleware canonicalises SUPER_ADMIN to ADMIN on req.user.role
        // (utils/roles.js#canonicalizeRequestRole), which is what every other
        // audit column records. Carry the token's own role too so a
        // SUPER_ADMIN print is not indistinguishable from an ADMIN one.
        actor_raw_role: req?.user?.rawRole ?? null,
        administrative_grant: decision.administrativeGrant ?? null,
        care_relationship: 'none',
        break_glass: false,
        reason: decision.reason ?? null,
        occurred_at: new Date().toISOString(),
      },
      { resource: 'patient_wristband', resourceId: patient?.uid ?? null },
    );
    return true;
  } catch (auditErr) {
    logger.error('Administrative wristband audit failed (band still printed)', {
      error: auditErr?.message,
      patient_uid: patient?.uid ?? null,
    });
    return false;
  }
}

// The `?autoprint=1` trigger is an inline <script>, and the app-wide helmet
// policy is `script-src 'self'` with no 'unsafe-inline' (app.js:537) — so the
// browser has always refused to run it and autoprint has never actually
// fired on any path. A wristband is one self-contained document with no
// external resources, so the HTML response carries its OWN policy: deny
// everything by default and admit exactly this one script by SHA-256 hash.
// The script text is interpolated from the same constant that is hashed, so
// the two cannot drift apart.
const WRISTBAND_AUTOPRINT_SCRIPT = "window.addEventListener('load', () => { if (new URLSearchParams(location.search).get('autoprint') === '1') window.print(); });";
const WRISTBAND_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${createHash('sha256').update(WRISTBAND_AUTOPRINT_SCRIPT, 'utf8').digest('base64')}'`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

// C-M8 — the wristband allergy strip, three-way. A wristband is a bedside
// safety artifact: "No known allergies recorded" asserts a VERIFIED negative,
// so it may only render when the unified lookup actually succeeded end to end.
// When any source failed, the truthful statement is "status unavailable —
// verify manually" (loud red strip, never the grey verified-none style); known
// allergens from the sources that DID answer are still shown above it.
// Exported for direct unit pinning of the failure branch (the deep round-trip
// exercises the ok branches against the real DB).
export function renderWristbandAllergyStrip(allergies, lookupFailed) {
  const list = allergies.length
    ? `<div class="allergies">⚠ ALLERGIES: ${escapeHtml(allergies.map((a) => a.allergen).join(', '))}</div>`
    : '';
  if (lookupFailed) {
    const warning = allergies.length
      ? '⚠ ADDITIONAL ALLERGY SOURCES UNAVAILABLE — verify manually before administration'
      : '⚠ ALLERGY STATUS UNAVAILABLE — verify manually before administration';
    return `${list}<div class="allergies">${warning}</div>`;
  }
  return list || '<div class="allergies none">No known allergies recorded</div>';
}

router.get('/wristband/:patientUid', guardWristbandView, async (req, res) => {
  try {
    const { patientUid } = req.params;
    if (!UUID_RE.test(patientUid)) {
      return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
    }
    const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.name, u.gender, u.blood_group,
              TO_CHAR(u.birthday, 'YYYY-MM-DD') AS birthday,
              CASE WHEN u.birthday IS NOT NULL THEN DATE_PART('year', AGE(NOW()::date, u.birthday))::int ELSE NULL END AS age_years,
              (SELECT pi.identifier_value FROM patient_identifiers pi
                WHERE pi.patient_uid = u.uid AND pi.identifier_type IN ('mrn', 'uhid')
                ORDER BY CASE pi.identifier_type WHEN 'mrn' THEN 0 ELSE 1 END
                LIMIT 1) AS mrn,
              (SELECT a.ward FROM admissions a
                WHERE a.patient_uid = u.uid
                  AND ($2::uuid IS NULL OR a.tenant_id = $2::uuid)
                  AND a.status IN ('admitted', 'active')
                ORDER BY a.created_at DESC LIMIT 1) AS ward,
              (SELECT a.bed_number FROM admissions a
                WHERE a.patient_uid = u.uid
                  AND ($2::uuid IS NULL OR a.tenant_id = $2::uuid)
                  AND a.status IN ('admitted', 'active')
                ORDER BY a.created_at DESC LIMIT 1) AS bed_number
         FROM users u
        WHERE u.uid = $1::uuid
          AND ($2::uuid IS NULL OR u.tenant_id = $2::uuid)
        LIMIT 1`,
      patientUid,
      tenantId,
    );
    if (!rows.length) return error(res, 'Patient not found', HTTP_STATUS.NOT_FOUND);
    const patient = rows[0];
    const requestedFormat = String(req.query.format || '').toLowerCase();

    // Owner decision 2026-08-25 — an administrator printing without a care
    // relationship is recorded before the band leaves the process. No-op for
    // every other caller, and cannot throw (see the helper).
    await recordAdministrativeWristbandAudit(req, patient, requestedFormat);

    // C-M8: the unified allergy service never throws — a total or partial
    // lookup failure used to be indistinguishable from verified-none here, and
    // the band printed the false negative "No known allergies recorded". Use
    // the detailed variant so failure is explicit; the route-level catch stays
    // as a belt-and-braces fail-unknown (never fail-verified-none).
    let allergies = [];
    let allergyLookupFailed = false;
    try {
      const detailed = await getUnifiedActiveAllergiesDetailed(prisma, { patientUid });
      allergies = detailed.allergies;
      allergyLookupFailed = detailed.sourcesFailed.length > 0 || !detailed.patientResolved;
    } catch (allergyErr) {
      allergyLookupFailed = true;
      logger.warn('Wristband allergy lookup failed (band prints the verify-manually strip)', {
        error: allergyErr.message,
      });
    }

    const payload = {
      patient: {
        uid: patient.uid,
        name: patient.name || null,
        gender: patient.gender || null,
        birthday: patient.birthday || null,
        age_years: patient.age_years ?? null,
        blood_group: patient.blood_group || null,
        mrn: patient.mrn || null,
        ward: patient.ward || null,
        bed_number: patient.bed_number || null,
      },
      barcode_payload: patient.uid,
      barcode_symbology: 'code39',
      allergies: allergies.map((a) => ({ allergen: a.allergen, severity: a.severity || null })),
      // 'ok' = every allergy source answered (an empty list is a VERIFIED
      // none); 'unavailable' = at least one source failed — consumers must
      // treat the list as incomplete and verify manually.
      allergies_status: allergyLookupFailed ? 'unavailable' : 'ok',
      generated_at: new Date().toISOString(),
    };

    if (requestedFormat === 'html') {
      const svg = code39Svg(patient.uid, { module: 2, height: 52 });
      const allergyStrip = renderWristbandAllergyStrip(payload.allergies, allergyLookupFailed);
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Wristband ${escapeHtml(patient.name || patient.uid)}</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; margin: 16px; }
  .band { border: 1.5px solid #000; border-radius: 8px; padding: 10px 14px; max-width: 560px; }
  .row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
  .name { font-size: 19px; font-weight: 700; }
  .meta { color: #222; }
  .allergies { margin-top: 6px; font-weight: 700; color: #a00; font-size: 13px; }
  .allergies.none { color: #555; font-weight: 400; }
  .code { margin-top: 8px; }
  @media print { body { margin: 0; } }
</style></head><body>
<div class="band">
  <div class="row"><span class="name">${escapeHtml(patient.name || 'Unknown patient')}</span>
    <span class="meta">${escapeHtml(patient.gender || '')} ${patient.age_years != null ? `${patient.age_years}y` : ''} ${escapeHtml(patient.blood_group || '')}</span></div>
  <div class="row meta"><span>DOB: ${escapeHtml(patient.birthday || '—')}</span>
    <span>MRN: ${escapeHtml(patient.mrn || '—')}</span>
    <span>${escapeHtml(patient.ward || '')} ${escapeHtml(patient.bed_number || '')}</span></div>
  ${allergyStrip}
  <div class="code">${svg}</div>
</div>
<script>${WRISTBAND_AUTOPRINT_SCRIPT}</script>
</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      // Replaces helmet's app-wide policy for THIS response only — see
      // WRISTBAND_CSP above. Narrower than the global one in every direction
      // except the single hashed script.
      res.setHeader('Content-Security-Policy', WRISTBAND_CSP);
      return res.send(html);
    }

    return success(res, payload, 'Wristband payload');
  } catch (err) {
    logger.error('Wristband generation failed:', err);
    return error(res, 'Failed to build wristband', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export const __testing__ = Object.freeze({
  WRISTBAND_AUTOPRINT_SCRIPT,
  WRISTBAND_CSP,
});

export default router;
