import express from 'express';

import { patientAccessGuard, patientAccessGuardForResource } from '../middleware/phiAccessMiddleware.js';
import {
  executePathwayCommand,
  getCarePathwayInstance,
  startCarePathwayInstance,
} from '../services/pathways/pathwayExecutorService.js';
import { isValidIdempotencyKey } from '../services/idempotency/idempotencyService.js';
import { ACCESS_POLICY_CODES } from '../services/security/accessPolicyRegistry.js';
import { AppError } from '../utils/AppError.js';
import { success } from '../utils/responseHelper.js';

const router = express.Router();

const START_FIELDS = new Set([
  'workflow_definition_id',
  'patient_uid',
  'encounter_id',
  'pathway_key',
  'parent_instance_id',
  'owning_clinician_uid',
  'owning_team_id',
  'accountable_role',
  'context',
  'metadata',
]);
const COMMAND_FIELDS = new Set(['signal']);
const CREATE_PATIENT_QUERY_SELECTOR_ALIASES = Object.freeze([
  'patient_uid',
  'patientUid',
  'patientId',
  'patient_id',
  'phone',
  'patient_phone',
  'patientPhone',
]);

const createPatientGuard = patientAccessGuard('CARE_PATHWAY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  requirePatientContext: true,
  requireResolvedPatient: true,
  patientSelector: (req) => ({ uid: req.body?.patient_uid }),
});
const readInstanceGuard = patientAccessGuardForResource('CARE_PATHWAY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'care_pathway_instance',
  idParam: 'id',
});
const mutateInstanceGuard = patientAccessGuardForResource('CARE_PATHWAY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'care_pathway_instance',
  idParam: 'id',
});

function requireActor(req) {
  const uid = req.user?.uid || null;
  if (!uid) throw AppError.unauthorized('Authenticated actor is required');
  const primaryRole = req.user?.role ? String(req.user.role).trim().toUpperCase() : null;
  const rawRoles = Array.isArray(req.user?.roles)
    ? req.user.roles
    : (req.user?.roles ? [req.user.roles] : []);
  const roles = [...new Set([
    primaryRole,
    ...rawRoles.map((role) => String(role).trim().toUpperCase()),
  ].filter(Boolean))];
  if (roles.length === 0) throw AppError.unauthorized('Authenticated actor role is required');
  const accessDecision = req.patientAccessDecision;
  let authorizationMode = 'authenticated_pathway_route';
  let overrideReason = null;
  let breakGlassId = null;
  if (accessDecision?.accessSource === 'break_glass') {
    authorizationMode = 'patient_access_break_glass';
    overrideReason = accessDecision.breakGlassReason || null;
    breakGlassId = accessDecision.breakGlassId || null;
  } else if (accessDecision?.shadow_mode === true && accessDecision?.allowed === false) {
    authorizationMode = 'patient_access_shadow_denied';
    overrideReason = accessDecision.reason || null;
  } else if (
    typeof accessDecision?.accessSource === 'string'
    && accessDecision.accessSource !== 'unknown'
  ) {
    authorizationMode = `patient_access_${accessDecision.accessSource}${
      accessDecision.shadow_mode === true ? '_shadow' : ''
    }`;
  }
  return {
    kind: 'user',
    uid,
    roles,
    primaryRole: primaryRole || roles[0],
    authorizationMode,
    ...(overrideReason ? { overrideReason } : {}),
    ...(breakGlassId ? { breakGlassId } : {}),
  };
}

function requireIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    throw AppError.badRequest('Idempotency-Key header is required', 'PATHWAY_IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!isValidIdempotencyKey(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'PATHWAY_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return key;
}

function rejectUnknownFields(body, allowed) {
  for (const field of Object.keys(body || {})) {
    if (!allowed.has(field)) {
      throw AppError.badRequest(
        `Unsupported pathway request field: ${field}`,
        'PATHWAY_ROUTE_FIELD_UNSUPPORTED',
      );
    }
  }
}

function setPhiPatientContext(req, patientUid) {
  if (!patientUid) return;
  req.phiContext = { ...(req.phiContext || {}), patientUid: String(patientUid) };
}

function rejectCreatePatientQuerySelectors(req, res, next) {
  const hasQuerySelector = CREATE_PATIENT_QUERY_SELECTOR_ALIASES.some((field) => (
    Object.prototype.hasOwnProperty.call(req.query || {}, field)
  ));
  if (!hasQuerySelector) return next();
  return res.status(403).json({
    success: false,
    message: 'Patient access is denied',
    code: 'PATIENT_ACCESS_DENIED',
  });
}

router.post('/instances', rejectCreatePatientQuerySelectors, createPatientGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    rejectUnknownFields(body, START_FIELDS);
    const row = await startCarePathwayInstance({
      tenantId: req.tenantId,
      workflowDefinitionId: body.workflow_definition_id,
      patientUid: body.patient_uid,
      encounterId: body.encounter_id,
      pathwayKey: body.pathway_key,
      sourceEpisodeType: body.encounter_id ? 'patient_encounter' : 'patient',
      sourceEpisodeId: body.encounter_id || body.patient_uid,
      parentInstanceId: body.parent_instance_id,
      owningClinicianUid: body.owning_clinician_uid,
      owningTeamId: body.owning_team_id,
      accountableRole: body.accountable_role,
      triggerKind: 'manual',
      triggerPayload: {},
      context: body.context,
      metadata: body.metadata,
      idempotencyKey: requireIdempotencyKey(req),
      actor: requireActor(req),
    });
    setPhiPatientContext(req, row?.patient_uid || body.patient_uid);
    return success(res, row, 'Care pathway instance created', 201);
  } catch (err) { return next(err); }
});

router.get('/instances/:id', readInstanceGuard, async (req, res, next) => {
  try {
    const row = await getCarePathwayInstance({ tenantId: req.tenantId, id: req.params.id });
    setPhiPatientContext(req, row?.patient_uid);
    return success(res, row, 'Care pathway instance retrieved');
  } catch (err) { return next(err); }
});

router.post('/instances/:id/commands', mutateInstanceGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    rejectUnknownFields(body, COMMAND_FIELDS);
    const result = await executePathwayCommand({
      tenantId: req.tenantId,
      pathwayInstanceId: req.params.id,
      idempotencyKey: requireIdempotencyKey(req),
      signal: body.signal,
      actor: requireActor(req),
    });
    setPhiPatientContext(req, result?.instance?.patient_uid || result?.patient_uid);
    return success(res, result, 'Care pathway command accepted');
  } catch (err) { return next(err); }
});

export default router;
