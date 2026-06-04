import logger from '../logging/logger.js';
import {
  authorizeStaffAccessRequest,
  shouldSkipStaffAccessCheckError,
  staffAccessErrorPayload,
} from '../services/security/staffAccessDecisionService.js';

export function staffAccessGuard(policyCode, options = {}) {
  return async function staffAccessGuardMiddleware(req, res, next) {
    try {
      const decision = await authorizeStaffAccessRequest(req, {
        ...options,
        policyCode,
      });

      if (!decision?.allowed) {
        return res.status(403).json(staffAccessErrorPayload(decision));
      }

      return next();
    } catch (err) {
      if (shouldSkipStaffAccessCheckError(err)) {
        logger.warn('Staff access guard skipped because staff governance tables are not migrated', {
          path: req.originalUrl || req.url,
          policyCode,
        });
        return next();
      }
      logger.error('Staff access guard failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Staff access check failed',
        code: 'STAFF_ACCESS_CHECK_FAILED',
      });
    }
  };
}
