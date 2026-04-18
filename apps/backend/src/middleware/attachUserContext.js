// src/middleware/attachUserContext.js

import * as Sentry from '@sentry/node';

export function attachUserContext(req, res, next) {
  if (req.user) {
    Sentry.setUser({
      id: req.user.uid,
      username: req.user.phone,
      role: req.user.role
    });
  }

  Sentry.setContext('request', {
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    query: req.query
  });

  next();
}
