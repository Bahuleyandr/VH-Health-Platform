import {
  clinicalContinuityPaperReconciliationEnabled,
} from '../config/downtimeConfig.js';
import {
  decodeClinicalContinuityFacilityContextHeader,
  resolveClinicalContinuityFacilityContext,
} from '../services/downtime/clinicalContinuityFacilityContextService.js';
import { AppError } from '../utils/AppError.js';

export async function requireClinicalContinuityReconciliationContext(req, _res, next) {
  try {
    if (!clinicalContinuityPaperReconciliationEnabled()) {
      return next(new AppError(
        'Clinical continuity reconciliation is unavailable',
        503,
        'CONTINUITY_PAPER_RECONCILIATION_UNAVAILABLE',
        { safe: true },
      ));
    }
    const facilityText = String(req.get('x-vh-continuity-facility-id') || '').trim();
    if (!/^[1-9][0-9]*$/.test(facilityText)) {
      throw AppError.forbidden(
        'Clinical continuity facility context was denied',
        'CONTINUITY_FACILITY_CONTEXT_DENIED',
      );
    }
    const encoded = req.get('x-vh-continuity-facility-context');
    const envelope = decodeClinicalContinuityFacilityContextHeader(encoded);
    await resolveClinicalContinuityFacilityContext({
      req,
      envelope,
      clientFacilityId: Number(facilityText),
    });
    return next();
  } catch (error) {
    if (String(error?.code || '').startsWith('CONTINUITY_FACILITY_CONTEXT_')) {
      return next(AppError.forbidden(
        'Clinical continuity facility context was denied',
        'CONTINUITY_FACILITY_CONTEXT_DENIED',
        { safe: true },
      ));
    }
    return next(error);
  }
}

export default requireClinicalContinuityReconciliationContext;
