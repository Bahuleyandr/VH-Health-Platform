import { Router } from 'express';
import logger from '../../logging/logger.js';
import {
  createActivation,
  getActivation,
  getStrokePathwaySettings,
  listActivations,
  recordNihssAssessment,
  recordPathwayEvent,
  recordThrombolysisDecision,
  setStrokePathwaySettings,
  updateActivationStatus,
} from '../../services/clinical/strokePathwayService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function actorOf(req) {
  return req.user?.uid || req.user?.id || null;
}

function actorRoleOf(req) {
  return req.user?.role || null;
}

function wrap(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return undefined;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) {
        return error(res, err.message, err.statusCode, {
          code: err.code,
          details: err.details,
          safe: true,
        });
      }
      logger.error('stroke pathway route error:', err);
      return error(res, 'An internal server error occurred. Please try again later.', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

router.get('/settings', requireStaffOrAdmin, wrap(async (req) =>
  getStrokePathwaySettings(tenantOf(req))));

router.patch('/settings', requireStaffOrAdmin, wrap(async (req) =>
  setStrokePathwaySettings({
    tenantId: tenantOf(req),
    actorUid: actorOf(req),
    enabled: req.body.enabled === true,
    clockDefinitionSource: req.body.clock_definition_source ?? req.body.clockDefinitionSource,
    clockDefinitionVersion: req.body.clock_definition_version ?? req.body.clockDefinitionVersion,
    clockDefinitionAttachmentRefs: req.body.clock_definition_attachment_refs ?? req.body.clockDefinitionAttachmentRefs,
    nihssSource: req.body.nihss_source ?? req.body.nihssSource,
    nihssVersion: req.body.nihss_version ?? req.body.nihssVersion,
    nihssAttachmentRefs: req.body.nihss_attachment_refs ?? req.body.nihssAttachmentRefs,
    thrombolysisProtocolSource: req.body.thrombolysis_protocol_source ?? req.body.thrombolysisProtocolSource,
    thrombolysisProtocolVersion: req.body.thrombolysis_protocol_version ?? req.body.thrombolysisProtocolVersion,
    thrombolysisProtocolAttachmentRefs: req.body.thrombolysis_protocol_attachment_refs ?? req.body.thrombolysisProtocolAttachmentRefs,
    thrombolysisApproverPrivilegeKey: req.body.thrombolysis_approver_privilege_key ?? req.body.thrombolysisApproverPrivilegeKey,
    doorToCtTargetMinutes: req.body.door_to_ct_target_minutes ?? req.body.doorToCtTargetMinutes,
    doorToNeedleTargetMinutes: req.body.door_to_needle_target_minutes ?? req.body.doorToNeedleTargetMinutes,
    acceptanceSnapshot: req.body.acceptance_snapshot ?? req.body.acceptanceSnapshot,
    metadata: req.body.metadata,
  })));

router.get('/activations', requireStaffOrAdmin, wrap(async (req) =>
  listActivations({
    tenantId: tenantOf(req),
    status: req.query.status,
    patientUid: req.query.patient_uid || req.query.patientUid,
    limit: req.query.limit,
  })));

router.post('/activations', requireStaffOrAdmin, wrap(async (req) =>
  createActivation({
    ...req.body,
    tenantId: tenantOf(req),
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.get('/activations/:id', requireStaffOrAdmin, wrap(async (req) =>
  getActivation({ tenantId: tenantOf(req), id: req.params.id })));

router.patch('/activations/:id/status', requireStaffOrAdmin, wrap(async (req) =>
  updateActivationStatus({
    tenantId: tenantOf(req),
    id: req.params.id,
    status: req.body.status,
    notes: req.body.notes,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.post('/activations/:id/nihss', requireStaffOrAdmin, wrap(async (req) =>
  recordNihssAssessment({
    ...req.body,
    tenantId: tenantOf(req),
    activationId: req.params.id,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.post('/activations/:id/thrombolysis', requireStaffOrAdmin, wrap(async (req) =>
  recordThrombolysisDecision({
    ...req.body,
    tenantId: tenantOf(req),
    activationId: req.params.id,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.post('/activations/:id/events', requireStaffOrAdmin, wrap(async (req) =>
  recordPathwayEvent({
    ...req.body,
    tenantId: tenantOf(req),
    activationId: req.params.id,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

export default router;
