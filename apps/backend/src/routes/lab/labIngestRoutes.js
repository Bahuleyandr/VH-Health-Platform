import { Router } from 'express';

import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import * as lab from '../../services/lab/labResultsService.js';
import * as labClosedLoop from '../../services/lab/labClosedLoopService.js';
import {
  ingestSequencedAstmRecovery,
  ingestSequencedOruRecovery,
} from '../../services/integrations/externalLabRecoveryService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import {
  canIngestLabInterface,
  getAuthenticatedActorRoles,
} from '../../utils/roleHelpers.js';
import { error, relayAppError, success } from '../../utils/responseHelper.js';

const router = Router();

function requireLabIngestActor(req, res, next) {
  const roles = getAuthenticatedActorRoles(req.user);
  if (!roles.some(canIngestLabInterface)) {
    return error(res, 'Lab analyzer ingestion role required', 403);
  }
  next();
}

function rejectCrossTenantDbApiClient(req, res, next) {
  if (req.apiClientId == null) return next();
  let tenantId;
  try {
    tenantId = resolveTenantOrThrow(req);
  } catch (err) {
    return relayAppError(res, err, 'Lab error');
  }
  if (
    !req.apiClientTenantId
    || String(req.apiClientTenantId).toLowerCase() !== String(tenantId).toLowerCase()
  ) {
    return error(res, 'Lab analyzer channel is not authorized for this tenant', 403);
  }
  return next();
}

function wrap(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req);
      const patientUids = new Set(
        (Array.isArray(data?.results) ? data.results : [])
          .map(result => result?.patient_uid)
          .filter(Boolean)
          .map(patientUid => String(patientUid).toLowerCase()),
      );
      if (patientUids.size === 1) {
        req.phiContext = {
          ...(req.phiContext || {}),
          patientUid: [...patientUids][0],
        };
      }
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Lab error');
    }
  };
}

router.post(
  '/oru/ingest',
  requireLabIngestActor,
  rejectCrossTenantDbApiClient,
  phiAccessLogger('LAB_RESULT'),
  wrap(async (req) => {
    const actorRoles = getAuthenticatedActorRoles(req.user);
    const context = {
      tenantId: resolveTenantOrThrow(req),
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || actorRoles[0] || null,
      actorRoles,
      apiClient: req.apiClient || null,
      apiClientId: req.apiClientId || null,
      apiClientTenantId: req.apiClientTenantId || null,
    };
    if (req.body?.recovery != null) {
      return ingestSequencedOruRecovery({
        tenantId: context.tenantId,
        message: req.body?.message,
        recovery: req.body.recovery,
      }, context);
    }
    return lab.ingestOruMessage(req.body?.message, context);
  }),
);

router.post(
  '/interface/ingest',
  requireLabIngestActor,
  rejectCrossTenantDbApiClient,
  phiAccessLogger('LAB_RESULT'),
  wrap(async (req) => {
    if (req.body?.protocol === 'hl7v2') {
      throw AppError.badRequest(
        'HL7 ORU messages must use /api/v1/lab/oru/ingest',
        'LAB_INTERFACE_HL7_ROUTE_REQUIRED',
      );
    }
    const actorRoles = getAuthenticatedActorRoles(req.user);
    const context = {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || actorRoles[0] || null,
      actorRoles,
      apiClient: req.apiClient || null,
      apiClientId: req.apiClientId || null,
      apiClientTenantId: req.apiClientTenantId || null,
    };
    const tenantId = resolveTenantOrThrow(req);
    if (req.body?.recovery != null) {
      if (req.body?.protocol !== 'astm_e1394') {
        throw AppError.badRequest(
          'I02 recovery requires protocol astm_e1394',
          'LAB_INTERFACE_BAD_PROTOCOL',
        );
      }
      return ingestSequencedAstmRecovery({
        tenantId,
        message: req.body?.message,
        analyzerCode: req.body?.analyzer_code || null,
        recovery: req.body.recovery,
      }, context);
    }
    return labClosedLoop.ingestInterfaceMessage({
      protocol: req.body?.protocol,
      rawMessage: req.body?.message,
      analyzerCode: req.body?.analyzer_code || null,
      tenantId,
    }, context);
  }),
);

export default router;
