import { clinicalContinuityActionRegistryEnabled } from '../config/downtimeConfig.js';
import {
  CLINICAL_CONTINUITY_ACTIONS_BY_ID
} from '../config/clinicalContinuityActionCatalog.js';
import { getRolePolicy } from '../config/rolePolicyGraph.js';
import {
  resolveClinicalContinuityActionBinding,
  resolveClinicalContinuityRouteTemplate
} from '../services/downtime/clinicalContinuityActionBindingRegistry.js';
import {
  evaluateClinicalContinuityActionRequest
} from '../services/downtime/clinicalContinuityActionRegistryService.js';
import { error } from '../utils/responseHelper.js';

const HEADER_PREFIX = 'x-vh-continuity-';

function header(req, suffix) {
  const value = req.get(`${HEADER_PREFIX}${suffix}`);
  return typeof value === 'string' ? value.trim() : '';
}

function nullableHeader(req, suffix) {
  const value = header(req, suffix);
  return value === '' || value === 'none' ? null : value;
}

function numericHeader(req, suffix) {
  const value = header(req, suffix);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

function roleCapabilities(role) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  const entry = getRolePolicy().roles.find(candidate => candidate.role_code === normalizedRole);
  return entry?.access?.route_capability_groups || [];
}

function identitySatisfied(action, req, facilityId) {
  const body = req.body || {};
  const values = {
    actor: req.user?.uid,
    tenant: req.tenantId,
    facility: facilityId,
    patient: body.patient_uid,
    capture_session: header(req, 'capture-session-id'),
    appointment_or_encounter: body.appointment_id || body.encounter_id
  };
  return action.requiredIdentity.every(key => Boolean(values[key]));
}

function cachedSourcesSatisfied(action, req, capturedAt) {
  if (action.cachedSourceContract.mode !== 'required') return true;
  const supplied = new Map();
  for (const item of header(req, 'cached-sources').split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    supplied.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  const capturedMillis = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMillis)) return false;
  return action.cachedSourceContract.sources.every(source => {
    const timestamp = supplied.get(source.sourceId);
    const sourceMillis = Date.parse(timestamp);
    const ageMinutes = (capturedMillis - sourceMillis) / 60_000;
    return (
      Number.isFinite(sourceMillis) &&
      ageMinutes >= 0 &&
      ageMinutes <= source.maxAgeMinutes
    );
  });
}

function authorityClaims(req) {
  return {
    actionChecksum: nullableHeader(req, 'action-checksum'),
    actionSchemaChecksum: nullableHeader(req, 'action-schema-checksum'),
    actionSchemaVersion: numericHeader(req, 'action-schema-version'),
    actionVersion: numericHeader(req, 'action-version'),
    policyChecksum: nullableHeader(req, 'policy-checksum'),
    policyEffectiveFrom: nullableHeader(req, 'policy-effective-from'),
    policyEffectiveUntil: nullableHeader(req, 'policy-effective-until'),
    policyId: nullableHeader(req, 'policy-id')?.toLowerCase() || null,
    policySigningKeyId: nullableHeader(req, 'policy-signing-key-id'),
    policySupersedesId:
      nullableHeader(req, 'policy-supersedes-id')?.toLowerCase() || null,
    policyVersion: header(req, 'policy-version'),
    registryChecksum: nullableHeader(req, 'registry-checksum'),
    registryVersion: header(req, 'registry-version'),
    revocationEpoch: header(req, 'revocation-epoch')
  };
}

export async function clinicalContinuityActionPolicyMiddleware(req, res, next) {
  if (!clinicalContinuityActionRegistryEnabled()) return next();

  const actionId = header(req, 'action-id');
  if (!actionId) return next();

  const action = CLINICAL_CONTINUITY_ACTIONS_BY_ID[actionId];
  const path = req.path;
  const binding = resolveClinicalContinuityActionBinding({
    actionId,
    method: req.method,
    path
  });
  const facilityId = numericHeader(req, 'facility-id');
  const capturedAt = header(req, 'captured-at');
  const claims = authorityClaims(req);

  try {
    const result = await evaluateClinicalContinuityActionRequest({
      tenantId: req.tenantId,
      facilityId,
      capturedPolicyId: claims.policyId,
      capturedPolicyVersion: claims.policyVersion,
      requestContext: {
        actionId,
        actorCapabilities: roleCapabilities(req.user?.role),
        actorRole: req.user?.role,
        actorUid: req.user?.uid,
        authorityClaims: claims,
        binding,
        body: req.body,
        cachedSourcesSatisfied: action
          ? cachedSourcesSatisfied(action, req, capturedAt)
          : false,
        capturedAt,
        clientAppVersion: header(req, 'client-app-version'),
        devicePosture: String(req.user?.deviceType || '').toLowerCase(),
        identitySatisfied: action ? identitySatisfied(action, req, facilityId) : false,
        requestId: req.id,
        routeTemplate: resolveClinicalContinuityRouteTemplate({
          actionId,
          method: req.method,
          path
        })
      }
    });
    if (result.proceed) return next();
    const status = result.decision === 'needs_review' ? 409 : 403;
    return error(res, 'Clinical continuity action was not authorized', status, {
      code: result.reasonCode,
      decision: result.decision,
      owner: result.owner,
      safe: true
    });
  } catch (err) {
    return next(err);
  }
}
