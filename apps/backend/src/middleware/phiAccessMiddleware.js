/**
 * HIPAA PHI Access Logging Middleware
 *
 * Automatically logs PHI (Protected Health Information) access for routes
 * that handle patient medical data. Applied at the route level to avoid
 * needing logPhiAccess() calls in every individual controller.
 *
 * Usage in app.js:
 *   app.use('/api/v1/records', phiAccessLogger('MEDICAL_RECORD'), recordRoutes);
 *   app.use('/api/v1/prescriptions', phiAccessLogger('PRESCRIPTION'), prescriptionRoutes);
 */

import logger from '../logging/logger.js';
import {
  authorizePatientAccessRequest,
  patientAccessErrorPayload,
  resolvePatientForResourceAccess,
  shouldSkipAccessCheckError,
} from '../services/security/accessDecisionService.js';
import { policyCodeForRecordType } from '../services/security/accessPolicyRegistry.js';
import {
  CARE_TEAM_ENFORCEMENT_MODES,
  resolveEnforcementModeForRequest,
} from '../services/security/careTeamEnforcement.js';
import { resolveTenantOrThrow } from '../services/tenant/tenantService.js';
import { logPhiAccess } from '../utils/hipaaAudit.js';

/**
 * Derive the patient ID from the request (params, query, or body).
 */
function derivePatientId(req) {
  return req.phiContext?.patientId
    || req.phiContext?.patient_id
    || req.phiContext?.patientUid
    || req.phiContext?.patient_uid
    || req.params?.patientId
    || req.params?.patient_uid
    || req.params?.patientUid
    || req.params?.uid
    || req.query?.patient_uid
    || req.query?.patientUid
    || req.query?.patientId
    || req.query?.patient_id
    || req.query?.phone   // phone can identify a patient
    || req.query?.patient_phone
    || req.query?.patientPhone
    || req.body?.patient_uid
    || req.body?.patientUid
    || req.body?.patientId
    || req.body?.patient_id
    || req.body?.phone
    || req.body?.patient_phone
    || req.body?.patientPhone
    || null;
}

/**
 * Map HTTP method to HIPAA action.
 */
function deriveAction(method) {
  switch (method) {
    case 'GET': case 'HEAD': return 'VIEW';
    case 'POST': return 'CREATE';
    case 'PUT': case 'PATCH': return 'UPDATE';
    case 'DELETE': return 'DELETE';
    default: return 'ACCESS';
  }
}

function deriveTenantId(req) {
  return resolveTenantOrThrow(req);
}

/**
 * Resolve the effective enforcement posture for a guard invocation.
 *
 * Legacy call sites (the dozens of route-level guards that pre-date the
 * CareTeam ABAC rollout) are NOT care-team-mode-governed: they keep their
 * historical contract of ALWAYS enforcing (real 403 on deny, 500 on
 * unexpected error). Downgrading them to shadow would silently WEAKEN PHI
 * access control that ships today — the opposite of the rollout's intent.
 *
 * Only call sites that explicitly opt in with `careTeamModeGoverned: true`
 * (the newly-mounted coverage on the previously-audit-only PHI families) are
 * governed by the per-tenant `care_team_enforcement_mode` flag, whose default
 * is 'shadow'. For those, this returns the resolved mode; for legacy sites it
 * returns 'enforce' without any tenant lookup.
 *
 * Fail-safe: if mode resolution throws for a governed site, fall back to the
 * non-breaking 'shadow' default.
 */
async function resolveGuardMode(req, options) {
  if (!options?.careTeamModeGoverned) return CARE_TEAM_ENFORCEMENT_MODES.ENFORCE;
  try {
    return await resolveEnforcementModeForRequest(req);
  } catch {
    return CARE_TEAM_ENFORCEMENT_MODES.SHADOW;
  }
}

