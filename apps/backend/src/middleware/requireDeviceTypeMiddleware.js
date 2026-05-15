// src/middleware/requireDeviceTypeMiddleware.js
//
// Route-level gate that enforces a JWT's `deviceType` claim. Used by routes
// that must only run from a specific class of client — most notably
// `POST /staff/attendance`, which must only be markable from the phone.
//
// The claim is set at login by every auth realm (see services/auth/* +
// userActiveSession.js). jwtMiddleware surfaces it as `req.user.deviceType`.
// Tokens issued before this claim was introduced have `deviceType = null`;
// the middleware rejects them with a clear "please re-login" 403 so the
// client knows to retry the login flow rather than the request.

import logger from '../logging/logger.js';

/**
 * Build an Express middleware that rejects requests whose JWT `deviceType`
 * claim is not in the allowed list.
 *
 * @param {string|string[]} allowed - 'mobile' | 'desktop' | 'web' or an array
 * @returns {import('express').RequestHandler}
 */
export function requireDeviceType(allowed) {
  const allowList = Array.isArray(allowed) ? allowed : [allowed];
  return function requireDeviceTypeMiddleware(req, res, next) {
    const got = req.user?.deviceType ?? null;
    if (got && allowList.includes(got)) return next();

    // Distinguish "old token without the claim" from "wrong device type" so
    // the client can react: the former forces a re-login, the latter is a
    // permanent rejection for this device class.
    if (!got) {
      logger.warn(
        `requireDeviceType denied: user=${req.user?.uid ?? 'unknown'} ` +
        `path=${req.path} no deviceType claim — token predates this gate`,
      );
      return res.status(403).json({
        success: false,
        code: 'DEVICE_TYPE_MISSING',
        message: 'This action requires re-login on the supported device.',
        allowed: allowList,
      });
    }

    logger.warn(
      `requireDeviceType denied: user=${req.user?.uid ?? 'unknown'} ` +
      `path=${req.path} got=${got} allowed=${allowList.join('|')}`,
    );
    return res.status(403).json({
      success: false,
      code: 'DEVICE_TYPE_FORBIDDEN',
      message: `This action can only be performed from a ${allowList.join(' or ')} device.`,
      allowed: allowList,
      got,
    });
  };
}

export default requireDeviceType;
