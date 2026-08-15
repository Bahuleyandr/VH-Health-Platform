import { patientAccessGuard, phiAccessLogger } from './phiAccessMiddleware.js';

function pathMatchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function shouldLogPhiAccessPath(originalUrl, matchers) {
  const requestPath = String(originalUrl || '').split('?')[0].toLowerCase();
  return matchers.some((matcher) => (
    matcher instanceof RegExp
      ? matcher.test(requestPath)
      : pathMatchesPrefix(requestPath, matcher)
  ));
}

export function phiAccessLoggerForPaths(recordType, matchers) {
  const loggerMiddleware = phiAccessLogger(recordType);
  return (req, res, next) => {
    const originalUrl = req.originalUrl || req.url || '';
    if (!shouldLogPhiAccessPath(originalUrl, matchers)) return next();
    return loggerMiddleware(req, res, next);
  };
}

/**
 * Path-scoped CareTeam ABAC guard, mirroring phiAccessLoggerForPaths.
 *
 * The EMR router is mounted once but its PHI sub-paths are enumerated by path
 * matchers (so non-PHI EMR utility paths are not logged/guarded). This runs the
 * enforcing/shadow patientAccessGuard ONLY on matching PHI paths, exactly as
 * the passive logger does — keeping the per-tenant enforcement-mode contract
 * (off/shadow/enforce + fail-open) since it delegates to patientAccessGuard.
 *
 * @param {string} recordType
 * @param {Array<string|RegExp>} matchers
 * @param {object} [options] forwarded to patientAccessGuard (policyCode, ...)
 */
export function patientAccessGuardForPaths(recordType, matchers, options = {}) {
  const guardMiddleware = patientAccessGuard(recordType, options);
  return (req, res, next) => {
    const originalUrl = req.originalUrl || req.url || '';
    if (!shouldLogPhiAccessPath(originalUrl, matchers)) return next();
    return guardMiddleware(req, res, next);
  };
}
