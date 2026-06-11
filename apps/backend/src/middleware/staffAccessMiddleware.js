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
        // M3: only reachable outside production with a verified 42P01.
        logger.error('SECURITY ALERT: staff access guard SKIPPED (governance table missing, non-prod)', {
          path: req.originalUrl || req.url,
          policyCode,
          sqlError: err?.message,
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
