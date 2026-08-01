import logger from '../../logging/logger.js';
import {
  decodeClinicalContinuityFacilityContextHeader,
  resolveClinicalContinuityFacilityContext
} from '../../services/downtime/clinicalContinuityFacilityContextService.js';
import {
  ifNoneMatchMatches,
  loadClinicalContinuityPolicyDelivery
} from '../../services/downtime/clinicalContinuityPolicyDeliveryService.js';
import { AppError } from '../../utils/AppError.js';

export async function authorizeClinicalContinuityPolicyFacility(req, _res, next) {
  try {
    const envelope = decodeClinicalContinuityFacilityContextHeader(
      req.get('X-VH-Continuity-Facility-Context')
    );
    const context = await resolveClinicalContinuityFacilityContext({
      req,
      envelope,
      clientFacilityId: Number(req.params.facilityId)
    });
    if (Number(context.facilityId) !== Number(req.params.facilityId)) {
      throw new Error('facility mismatch');
    }
    return next();
  } catch (_error) {
    logger.warn('Clinical continuity policy facility context denied', {
      code: 'CONTINUITY_POLICY_FACILITY_FORBIDDEN',
      facilityId: Number(req.params.facilityId) || null,
      tenantId: req.tenantId || null
    });
    return next(
      new AppError(
        'Clinical continuity policy access is forbidden',
        403,
        'CONTINUITY_POLICY_FACILITY_FORBIDDEN'
      )
    );
  }
}

export async function getClinicalContinuityPolicyDelivery(req, res) {
  const delivery = await loadClinicalContinuityPolicyDelivery({
    tenantId: req.tenantId,
    facilityId: Number(req.params.facilityId)
  });
  res.set({
    'Cache-Control': 'private, no-cache, must-revalidate',
    'Content-Digest': delivery.contentDigest,
    'Content-Type': delivery.mediaType,
    ETag: delivery.etag,
    Vary: 'Authorization, X-API-Key',
    'X-VH-Continuity-Trusted-Time': delivery.trustedNow
  });
  if (ifNoneMatchMatches(req.get('If-None-Match'), delivery.etag)) {
    return res.status(304).end();
  }
  return res.status(200).send(delivery.body);
}
