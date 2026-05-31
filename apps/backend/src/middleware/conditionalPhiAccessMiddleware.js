import { phiAccessLogger } from './phiAccessMiddleware.js';

export function pathMatchesPrefix(path, prefix) {
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