export function patientAccessGuard(recordType = 'PHI', options = {}) {
  return async function patientAccessGuardMiddleware(req, res, next) {
    // Phase 0 — resolve the enforcement posture for THIS call site.
    // Legacy sites → 'enforce' (unchanged). Care-team-governed coverage →
    // per-tenant mode (default 'shadow').
    const mode = await resolveGuardMode(req, options);

    // 'off' — skip ABAC entirely. The passive phiAccessLogger mounted after
    // this guard in the chain still records the HIPAA access trail.
    if (mode === CARE_TEAM_ENFORCEMENT_MODES.OFF) {
      return next();
    }

    const shadow = mode === CARE_TEAM_ENFORCEMENT_MODES.SHADOW;

    try {
      const decision = await authorizePatientAccessRequest(req, {
        policyCode: options.policyCode || policyCodeForRecordType(recordType),
        recordType,
        shadowMode: shadow,
      });
      if (decision?.no_patient_context) {
        // Only enforce mode may block on a missing-but-required patient
        // context. Shadow must never block.
        if (options.requirePatientContext && !shadow) {
          return res.status(403).json({
            success: false,
            message: 'Patient context is required for this PHI operation',
            code: 'PATIENT_CONTEXT_REQUIRED',
          });
        }
        return next();
      }

      // In shadow mode authorizePatientAccessRequest already returns
      // allowed:true for a would-be denial (shadow_denied:true) and has
      // written the deny audit row, so this branch only fires in enforce mode.
      if (!decision.allowed) {
        return res.status(403).json(patientAccessErrorPayload(decision));
      }

      return next();
    } catch (err) {
      if (shouldSkipAccessCheckError(err)) {
        // M3: only reachable outside production with a verified 42P01.
        // Alert at error level — a skipped PHI access check must never be
        // background noise.
        logger.error('SECURITY ALERT: patient access guard SKIPPED (governance table missing, non-prod)', {
          path: req.originalUrl || req.url,
          sqlError: err?.message,
        });
        return next();
      }
      // CRITICAL NON-BREAKING GUARANTEE: in shadow mode the guard must NEVER
      // block and NEVER 500. Any unexpected error fails OPEN (allow + log) so
      // a PHI route can never be taken down by the access check while we are
      // still observing. Legacy/enforce mode keeps the fail-closed 500.
      if (shadow) {
        logger.error('SECURITY ALERT: patient access guard failed OPEN in shadow mode (allowing request)', {
          path: req.originalUrl || req.url,
          recordType,
          error: err?.message,
        });
        return next();
      }
      logger.error('Patient access guard failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Patient access check failed',
        code: 'PATIENT_ACCESS_CHECK_FAILED',
      });
    }
  };
}

export function patientAccessGuardForResource(recordType = 'PHI', options = {}) {
  const {
    policyCode,
    resourceType,
    idParam = 'id',
    idSelector = null,
    allowNoPatientResource = false,
    careTeamModeGoverned = false,
  } = options;

  return async function patientAccessGuardForResourceMiddleware(req, res, next) {
    // Phase 0 — resolve the enforcement posture for THIS call site. Legacy
    // sites → 'enforce' (unchanged); care-team-governed → per-tenant mode.
    const mode = await resolveGuardMode(req, { careTeamModeGoverned });

    // 'off' — skip ABAC entirely; the downstream phiAccessLogger still runs.
    if (mode === CARE_TEAM_ENFORCEMENT_MODES.OFF) {
      return next();
    }

    const shadow = mode === CARE_TEAM_ENFORCEMENT_MODES.SHADOW;

    try {
      const resourceId = typeof idSelector === 'function'
        ? idSelector(req)
        : req.params?.[idParam] ?? req.query?.[idParam] ?? req.body?.[idParam] ?? null;

      if (!resourceId) {
        return patientAccessGuard(recordType, { policyCode, careTeamModeGoverned })(req, res, next);
      }

      const patient = await resolvePatientForResourceAccess(req, {
        resourceType,
        resourceId,
      });

      if (!patient?.uid && allowNoPatientResource) return next();

      const decision = await authorizePatientAccessRequest(req, {
        policyCode: policyCode || policyCodeForRecordType(recordType),
        recordType,
        patient,
        resourceContext: { resourceType, resourceId },
        requireResolvedPatient: true,
        shadowMode: shadow,
      });

      // Shadow mode already coerces a would-be denial to allowed:true (after
      // writing the deny audit row), so this only blocks in enforce mode.
      if (!decision.allowed) {
        return res.status(403).json(patientAccessErrorPayload(decision));
      }

      return next();
    } catch (err) {
      if (shouldSkipAccessCheckError(err)) {
        // M3: only reachable outside production with a verified 42P01.
        logger.error('SECURITY ALERT: patient resource access guard SKIPPED (governance table missing, non-prod)', {
          path: req.originalUrl || req.url,
          resourceType,
          sqlError: err?.message,
        });
        return next();
      }
      // CRITICAL NON-BREAKING GUARANTEE: off/shadow never block and never 500.
      // Fail OPEN on any unexpected error in shadow; only enforce fails closed.
      if (shadow) {
        logger.error('SECURITY ALERT: patient resource access guard failed OPEN in shadow mode (allowing request)', {
          path: req.originalUrl || req.url,
          resourceType,
          error: err?.message,
        });
        return next();
      }
      logger.error('Patient resource access guard failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Patient access check failed',
        code: 'PATIENT_ACCESS_CHECK_FAILED',
      });
    }
  };
}

