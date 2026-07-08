import logger from '../logging/logger.js';
import { evaluateEntitlement } from '../services/entitlements/entitlementService.js';
import { error } from '../utils/responseHelper.js';

export function requireEntitlement(featureKey, options = {}) {
  const { urgentClinical = false, surface = 'route', failOpenForUrgentClinical = true } = options;

  return async function entitlementGate(req, res, next) {
    try {
      const decision = await evaluateEntitlement({
        tenantId: req.tenantId,
        featureKey,
        urgentClinical,
        actorUid: req.user?.uid || null,
        actorRole: req.user?.rawRole || req.user?.role || null,
        surface,
        routePath: req.originalUrl,
        requestId: req.id,
        audit: true,
        metadata: {
          method: req.method,
          path: req.path
        }
      });

      req.entitlementDecision = decision;
      res.setHeader('X-VH-Entitlement-Feature', featureKey);
      res.setHeader('X-VH-Entitlement-Status', decision.status);

      if (decision.allowed || !decision.hardBlock) {
        return next();
      }

      return error(res, 'Feature not enabled for this tenant', 403, {
        code: 'FEATURE_NOT_ENTITLED',
        featureKey,
        status: decision.status,
        reason: decision.reason
      });
    } catch (err) {
      logger.error('Entitlement gate failed', {
        featureKey,
        error: err.message,
        path: req.originalUrl
      });
      if (urgentClinical && failOpenForUrgentClinical) {
        res.setHeader('X-VH-Entitlement-Feature', featureKey);
        res.setHeader('X-VH-Entitlement-Status', 'check_unavailable');
        return next();
      }
      return error(res, 'Entitlement check unavailable', 503, {
        code: 'ENTITLEMENT_CHECK_UNAVAILABLE'
      });
    }
  };
}

export default requireEntitlement;
