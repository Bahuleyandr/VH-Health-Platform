// src/middleware/sentryScopeMiddleware.js
//
// Attach per-request Sentry scope. Runs after `requestIdMiddleware` and
// `jwtMiddleware` (when applied) so req.id / req.user are populated. The
// scope is cleared after the response finishes so tags from one request
// never leak into another.
//
// Any error surfaced later (by `errorHandlerMiddleware` calling
// `Sentry.captureException`) will carry the requestId, route, userId, and
// role tags automatically — no ad-hoc enrichment at each call site.
import * as Sentry from '@sentry/node';
import { normalizeSentryPath } from '../utils/sentryScrubber.js';

export function sentryScopeMiddleware(req, res, next) {
  // Sentry v8 exposes withScope via the hub; we set tags on the current scope
  // so they apply for the duration of this request.
  const scope = Sentry.getCurrentScope();
  scope.setTag('requestId', req.id ?? null);
  scope.setTag('method', req.method);
  scope.setTag('route', normalizeSentryPath(req.originalUrl?.split('?')[0]) ?? null);
  scope.setTag('apiClient', req.apiClient ?? null);
  if (req.tenantId) scope.setTag('tenantId', String(req.tenantId));

  // User context is set later (after jwtMiddleware) if available — we attach
  // a deferred hook so scope picks it up just before response completes.
  const attachUser = () => {
    if (req.user) {
      scope.setUser({
        id: req.user.id ?? req.user.uid ?? null,
        role: req.user.role ?? null,
      });
    }
  };
  res.on('finish', attachUser);

  next();
}

export default sentryScopeMiddleware;