/**
 * Create middleware that logs PHI access after the response is sent.
 * Fire-and-forget — never blocks the request.
 *
 * Captures both actor and subject so the acting-as delegation flow is
 * fully traceable:
 *   * userId  / accessed_by — historically the actor (kept).
 *   * actorUid              — the human pressing the button (=
 *     req.acting.actorUid when delegating, = req.user.uid otherwise).
 *   * subjectUid            — the patient whose record was accessed (=
 *     req.user.uid AFTER any acting-as rewrite).
 *   * actingAsDependent     — TRUE iff X-Acting-As-Uid was honoured.
 *
 * @param {string} recordType - PHI category: 'MEDICAL_RECORD', 'INVESTIGATION',
 *   'PRESCRIPTION', 'PHARMACY_ORDER', 'APPOINTMENT', 'ADMISSION', 'CLINICAL_NOTE',
 *   'VITAL_SIGN', 'DIAGNOSIS', 'CLINICAL_ORDER'
 * @returns {import('express').RequestHandler}
 */
export function phiAccessLogger(recordType) {
  const middleware = function phiAccessLoggerMiddleware(req, res, next) {
    // Log after response is sent (fire-and-forget)
    res.on('finish', () => {
      const actorUid = req.acting?.actorUid ?? req.user?.uid ?? null;
      const subjectUid = req.user?.uid ?? null;
      const actingAsDependent = req.acting != null;

      // Use the actor (human pressing the button) for the legacy
      // accessed_by column — that preserves historical semantics, since
      // the column always meant "who initiated this access".
      const userId = actorUid || req.user?.id;

      // Skip if we can't identify who's accessing (middleware ran before auth).
      // This also prevents double-logging auth-layer 401s — those never set
      // req.user, so there's no authenticated actor to attribute the attempt to.
      if (!userId) return;

      // SEC-6: a 403/404 against a resolved patient context is an *attempted
      // unauthorized PHI access* and must be auditable for HIPAA breach
      // detection — the success-only path used to drop these silently.
      const isDenied = res.statusCode === 403 || res.statusCode === 404;

      if (res.statusCode >= 400 && !isDenied) {
        // Other 4xx/5xx (400 validation, 429 rate limit, 500 server error)
        // are not PHI-access decisions — leave them to the error/security log.
        return;
      }

      // For the denied path, only audit when a patient was actually resolved.
      // A 404 on a route that never identified a patient (bad id, typo'd path)
      // is not a PHI-access attempt and must not pollute the breach-detection
      // trail. The access decision (set by the patient-access guard) is the
      // authoritative signal; fall back to request-derived patient ids.
      const resolvedPatientId = req.patientAccessDecision?.patient_uid
        ?? req.patientAccessDecision?.patient_id
        ?? derivePatientId(req);

      if (isDenied && !resolvedPatientId) return;

      const patientId = isDenied ? resolvedPatientId : derivePatientId(req);

      logPhiAccess({
        userId: String(userId),
        userRole: req.acting?.actorRole ?? req.user?.role ?? 'UNKNOWN',
        patientId: patientId ? String(patientId) : null,
        recordType,
        // Denied attempts are recorded as ACCESS_DENIED regardless of the HTTP
        // verb; successful access keeps the VIEW/CREATE/UPDATE/DELETE mapping.
        action: isDenied ? 'ACCESS_DENIED' : deriveAction(req.method),
        ip: req.ip,
        requestId: req.id,
        actorUid,
        subjectUid,
        actingAsDependent,
        deviceType: req.user?.deviceType ?? null,
        tenantId: deriveTenantId(req),
      });
    });

    next();
  };
  middleware.phiRecordType = recordType;
  return middleware;
}
