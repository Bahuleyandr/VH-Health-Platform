import {
  clinicalContinuityFacilityContextEnabled,
} from '../../config/downtimeConfig.js';
import logger from '../../logging/logger.js';
import {
  issueClinicalContinuityFacilityContext,
} from '../../services/downtime/clinicalContinuityFacilityContextService.js';
import { error, success } from '../../utils/responseHelper.js';

export async function issueFacilityContext(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!clinicalContinuityFacilityContextEnabled()) {
    return error(
      res,
      'Clinical continuity facility context is unavailable',
      503,
      {
        safe: true,
        topLevel: { code: 'CONTINUITY_FACILITY_CONTEXT_UNAVAILABLE' },
      },
    );
  }

  try {
    const envelope = await issueClinicalContinuityFacilityContext({
      tenantId: req.tenantId,
      actorUid: req.user?.uid,
      stableDeviceId: req.user?.stableDeviceId,
      sessionJti: req.user?.jti,
      sessionExpiresAt: req.user?.tokenExpiresAt,
      requestedFacilityId: req.body?.facilityId,
      deviceProof: req.body?.deviceProof,
      signer: req.app?.locals?.clinicalContinuitySigner,
      // Intentionally absent while C-D14 is open. A later owner-cleared
      // activation slice must inject the approved finite lifetime.
      contextLifetimeMs: undefined,
    });
    return success(
      res,
      { facilityContext: envelope },
      'Clinical continuity facility context issued',
    );
  } catch (err) {
    logger.warn('Clinical continuity facility context denied', {
      code: err?.code || 'CONTINUITY_FACILITY_CONTEXT_DENIED',
      requestId: req.id,
      tenantId: req.tenantId,
      actorUid: req.user?.uid,
    });
    return error(
      res,
      'Clinical continuity facility context was denied',
      err?.statusCode || 403,
      {
        safe: true,
        topLevel: { code: 'CONTINUITY_FACILITY_CONTEXT_DENIED' },
      },
    );
  }
}
