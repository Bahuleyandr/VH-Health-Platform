// src/middleware/attachUserContext.js

import * as Sentry from '@sentry/node';
import { normalizeSentryPath } from '../utils/sentryScrubber.js';

export function attachUserContext(req, res, next) {
  if (req.user) {
    Sentry.setUser({
      id: req.user.uid ?? req.user.id,
      role: req.user.role,
    });
  }

  Sentry.setContext('request', {
    requestId: req.id,
    method: req.method,
    route: normalizeSentryPath(req.originalUrl?.split('?')[0]),
    apiClient: req.apiClient,
    tenantId: req.tenantId,
  });

  next();
}
