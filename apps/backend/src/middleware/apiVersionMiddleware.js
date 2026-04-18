/**
 * API version detection middleware.
 * Reads version from Accept-Version header, X-API-Version header, or URL prefix.
 * Attaches req.apiVersion for downstream use.
 *
 * Currently informational — does not gate behavior.
 * Future: response helpers can conditionally include/exclude fields based on version.
 */
export default function apiVersionMiddleware(req, res, next) {
  const version = req.headers['accept-version']
    || req.headers['x-api-version']
    || '1'; // Default to v1

  req.apiVersion = parseInt(version, 10) || 1;
  res.setHeader('X-API-Version', String(req.apiVersion));
  res.setHeader('X-App-Version', process.env.API_VERSION || '1.0.0');
  next();
}
